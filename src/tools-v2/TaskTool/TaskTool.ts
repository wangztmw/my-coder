import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  action: z.enum(['create', 'list', 'check', 'wait']).describe('What to do'),
  subject: z.string().optional().describe('Task title (for create)'),
  description: z.string().optional().describe('Task description (for create)'),
  prompt: z.string().optional().describe('Agent prompt (for create with agent type)'),
  taskId: z.string().optional().describe('Task ID (for check)'),
  timeout_ms: z.number().optional().describe('Max wait time in ms (for wait, default 60000)'),
});

// Task registry — shared with main.ts via init
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _taskRegistry: Map<string, any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _notifyTask: ((msg: string) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _runSubAgent2: ((messages: any[], taskId?: string) => Promise<string>) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _buildSubAgentContext2: ((task: string) => any[]) | null = null;

export function initTaskTool(deps: {
  taskRegistry: NonNullable<typeof _taskRegistry>;
  notify: (msg: string) => void;
  runSubAgent: (...args: any[]) => Promise<string>;
  buildSubAgentContext: (task: string) => any[];
}) {
  _notifyTask = deps.notify;
  _taskRegistry = deps.taskRegistry;
  _runSubAgent2 = deps.runSubAgent;
  _buildSubAgentContext2 = deps.buildSubAgentContext;
}

export const TaskTool = buildTool({
  name: 'Task',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,

  async call({ action, subject, description: _desc, prompt, taskId, timeout_ms }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    switch (action) {
      case 'create': {
        if (!subject) return { data: 'Error: subject is required for create' };
        if (!prompt) return { data: 'Error: prompt is required for create' };
        if (!_taskRegistry || !_runSubAgent2 || !_buildSubAgentContext2 || !_notifyTask) {
          return { data: 'Task system not initialized.' };
        }
        const id = 'a' + Math.random().toString(36).slice(2, 10);
        _taskRegistry.set(id, { id, type: 'local_agent', status: 'running', description: subject, startTime: Date.now() });
        const msgs = _buildSubAgentContext2(prompt);
        _runSubAgent2(msgs, id).then(result => {
          const t = _taskRegistry!.get(id);
          if (t) { t.status = 'completed'; t.output = result; }
          const active = [..._taskRegistry!.values()].filter((t: { status: string }) => t.status === 'running').length;
          _notifyTask!(`[Task "${subject}" completed${active > 0 ? ` — ${active} task${active > 1 ? 's' : ''} still running` : ''}]:\n${result.slice(0, 1000)}`);
        });
        return { data: `Task created: ${id} ("${subject}")` };
      }

      case 'list': {
        if (!_taskRegistry) return { data: 'Task system not initialized.' };
        const tasks = [..._taskRegistry.values()];
        if (tasks.length === 0) return { data: '(no tasks)' };
        const lines = tasks.map((t: { id: string; type: string; status: string; description: string; startTime: number }) =>
          `${t.status === 'running' ? '⏳' : '✓'} [${t.status}] ${t.id}: ${t.description}${t.type === 'local_agent' ? ' (agent)' : ' (bash)'}`);
        return { data: `${tasks.length} task(s):\n${lines.join('\n')}` };
      }

      case 'check': {
        if (!taskId) return { data: 'Error: taskId is required for check' };
        if (!_taskRegistry) return { data: 'Task system not initialized.' };
        const task = _taskRegistry.get(taskId);
        if (!task) return { data: `Task not found: ${taskId}` };
        if (task.status === 'running') {
          return { data: `[${task.status}] ${task.id}: ${task.description}\n(no output yet — task is still running)` };
        }
        return { data: `[${task.status}] ${task.id}: ${task.description}\n\n${task.output || '(no output)'}` };
      }

      case 'wait': {
        if (!_taskRegistry) return { data: 'Task system not initialized.' };
        const deadline = Date.now() + (timeout_ms || 60000);
        while (Date.now() < deadline) {
          const running = [..._taskRegistry.values()].filter((t: { status: string }) => t.status === 'running');
          if (running.length === 0) {
            const all = [..._taskRegistry.values()];
            return { data: `All ${all.length} task(s) completed.` };
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        const stillRunning = [..._taskRegistry.values()].filter((t: { status: string }) => t.status === 'running');
        return {
          data: `Timeout after ${timeout_ms || 60000}ms. ${stillRunning.length} task(s) still running:\n` +
            stillRunning.map((t: { id: string; description: string }) => `  ${t.id}: ${t.description}`).join('\n') +
            `\nUse Task(check, taskId: "...") to investigate.`,
        };
      }

      default:
        return { data: `Unknown action: ${action}` };
    }
  },

  async prompt() { return `## Task\n${DESCRIPTION}`; },
  userFacingName: () => 'Task',
  getToolUseSummary({ action, subject }: Partial<z.infer<typeof inputSchema>>) { return `Task: ${action}${subject ? ` "${subject}"` : ''}`; },
});
