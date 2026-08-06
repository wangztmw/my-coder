/**
 * 文件追踪与文件锁模块
 *
 * 职责：
 * - 记录每个 Agent 操作了哪些文件（读/写）
 * - 将追踪数据合并写入 TreeNode.touchedFiles
 * - 检测 LLM 预测文件范围与实际操作范围的发散
 * - 提供基于文件所有权的轻量级写锁（纯内存，与文件追踪共享同一 Map）
 *
 * 设计要点：
 * - fileOwnershipMap 是文件追踪和文件锁的共享数据源
 * - acquireFileLock 只锁 write 操作，read 操作不冲突
 * - releaseFileLocks 在 Agent 完成/失败时由 AgentTool 调用
 * - 纯内存操作，无磁盘 I/O
 */

import type { FileOperation, FileOwnershipMap, DivergenceReport, TaskTree } from './types.js';

// ============================================================================
// 1. 全局 FileOwnershipMap（文件追踪 + 文件锁共享数据源）
// ============================================================================

/**
 * 全局文件归属映射。
 *
 * 键 = 文件路径（绝对路径），值 = 当前持有该文件锁的 Agent 信息。
 * 文件追踪和文件锁共享此数据源，避免两份独立 Map 产生不一致。
 */
export const fileOwnershipMap: FileOwnershipMap = new Map();

// ============================================================================
// 2. recordFileOps — 从工具调用提取文件路径并记录
// ============================================================================

/**
 * 从工具调用输入中提取文件路径并记录到 fileOwnershipMap。
 *
 * 规则：
 * - Read / Grep / Glob → operation = 'read'
 * - Write / Edit        → operation = 'write'
 * - Bash                → 跳过（太容易误判）
 *
 * 注意：如果同一文件已有 write 记录，read 操作不会覆盖它（写锁优先级更高）。
 *
 * @param nodeId  - 发起操作的树节点 ID
 * @param agentId - 执行操作的 Agent ID
 * @param toolName - 工具名称（'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob' | 'Bash'）
 * @param input   - 工具调用的 input 参数
 */
export function recordFileOps(
  nodeId: string,
  agentId: string,
  toolName: string,
  input: Record<string, unknown>,
): void {
  const filePath = extractFilePath(toolName, input);
  if (!filePath) return;

  const operation = classifyOperation(toolName);

  const existing = fileOwnershipMap.get(filePath);

  // 如果已有 write 记录，不要用 read 降级覆盖
  if (existing && existing.operation === 'write' && operation === 'read') {
    return;
  }

  fileOwnershipMap.set(filePath, { agentId, nodeId, operation });
}

/**
 * 从工具 input 中提取文件路径。
 *
 * - Read / Write / Edit：直接取 `input.file_path`
 * - Grep：取 `input.path`（搜索目录）
 * - Glob：取 `input.path` 或 `input.pattern`
 * - Bash：不提取，返回 null
 */
function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof input.file_path === 'string' ? input.file_path : null;

    case 'Grep':
      // Grep 的 path 是搜索目录，虽不是具体文件但仍是读操作的作用范围
      return typeof input.path === 'string' ? input.path : null;

    case 'Glob':
      // Glob 的 pattern 是匹配模式，path 是搜索根目录
      if (typeof input.path === 'string') return input.path;
      if (typeof input.pattern === 'string') return input.pattern;
      return null;

    case 'Bash':
      // Bash 不自动提取路径，命令内容太容易误判
      return null;

    default:
      return null;
  }
}

/**
 * 根据工具名判定操作类型。
 *
 * Read / Grep / Glob → 'read'
 * Write / Edit        → 'write'
 * 其他                → 'read'（保守默认）
 */
function classifyOperation(toolName: string): 'read' | 'write' {
  switch (toolName) {
    case 'Write':
    case 'Edit':
      return 'write';
    case 'Read':
    case 'Grep':
    case 'Glob':
      return 'read';
    default:
      // 未知工具保守视为 read，至少不会错误地阻塞写操作
      return 'read';
  }
}

// ============================================================================
// 3. flushFileOpsToNode — 将追踪数据合并写入 TreeNode
// ============================================================================

/**
 * 将 fileOwnershipMap 中属于指定 nodeId 的记录合并写入 tree.nodes[nodeId].touchedFiles。
 *
 * 去重：同一文件在同一操作类型（read / written）下只保留一条。
 * 不清除 fileOwnershipMap 中的条目（文件锁仍需要它们）。
 *
 * @param tree   - 任务树
 * @param nodeId - 要刷新的节点 ID
 * @returns 合并后的 { read: string[]; written: string[] }
 */
export function flushFileOpsToNode(
  tree: TaskTree,
  nodeId: string,
): { read: string[]; written: string[] } {
  const node = tree.nodes[nodeId];
  if (!node) {
    return { read: [], written: [] };
  }

  const readSet = new Set(node.touchedFiles.read);
  const writtenSet = new Set(node.touchedFiles.written);

  for (const [filePath, entry] of fileOwnershipMap) {
    if (entry.nodeId !== nodeId) continue;

    if (entry.operation === 'read') {
      readSet.add(filePath);
    } else {
      writtenSet.add(filePath);
    }
  }

  const read = Array.from(readSet);
  const written = Array.from(writtenSet);

  // 写回树节点
  node.touchedFiles = { read, written };

  return { read, written };
}

// ============================================================================
// 4. detectDivergence — 检测预测 vs 实际文件发散
// ============================================================================

/**
 * 比较 context.files（LLM 预测的涉及文件）和 touchedFiles（实际操作的文件），
 * 生成发散报告。
 *
 * - missed：实际改了但 LLM 没预测到的文件
 * - untouched：LLM 预测了但实际没碰的文件
 * - isDivergent：存在 missed 或 untouched 时为 true
 *
 * @param tree   - 任务树
 * @param nodeId - 要检测的节点 ID
 * @returns 发散检测报告
 */
export function detectDivergence(tree: TaskTree, nodeId: string): DivergenceReport {
  const node = tree.nodes[nodeId];

  if (!node) {
    return {
      nodeId,
      predicted: [],
      actual: [],
      missed: [],
      untouched: [],
      isDivergent: false,
    };
  }

  const predicted = node.context.files;
  const actual = [
    ...new Set([...node.touchedFiles.read, ...node.touchedFiles.written]),
  ];

  const predictedSet = new Set(predicted);
  const actualSet = new Set(actual);

  const missed = actual.filter((f) => !predictedSet.has(f));
  const untouched = predicted.filter((f) => !actualSet.has(f));

  return {
    nodeId,
    predicted,
    actual,
    missed,
    untouched,
    isDivergent: missed.length > 0 || untouched.length > 0,
  };
}

// ============================================================================
// 5. acquireFileLock — 尝试获取文件写锁
// ============================================================================

/**
 * 尝试获取一组文件的写锁。
 *
 * 规则：
 * - 只检查 write 操作冲突。read 操作不冲突（多个 Agent 可同时读）。
 * - 如果 fileOwnershipMap 中已有其他 agentId 的 write 记录 → 返回冲突。
 * - 同一 agentId 的已有记录不冲突（幂等）。
 * - 原子性：全部成功或全部失败，不存在部分锁定的中间状态。
 *
 * @param agentId - 请求锁的 Agent ID
 * @param files   - 要锁定的文件路径列表
 * @returns { ok: true } 或 { ok: false; conflictFile; heldBy }
 */
export function acquireFileLock(
  agentId: string,
  files: string[],
): { ok: true } | { ok: false; conflictFile: string; heldBy: string } {
  // 第一遍：检查全部文件是否可锁
  for (const file of files) {
    const existing = fileOwnershipMap.get(file);
    if (
      existing &&
      existing.operation === 'write' &&
      existing.agentId !== agentId
    ) {
      return { ok: false, conflictFile: file, heldBy: existing.agentId };
    }
  }

  // 第二遍：全部通过，写入锁记录
  for (const file of files) {
    // 保留已有 nodeId（如果同一 agentId 已持有 read 锁）
    const existing = fileOwnershipMap.get(file);
    const nodeId = existing?.nodeId ?? '';
    fileOwnershipMap.set(file, { agentId, nodeId, operation: 'write' });
  }

  return { ok: true };
}

// ============================================================================
// 6. releaseFileLocks — 释放 Agent 持有的所有文件锁
// ============================================================================

/**
 * 释放指定 Agent 持有的所有文件锁。
 *
 * 遍历 fileOwnershipMap，删除所有 agentId 匹配的条目。
 * 在 Agent 完成或失败时由 AgentTool 调用。
 *
 * @param agentId - 要释放锁的 Agent ID
 */
export function releaseFileLocks(agentId: string): void {
  for (const [filePath, entry] of fileOwnershipMap) {
    if (entry.agentId === agentId) {
      fileOwnershipMap.delete(filePath);
    }
  }
}

// ============================================================================
// 7. createFileTrackerHook — 创建 agentLoop 可用的钩子工厂
// ============================================================================

/**
 * 创建一个文件追踪钩子函数，供 agentLoop 在每次工具调用后使用。
 *
 * 返回的函数签名与 recordFileOps 兼容（省略 nodeId/agentId，
 * 因为它们在工厂调用时已闭包捕获）。
 *
 * 用法示例：
 * ```typescript
 * const fileTracker = createFileTrackerHook(nodeId, agentId);
 * // 在 agentLoop 工具调用后：
 * fileTracker('Write', { file_path: '/src/foo.ts' });
 * ```
 *
 * @param nodeId  - 当前树节点 ID
 * @param agentId - 当前 Agent ID
 * @returns (toolName, input) => void
 */
export function createFileTrackerHook(
  nodeId: string,
  agentId: string,
): (toolName: string, input: Record<string, unknown>) => void {
  return (toolName: string, input: Record<string, unknown>) => {
    recordFileOps(nodeId, agentId, toolName, input);
  };
}
