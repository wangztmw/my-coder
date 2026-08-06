/**
 * 任务树系统 — 会话恢复模块
 *
 * 启动时调用一次（在 Mycoder.ts main() 中），负责：
 * 1. 检测崩溃后丢失的 Agent（detectLostAgents）
 * 2. 统一恢复入口（resumeSessionOrchestrator）：
 *    loadTree → initWal → replayWal → detectLostAgents → saveTree
 *
 * 所有 I/O 操作均有 try-catch，异常不向上抛出让调用者崩溃。
 *
 * 依赖：types.ts（类型）、persist.ts（loadTree / saveTree）、wal.ts（initWal / replayWal）
 */

import type { ResumeResult, TaskTree } from './types.js';
import { loadTree, saveTree } from './persist.js';
import { initWal, replayWal } from './wal.js';
import { repairStaleReferences } from './validate.js';

// ---- detectLostAgents ----

/**
 * 检测并修复崩溃后丢失的 Agent。
 *
 * 遍历树中所有 status === 'running' 的节点，通过 getMember 查询其 assignedAgentId
 * 在 agent_team 注册表中的状态：
 *
 * - Agent 完全不存在（getMember 返回 undefined）
 *   → 标记为 failed，result = '(agent lost on crash)'，加入 recovered
 * - Agent 存在但已处于终态（completed / failed / killed 等），而树仍为 running
 *   → 同步状态与 result，加入 orphaned
 * - Agent 仍在运行中
 *   → 不做任何修改，保留 running 状态
 *
 * 本函数原地修改 tree 对象。
 *
 * @param tree      - 要检查的任务树（原地修改）
 * @param getMember - agent_team 注册表查询函数，按 Agent ID 返回 MemberState 的快照
 * @returns { recovered: 已修复（标 failed）的节点 ID, orphaned: 已同步终态的节点 ID }
 */
export function detectLostAgents(
  tree: TaskTree,
  getMember: (id: string) => { status: string; output?: string } | undefined,
): { recovered: string[]; orphaned: string[] } {
  const recovered: string[] = [];
  const orphaned: string[] = [];

  try {
    for (const nodeId of Object.keys(tree.nodes)) {
      const node = tree.nodes[nodeId];

      // 只检查正在运行的节点
      if (node.status !== 'running') continue;

      // 没有分配 Agent 的节点跳过（理论上不应该出现，但保守处理）
      if (!node.assignedAgentId) continue;

      const member = getMember(node.assignedAgentId);

      // ---- 情况 1：Agent 完全不存在 ----
      if (!member) {
        node.status = 'failed';
        node.result = '(agent lost on crash)';
        recovered.push(nodeId);
        console.warn(
          `[resume] 节点 "${node.meaning}" (${nodeId}) 的 Agent ${node.assignedAgentId} 已丢失，标记为 failed`,
        );
        continue;
      }

      // ---- 情况 2：Agent 存在，检查是否需要同步终态 ----
      const agentStatus = member.status.toLowerCase();

      // Agent 已成功完成
      if (['completed', 'success', 'finished', 'done'].includes(agentStatus)) {
        node.status = 'completed';
        node.result = member.output ?? node.result ?? '(completed)';
        orphaned.push(nodeId);
        console.log(
          `[resume] 节点 "${node.meaning}" (${nodeId}) 的 Agent 已完成，同步为 completed`,
        );
        continue;
      }

      // Agent 已失败 / 崩溃 / 被杀死
      if (['failed', 'error', 'crashed', 'killed'].includes(agentStatus)) {
        node.status = 'failed';
        node.result = member.output ?? '(agent terminated)';
        orphaned.push(nodeId);
        console.warn(
          `[resume] 节点 "${node.meaning}" (${nodeId}) 的 Agent 已终止 (${agentStatus})，同步为 failed`,
        );
        continue;
      }

      // 其他状态（如 'idle', 'running', 'pending' 等）→ Agent 仍在运行，保持不变
    }
  } catch (e) {
    console.error('[resume] detectLostAgents 执行出错:', e);
  }

  return { recovered, orphaned };
}

// ---- resumeSessionOrchestrator ----

/**
 * 统一会话恢复入口。
 *
 * 启动时调用一次，完整流程：
 *
 * 1. loadTree(sessionId) —— 加载全量快照
 * 2. 树不存在 → 返回 { resumedTree: false }，优雅退出
 * 3. initWal(sessionId) —— 初始化 WAL seq 计数器
 * 4. replayWal(sessionId, tree) —— 回放 WAL 增量日志到内存
 * 5. detectLostAgents(tree, getMember) —— 检测并修复崩溃丢失的 Agent
 * 6. saveTree(tree) —— 原子写回修复后的树
 * 7. 生成中文 human-readable summary
 *
 * 所有步骤独立 try-catch：某一步失败不阻止后续步骤（尽力恢复原则）。
 *
 * @param sessionId - 会话 ID
 * @param getMember - agent_team 注册表查询函数（由 ITreeAgentBridge 提供）
 * @returns ResumeResult，包含 resumedTree、lostAgentsRecovered 计数和中文摘要
 */
export function resumeSessionOrchestrator(
  sessionId: string,
  getMember: (id: string) => { status: string; output?: string } | undefined,
): ResumeResult {
  // ===== 步骤 1：加载全量快照 =====
  let tree: TaskTree | null;
  try {
    tree = loadTree(sessionId);
  } catch (e) {
    console.error(`[resume] loadTree 抛出异常: sessionId=${sessionId}`, e);
    return {
      resumedMessages: false,
      resumedTree: false,
      lostAgentsRecovered: 0,
      summary: `会话 ${sessionId} 的树文件加载异常`,
    };
  }

  // 树文件不存在 —— 全新会话，无需恢复
  if (!tree) {
    return {
      resumedMessages: false,
      resumedTree: false,
      lostAgentsRecovered: 0,
      summary: `会话 ${sessionId} 的树文件不存在，视为全新会话`,
    };
  }

  // ===== 步骤 2：初始化 WAL 并回放 =====
  try {
    initWal(sessionId);
    tree = replayWal(sessionId, tree);
  } catch (e) {
    console.error(`[resume] WAL 初始化/回放失败: sessionId=${sessionId}`, e);
    // 不回退 —— WAL 回放失败时以全量快照为基准继续
  }

  // ===== 步骤 3：检测丢失的 Agent =====
  let recovered: string[] = [];
  let orphaned: string[] = [];
  try {
    const result = detectLostAgents(tree, getMember);
    recovered = result.recovered;
    orphaned = result.orphaned;
  } catch (e) {
    console.error(`[resume] detectLostAgents 抛出异常: sessionId=${sessionId}`, e);
    // detectLostAgents 内部已有 try-catch，此处为双重保险
  }

  // ===== 步骤 3.5：修复陈旧引用 =====
  let repairedCount = 0;
  try {
    repairedCount = repairStaleReferences(tree, getMember);
  } catch { /* 降级 */ }

  // ===== 步骤 4：写回修复后的树 =====
  try {
    saveTree(tree);
  } catch (e) {
    console.error(`[resume] saveTree 失败: sessionId=${sessionId}`, e);
    // 写回失败不影响摘要生成 —— 内存中的树已是修复后的状态
  }

  // 崩溃恢复后重算 children_all_done
  try {
    const { checkChildrenAllDone } = require('./core.js');
    const { appendWal } = require('./wal.js');
    for (const [nodeId, node] of Object.entries(tree.nodes)) {
      if (node.children.length > 0) {
        const readyParentId = checkChildrenAllDone(tree, nodeId);
        if (readyParentId) {
          appendWal(tree.sessionId, readyParentId, 'children_all_done', {});
        }
      }
    }
  } catch { /* 降级 */ }

  // ===== 步骤 5：生成中文摘要 =====
  const parts: string[] = [];

  // 节点总数
  const nodeCount = Object.keys(tree.nodes).length;
  parts.push(`树已恢复，共 ${nodeCount} 个节点`);

  // 状态分布
  const statusCounts: Record<string, number> = {};
  for (const n of Object.values(tree.nodes)) {
    statusCounts[n.status] = (statusCounts[n.status] || 0) + 1;
  }
  const statusEntries = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1]) // 按数量降序
    .map(([status, count]) => `${status}:${count}`);
  if (statusEntries.length > 0) {
    parts.push(`状态分布 [${statusEntries.join(', ')}]`);
  }

  // WAL 回放信息
  // （replayWal 是纯内存操作，不返回回放条目数；此处仅记录是否有 WAL）
  // 我们通过节点状态间接说明

  // 丢失 Agent 恢复
  if (recovered.length > 0) {
    parts.push(`恢复丢失 Agent: ${recovered.length} 个节点已标记失败`);
  }

  // 孤儿节点同步
  if (orphaned.length > 0) {
    parts.push(`同步孤儿节点: ${orphaned.length} 个节点状态已对齐`);
  }

  if (repairedCount > 0) {
    parts.push(`修复陈旧引用: ${repairedCount} 个节点`);
  }

  const summary = parts.join('；') + '。';

  return {
    resumedMessages: false,
    resumedTree: true,
    lostAgentsRecovered: recovered.length + orphaned.length,
    summary,
  };
}
