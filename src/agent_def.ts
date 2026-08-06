/**
 * Agent 引擎定义 — 类型、类、LLM调用、通知、工具合并
 *
 * 执行循环 agentLoop() 在 session_loop.ts 中。
 */
import type { Tool, Tools, ToolUseContext } from './tools-v2/core/Tool.js';
import type { LLMProvider, ChatMessage } from './llm/types.js';
import type { MemberState } from './agent_team.js';
import { loadMemory } from './config.js';
import { ConcurrencyLimiter } from './llm/concurrency.js';

// ---- 进度事件类型 ----

export interface ToolCall {
  name: string;
  id: string;
  input: Record<string, unknown>;
  output: string;
}

export interface MergedTool {
  name: string;
  count: number;
  inputs: string[];
  lines: number;
  sample: string;
}

export type ProgressEvent =
  | { type: 'thinking_start'; label: string }
  | { type: 'thinking_tick'; label: string; elapsedMs: number }
  | { type: 'thinking_end'; label: string; elapsedMs: number; toolCount: number }
  | { type: 'tool_display'; calls: MergedTool[] }
  | { type: 'thought'; text: string }
  | { type: 'error'; message: string };

/** Agent 执行结果 */
export interface AgentResult {
  text: string;
  ms: number;
}

// ---- 工具函数 ----

export function briefResult(data: string): string {
  const firstLine = data.split('\n')[0].slice(0, 80);
  return firstLine.length < data.length ? firstLine + '...' : firstLine;
}

export const SUB_AGENT_PROMPT = 'You are a sub-agent. Complete the assigned task using the available tools. If web tools (WebSearch/WebFetch) fail 2+ times, stop using them and rely on your existing knowledge. Do not keep retrying failed network calls. Return a concise report — prioritize completing quickly over exhaustive searching. Do not ask questions.';

// ---- 引擎类 ----

export class AgentEngine {
  private provider: LLMProvider;
  private tools: Tools;
  private toolMap: Map<string, Tool>;
  private toolContext: ToolUseContext;
  private apiKey: string;
  private model: string;
  private openaiBase: string;
  private systemPrompt: string;

  sessionMessages: ChatMessage[] = [];
  pendingNotifications: Array<{ role: string; content: string }> = [];
  onTurnComplete?: (messages: ChatMessage[], toolCount: number) => void;
  private llmLimiter = new ConcurrencyLimiter(3);

  // ★ 任务树感知
  activeTreeId: string | null = null;
  activeTreeNodeId: string | null = null;
  setActiveTree(treeId: string, nodeId?: string): void {
    this.activeTreeId = treeId;
    this.activeTreeNodeId = nodeId || null;
  }
  getTreeContext(): string | null {
    if (!this.activeTreeId) return null;
    try {
      const { loadTree } = require('./task_tree/persist.js');
      const { renderTree } = require('./task_tree/core.js');
      const tree = loadTree(this.activeTreeId);
      if (!tree) return null;
      return renderTree(tree);
    } catch { return null; }
  }

  team: Map<string, MemberState>;
  addMember: (type: 'local_agent' | 'local_bash', subject: string, desc?: string) => MemberState;
  completeMember: (id: string, output: string) => void;
  notify: (msg: string) => void;

  constructor(
    provider: LLMProvider,
    tools: Tools,
    config: { apiKey: string; model: string; openaiBase: string; llmMaxConcurrency?: number },
    deps: {
      teamReg: Map<string, MemberState>;
      addMember: (type: 'local_agent' | 'local_bash', subject: string, desc?: string) => MemberState;
      completeMember: (id: string, output: string) => void;
    },
  ) {
    this.provider = provider;
    this.tools = tools;
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolContext = {
      options: { tools, verbose: false, isNonInteractiveSession: false, mainLoopModel: config.model, debug: false, engine: this },
      abortController: new AbortController(),
    };
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.openaiBase = config.openaiBase;
    if (config.llmMaxConcurrency) this.llmLimiter = new ConcurrencyLimiter(config.llmMaxConcurrency);
    this.team = deps.teamReg;
    this.addMember = deps.addMember;
    this.completeMember = deps.completeMember;
    this.notify = (msg: string) => { this.pendingNotifications.push({ role: 'user', content: msg }); };
    this.systemPrompt = this.buildSystemPrompt();
  }

  // ---- System Prompt ----

  buildSystemPrompt(role?: 'planner' | 'supervisor' | 'worker'): string {
    const now = new Date().toISOString().split('T')[0];
    const osInfo = `${process.platform} ${process.arch}`;
    const memory = loadMemory();
    const sections = [
      `你是 my-coder，一个AI编程助手。始终用中文回复用户。`,
      `CWD: ${process.cwd()}  |  Date: ${now}  |  OS: ${osInfo}`,
      ``,
      ...(memory ? [`## 用户记忆`, memory, ``] : []),
      `## 规则`,
      `- 多领域/多文件/多步骤的复杂任务→先用 TreeCmd(create) 建工作树→add_child 拆义群→Agent(background=true) 并行派发→AgentTeam(list) 监督→收报告。`,
      `- 编辑前先Read。小改用Edit。独立任务并行调工具。`,
      `- 有后台Agent时：AgentTeam(list)检查进度。看到blocked→读feedback→AgentTeam(direct)给新方向或AgentTeam(kill)重派。`,
      `- 你是子Agent时：如果任务无法完成，在思考中写[BLOCKED:原因]。有进展时写[FEEDBACK:消息]向主Agent汇报。`,
      `- WebSearch/WebFetch如果连续失败→换关键词重试一次，再失败就靠已有知识。不要反复重试同一个失败的搜索。`,
      `- 子Agent完成后检查成功/失败，失败的重试，最终汇总结构化报告。`,
      `- 工具结果重要信息记在回复里（旧结果可能被清除）。卡住时解释试了什么。`,
      `- 不主动用emoji。不重复调已有结果的工具。不擅改git config/跳过hooks/强推。`,
      `- 提交前：git status+diff+log了解上下文。add具体文件不add -A。不擅提交擅amend。`,
      ``,
      ...(role ? this._rolePrompt(role) : []),
      `## 工具`,
      `- Bash: git/npm/测试/文件操作。不用cat/head/tail/sed/awk——用Read/Edit`,
      `- Read: 带行号，offset+limit分页，检测二进制/图片`,
      `- Edit: 精确字符串替换(含空格缩进)，replace_all批量改名。失败先Read确认`,
      `- Write: 原子写入，自动建父目录，空内容警告`,
      `- Grep/Glob: ripgrep优先(.gitignore感知)`,
      `- Agent: description=标题, prompt=指令, background=true批量并行。子Agent英文执行，用中文汇报`,
      `- AgentTeam: list/check/deep/wait/kill/inbox/direct — 管理后台Agent`,
      `- TreeCmd: create/add_child/status/report/replace/get_leaves — 管理任务树`,
      ``,
      `## Tools`,
      ...this.tools.map(t => `- **${t.name}**`),
    ];
    return sections.join('\n');
  }

  private _rolePrompt(role: 'planner' | 'supervisor' | 'worker'): string[] {
    const convergence = [
      `## 收敛规则`,
      `- 任务分解由语义驱动，不由深度限制。判断 isLeaf 的三条标准：`,
      `  1. 只涉及 1-2 个文件 + 1 个概念 → isLeaf=true，直接执行`,
      `  2. 是一个原子 Git commit → isLeaf=true，直接执行`,
      `  3. 可拆成更小的独立操作 → isLeaf=false，用 TreeCmd(add_child) 继续分解`,
    ];

    switch (role) {
      case 'planner':
        return [
          `## 任务树规划`,
          `- 你是根节点 Planner。负责：分析需求→用 TreeCmd(create) 建树→用 TreeCmd(add_child) 拆义群→派 Supervisor→AgentTeam(list) 监督→收报告。`,
          `- TaskDecompose: 一次产出 purpose + parallelism + groups。最多 8 个义群，空义群合并回父级。`,
          `- 独立义群用 background=true 并行派发。依赖关系通过 parallelism.sequential 声明。`,
          `- 你是唯一的树写入者。Supervisor/Worker 不能修改树结构。如果子Agent建议改树(通过 AgentTeam check 的 feedback)，你来评估和执行 TreeCmd replace/add_child。`,
          `- 对用户汇报前，先用 TreeCmd status 看全貌，一次性汇报总体进度（完成数/总节点数 + 关键阻塞点）。不要逐个节点 check。`,
          ...convergence,
        ];
      case 'supervisor':
        return [
          `## 监督职责`,
          `- 你是分支 Supervisor。不自己写代码。职责：派 Worker→AgentTeam(list) 检查→收结果→向 Planner 汇报。`,
          `- ★ 不要仅凭 Worker 的 [DONE] 标记判断完成。对每个声称完成的 Worker，至少用 Read 打开其声称修改的文件，确认改动存在。`,
          `- Worker [BLOCKED] → 读原因 → AgentTeam(direct) 给新方向或 AgentTeam(kill) 重派。`,
          `- 文件冲突时 → 检查 context.files 交集 → blocked + notify → LLM 决策。`,
          `- 你可以为自己管辖的树节点创建子Agent（使用 Agent 工具 + parent_node_id——这是你唯一的树扩展方式）。不能调用 TreeCmd add_child / replace / delete_node——这些只有主Agent有权执行。如果发现应该调整树结构，通过 [FEEDBACK] 向主Agent建议。`,
          ...convergence,
        ];
      case 'worker':
        return [
          `## 执行自检`,
          `- 你是叶节点 Worker。干一件具体的事→返回结果→销毁。`,
          `- 返回前必须包含完成清单：`,
          `  [CHECKLIST]`,
          `  - [x] or [ ] 任务理解正确`,
          `  - [x] or [ ] 文件已读取`,
          `  - [x] or [ ] 修改已完成`,
          `  - [x] or [ ] 输出已验证`,
          `- 末尾标注：[DONE] 全部完成 / [PARTIAL: 原因] 部分完成 / [BLOCKED: 原因] 无法继续。`,
          `- 不要标注 [DONE] 除非每个清单项都是 [x]。标错了 Supervisor 会验证到。`,
          `- 如果发现任务可继续分解，附加 [FEEDBACK: DECOMPOSE: 子任务A | 子任务B | ...]。优先级: [BLOCKED] > [DONE]/[PARTIAL] > [FEEDBACK: DECOMPOSE]。[BLOCKED] 时不附加 DECOMPOSE。`,
          ...convergence,
        ];
    }
  }

  // ---- LLM 调用（纯数据，不写终端） ----

  private async callLLM(
    messages: ChatMessage[],
    label?: string,
    onProgress?: (e: ProgressEvent) => void,
  ): Promise<{ content: Array<unknown>; stop_reason: string }> {
    const thinkStart = Date.now();
    const thinkLabel = label || (messages.length <= 2 ? 'analyzing request' : 'processing');

    onProgress?.({ type: 'thinking_start', label: thinkLabel });

    await this.llmLimiter.acquire();
    let tick: ReturnType<typeof setInterval> | null = null;
    try {
      tick = setInterval(() => {
        onProgress?.({ type: 'thinking_tick', label: thinkLabel, elapsedMs: Date.now() - thinkStart });
      }, 100);

      const formattedTools = this.provider.formatTools(this.tools);
      const result = await this.provider.call(
        this.systemPrompt, messages, this.apiKey, this.model,
        formattedTools, this.openaiBase,
      );

      const elapsedMs = Date.now() - thinkStart;
      const toolCount = (result.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;

      onProgress?.({ type: 'thinking_end', label: thinkLabel, elapsedMs, toolCount });

      return result;
    } finally {
      if (tick !== null) clearInterval(tick);
      this.llmLimiter.release();
    }
  }

  // ---- 通知管理 ----

  flushNotifications() {
    while (this.pendingNotifications.length > 0) {
      this.sessionMessages.push(this.pendingNotifications.shift()! as ChatMessage);
    }
  }

  // ---- 工具调用合并（纯数据，不渲染） ----

  private mergeToolCalls(calls: ToolCall[]): MergedTool[] {
    const merged: MergedTool[] = [];
    for (const c of calls) {
      const last = merged[merged.length - 1];
      let summary = this.toolMap.get(c.name)?.getToolUseSummary?.(c.input as never) || c.name;
      if (summary.startsWith(c.name + ': ')) summary = summary.slice(c.name.length + 2);
      else if (summary.startsWith(c.name + ' ')) summary = summary.slice(c.name.length + 1);
      if (last && last.name === c.name) {
        last.count++;
        last.inputs.push(summary);
        last.lines += c.output.split('\n').length;
      } else {
        merged.push({
          name: c.name, count: 1, inputs: [summary],
          lines: c.output.split('\n').length, sample: briefResult(c.output),
        });
      }
    }
    return merged;
  }

  // run() / runSubAgent() → 已替换为 session_loop.ts 的 agentLoop()
}
