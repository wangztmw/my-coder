/**
 * 任务树系统 — 基础 CRUD 操作模块
 *
 * 所有函数纯操作内存中的 TaskTree 对象，不直接写磁盘。
 * 调用者负责在外部包 TreeWriteLock + saveTree 持久化。
 * 依赖：types.ts（类型定义）。
 */

import type {
  TreeNode,
  TaskTree,
  NodeStatus,
  NodeStatusCheck,
  TreeEvent,
} from './types.js';
import type { AgentRole } from './types.js';

// ---- 常量 ----

/** 单棵树最大节点数 */
const MAX_NODES = 50;

/** 状态 → 渲染符号映射 */
const STATUS_SYMBOLS: Record<NodeStatus, string> = {
  pending: '◌',   // ◌
  running: '●',   // ●
  blocked: '⊘',   // ⊘
  completed: '✓', // ✓
  failed: '✗',    // ✗
  killed: '☠',    // ☠
};

// ---- 内部工具 ----

let _idSeq = 0;

/**
 * 生成唯一节点 ID。
 * 格式：<timestamp36>-<seq36>-<random6>
 */
function genId(): string {
  const ts = Date.now().toString(36);
  const seq = (_idSeq++).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${seq}-${rand}`;
}

/**
 * 收集指定节点子树中所有节点 ID（不含自身）。
 * 使用 BFS 迭代 + visited Set，防循环引用。
 */
function collectDescendantIds(tree: TaskTree, nodeId: string): string[] {
  const visited = new Set<string>([nodeId]);
  const queue: string[] = [];
  const result: string[] = [];

  const startNode = tree.nodes[nodeId];
  if (!startNode) return result;

  for (const childId of startNode.children) {
    queue.push(childId);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);

    const node = tree.nodes[id];
    if (node && node.children.length > 0) {
      for (const childId of node.children) {
        if (!visited.has(childId)) queue.push(childId);
      }
    }
  }

  return result;
}

// ---- 公开 API ----

/**
 * 创建一棵全新的任务树，含单一根节点。
 *
 * @param sessionId - 所属会话 ID
 * @param rootMeaning - 根节点语义描述
 * @returns 初始化完成的 TaskTree
 */
export function createTree(sessionId: string, rootMeaning: string): TaskTree {
  const rootId = genId();
  const now = Date.now();

  const rootNode: TreeNode = {
    id: rootId,
    parentId: null,
    meaning: rootMeaning,
    context: { files: [], concepts: [] },
    task: '',
    role: 'planner',
    status: 'pending',
    assignedAgentId: null,
    depth: 0,
    maxRounds: 10,
    tools: null,
    result: null,
    replanCount: 0,
    children: [],
    touchedFiles: { read: [], written: [] },
  };

  const tree: TaskTree = {
    sessionId,
    rootId,
    nodes: { [rootId]: rootNode },
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  return tree;
}

/**
 * 向指定父节点添加一个子节点。
 *
 * 硬限制：树内节点总数达到 MAX_NODES（50）时返回 null，
 * 避免单棵树无限膨胀。调用者应检查返回值并做降级处理。
 *
 * @param tree - 目标任务树
 * @param parentId - 父节点 ID
 * @param opts - 新节点配置
 * @param opts.meaning - 语义描述
 * @param opts.task - 具体任务提示词
 * @param opts.role - Agent 角色
 * @param opts.context - LLM 预测的涉及范围（可选）
 * @returns 新创建的 TreeNode，或超限时返回 null
 */
export function addChildNode(
  tree: TaskTree,
  parentId: string,
  opts: {
    meaning: string;
    task: string;
    role: AgentRole;
    context?: { files: string[]; concepts: string[] };
  },
): TreeNode | null {
  // 硬限制检查
  if (Object.keys(tree.nodes).length >= MAX_NODES) {
    return null;
  }

  const parent = tree.nodes[parentId];
  if (!parent) {
    return null;
  }

  // 拒绝向终态节点添加子节点
  if (parent.status === 'completed' || parent.status === 'failed' || parent.status === 'killed') {
    return null; // 父节点已终结，不可再添加子节点
  }

  const childId = genId();
  const child: TreeNode = {
    id: childId,
    parentId,
    meaning: opts.meaning,
    context: opts.context ?? { files: [], concepts: [] },
    task: opts.task,
    role: opts.role,
    status: 'pending',
    assignedAgentId: null,
    depth: parent.depth + 1,
    maxRounds: 10,
    tools: null,
    result: null,
    replanCount: 0,
    children: [],
    touchedFiles: { read: [], written: [] },
  };

  // 写入扁平 Map
  tree.nodes[childId] = child;

  // 更新父节点 children 列表
  parent.children.push(childId);

  // 更新时间戳与版本
  tree.updatedAt = Date.now();
  tree.version++;

  return child;
}

/**
 * 替换指定节点的子树：删除旧子孙节点，重置节点属性，保留 id/parentId/depth。
 *
 * **调用者必须在调用前 cascadeKill 旧子树中的 Agent**，
 * 本函数仅操作内存中的树结构，不处理 Agent 生命周期。
 *
 * @param tree - 目标任务树
 * @param nodeId - 要被替换的节点 ID
 * @param newMeaning - 新的语义描述
 * @param newTask - 新的任务提示词
 * @returns 替换后的节点，若 nodeId 不存在则返回 null
 */
export function replaceSubtree(
  tree: TaskTree,
  nodeId: string,
  newMeaning: string,
  newTask: string,
): TreeNode | null {
  const node = tree.nodes[nodeId];
  if (!node) {
    return null;
  }

  // 1. 收集并删除所有子孙节点
  const descendantIds = collectDescendantIds(tree, nodeId);
  for (const descId of descendantIds) {
    delete tree.nodes[descId];
  }

  // 2. 重置节点属性
  node.meaning = newMeaning;
  node.task = newTask;
  node.status = 'pending';
  node.assignedAgentId = null;
  node.result = null;
  node.replanCount = 0;
  node.children = [];
  node.context = { files: [], concepts: [] };
  node.touchedFiles = { read: [], written: [] };

  // 3. 标记版本
  tree.updatedAt = Date.now();
  tree.version++;

  return node;
}

/**
 * 派发节点到指定 Agent：标记 status='running' 并记录 assignedAgentId。
 *
 * 调用者应确保节点当前处于可派发状态（pending），本函数不做前置校验。
 *
 * @param tree - 目标任务树
 * @param nodeId - 节点 ID
 * @param agentId - Agent 标识（agent_team MemberState.id）
 */
export function dispatchNode(
  tree: TaskTree,
  nodeId: string,
  agentId: string,
): void {
  const node = tree.nodes[nodeId];
  if (!node) return;

  node.status = 'running';
  node.assignedAgentId = agentId;
  tree.updatedAt = Date.now();
}

/**
 * 检查节点的所有子节点是否都处于终态（completed/failed/killed）。
 * 如果是 → 返回 parentId 供调用者进一步处理（配合 WAL 事件传播）。
 * 如果否 → 返回 null。
 *
 * 不会自动修改节点状态——仅返回信号。调用者负责决定是否标记 ready 或继续向上传播。
 */
export function checkChildrenAllDone(tree: TaskTree, nodeId: string): string | null {
  if (process.env.DISABLE_CHILDREN_ALL_DONE === '1') return null;
  const node = tree.nodes[nodeId];
  if (!node || node.children.length === 0) return null;

  const allDone = node.children.every(cid => {
    const c = tree.nodes[cid];
    return c && (c.status === 'completed' || c.status === 'failed' || c.status === 'killed');
  });

  if (!allDone) return null;

  // 找到父节点
  if (!node.parentId) return nodeId; // 根节点 → 返回自己（整棵树完成）

  const parent = tree.nodes[node.parentId];
  if (!parent) return null;

  // 父节点已经是终态 → 不重复触发
  if (parent.status === 'completed' || parent.status === 'failed' || parent.status === 'killed') return null;

  return node.parentId;
}

/**
 * 汇报节点执行结果。
 *
 * @param tree - 目标任务树
 * @param nodeId - 节点 ID
 * @param result - 结果文本
 * @param status - 终态：'completed' 或 'failed'
 */
export function reportResult(
  tree: TaskTree,
  nodeId: string,
  result: string,
  status: 'completed' | 'failed',
): void {
  const node = tree.nodes[nodeId];
  if (!node) return;

  node.result = result;
  node.status = status;
  tree.updatedAt = Date.now();
  tree.version++;

  // 检查 children_all_done 传播
  const readyParentId = checkChildrenAllDone(tree, nodeId);
  if (readyParentId) {
    try {
      const { appendWal } = require('./wal.js');
      appendWal(tree.sessionId, readyParentId, 'children_all_done', {});
    } catch { /* wal 不可用则跳过 */ }
    // 递归向上
    let current: string | null = readyParentId;
    while (current) {
      const next = checkChildrenAllDone(tree, current);
      if (!next) break;
      try {
        const { appendWal } = require('./wal.js');
        appendWal(tree.sessionId, next, 'children_all_done', {});
      } catch {}
      current = (next !== current) ? next : '';
    }
  }
}

/**
 * 检查指定节点子树的完整状态，返回每个节点的状态快照。
 *
 * **使用 visited Set + BFS 队列迭代，绝不用递归**，防止循环引用导致栈溢出。
 * 适用于大子树或存在异常引用结构的场景。
 *
 * @param tree - 目标任务树
 * @param nodeId - 子树根节点 ID
 * @returns 子树内所有节点的状态检查结果数组
 */
export function checkSubtreeStatus(
  tree: TaskTree,
  nodeId: string,
): NodeStatusCheck[] {
  const results: NodeStatusCheck[] = [];
  const visited = new Set<string>();
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const node = tree.nodes[currentId];
    if (!node) continue;

    // 汇总子节点状态
    let completedCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    let pendingCount = 0;

    for (const childId of node.children) {
      const child = tree.nodes[childId];
      if (!child) continue;
      switch (child.status) {
        case 'completed':
          completedCount++;
          break;
        case 'failed':
          failedCount++;
          break;
        case 'running':
          runningCount++;
          break;
        case 'pending':
          pendingCount++;
          break;
      }
    }

    const childrenSummary =
      `${completedCount}C/${failedCount}F/${runningCount}R/${pendingCount}P`;

    results.push({
      nodeId: currentId,
      nodeStatus: node.status,
      agentStatus: node.assignedAgentId ? 'assigned' : 'not_found',
      agentAlive: node.assignedAgentId !== null,
      childrenSummary,
    });

    // 将子节点加入 BFS 队列
    for (const childId of node.children) {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return results;
}

/**
 * 获取所有可立即执行的叶节点。
 *
 * 可执行条件：
 * 1. 节点自身 status === 'pending'
 * 2. 从根到父节点的所有祖先 status 均为 'completed' 或 'running'
 * 3. 节点没有子节点（children 为空数组）
 *
 * @param tree - 目标任务树
 * @returns 可执行叶节点列表
 */
export function getExecutableLeaves(tree: TaskTree): TreeNode[] {
  const result: TreeNode[] = [];

  for (const node of Object.values(tree.nodes)) {
    // 条件 1：自身 pending
    if (node.status !== 'pending') continue;

    // 条件 3：是叶节点（无子节点）
    if (node.children.length > 0) continue;

    // 条件 2：所有祖先 completed 或 running
    if (!allAncestorsPassed(tree, node)) continue;

    result.push(node);
  }

  return result;
}

/**
 * 检查节点的所有祖先是否均处于 completed 或 running 状态。
 * 从父节点向上追溯到根，遇到 pending / blocked / failed / killed 则返回 false。
 */
function allAncestorsPassed(tree: TaskTree, node: TreeNode): boolean {
  let currentId: string | null = node.parentId;

  while (currentId !== null) {
    const ancestor = tree.nodes[currentId];
    if (!ancestor) return false;

    if (ancestor.status !== 'completed' && ancestor.status !== 'running') {
      return false;
    }

    currentId = ancestor.parentId;
  }

  return true;
}

/**
 * 将任务树渲染为 ASC-II 树状图字符串，供 `mycoder tree` 命令展示。
 *
 * 输出格式示例：
 * ```
 * ● 重构 config.ts 缓存逻辑 [running]
 *    ├─ ✓ 调研引用点 [completed]
 *    │     ├─ ✓ Grep loadConfig [completed]
 *    │     └─ ✓ Grep saveConfig [completed]
 *    ├─ ◌ 改saveConfig [pending]
 *    └─ ✗ 编译验证 [failed]
 * ```
 *
 * @param tree - 目标任务树
 * @returns 多行树状图字符串
 */
export function renderTree(tree: TaskTree): string {
  const root = tree.nodes[tree.rootId];
  if (!root) return '(empty tree)';

  return renderNode(tree, root.id, '', true, true);
}

/**
 * 递归渲染单个节点及其子树。
 *
 * 每个节点自己负责输出本行内容，并驱动所有子节点递归渲染自身。
 * 子节点通过 `prefix + 延续符` 获得正确的缩进层级。
 *
 * @param tree - 任务树
 * @param nodeId - 当前节点 ID
 * @param prefix - 行前缀（祖先层级累积的缩进符号，不含当前层的分支符）
 * @param isLast - 当前节点是否为父节点的最后一个子节点（决定分支符是 └─ 还是 ├─）
 * @param isRoot - 是否为根节点（根节点不画分支线，且其子节点以 3 空格起始缩进）
 */
function renderNode(
  tree: TaskTree,
  nodeId: string,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
): string {
  const node = tree.nodes[nodeId];
  if (!node) return '';

  const symbol = STATUS_SYMBOLS[node.status] ?? '?';
  const statusTag = `[${node.status}]`;

  // 构建当前行
  let line: string;
  if (isRoot) {
    line = `${symbol} ${node.meaning} ${statusTag}`;
  } else {
    const branch = isLast ? '└─ ' : '├─ ';
    line = `${prefix}${branch}${symbol} ${node.meaning} ${statusTag}`;
  }

  const children = node.children.filter((cid) => tree.nodes[cid] != null);
  if (children.length === 0) return line;

  // 递归渲染子节点（每个子节点自己负责输出完整行）
  const allLines = [line];
  for (let i = 0; i < children.length; i++) {
    const childId = children[i];
    const childIsLast = i === children.length - 1;

    // 子节点的 prefix：根节点的子节点以 3 空格起始；非根节点继承 prefix 并追加延续符
    const childPrefix = isRoot
      ? '   '
      : prefix + (isLast ? '   ' : '│  ');

    allLines.push(renderNode(tree, childId, childPrefix, childIsLast, false));
  }

  return allLines.join('\n');
}
