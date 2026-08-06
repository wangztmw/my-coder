/**
 * 任务树系统 — 级联终止模块
 *
 * 提供节点级联 kill、祖先存活检查、孤儿结果收集等功能。
 *
 * 设计原则：
 * - 函数参数注入：通过 CascadeBridge 访问 agent_team，避免循环依赖。
 * - 防单点阻塞：BFS 每层并发度 10，使用 Promise.allSettled 而非 Promise.all，
 *   单个节点 abort 失败不会阻塞同层其他节点。
 * - 同步操作优先：markNodeKill 为纯同步操作，无 I/O。
 */

import type { TaskTree, TreeNode, TreeEvent } from './types.js';

// ---- Agent 桥接接口 ----

/**
 * 级联终止所需的 Agent 桥接最小接口。
 *
 * 调用者（Mycoder.ts 或 orchestrator）注入实现，
 * 避免 cascade.ts 直接 import agent_team 造成循环依赖。
 */
export interface CascadeBridge {
  /** 根据 agentId 获取对应的 AbortController（用于 abort 正在运行的 Agent） */
  getAbortController(agentId: string): AbortController | undefined;

  /** 获取指定 Agent 的运行状态 */
  getMemberStatus(agentId: string): string | undefined;

  /** 获取指定 Agent 的输出文本 */
  getMemberOutput(agentId: string): string | undefined;
}

// ---- 导出函数 ----

/**
 * 标记单个节点为 killed 状态（同步操作，无 I/O）。
 *
 * 设置 status='killed'，写入 result 原因，清除 assignedAgentId。
 * 对于不存在的节点静默忽略。
 *
 * @param tree   - 任务树
 * @param nodeId - 要标记的节点 ID
 * @param reason - kill 原因，会写入 node.result
 */
export function markNodeKilled(
  tree: TaskTree,
  nodeId: string,
  reason: string,
): void {
  const node = tree.nodes[nodeId];
  if (!node) return;

  node.status = 'killed';
  node.result = `(killed: ${reason})`;
  node.assignedAgentId = null;
  tree.updatedAt = Date.now();
}

/**
 * 检查目标节点的祖先链上所有 Agent 是否仍然存活。
 *
 * 从 nodeId 开始，沿 parentId 链向上追溯直到根节点（parentId === null）。
 * 对每个祖先节点，通过 bridge 查询其 assignedAgentId 对应的 Agent 状态。
 * 如果任一祖先的 Agent 状态为 'completed' / 'failed' / 'killed' 或根本不存在，
 * 则认为该祖先已死。
 *
 * 典型调用场景：子 Agent 的 preRoundCheck —— 检查父节点 Agent 是否仍在运行，
 * 若父已死则子应自行终止。
 *
 * @param tree   - 任务树
 * @param nodeId - 起始节点 ID（从此节点向根追溯）
 * @param bridge - Agent 桥接对象（注入）
 * @returns true 表示所有祖先 Agent 仍在运行，false 表示至少有一个祖先已死
 */
export function isAncestorAlive(
  tree: TaskTree,
  nodeId: string,
  bridge: CascadeBridge,
): boolean {
  const deadStatuses = new Set<string>(['completed', 'failed', 'killed']);

  let current: TreeNode | undefined = tree.nodes[nodeId];
  if (!current) return false;

  // 从 nodeId 的父节点开始向上追溯（nodeId 自身不是"祖先"）
  let cursor: string | null = current.parentId;

  while (cursor !== null) {
    const ancestor = tree.nodes[cursor];
    if (!ancestor) {
      // 父节点 ID 存在但节点不在 nodes Map 中，视为数据不一致
      return false;
    }

    // 检查祖先节点状态：如果树内状态已经是终态，直接判定为死
    if (deadStatuses.has(ancestor.status)) {
      return false;
    }

    // 通过 bridge 检查祖先对应的 Agent 的实际运行状态
    if (ancestor.assignedAgentId) {
      const agentStatus = bridge.getMemberStatus(ancestor.assignedAgentId);
      // Agent 不存在或处于终态 → 祖先已死
      if (!agentStatus || deadStatuses.has(agentStatus)) {
        return false;
      }
    }

    cursor = ancestor.parentId;
  }

  return true;
}

/**
 * 收集已完成但父节点已死的孤儿子节点结果。
 *
 * 以 nodeId 为根遍历其整个子树（深度优先），
 * 收集所有 status === 'completed' 且 result 非空白的节点，
 * 为每个产出 `{ type: 'node_completed', nodeId, result }` 事件。
 *
 * 这些事件可供调用者注入到 Agent 通知队列中，
 * 避免已完成子节点的工作成果因父节点被杀而丢失。
 *
 * @param tree   - 任务树
 * @param nodeId - 子树的根节点 ID
 * @returns TreeEvent[] 孤儿节点完成事件列表
 */
export function collectOrphanedResults(
  tree: TaskTree,
  nodeId: string,
): TreeEvent[] {
  const events: TreeEvent[] = [];
  const root = tree.nodes[nodeId];
  if (!root) return events;

  // 深度优先遍历子树
  const stack: string[] = [nodeId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    const node = tree.nodes[currentId];
    if (!node) continue;

    // 收集已完成且有结果的节点
    if (node.status === 'completed' && node.result) {
      events.push({
        type: 'node_completed',
        nodeId: node.id,
        result: node.result,
      });
    }

    // 将子节点压入栈（DFS）
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }

  return events;
}

/**
 * 级联终止一个子树（BFS 层序遍历，每层最多 10 个并发 abort）。
 *
 * 算法：
 * 1. 从 nodeId 开始，使用 BFS 队列逐层处理。
 * 2. 每层节点以 Promise.allSettled 并发 abort，最多 10 个一批。
 * 3. 对层内每个节点：markNodeKilled → 通过 bridge 获取 AbortController →
 *    abort()（若存在）→ 将该节点的 children 加入下一层队列。
 * 4. 单个节点 abort 失败不阻塞同层其他节点（allSettled 而非 all）。
 * 5. 所有层处理完毕后 resolve。
 *
 * @param tree   - 任务树
 * @param nodeId - 要级联终止的子树根节点 ID
 * @param reason - kill 原因
 * @param bridge - Agent 桥接对象（注入）
 */
export async function cascadeKillTreeNode(
  tree: TaskTree,
  nodeId: string,
  reason: string,
  bridge: CascadeBridge,
): Promise<void> {
  const BATCH_SIZE = 10;

  // 防御：根节点不存在则直接返回
  if (!tree.nodes[nodeId]) return;

  // BFS 队列：当前层待处理的节点 ID 列表
  let currentLevel: string[] = [nodeId];

  while (currentLevel.length > 0) {
    const nextLevel: string[] = [];

    // 将当前层分批，每批最多 BATCH_SIZE 个
    const batches: string[][] = [];
    for (let i = 0; i < currentLevel.length; i += BATCH_SIZE) {
      batches.push(currentLevel.slice(i, i + BATCH_SIZE));
    }

    // 逐批并发处理当前层
    for (const batch of batches) {
      const tasks = batch.map((nid): Promise<void> => {
        return new Promise<void>((resolve) => {
          try {
            const node = tree.nodes[nid];
            if (!node) {
              resolve(); // 节点已不存在，跳过
              return;
            }

            // 1. 标记为 killed
            markNodeKilled(tree, nid, reason);

            // 2. 通过 bridge abort 正在运行的 Agent
            if (node.assignedAgentId) {
              const controller = bridge.getAbortController(node.assignedAgentId);
              if (controller) {
                try {
                  controller.abort();
                } catch {
                  // abort 可能因已 aborted 而抛出，忽略
                }
              }
            }

            // 3. 将子节点加入下一层队列
            for (const childId of node.children) {
              nextLevel.push(childId);
            }

            resolve();
          } catch {
            // 单个节点处理失败不影响同批次其他节点
            resolve();
          }
        });
      });

      // Promise.allSettled：单点失败不阻塞级联
      await Promise.allSettled(tasks);
    }

    currentLevel = nextLevel;
  }

  tree.updatedAt = Date.now();

  // 级联终止后重算 children_all_done
  try {
    const { checkChildrenAllDone } = require('./core.js');
    const { appendWal } = require('./wal.js');
    const parentId = tree.nodes[nodeId]?.parentId;
    if (parentId) {
      const readyParentId = checkChildrenAllDone(tree, parentId);
      if (readyParentId) {
        appendWal(tree.sessionId, readyParentId, 'children_all_done', {});
      }
    }
  } catch { /* 降级 */ }
}
