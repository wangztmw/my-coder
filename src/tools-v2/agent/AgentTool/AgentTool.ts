import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { DESCRIPTION } from './prompt.js';
import { addMember, completeMember } from '../../../agent_team.js';
import type { AgentEngine } from '../../../agent_def.js';
import { agentLoop } from '../../../session_loop.js';
import type { ChatMessage } from '../../../llm/types.js';
import { TreeWriteLock } from '../../../task_tree/lock.js';
// 与 TreeCmdTool 共享同一锁实例——通过模块级单例
const agentTreeLock = (() => {
  try { return require('../../../task_tree/lock.js').sharedLock; } catch { return new TreeWriteLock(); }
})();

const inputSchema = z.object({
  description: z.string().describe('Short (3-5 word) description'),
  prompt: z.string().describe('The task for the sub-agent to complete. Be specific.'),
  subagent_type: z.enum(['general-purpose', 'explore', 'planner', 'supervisor', 'worker']).optional(),
  run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete.'),
  context_files: z.array(z.string()).optional().describe('List of files this agent will modify. Helps detect conflicts.'),
  parent_depth: z.number().optional().describe('Parent agent depth. Used for tree convergence tracking.'),
  parent_node_id: z.string().optional().describe('IMPORTANT: If you created a node with TreeCmd(add_child), pass the returned node ID here. This links the agent to the tree so completion is tracked automatically. The TreeCmd response tells you which ID to use.'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tasks: Map<string, any> | null = null;
let _engine: AgentEngine | null = null;
let _notify: ((msg: string) => void) | null = null;

export function initAgentTool(deps: {
  taskRegistry: Map<string, any>;
  engine: AgentEngine;
  notify: (msg: string) => void;
}) {
  _tasks = deps.taskRegistry;
  _engine = deps.engine;
  _notify = deps.notify;
}

async function syncTreeNode(task: any, status: string, result: string) {
  if (!task.treeNodeId || !_engine?.activeTreeId) return;
  const activeTreeId = _engine!.activeTreeId!;
  try {
    await agentTreeLock.batch(task.id, async () => {
      const { syncNodeFromMember } = await import('../../../task_tree/validate.js');
      const { loadTree, saveTree } = await import('../../../task_tree/persist.js');
      const tree = loadTree(activeTreeId);
      if (tree) {
        syncNodeFromMember(tree, task.treeNodeId, status, result);
        // flush 文件操作
        try {
          const { flushFileOpsToNode } = await import('../../../task_tree/file_tracker.js');
          flushFileOpsToNode(tree, task.treeNodeId);
        } catch {}
        saveTree(tree);
        // appendWal
        try {
          const { appendWal } = await import('../../../task_tree/wal.js');
          appendWal(tree.sessionId, task.treeNodeId,
            status === 'completed' ? 'node_completed' : 'node_failed',
            { result: result.slice(0, 500) });
        } catch {}
      }
    });
  } catch {}

  // children_all_done 传播
  if (task.treeNodeId && _engine?.activeTreeId) {
    try {
      const { checkChildrenAllDone } = await import('../../../task_tree/core.js');
      const { loadTree } = await import('../../../task_tree/persist.js');
      const tree = loadTree(_engine.activeTreeId);
      if (tree) {
        const readyParentId = checkChildrenAllDone(tree, task.treeNodeId);
        if (readyParentId) {
          const { appendWal } = await import('../../../task_tree/wal.js');
          appendWal(tree.sessionId, readyParentId, 'children_all_done', {});
          // 推送到主 Agent 的通知队列
          if (readyParentId === tree.rootId) {
            _notify!(`[TREE] ALL_DONE: 所有子节点已完成，整棵树完成`);
          } else {
            _notify!(`[TREE] children_all_done: ${readyParentId}`);
          }
        }
      }
    } catch { /* 降级 */ }
  }
}

export const AgentTool = buildTool({
  name: 'Agent',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call({ description, prompt, subagent_type: _type, run_in_background, context_files, parent_depth, parent_node_id }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    if (!_tasks || !_engine || !_notify) {
      return { data: 'Agent system not initialized.' };
    }

    const task = addMember('local_agent', description, prompt.slice(0, 200));

    const myDepth = parent_depth ?? 0;
    const childDepth = myDepth + 1;

    // MAX_NODES 检查
    try {
      const { loadTree } = await import('../../../task_tree/persist.js');
      const tree = loadTree((_engine as any).activeTreeId);
      if (tree && Object.keys(tree.nodes).length >= 50) {
        return { data: 'BLOCKED: Task tree has reached maximum size (50 nodes). Please merge related groups or simplify the task, then retry.' };
      }
    } catch {}

    // ★ 关联树节点
    if (_engine.activeTreeId && parent_node_id) {
      const treeId = _engine.activeTreeId;
      const nodeId = parent_node_id;
      try {
        await agentTreeLock.batch(task.id, async () => {
          const { addChildNode } = await import('../../../task_tree/core.js');
          const { loadTree, saveTree } = await import('../../../task_tree/persist.js');
          const tree = loadTree(treeId);
          if (tree) {
            const child = addChildNode(tree, nodeId, {
              meaning: description, task: prompt,
              role: childDepth >= 2 ? 'worker' : childDepth === 1 ? 'supervisor' : 'worker',
            });
            if (child) { task.treeNodeId = child.id; task.treeRole = child.role; saveTree(tree); }
          }
        });
      } catch {}
    }

    // context.files 冲突检测
    if (context_files && context_files.length > 0) {
      task.contextFiles = context_files;
      const conflicts: string[] = [];
      for (const [id, t] of _tasks!) {
        if (id === task.id) continue;
        if ((t as any).status !== 'running') continue;
        if (!(t as any).contextFiles || (t as any).contextFiles.length === 0) continue;
        const intersection = context_files.filter((f: string) => (t as any).contextFiles.includes(f));
        if (intersection.length > 0) conflicts.push(`${id} ("${(t as any).subject}"): ${intersection.join(', ')}`);
      }
      if (conflicts.length > 0) {
        task.status = 'blocked'; task.feedback = `File conflict: ${conflicts.join('; ')}`; task.feedbackAt = Date.now();
        return { data: `Agent ${task.id} BLOCKED: file conflicts.` };
      }
      // C1: acquireFileLock
      try {
        const { acquireFileLock } = await import('../../../task_tree/file_tracker.js');
        const lr = acquireFileLock(task.id, context_files);
        if (!lr.ok) {
          task.status = 'blocked'; task.feedback = `File lock: ${lr.conflictFile} held by ${lr.heldBy}`; task.feedbackAt = Date.now();
          return { data: `Agent ${task.id} BLOCKED: "${lr.conflictFile}" locked by ${lr.heldBy}.` };
        }
      } catch {}
    }

    // 身份声明
    let identityLine = '';
    if (childDepth >= 2) {
      identityLine = `\n\nYou are a LEAF worker at depth ${childDepth}. Return [DONE]/[PARTIAL:reason]/[BLOCKED:reason]. Optionally suggest splits: [FEEDBACK: DECOMPOSE: subtaskA | subtaskB].`;
    } else if (childDepth === 1) {
      identityLine = `\n\nYou are a BRANCH supervisor at depth ${childDepth}. Decompose further or supervise sub-agents.`;
    }

    const messages: ChatMessage[] = [
      { role: 'user', content: `Complete this task:\n${prompt}${identityLine}\n\nReturn a concise report.` },
    ];

    const subConfig = {
      messages,
      maxRounds: 10,
      serialTools: true as const,  // ★ 子Agent保持串行
      agentMeta: { depth: childDepth, isLeaf: childDepth >= 2 },  // 预留，暂不读取
      systemPrompt: childDepth >= 2 ? (_engine as any).buildSystemPrompt?.('worker')
        : childDepth === 1 ? (_engine as any).buildSystemPrompt?.('supervisor')
        : undefined,
      fileTracker: undefined as any, // TODO Phase 6b: pass createFileTrackerHook(task.id, task.treeNodeId)
      onComplete: (text: string) => { /* handled in caller */ },
      preRoundCheck: () => {
        if (task.status === 'blocked') {
          return `BLOCKED: ${task.feedback || 'no reason'}`;
        }
        // ★ 检查祖先是否存活
        if (task.treeNodeId && _engine?.activeTreeId) {
          try {
            const { loadTree } = require('../../../task_tree/persist.js');
            const { isAncestorAlive } = require('../../../task_tree/cascade.js');
            const tree = loadTree(_engine.activeTreeId);
            if (tree && !isAncestorAlive(tree, task.treeNodeId, {
              getAbortController: () => undefined,
              getMemberStatus: (agentId: string) => _tasks?.get(agentId)?.status,
              getMemberOutput: () => undefined,
            })) {
              task.status = 'killed';
              return '(killed)';
            }
          } catch { /* 降级 */ }
        }
        if (task.pendingInstruction) {
          messages.push({ role: 'user', content: `[MAIN AGENT INSTRUCTION — follow this]: ${task.pendingInstruction}` });
          task.pendingInstruction = undefined;
          return null;
        }
        if (task.abortController?.signal.aborted) {
          task.status = 'killed';
          return '(killed)';
        }
        return null;
      },
      updateStats: (name: string, summary: string, output: string, feedback?: string) => {
        if (task.agentLoop) {
          task.agentLoop.lastActivity = `${name}(${summary})`;
          task.agentLoop.lastOutput = output.slice(0, 200);
        }
        if (feedback) {
          task.feedback = feedback;
          task.feedbackAt = Date.now();
          if (feedback.startsWith('BLOCKED:')) task.status = 'blocked';
        }
      },
    };

    if (run_in_background) {
      // 后台执行：pending → agentLoop → completeMember
      const bgTreeId = _engine.activeTreeId;
      const bgNodeId = task.treeNodeId;
      if (bgNodeId && bgTreeId) {
        try {
          await agentTreeLock.batch(task.id, async () => {
            const { dispatchNode } = await import('../../../task_tree/core.js');
            const { loadTree, saveTree } = await import('../../../task_tree/persist.js');
            const { appendWal } = await import('../../../task_tree/wal.js');
            const tree = loadTree(bgTreeId);
            if (tree) { dispatchNode(tree, bgNodeId, task.id); appendWal(bgTreeId, bgNodeId, 'node_dispatched', { agentId: task.id }); saveTree(tree); }
          });
        } catch {}
      }
      agentLoop(_engine, subConfig).then(result => {
        if (result.status === 'success') {
          completeMember(task.id, result.text);
          syncTreeNode(task, 'completed', result.text);
        } else {
          const t = _tasks!.get(task.id) as any;
          if (t) { t.status = result.status === 'blocked' ? 'blocked' : 'failed'; t.endTime = Date.now(); t.output = `[${result.status}] ${result.text}`; if (result.blockedReason) t.feedback = result.blockedReason; }
          syncTreeNode(task, result.status === 'blocked' ? 'blocked' : 'failed', result.text);
        }
        import('../../../task_tree/file_tracker.js').then(m => m.releaseFileLocks(task.id)).catch(() => {});
        const active = [..._tasks!.values()].filter((x: any) => x.status === 'running').length;
        _notify!(`[Agent "${description}" ${result.status === 'success' ? 'completed' : result.status}${active > 0 ? ` — ${active} running` : ''}]:\n${result.text.slice(0, 1500)}${result.text.length > 1500 ? `\n... (${result.text.length - 1500} more chars. Use AgentTeam(check, ${task.id}) for full report.)` : ''}`);
      }).catch(err => {
        const t = _tasks!.get(task.id) as any;
        if (t) { t.status = 'failed'; t.endTime = Date.now(); t.output = `(crashed: ${(err as Error).message})`; }
        syncTreeNode(task, 'failed', (err as Error).message);
        import('../../../task_tree/file_tracker.js').then(m => m.releaseFileLocks(task.id)).catch(() => {});
        _notify!(`[Agent "${description}" failed]: ${(err as Error).message}`);
      });
      return { data: `Agent spawned: ${task.id} ("${description}" pending in background)` };
    }

    // 同步模式：pending → agentLoop → completeMember
    const syncTreeId = _engine.activeTreeId;
    const syncNodeId = task.treeNodeId;
    if (syncNodeId && syncTreeId) {
      try {
        await agentTreeLock.batch(task.id, async () => {
          const { dispatchNode } = await import('../../../task_tree/core.js');
          const { loadTree, saveTree } = await import('../../../task_tree/persist.js');
          const { appendWal } = await import('../../../task_tree/wal.js');
          const tree = loadTree(syncTreeId);
          if (tree) { dispatchNode(tree, syncNodeId, task.id); appendWal(syncTreeId, syncNodeId, 'node_dispatched', { agentId: task.id }); saveTree(tree); }
        });
      } catch {}
    }
    try {
      const result = await agentLoop(_engine, subConfig);
      if (result.status === 'success') {
        completeMember(task.id, result.text);
        syncTreeNode(task, 'completed', result.text);
      } else {
        task.status = result.status === 'blocked' ? 'blocked' : 'failed';
        task.endTime = Date.now();
        task.output = `[${result.status}] ${result.text}`;
        if (result.blockedReason) task.feedback = result.blockedReason;
        syncTreeNode(task, result.status === 'blocked' ? 'blocked' : 'failed', result.text);
      }
      import('../../../task_tree/file_tracker.js').then(m => m.releaseFileLocks(task.id)).catch(() => {});
      return { data: `[Agent "${description}" ${result.status === 'success' ? 'report' : result.status}]:\n${result.text}` };
    } catch (e) {
      task.status = 'failed';
      task.endTime = Date.now();
      task.output = `(crashed: ${(e as Error).message})`;
      syncTreeNode(task, 'failed', (e as Error).message);
      import('../../../task_tree/file_tracker.js').then(m => m.releaseFileLocks(task.id)).catch(() => {});
      return { data: `Agent error: ${(e as Error).message}` };
    }
  },

  async prompt() { return `## Agent\n${DESCRIPTION}\nInput: { description, prompt, subagent_type?, run_in_background? }`; },
  userFacingName: () => 'Agent',
  getToolUseSummary({ description }: Partial<z.infer<typeof inputSchema>>) { return description ? `Agent: ${description}` : 'Agent'; },
});
