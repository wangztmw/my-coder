import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../../core/Tool.js';
import { sharedLock as treeLock } from '../../../task_tree/lock.js';
import { SESSIONS_DIR, sessionDir } from '../../../task_tree/paths.js';

const inputSchema = z.object({
  action: z.enum(['create', 'add_child', 'status', 'report', 'replace', 'get_leaves', 'list', 'get_node', 'delete_node'])
    .describe('Tree operation to perform'),
  treeId: z.string().optional().describe('Tree ID (auto-detected from current session if omitted)'),
  parentId: z.string().optional().describe('Parent node ID (for add_child)'),
  nodeId: z.string().optional().describe('Node ID (for status/report/replace)'),
  meaning: z.string().optional().describe('Semantic description (for add_child/create)'),
  task: z.string().optional().describe('Task prompt (for add_child)'),
  role: z.enum(['planner', 'supervisor', 'worker']).optional().describe('Agent role (for add_child)'),
  result: z.string().optional().describe('Task result text (for report)'),
  purpose: z.string().optional().describe('Overall purpose (for create)'),
});

export const TreeCmdTool = buildTool({
  name: 'TreeCmd',
  inputSchema,
  async description() {
    return 'Manage the task tree. Actions: create (start a tree), add_child (decompose a node), status (check subtree), report (submit result), replace (replan failed subtree), get_leaves (list executable leaves), get_node (inspect a node), delete_node (remove a node and its subtree), list (list saved trees).';
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(params, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    // Dynamic import to avoid circular dependency — task_tree module may not
    // be fully compiled when this file is first loaded.
    const { createTree, addChildNode, checkSubtreeStatus, reportResult, replaceSubtree, getExecutableLeaves, renderTree } = await import('../../../task_tree/core.js');
    const { loadTree, saveTree } = await import('../../../task_tree/persist.js');

    // Resolve treeId: explicit param > engine's activeTree > auto-generate for create
    const engine = (_ctx.options as any).engine;
    const treeId = params.treeId || engine?.activeTreeId;

    // ★ 分层权限：非主 Agent 只能读树
    const agentDepth = (_ctx.options as any).agentMeta?.depth ?? 0;
    const writeActions = ['create', 'replace', 'delete_node', 'report'];
    if (writeActions.includes(params.action) && agentDepth > 0) {
      return { data: `PERMISSION DENIED: Only the root agent (depth 0) can use TreeCmd ${params.action}. To suggest tree changes, use [FEEDBACK] to the main agent.` };
    }

    switch (params.action) {
      case 'create': {
        if (!params.purpose) return { data: 'Error: purpose required for create' };
        // 自动生成可读 treeId：tree-{timestamp}
        const autoId = treeId || `tree-${Date.now().toString(36)}`;
        const existingActive = engine?.activeTreeId;
        let createWarning: string | null = null;
        const result = await treeLock.batch('TreeCmdTool', async () => {
          // 轻量校验（不阻塞，仅 warn）
          try {
            const { validateDecomposition } = await import('../../../task_tree/validate.js');
            const report = validateDecomposition(
              { purpose: params.purpose!, parallelism: { independent: [], sequential: [], reason: '' }, groups: [] },
              { files: [], concepts: [] },
            );
            if (!report.passed) {
              createWarning = `\n⚠ Decomposition warning: ${[...report.overDecomposed, ...report.inconsistent].join('; ')}`;
            }
          } catch { /* validate 不可用 */ }
          const tree = createTree(autoId, params.purpose!);
          saveTree(tree);
          // 自动 WAL compaction
          try {
            const { readWal, compactWal, COMPACTION_THRESHOLD } = await import('../../../task_tree/wal.js');
            const entries = readWal(autoId);
            if (entries.length >= COMPACTION_THRESHOLD) {
              compactWal(autoId, tree);
            }
          } catch { /* 降级 */ }
          // WAL 记录
          try {
            const { appendWal } = await import('../../../task_tree/wal.js');
            appendWal(autoId, tree.rootId, 'node_created', {});
          } catch { /* 降级 */ }
          return tree;
        });
        const tree = result;
        if (engine) engine.setActiveTree(tree.sessionId, tree.rootId);
        let msg = `Tree created: ${tree.sessionId}\nRoot: ${tree.rootId} — "${params.purpose}"\nTotal nodes: ${Object.keys(tree.nodes).length}`;
        if (createWarning) msg += createWarning;
        if (existingActive) {
          msg += `\n⚠ You already have an active tree (${existingActive}). The new tree is now active.`;
        }
        return { data: msg };
      }
      case 'add_child': {
        if (!treeId) return { data: 'Error: treeId required for add_child. No active tree. Use action:\'create\' first or pass treeId.' };
        const missing: string[] = [];
        if (!params.parentId) missing.push('parentId');
        if (!params.meaning) missing.push('meaning');
        if (!params.task) missing.push('task');
        if (missing.length > 0) return { data: `Error: Missing: ${missing.join(', ')}` };
        const parentId = params.parentId!;
        const meaning = params.meaning!;
        const result = await treeLock.batch('TreeCmdTool', async () => {
          const tree = loadTree(treeId);
          if (!tree) return { child: null, warning: null, error: `Tree ${treeId} not found` };
          // 去重检查
          let warning: string | null = null;
          const existingSibling = Object.values(tree.nodes).find(
            n => n.parentId === parentId && n.meaning === meaning
          );
          if (existingSibling) {
            warning = `\n⚠ A sibling with the same meaning already exists: ${existingSibling.id}`;
          }
          // 轻量校验（不阻塞，仅 warn）
          try {
            const { validateDecomposition, detectSecurityAnomaly } = await import('../../../task_tree/validate.js');
            const decomp = {
              purpose: meaning || '',
              parallelism: { independent: [], sequential: [], reason: '' },
              groups: [{ meaning: meaning || '', context: { files: [], concepts: [] }, isLeaf: (params.role || 'worker') === 'worker' }],
            };
            const report = validateDecomposition(decomp, { files: [], concepts: [] });
            if (!report.passed) {
              warning = (warning ? warning : '') + `\n⚠ Decomposition warning: ${[...report.overDecomposed, ...report.inconsistent].join('; ')}`;
            }
            const alert = detectSecurityAnomaly(parentId, decomp, { files: [], concepts: [] }, { jaccardStreak: 0, replanCount: 0, emptyGroupStreak: 0 });
            if (alert) {
              warning = (warning ? warning : '') + `\n⚠ Security anomaly: ${alert.type} — ${alert.detail}`;
            }
          } catch { /* validate 不可用 */ }
          const child = addChildNode(tree, parentId, { meaning, task: params.task!, role: params.role || 'worker' });
          if (!child) {
            const parentExists = tree.nodes[parentId] != null;
            return { child: null, warning, error: parentExists
              ? 'Error: tree full (max 50 nodes)'
              : `Error: parent not found: ${parentId}` };
          }
          saveTree(tree);
          // 自动 WAL compaction
          try {
            const { readWal, compactWal, COMPACTION_THRESHOLD } = await import('../../../task_tree/wal.js');
            const entries = readWal(treeId);
            if (entries.length >= COMPACTION_THRESHOLD) {
              compactWal(treeId, tree);
            }
          } catch { /* 降级 */ }
          // WAL 记录
          try {
            const { appendWal } = await import('../../../task_tree/wal.js');
            appendWal(treeId, child.id, 'child_added', { childId: child.id });
          } catch { /* 降级 */ }
          return { child, warning, error: null };
        });
        if (result.error) return { data: result.error };
        if (!result.child) return { data: 'Cannot add child: tree may be full (max 50 nodes) or parent not found' };
        const child = result.child;
        let msg = `Child node added: ${child.id} — "${meaning}" (${params.role || 'worker'}, depth ${child.depth})\n💡 Next: Agent(description="${meaning}", prompt="...", parent_node_id="${child.id}", background=true)`;
        if (result.warning) msg += result.warning;
        return { data: msg };
      }
      case 'status': {
        if (!treeId) return { data: `Error: treeId required. No active tree. Use action:'create' first or pass treeId.` };
        const tree = loadTree(treeId);
        if (!tree) return { data: `Tree ${treeId} not found` };
        const targetId = params.nodeId || tree.rootId;
        const statuses = checkSubtreeStatus(tree, targetId);
        const treeStr = renderTree(tree);
        const totalNodes = Object.keys(tree.nodes).length;
        const doneNodes = Object.values(tree.nodes).filter(n => n.status === 'completed' || n.status === 'failed' || n.status === 'killed').length;
        const detailLines = statuses.map(s => {
          const node = tree.nodes[s.nodeId];
          const readyMark = (node && node.children.length > 0 && node.children.every(cid => {
            const c = tree.nodes[cid];
            return c && (c.status === 'completed' || c.status === 'failed' || c.status === 'killed');
          })) ? ' [ready]' : '';
          return `${s.nodeStatus}${readyMark} ${s.nodeId} "${node?.meaning || ''}"`;
        });
        return { data: `Tree status:\n${treeStr}\n\n${detailLines.join('\n')}\n\n进度: ${doneNodes}/${totalNodes}` };
      }
      case 'report': {
        if (!treeId || !params.nodeId || !params.result) return { data: 'Error: treeId, nodeId, result required for report. No active tree. Use action:\'create\' first or pass treeId.' };
        const reportResult2 = await treeLock.batch('TreeCmdTool', async () => {
          const tree = loadTree(treeId!);
          if (!tree) return { ok: false, error: `Tree ${treeId} not found`, oldResult: undefined };
          const node = tree.nodes[params.nodeId!];
          if (!node) return { ok: false, error: `Node ${params.nodeId} not found`, oldResult: undefined };
          const oldResult = node.result;
          reportResult(tree, params.nodeId!, params.result!, 'completed');
          saveTree(tree);
          // 自动 WAL compaction
          try {
            const { readWal, compactWal, COMPACTION_THRESHOLD } = await import('../../../task_tree/wal.js');
            const entries = readWal(treeId!);
            if (entries.length >= COMPACTION_THRESHOLD) {
              compactWal(treeId!, tree);
            }
          } catch { /* 降级 */ }
          // WAL 记录
          try {
            const { appendWal } = await import('../../../task_tree/wal.js');
            appendWal(treeId!, params.nodeId!, 'node_completed', { result: params.result?.slice(0, 500) });
          } catch { /* 降级 */ }
          return { ok: true, error: null, oldResult };
        });
        if (!reportResult2.ok) return { data: reportResult2.error! };
        let msg = `Result reported for ${params.nodeId}`;
        if (reportResult2.oldResult) msg += `\n⚠ Previous result overwritten: "${reportResult2.oldResult.slice(0, 80)}${reportResult2.oldResult.length > 80 ? '...' : ''}"`;
        return { data: msg };
      }
      case 'replace': {
        if (!treeId || !params.nodeId) return { data: 'Error: treeId, nodeId required for replace. No active tree. Use action:\'create\' first or pass treeId.' };
        const replaceResult = await treeLock.batch('TreeCmdTool', async () => {
          const tree = loadTree(treeId!);
          if (!tree) return { ok: false, error: `Tree ${treeId} not found`, replaced: null };
          const replaced = replaceSubtree(tree, params.nodeId!, params.meaning || 'replanned', params.task || 're-execute');
          if (!replaced) return { ok: false, error: `Replace failed: node ${params.nodeId} not found`, replaced: null };
          saveTree(tree);
          // 自动 WAL compaction
          try {
            const { readWal, compactWal, COMPACTION_THRESHOLD } = await import('../../../task_tree/wal.js');
            const entries = readWal(treeId!);
            if (entries.length >= COMPACTION_THRESHOLD) {
              compactWal(treeId!, tree);
            }
          } catch { /* 降级 */ }
          // WAL 记录
          try {
            const { appendWal } = await import('../../../task_tree/wal.js');
            appendWal(treeId!, params.nodeId!, 'subtree_replaced', {});
          } catch { /* 降级 */ }
          return { ok: true, error: null, replaced };
        });
        if (!replaceResult.ok) return { data: replaceResult.error! };
        return { data: `Subtree replaced at ${params.nodeId}. New meaning: "${params.meaning || 'replanned'}"` };
      }
      case 'get_leaves': {
        if (!treeId) return { data: `Error: treeId required. No active tree. Use action:'create' first or pass treeId.` };
        const tree = loadTree(treeId);
        if (!tree) return { data: `Tree ${treeId} not found` };
        const leaves = getExecutableLeaves(tree);
        return { data: `${leaves.length} executable leaves:\n${leaves.map(l => `  - ${l.id}: "${l.meaning}" role=${l.role} depth=${l.depth} task="${(l.task || '').slice(0, 100)}" [${l.status}]`).join('\n')}` };
      }
      case 'list': {
        const { readdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && existsSync(join(sessionDir(d.name), 'tree.json')))
          .map(d => d.name);
        return { data: dirs.length > 0
          ? `${dirs.length} tree(s):\n${dirs.map(d => `  - ${d}`).join('\n')}`
          : '(no saved trees)' };
      }
      case 'get_node': {
        if (!treeId || !params.nodeId) return { data: 'Error: treeId and nodeId required for get_node' };
        const tree = loadTree(treeId);
        if (!tree) return { data: `Tree ${treeId} not found` };
        const node = tree.nodes[params.nodeId];
        if (!node) return { data: `Node ${params.nodeId} not found` };
        return { data: [
          `Node: ${node.id}`,
          `  meaning: ${node.meaning}`,
          `  role: ${node.role} | depth: ${node.depth} | status: ${node.status}`,
          `  task: ${node.task}`,
          `  result: ${node.result || '(none)'}`,
          `  parentId: ${node.parentId || '(root)'}`,
          `  children: ${node.children.length > 0 ? node.children.join(', ') : '(none)'}`,
          `  replanCount: ${node.replanCount}`,
          `  touchedFiles: read=${node.touchedFiles.read.length}, written=${node.touchedFiles.written.length}`,
        ].join('\n') };
      }
      case 'delete_node': {
        if (!treeId || !params.nodeId) return { data: 'Error: treeId and nodeId required for delete_node' };
        // 用锁保护
        await treeLock.batch('TreeCmdTool', async () => {
          const tree = loadTree(treeId);
          if (!tree) return { data: `Tree ${treeId} not found` };
          const node = tree.nodes[params.nodeId!];
          if (!node) return { data: `Node ${params.nodeId} not found` };
          // 从父节点的 children 列表中移除
          if (node.parentId && tree.nodes[node.parentId]) {
            tree.nodes[node.parentId].children = tree.nodes[node.parentId].children.filter(c => c !== params.nodeId);
          }
          // 递归删除所有子孙
          const toDelete = [params.nodeId!];
          while (toDelete.length > 0) {
            const id = toDelete.shift()!;
            const n = tree.nodes[id];
            if (n) { toDelete.push(...n.children); delete tree.nodes[id]; }
          }
          tree.version++;
          saveTree(tree);
          // WAL 记录
          try {
            const { appendWal } = await import('../../../task_tree/wal.js');
            appendWal(treeId!, params.nodeId!, 'node_failed', { reason: 'deleted' });
          } catch { /* 降级 */ }
        });
        return { data: `Node ${params.nodeId} and its subtree deleted.` };
      }
      default:
        return { data: `Unknown action: ${(params as any).action}` };
    }
  },

  async prompt() { return '## TreeCmd\nManage task tree: create, add_child, status, report, replace, get_leaves, get_node, delete_node, list.'; },
  userFacingName: () => 'TreeCmd',
  getToolUseSummary({ action, meaning }: Partial<z.infer<typeof inputSchema>>) {
    return `TreeCmd: ${action}${meaning ? ` "${meaning}"` : ''}`;
  },
});
