/**
 * 任务树系统 — 类型定义
 *
 * 所有共享类型集中在此文件，零逻辑，仅类型 + 接口。
 * 依赖：无（不 import 任何项目内模块，避免循环依赖）。
 */

// ---- 树节点 ----

/** Agent 在树中的角色 */
export type AgentRole = 'planner' | 'supervisor' | 'worker';

/** 树节点状态 */
export type NodeStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'killed';

/** 单个树节点 */
export interface TreeNode {
  id: string;
  parentId: string | null;        // null = 根节点
  meaning: string;                // 语义描述（"重构缓存逻辑"）
  context: {                       // LLM 预测的涉及范围
    files: string[];
    concepts: string[];
  };
  task: string;                   // 具体任务提示词
  role: AgentRole;
  status: NodeStatus;
  assignedAgentId: string | null;  // agent_team MemberState.id
  depth: number;                   // 根=0，每层+1
  maxRounds: number;
  tools: string[] | null;          // null = 用角色默认值
  result: string | null;
  replanCount: number;             // 重新分解次数
  children: string[];              // 子节点 ID 列表（冗余加速遍历）
  touchedFiles: {                  // 运行时追踪（Agent 实际操作的文件）
    read: string[];
    written: string[];
  };
}

/** 完整的任务树 */
export interface TaskTree {
  sessionId: string;
  rootId: string;
  nodes: Record<string, TreeNode>;  // 扁平 Map，O(1) 查找
  createdAt: number;
  updatedAt: number;
  version: number;
}

// ---- 义群分解 ----

/** 递归义群定义 */
export interface MeaningGroup {
  meaning: string;                 // 语义描述
  context: {                       // 涉及的文件/概念
    files: string[];
    concepts: string[];
  };
  subGroups?: MeaningGroup[];      // 子树（叶节点没有）
  isLeaf: boolean;                 // 是否不可再分
}

/** 一次 LLM 调用的结构化输出 */
export interface TaskDecomposition {
  purpose: string;                 // "重构 config.ts 缓存逻辑，测试，更新文档"
  parallelism: {                   // 时空并行性分析
    independent: string[][];       // 可并行执行的义群组
    sequential: string[][];        // 必须串行的义群组
    reason: string;                // 为什么这样分
  };
  groups: MeaningGroup[];          // 按动作划分的独立义群
}

// ---- 义群分解校验 ----

/** decomposeWithValidation 返回结构 */
export interface DecompositionResult {
  decomposition: TaskDecomposition;
  attempts: number;                // 实际尝试次数（1-3）
  fallback: boolean;               // 是否触发了 fallback 单义群
}

/** 分解质量报告 */
export interface DecompositionQualityReport {
  passed: boolean;
  overDecomposed: string[];        // 疑似过度拆分的义群 ID
  inconsistent: string[];          // purpose/parallelism/groups 不一致
  warnings: string[];
}

// ---- agentLoop 返回类型（替代裸 string）----

/** agentLoop 终止状态 */
export type LoopStatus = 'success' | 'max_rounds' | 'killed' | 'blocked' | 'crashed';

/** agentLoop 结构化返回值 */
export interface LoopResult {
  status: LoopStatus;
  text: string;
  blockedReason?: string;          // status='blocked' 时的阻塞原因
  roundCount?: number;             // 实际执行的轮次数
}

// ---- 依赖反转桥接（解决 task_tree ↔ agent_team 循环依赖）----

/**
 * task_tree 模块通过此接口访问 agent_team，不直接 import。
 * 由 Mycoder.ts 在启动时注入实现。
 */
export interface ITreeAgentBridge {
  getMember(id: string): { status: string; output?: string } | undefined;
  completeMember(id: string, output: string, role?: string): void;
  onTreeNodeSynced(nodeId: string, status: string, result?: string): void;
}

// ---- WAL 预写日志 ----

/** 单条 WAL 日志 */
export interface WalEntry {
  seq: number;                     // 单调递增序号
  ts: number;                      // 写入时间戳
  sessionId: string;
  nodeId: string;
  event: 'node_created' | 'node_dispatched' | 'node_completed' | 'node_failed'
       | 'node_blocked' | 'node_replanned' | 'child_added' | 'subtree_replaced' | 'children_all_done';
  payload: {
    agentId?: string;
    result?: string;
    reason?: string;
    oldChildren?: string[];
    newChildren?: string[];
    childId?: string;  // child_added 事件时记录新子节点 ID
  };
}

// ---- 持久化 ----

/** 增量变更（Delta） */
export interface TreeDelta {
  sessionId: string;
  version: number;                 // 基于哪个版本
  nodeUpdates: Partial<TreeNode>[];
  nodeDeletions: string[];
}

// ---- 文件追踪 ----

/** 单次文件操作记录 */
export interface FileOperation {
  nodeId: string;
  agentId: string;
  toolName: string;                // 'Read' | 'Write' | 'Edit' | 'Bash' | 'Grep' | 'Glob'
  filePath: string;
  operation: 'read' | 'written';
  timestamp: number;
}

/** 文件归属映射（文件追踪 + 文件锁共享数据源） */
export type FileOwnershipMap = Map<string, {
  agentId: string;
  nodeId: string;
  operation: 'read' | 'write';
}>;

/** 文件发散检测报告 */
export interface DivergenceReport {
  nodeId: string;
  predicted: string[];             // context.files（LLM 预测）
  actual: string[];                // touchedFiles（实际）
  missed: string[];                // 实际改了但预测没列出
  untouched: string[];             // 预测了但实际没碰
  isDivergent: boolean;
}

// ---- 引用验证 ----

/** 引用完整性检查结果 */
export interface ReferenceCheck {
  valid: number;
  stale: string[];                 // assignedAgentId 指向已消失 Agent 的节点
  orphaned: string[];              // Agent 存在但状态与节点不一致
}

/** 单节点状态检查结果 */
export interface NodeStatusCheck {
  nodeId: string;
  nodeStatus: NodeStatus;
  agentStatus: string | 'not_found';
  agentAlive: boolean;
  childrenSummary: string;
}

// ---- 会话恢复 ----

/** 恢复编排结果 */
export interface ResumeResult {
  resumedMessages: boolean;
  resumedTree: boolean;
  lostAgentsRecovered: number;
  summary: string;
}

// ---- Agent 元数据（注入 agentLoop）----

/** 当前 Agent 的树角色信息 */
export interface AgentMeta {
  depth: number;
  isLeaf: boolean;
}

// ---- 树事件（供 AgentTeamTool 消费）----

/** 树操作产生的通知事件 */
export type TreeEvent =
  | { type: 'node_completed'; nodeId: string; result: string }
  | { type: 'node_failed'; nodeId: string; reason: string }
  | { type: 'node_blocked'; nodeId: string; feedback: string }
  | { type: 'children_all_done'; nodeId: string }
  | { type: 'subtree_replaced'; nodeId: string; oldChildren: string[]; newChildren: string[] }
  | { type: 'tree_created'; sessionId: string; rootId: string };
