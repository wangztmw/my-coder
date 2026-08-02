import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';

const inputSchema = z.object({
  action: z.enum(['list', 'check', 'wait', 'kill', 'inbox', 'direct']).describe('What to do'),
  taskId: z.string().optional().describe('Task ID (for check/kill/direct)'),
  instruction: z.string().optional().describe('Instruction to inject into running agent (for direct)'),
  timeout_ms: z.number().optional().describe('Max wait ms (for wait, default 30000)'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tasks: Map<string, any> | null = null;
let _notify: ((msg: string) => void) | null = null;
let _pendingNotifs: Array<{ role: string; content: string }> | null = null;

export function initTaskTool(deps: {
  taskRegistry: Map<string, any>;
  notify: (msg: string) => void;
  pendingNotifications: Array<{ role: string; content: string }>;
}) {
  _tasks = deps.taskRegistry;
  _notify = deps.notify;
  _pendingNotifs = deps.pendingNotifications;
}

function fmtTask(t: { id: string; status: string; subject: string; type: string;
  startTime: number; agentLoop?: { roundCount: number; toolUseCount: number; lastActivity?: string; lastOutput?: string };
  output?: string; endTime?: number;
}): string {
  const elapsed = Math.round(((t.endTime || Date.now()) - t.startTime) / 1000);
  const icon = t.status === 'running' ? '⏳' : t.status === 'completed' ? '✓' : t.status === 'killed' ? '✗' : '?';
  let line = `${icon} [${t.status}] ${t.id}: ${t.subject} (${elapsed}s)`;
  if (t.agentLoop && t.status === 'running') {
    line += ` — round ${t.agentLoop.roundCount}, ${t.agentLoop.toolUseCount} tools`;
    if (t.agentLoop.lastActivity) line += `, last: ${t.agentLoop.lastActivity}`;
  }
  if (t.output && t.status !== 'running') {
    line += ` → ${t.output.slice(0, 80)}`;
  }
  return line;
}

export const TaskTool = buildTool({
  name: 'Task',
  inputSchema,
  async description() {
    return 'Manage background tasks. Actions: list, check, wait, kill, inbox, direct. Use direct to inject new instructions into a RUNNING agent — it will see the instruction on its next turn. Use this to redirect stuck agents instead of killing them.';
  },
  isReadOnly: () => false,

  async call({ action, taskId, timeout_ms, instruction }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    if (!_tasks || !_pendingNotifs) return { data: 'Task system not initialized.' };
    const tasks = [..._tasks.values()] as Array<{
      id: string; status: string; subject: string; type: string;
      startTime: number; endTime?: number; output?: string; abortController?: AbortController;
      agentLoop?: { roundCount: number; toolUseCount: number; lastActivity?: string; lastOutput?: string };
    }>;

    switch (action) {
      case 'list': {
        if (tasks.length === 0) return { data: '(no tasks)' };
        const running = tasks.filter(t => t.status === 'running');
        const done = tasks.filter(t => t.status !== 'running');
        const lines = [...running, ...done].map(fmtTask);
        return { data: `${tasks.length} tasks (${running.length} running, ${done.length} done):\n${lines.join('\n')}` };
      }

      case 'check': {
        if (!taskId) return { data: 'Error: taskId required' };
        const t = _tasks.get(taskId);
        if (!t) return { data: `Task ${taskId} not found.` };
        let result = `${fmtTask(t)}\n`;
        if (t.agentLoop && t.status === 'running') {
          result += `\nLive progress:\n  Round: ${t.agentLoop.roundCount}/10\n  Tools called: ${t.agentLoop.toolUseCount}\n`;
          if (t.agentLoop.lastActivity) result += `  Last activity: ${t.agentLoop.lastActivity}\n`;
          if (t.agentLoop.lastOutput) result += `  Last output: ${t.agentLoop.lastOutput.slice(0, 300)}\n`;
        }
        if (t.output) {
          result += `\nOutput:\n${t.output.slice(0, 2000)}`;
        }
        return { data: result };
      }

      case 'wait': {
        const deadline = Date.now() + (timeout_ms || 30000);
        while (Date.now() < deadline) {
          const running = tasks.filter(t => t.status === 'running');
          if (running.length === 0) {
            const all = tasks;
            return { data: `All ${all.length} tasks completed.` };
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        const still = tasks.filter(t => t.status === 'running');
        return {
          data: `Timeout after ${timeout_ms || 30000}ms. ${still.length} still running:\n${still.map(fmtTask).join('\n')}\n\nUse Task(check, taskId) to investigate or Task(kill, taskId) to stop.`,
        };
      }

      case 'kill': {
        if (!taskId) return { data: 'Error: taskId required' };
        const t = _tasks.get(taskId);
        if (!t) return { data: `Task ${taskId} not found.` };
        if (t.abortController) {
          try { t.abortController.abort(); } catch {}
        }
        t.status = 'killed';
        t.endTime = Date.now();
        return { data: `Task ${taskId} ("${t.subject}") killed.` };
      }

      case 'direct': {
        if (!taskId) return { data: 'Error: taskId required' };
        if (!instruction) return { data: 'Error: instruction required' };
        const dt = _tasks.get(taskId);
        if (!dt) return { data: `Task ${taskId} not found.` };
        if (dt.status !== 'running') return { data: `Task ${taskId} is ${dt.status}, cannot inject instruction.` };
        dt.pendingInstruction = instruction;
        return { data: `Instruction sent to ${taskId} ("${dt.subject}"): ${instruction}` };
      }

      case 'inbox': {
        const pending = _pendingNotifs;
        if (pending.length === 0) return { data: '(inbox empty)' };
        return {
          data: `${pending.length} pending notification(s):\n${pending.map((n, i) => `${i + 1}. ${n.content.slice(0, 200)}`).join('\n\n')}\n\n(Notifications will be delivered at the start of the next user turn.)`,
        };
      }

      default:
        return { data: `Unknown action: ${action}` };
    }
  },

  async prompt() { return '## Task\nManage background tasks: list, check, wait, kill, inbox.'; },
  userFacingName: () => 'Task',
  getToolUseSummary({ action, taskId }: Partial<z.infer<typeof inputSchema>>) {
    return `Task: ${action}${taskId ? ` ${taskId}` : ''}`;
  },
});
