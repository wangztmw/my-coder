/**
 * 任务树上下文工具 — 纯函数，无 I/O
 *
 * 提供结果写入、摘要生成、格式化输出等辅助函数。
 * 所有函数不依赖文件系统、网络或全局状态。
 */

import type { TaskTree, TreeNode, NodeStatus } from './types.js';

// ---- 截断 ----

/**
 * 按词数截断文本。
 *
 * 当文本词数超过 maxWords 时，保留前 maxWords 个词并在末尾追加 ` (truncated)`。
 * 不超限时原样返回。空字符串直接返回空字符串。
 *
 * @param text  原始文本
 * @param maxWords  最大保留词数
 * @returns 截断后的文本
 */
export function truncateToWordLimit(text: string, maxWords: number): string {
  if (!text) return '';
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + ' (truncated)';
}

// ---- 结果写入 ----

/**
 * 按角色截断结果并写入节点。
 *
 * 不同角色有不同的上下文长度限制：
 * - `'worker'` → 300 词（用 truncateToWordLimit）
 * - `'supervisor'` → 2000 字符
 * - `'planner'` → 5000 字符
 *
 * 同时更新 `tree.updatedAt` 为当前时间戳，`tree.version` 自增 1。
 * 若 nodeId 不存在则静默忽略。
 *
 * @param tree   目标任务树（原地修改）
 * @param nodeId 目标节点 ID
 * @param raw    原始结果文本
 * @param role   节点角色
 */
export function setNodeResult(
  tree: TaskTree,
  nodeId: string,
  raw: string,
  role: string,
): void {
  const node = tree.nodes[nodeId];
  if (!node) return;

  switch (role) {
    case 'worker':
      node.result = truncateToWordLimit(raw, 300);
      break;
    case 'supervisor':
      node.result = raw.length > 2000 ? raw.slice(0, 2000) + ' (truncated)' : raw;
      break;
    case 'planner':
      node.result = raw.length > 5000 ? raw.slice(0, 5000) + ' (truncated)' : raw;
      break;
    default:
      node.result = raw;
  }

  tree.updatedAt = Date.now();
  tree.version += 1;
}

// ---- 状态图标 ----

/**
 * 将节点状态映射为单字符图标。
 *
 * | 状态       | 图标 |
 * |-----------|------|
 * | pending   | ◌    |
 * | running   | ●    |
 * | blocked   | ⊘    |
 * | completed | ✓    |
 * | failed    | ✗    |
 * | killed    | ☠    |
 *
 * @param status 节点状态
 * @returns 对应的单字符图标
 */
export function statusIcon(status: NodeStatus): string {
  const map: Record<NodeStatus, string> = {
    pending: '◌',    // ◌
    running: '●',    // ●
    blocked: '⊘',    // ⊘
    completed: '✓',  // ✓
    failed: '✗',     // ✗
    killed: '☠',     // ☠
  };
  return map[status];
}

// ---- 单行格式化 ----

/**
 * 将节点格式化为单行摘要字符串。
 *
 * 格式：`[图标] meaning — result前60字符预览`
 * 输出保证不超过 120 字符（超出部分截断加 `…`）。
 * result 为 null 时省略预览部分。
 *
 * @param node 树节点
 * @returns 单行格式化字符串
 */
export function formatNodeLine(node: TreeNode): string {
  const icon = statusIcon(node.status);
  const preview = node.result
    ? node.result.replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';

  let line: string;
  if (preview) {
    line = `${icon} ${node.meaning} — ${preview}`;
  } else {
    line = `${icon} ${node.meaning}`;
  }

  if (line.length > 120) {
    line = line.slice(0, 119) + '…'; // … (U+2026)
  }

  return line;
}

// ---- 层次化摘要 ----

/**
 * 生成子树的结构化摘要。
 *
 * 三种深度模式：
 * - `'leaf'` — 仅返回该节点一行（调用 formatNodeLine）
 * - `'branch'` — 返回该节点一行 + 每个直接子节点一行（不递归展开孙子节点）
 * - `'all'` — 完全递归展开整棵子树，每层缩进 2 空格
 *
 * 若 nodeId 不存在则返回空字符串。
 *
 * @param tree   任务树
 * @param nodeId 起始节点 ID
 * @param depth  展开深度
 * @returns 多行摘要字符串
 */
export function summarizeSubtree(
  tree: TaskTree,
  nodeId: string,
  depth: 'branch' | 'leaf' | 'all',
): string {
  const node = tree.nodes[nodeId];
  if (!node) return '';

  const lines: string[] = [];
  lines.push(formatNodeLine(node));

  if (depth === 'leaf') return lines[0];

  // branch 或 all：添加直接子节点
  for (const childId of node.children) {
    const child = tree.nodes[childId];
    if (!child) continue;

    if (depth === 'branch') {
      lines.push('  ' + formatNodeLine(child));
    } else {
      // depth === 'all'：递归展开
      const childSummary = summarizeSubtree(tree, childId, 'all');
      const indented = childSummary
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n');
      lines.push(indented);
    }
  }

  return lines.join('\n');
}
