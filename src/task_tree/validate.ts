/**
 * 任务树系统 — 校验与修复模块
 *
 * 所有函数纯操作内存对象，不写磁盘。单元测试友好（纯函数，无 I/O）。
 * 依赖：types.ts（类型定义）。
 */

import type {
  TaskDecomposition,
  DecompositionQualityReport,
  DecompositionResult,
  TaskTree,
  ReferenceCheck,
  TreeNode,
  NodeStatus,
} from './types.js';

// ---- 模块级闭包注入 ----

// getMember 闭包注入（由 Mycoder.ts 启动时设置）
let _getMember: ((id: string) => { status: string; output?: string } | undefined) | null = null;
export function setMemberGetter(fn: typeof _getMember) { _getMember = fn; }

// ---- 公开 API ----

/**
 * 计算两个字符串数组的 Jaccard 相似度。
 *
 * Jaccard = |A ∩ B| / |A ∪ B|，范围 [0, 1]。
 * **当并集大小为 0 时返回 0**（两个数组均为空），避免 NaN。
 *
 * @param a - 第一个字符串数组
 * @param b - 第二个字符串数组
 * @returns Jaccard 相似度，范围 [0, 1]
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);

  // 两个集合均为空 → 返回 0（避免 0/0 = NaN）
  if (setA.size === 0 && setB.size === 0) {
    return 0;
  }

  // 计算交集大小
  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionSize++;
    }
  }

  // 计算并集大小
  const union = new Set<string>();
  for (const item of setA) union.add(item);
  for (const item of setB) union.add(item);

  // 除零安全：理论上 unionSize > 0（因为上面已排除双空的情况）
  if (union.size === 0) {
    return 0;
  }

  return intersectionSize / union.size;
}

/**
 * 校验 LLM 产出的义群分解质量。
 *
 * 检查项：
 * 1. **交叉校验** — parallelism.independent 和 parallelism.sequential
 *    中引用的义群名必须在 groups 中存在，否则标记为 inconsistent。
 * 2. **过度分解检测** — 叶节点（isLeaf=true）的 context.files 为空视为
 *    过度分解；任意两个义群之间 Jaccard 相似度 > 0.8 标记为 warning。
 * 3. **数量检查** — groups 数量 > 8 标记为 warning。
 *
 * 当 overDecomposed、inconsistent、warnings 均为空时，passed = true。
 *
 * @param decomposition - LLM 产出的分解结果
 * @param parentContext - 父节点的 context（用于相似度比较）
 * @returns 分解质量报告
 */
export function validateDecomposition(
  decomposition: TaskDecomposition,
  parentContext: { files: string[]; concepts: string[] },
): DecompositionQualityReport {
  const overDecomposed: string[] = [];
  const inconsistent: string[] = [];
  const warnings: string[] = [];

  const { groups, parallelism } = decomposition;

  // 构建义群名集合（O(1) 查找）
  const groupNameSet = new Set(groups.map((g) => g.meaning));

  // ---- 1. 交叉校验：parallelism 引用的义群名必须在 groups 中存在 ----
  const allParallelNames: string[] = [
    ...parallelism.independent.flat(),
    ...parallelism.sequential.flat(),
  ];

  for (const name of allParallelNames) {
    if (!groupNameSet.has(name) && !inconsistent.includes(name)) {
      inconsistent.push(name);
    }
  }

  // ---- 2. 过度分解检测 ----

  // 2a. 叶节点 context.files 为空 → 过度分解
  for (const group of groups) {
    if (group.isLeaf && group.context.files.length === 0) {
      if (!overDecomposed.includes(group.meaning)) {
        overDecomposed.push(group.meaning);
      }
    }
  }

  // 2b. 义群两两之间的 Jaccard 相似度（基于 context.files）
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const sim = jaccardSimilarity(
        groups[i].context.files,
        groups[j].context.files,
      );
      if (sim > 0.8) {
        const msg =
          `高相似度 (${sim.toFixed(2)}) 在义群 "${groups[i].meaning}" ` +
          `和 "${groups[j].meaning}" 之间，可能存在过度分解`;
        if (!warnings.includes(msg)) {
          warnings.push(msg);
        }
      }
    }
  }

  // 2c. 义群与父 context 之间的 Jaccard 相似度
  for (const group of groups) {
    const sim = jaccardSimilarity(group.context.files, parentContext.files);
    if (sim > 0.8 && group.context.files.length > 0) {
      const msg =
        `义群 "${group.meaning}" 的 files 与父 context 高度重叠 ` +
        `(${(sim * 100).toFixed(0)}%)，可能未有效拆分`;
      if (!warnings.includes(msg)) {
        warnings.push(msg);
      }
    }
  }

  // ---- 3. 义群数量检查 ----
  if (groups.length > 8) {
    warnings.push(
      `义群数量 ${groups.length} 超过建议上限 8，可能分解过于细碎`,
    );
  }

  const passed =
    overDecomposed.length === 0 &&
    inconsistent.length === 0 &&
    warnings.length === 0;

  return { passed, overDecomposed, inconsistent, warnings };
}

/**
 * 遍历树中所有节点，检查 assignedAgentId 指向的 Agent 是否还存在。
 *
 * 通过闭包注入的 getMember 函数（由 setMemberGetter 设置）进行检查：
 * - **getMember 未注入**（null）：所有引用视为 valid
 * - **assignedAgentId 为 null**（未分配）：视为 valid
 * - **getMember 返回 undefined**：Agent 已消失 → stale
 * - **Agent 存在但节点 running 而 Agent 已 completed/failed**：状态不一致 → orphaned
 *
 * @param tree - 目标任务树
 * @returns 引用完整性检查结果
 */
export function validateReferences(tree: TaskTree): ReferenceCheck {
  let valid = 0;
  const stale: string[] = [];
  const orphaned: string[] = [];

  for (const node of Object.values(tree.nodes)) {
    // 未分配 Agent → valid
    if (node.assignedAgentId === null) {
      valid++;
      continue;
    }

    // getMember 未注入 → 所有引用视为 valid
    if (_getMember === null) {
      valid++;
      continue;
    }

    const member = _getMember(node.assignedAgentId);

    // Agent 不存在 → stale
    if (member === undefined) {
      stale.push(node.id);
      continue;
    }

    // Agent 存在但节点状态为 running 而 Agent 已进入终态 → orphaned
    if (
      node.status === 'running' &&
      (member.status === 'completed' ||
        member.status === 'failed' ||
        member.status === 'killed')
    ) {
      orphaned.push(node.id);
      continue;
    }

    valid++;
  }

  return { valid, stale, orphaned };
}

/**
 * 自动修复断裂的 Agent 引用。
 *
 * 遍历所有节点，对 **status === 'running'** 且 assignedAgentId 指向的
 * Agent 已不存在的节点进行修复：
 * - 将节点状态标记为 `failed`
 * - 在 result 中追加 `(agent lost)` 原因
 * - 将 assignedAgentId 置为 null
 *
 * **安全机制**：
 * - 仅修复 `running` 状态的节点（防止 completed → failed 的回退）
 * - 对其他状态（completed / failed / pending / blocked / killed）不做任何修改
 * - 如果 result 已有内容，追加 agent lost 信息而非覆盖
 *
 * @param tree - 目标任务树
 * @param getMember - agent_team 的成员查询函数
 * @returns 实际修复的节点数量
 */
export function repairStaleReferences(
  tree: TaskTree,
  getMember: (id: string) => { status: string } | undefined,
): number {
  let repairedCount = 0;

  for (const node of Object.values(tree.nodes)) {
    // 仅处理 running 状态的节点（防 completed → failed 回退）
    if (node.status !== 'running') {
      continue;
    }

    // 无分配 Agent → 跳过
    if (node.assignedAgentId === null) {
      continue;
    }

    const member = getMember(node.assignedAgentId);

    // Agent 仍然存在 → 跳过
    if (member !== undefined) {
      continue;
    }

    // Agent 不存在 → 修复
    const lostNote = '(agent lost)';
    node.status = 'failed';
    node.result = node.result
      ? `${node.result} ${lostNote}`
      : lostNote;
    node.assignedAgentId = null;
    repairedCount++;
  }

  // 更新树的时间戳和版本
  if (repairedCount > 0) {
    tree.updatedAt = Date.now();
    tree.version++;
  }

  return repairedCount;
}

/**
 * 当 agent_team 的 completeMember 被调用时，同步更新对应的树节点状态。
 *
 * 将 agent_team 的状态字符串映射为标准 NodeStatus：
 * - `success` → `completed`
 * - `error` / `crashed` / `max_rounds` → `failed`
 * - 直接匹配 NodeStatus → 原样使用
 * - 未知状态 → 保守默认为 `running`
 *
 * **设计要点**：
 * - 节点不存在时**静默跳过**（不抛异常），因为树可能已被重建
 * - 如果提供了 result 参数，同步更新 node.result
 * - 自动更新 tree.updatedAt 时间戳
 *
 * @param tree - 目标任务树
 * @param nodeId - 要同步的节点 ID
 * @param status - agent_team 上报的状态字符串
 * @param result - 可选的执行结果文本
 */
export function syncNodeFromMember(
  tree: TaskTree,
  nodeId: string,
  status: string,
  result?: string,
): void {
  const node = tree.nodes[nodeId];
  if (!node) {
    // 静默跳过：节点可能在恢复过程中已被移除
    return;
  }

  // 映射状态字符串到 NodeStatus
  node.status = mapAgentStatus(status);

  // 同步结果文本（仅在提供时覆盖）
  if (result !== undefined) {
    node.result = result;
  }

  tree.updatedAt = Date.now();
  tree.version++;
}

/**
 * 安全攻击检测结果。
 *
 * 当检测到可疑的重复模式时返回对应类型和详情。
 */
export interface SecurityAlert {
  type: 'jaccard_loop' | 'replan_exceeded' | 'empty_groups_repeated';
  detail: string;
}

/**
 * 带有校验与重试编排的义群分解入口。
 *
 * 不直接调用 LLM——它是一个纯校验编排函数。
 * 调用方负责：
 * 1. 传入 LLM 首先生成的 TaskDecomposition
 * 2. 提供 onRetryNeeded 回调，在验证失败时请求重试
 *
 * 流程：
 * - 最多 3 次尝试（首次 + 2 次重试）
 * - 每轮调用 validateDecomposition 检查质量
 * - passed 且无 warnings → 立即返回
 * - passed 但有 warnings → 仍然接受（警告不阻塞）
 * - 未通过 → 调用 onRetryNeeded 获取新 decomposition，继续循环
 * - 3 次尝试后仍未通过 → 返回 fallback 单义群
 *
 * @param decomposition - LLM 首先生成的分解
 * @param parentContext  - 父节点的 context
 * @param onRetryNeeded  - 验证失败时的重试回调，返回新的分解或 null（放弃重试）
 * @returns 分解结果（含尝试次数和是否 fallback）
 */
export async function decomposeWithValidation(
  decomposition: TaskDecomposition,
  parentContext: { files: string[]; concepts: string[] },
  onRetryNeeded: (report: DecompositionQualityReport) => Promise<TaskDecomposition | null>,
): Promise<DecompositionResult> {
  let current = decomposition;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const report = validateDecomposition(current, parentContext);
    if (report.passed && report.warnings.length === 0) {
      return { decomposition: current, attempts: attempt, fallback: false };
    }
    if (report.passed) {
      return { decomposition: current, attempts: attempt, fallback: false }; // 有警告但通过
    }
    if (attempt < 3) {
      const retry = await onRetryNeeded(report);
      if (retry) {
        current = retry;
        continue;
      }
    }
  }
  // fallback: 单义群
  const taskPrompt = parentContext.concepts.join(', ') || 'task';
  return {
    decomposition: {
      purpose: parentContext.concepts.join(', ') || 'task',
      parallelism: {
        independent: [],
        sequential: [[taskPrompt || 'fallback']],
        reason: 'fallback after failed validation',
      },
      groups: [
        {
          meaning: taskPrompt || 'fallback',
          context: parentContext,
          isLeaf: true,
        },
      ],
    },
    attempts: 3,
    fallback: true,
  };
}

/**
 * 检测安全攻击/异常模式。
 *
 * 在节点分解时调用，检查是否存在可疑的重复模式：
 * - **jaccard_loop**: Jaccard > 0.8 的过度分解连续出现 ≥ 3 次
 * - **empty_groups_repeated**: 所有义群 context.files 均为空连续出现 ≥ 3 次
 * - **replan_exceeded**: 由调用者在 core.ts 中检查 replanCount（此函数不递增）
 *
 * @param nodeId           - 当前节点 ID（用于日志上下文）
 * @param newDecomposition - 新生成的分解
 * @param parentContext    - 父节点的 context
 * @param history          - 历史统计（会被本函数原地修改）
 * @returns 检测到异常时返回 SecurityAlert，否则返回 null
 */
export function detectSecurityAnomaly(
  nodeId: string,
  newDecomposition: TaskDecomposition,
  parentContext: { files: string[]; concepts: string[] },
  history: { jaccardStreak: number; replanCount: number; emptyGroupStreak: number },
): SecurityAlert | null {
  const report = validateDecomposition(newDecomposition, parentContext);

  // Jaccard > 0.8 连续 3 次
  if (report.overDecomposed.length > 0) {
    history.jaccardStreak++;
    if (history.jaccardStreak >= 3) {
      return {
        type: 'jaccard_loop',
        detail: `Group over-decomposed ${history.jaccardStreak} consecutive times`,
      };
    }
  } else {
    history.jaccardStreak = 0;
  }

  // 空义群连续
  if (newDecomposition.groups.every((g) => g.context.files.length === 0)) {
    history.emptyGroupStreak++;
    if (history.emptyGroupStreak >= 3) {
      return {
        type: 'empty_groups_repeated',
        detail: `Empty groups ${history.emptyGroupStreak} consecutive times`,
      };
    }
  } else {
    history.emptyGroupStreak = 0;
  }

  // replanCount 由调用者检查（在 core.ts 中递增）
  return null;
}

// ---- 内部工具 ----

/** 有效的 NodeStatus 值集合（用于 O(1) 查表） */
const VALID_NODE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'blocked',
  'completed',
  'failed',
  'killed',
]);

/**
 * 将 agent_team 的状态字符串映射为 NodeStatus。
 *
 * 映射规则（按优先级）：
 * 1. 直接匹配 NodeStatus → 原样返回
 * 2. `success` → `completed`
 * 3. `error` / `crashed` / `max_rounds` → `failed`
 * 4. 未知状态 → `running`（保守默认值，避免错误地标记终态）
 *
 * @param status - agent_team 的状态字符串
 * @returns 对应的 NodeStatus
 */
function mapAgentStatus(status: string): NodeStatus {
  // 直接匹配 NodeStatus
  if (VALID_NODE_STATUSES.has(status)) {
    return status as NodeStatus;
  }

  // 常见映射
  switch (status) {
    case 'success':
      return 'completed';
    case 'error':
    case 'crashed':
    case 'max_rounds':
      return 'failed';
    default:
      // 保守默认值：未知状态视为 running，避免错误标记终态
      return 'running';
  }
}
