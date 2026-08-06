import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { readMemberOutput } from '../../../agent_team.js';

const inputSchema = z.object({
  action: z.enum(['list', 'check', 'wait', 'kill', 'inbox', 'direct', 'deep']).describe('What to do'),
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
  output?: string; endTime?: number; feedback?: string;
  treeRole?: string; depth?: number; treeNodeId?: string;
}): string {
  const elapsed = Math.round(((t.endTime || Date.now()) - t.startTime) / 1000);
  const icon = t.status === 'running' ? '⏳' : t.status === 'completed' ? '✓' : t.status === 'blocked' ? '⏸' : t.status === 'killed' ? '✗' : '?';
  let line = `${icon} [${t.status}] ${t.id}: ${t.subject} (${elapsed}s)`;
  if (t.treeRole) line += ` [${t.treeRole}]`;
  if (t.depth !== undefined) line += ` d${t.depth}`;
  if (t.agentLoop && (t.status === 'running' || t.status === 'blocked')) {
    line += ` — round ${t.agentLoop.roundCount}, ${t.agentLoop.toolUseCount} tools`;
    if (t.agentLoop.lastActivity) line += `, last: ${t.agentLoop.lastActivity}`;
  }
  if (t.feedback) {
    line += `\n       💬 "${t.feedback.slice(0, 100)}"`;
  }
  if (t.output && t.status !== 'running' && t.status !== 'blocked') {
    line += ` → ${t.output.slice(0, 80)}`;
  }
  return line;
}

export const AgentTeamTool = buildTool({
  name: 'AgentTeam',
  inputSchema,
  async description() {
    return 'Manage background tasks. Actions: list, check, deep, wait, kill, inbox, direct. Use direct to inject new instructions into a RUNNING agent — it will see the instruction on its next turn. Use this to redirect stuck agents instead of killing them. deep shows full subtree for tasks with trees.';
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
        const blocked = tasks.filter(t => t.status === 'blocked');
        const done = tasks.filter(t => t.status !== 'running' && t.status !== 'blocked');
        const lines = [...running, ...blocked, ...done].map(fmtTask);
        return { data: `${tasks.length} tasks (${running.length} running, ${blocked.length} blocked, ${done.length} done):\n${lines.join('\n')}` };
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
        // 优先读磁盘完整输出，内存摘要作 fallback
        const diskOutput = readMemberOutput(taskId);
        if (diskOutput) {
          result += `\nOutput (full):\n${diskOutput.slice(0, 3000)}`;
          if (diskOutput.length > 3000) result += `\n... (${diskOutput.length - 3000} more chars)`;
        } else if (t.output) {
          result += `\nOutput (summary):\n${t.output.slice(0, 2000)}`;
        }
        // 尝试加载关联树状态
        const engine = (_ctx.options as any)?.engine;
        const treeSessionId = engine?.activeTreeId;
        if (t.treeNodeId && treeSessionId) {
          try {
            const { loadTree } = await import('../../../task_tree/persist.js');
            const { checkSubtreeStatus } = await import('../../../task_tree/core.js');
            const tree = loadTree(treeSessionId);
            if (tree) {
              const treeNodeId = t.treeNodeId;
              const statuses = checkSubtreeStatus(tree, treeNodeId);
              result += `\n\nSubtree status (${statuses.length} nodes):`;
              for (const s of statuses.slice(0, 10)) {
                result += `\n  ${s.nodeStatus} ${s.nodeId.slice(0, 10)}... agent=${s.agentStatus}`;
              }
              if (statuses.length > 10) result += `\n  ... and ${statuses.length - 10} more`;
              // 发散检测
              try {
                const { detectDivergence } = await import('../../../task_tree/file_tracker.js');
                const div = detectDivergence(tree, treeNodeId);
                if (div.isDivergent) {
                  result += `\n\n⚠ Tree divergence detected:`;
                  if (div.missed.length > 0) result += `\n  Missed (not predicted): ${div.missed.join(', ')}`;
                  if (div.untouched.length > 0) result += `\n  Untouched (predicted but not used): ${div.untouched.join(', ')}`;
                }
              } catch { /* file_tracker 不可用 */ }
            }
          } catch { /* task_tree module not available yet — skip */ }
        }
        return { data: result };
      }

      case 'deep': {
        if (!taskId) return { data: 'Error: taskId required' };
        const dt2 = _tasks.get(taskId);
        if (!dt2) return { data: `Task ${taskId} not found.` };
        let deepResult = `${fmtTask(dt2)}\n`;
        if (dt2.agentLoop && dt2.status === 'running') {
          deepResult += `\nLive progress:\n  Round: ${dt2.agentLoop.roundCount}/10\n  Tools called: ${dt2.agentLoop.toolUseCount}\n`;
          if (dt2.agentLoop.lastActivity) deepResult += `  Last activity: ${dt2.agentLoop.lastActivity}\n`;
          if (dt2.agentLoop.lastOutput) deepResult += `  Last output: ${dt2.agentLoop.lastOutput.slice(0, 300)}\n`;
        }
        // 尝试加载关联树并完整展开子树
        const engine = (_ctx.options as any)?.engine;
        const treeSessionId = engine?.activeTreeId;
        if (dt2.treeNodeId && treeSessionId) {
          try {
            const { loadTree } = await import('../../../task_tree/persist.js');
            const { checkSubtreeStatus } = await import('../../../task_tree/core.js');
            const tree = loadTree(treeSessionId);
            if (tree) {
              const treeNodeId = dt2.treeNodeId;
              const statuses = checkSubtreeStatus(tree, treeNodeId);
              deepResult += `\n\nFull subtree (${statuses.length} nodes):`;
              for (const s of statuses) {
                const agentInfo = s.agentStatus !== 'not_found' ? ` agent=${s.agentStatus}` : '';
                deepResult += `\n  [${s.nodeStatus}] ${s.nodeId}${agentInfo} children=${s.childrenSummary}`;
              }
              // 发散检测
              try {
                const { detectDivergence } = await import('../../../task_tree/file_tracker.js');
                const div = detectDivergence(tree, treeNodeId);
                if (div.isDivergent) {
                  deepResult += `\n\n⚠ Tree divergence detected:`;
                  if (div.missed.length > 0) deepResult += `\n  Missed (not predicted): ${div.missed.join(', ')}`;
                  if (div.untouched.length > 0) deepResult += `\n  Untouched (predicted but not used): ${div.untouched.join(', ')}`;
                }
              } catch { /* file_tracker 不可用 */ }
            }
          } catch { /* task_tree module not available yet — skip */ }
        } else {
          deepResult += `\n\n(no tree associated with this task)`;
        }
        return { data: deepResult };
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
        // ★ 级联终止：如果该 Agent 有关联的树节点，递归终止所有子孙
        if (t.treeNodeId) {
          const engine = (_ctx.options as any)?.engine;
          if (engine?.activeTreeId) {
            try {
              const { loadTree, saveTree } = await import('../../../task_tree/persist.js');
              const { cascadeKillTreeNode } = await import('../../../task_tree/cascade.js');
              const tree = loadTree(engine.activeTreeId);
              if (tree) {
                const bridge = {
                  getAbortController: (agentId: string) => {
                    const member = _tasks?.get(agentId);
                    return member?.abortController;
                  },
                  getMemberStatus: (agentId: string) => {
                    const member = _tasks?.get(agentId);
                    return member?.status;
                  },
                  getMemberOutput: (agentId: string) => {
                    const member = _tasks?.get(agentId);
                    return member?.output;
                  },
                };
                // 收集孤儿结果
                if (t.treeNodeId && engine?.activeTreeId) {
                  try {
                    const { collectOrphanedResults } = await import('../../../task_tree/cascade.js');
                    const orphans = collectOrphanedResults(tree, t.treeNodeId);
                    for (const o of orphans) {
                      if (o.type === 'node_completed') {
                        _pendingNotifs!.push({ role: 'user', content: `[ORPHAN RESULT] Node ${o.nodeId}: ${o.result?.slice(0, 500)}` });
                      }
                    }
                  } catch { /* 降级 */ }
                }
                await cascadeKillTreeNode(tree, t.treeNodeId, `Parent agent ${taskId} killed`, bridge);
                saveTree(tree);
              }
            } catch { /* 级联终止失败不影响 kill 本身 */ }
          }
        }
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

  async prompt() { return '## Task\nManage background tasks: list, check, deep, wait, kill, inbox.'; },
  userFacingName: () => 'AgentTeam',
  getToolUseSummary({ action, taskId }: Partial<z.infer<typeof inputSchema>>) {
    return `AgentTeam: ${action}${taskId ? ` ${taskId}` : ''}`;
  },
});
