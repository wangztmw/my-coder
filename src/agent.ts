/**
 * Agent 引擎 — 主 Agent 循环 + 子 Agent 引擎
 *
 * Phase 50: 引擎不再 import ANSI 模块，不再写 stdout/stderr。
 * 所有进度和状态通过 onProgress 回调传给 CLI 层。
 */

import type { Tool, Tools, ToolUseContext } from './tools-v2/Tool.js';
import type { LLMProvider, ChatMessage } from './llm/types.js';
import type { TaskState } from './task.js';
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
  text: string;      // 纯 Markdown，不含 ANSI
  ms: number;
}

// ---- 工具函数 ----

export function briefResult(data: string): string {
  const firstLine = data.split('\n')[0].slice(0, 80);
  return firstLine.length < data.length ? firstLine + '...' : firstLine;
}

const SUB_AGENT_PROMPT = 'You are a sub-agent. Complete the assigned task using the available tools. If web tools (WebSearch/WebFetch) fail 2+ times, stop using them and rely on your existing knowledge. Do not keep retrying failed network calls. Return a concise report — prioritize completing quickly over exhaustive searching. Do not ask questions.';

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

  taskRegistry: Map<string, TaskState>;
  createTask: (type: 'local_agent' | 'local_bash', subject: string, desc?: string) => TaskState;
  completeTask: (id: string, output: string) => void;
  notify: (msg: string) => void;

  constructor(
    provider: LLMProvider,
    tools: Tools,
    config: { apiKey: string; model: string; openaiBase: string; llmMaxConcurrency?: number },
    deps: {
      taskRegistry: Map<string, TaskState>;
      createTask: (type: 'local_agent' | 'local_bash', subject: string, desc?: string) => TaskState;
      completeTask: (id: string, output: string) => void;
    },
  ) {
    this.provider = provider;
    this.tools = tools;
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolContext = {
      options: { tools, verbose: false, isNonInteractiveSession: false, mainLoopModel: config.model, debug: false },
      abortController: new AbortController(),
    };
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.openaiBase = config.openaiBase;
    if (config.llmMaxConcurrency) this.llmLimiter = new ConcurrencyLimiter(config.llmMaxConcurrency);
    this.taskRegistry = deps.taskRegistry;
    this.createTask = deps.createTask;
    this.completeTask = deps.completeTask;
    this.notify = (msg: string) => { this.pendingNotifications.push({ role: 'user', content: msg }); };
    this.systemPrompt = this.buildSystemPrompt();
  }

  // ---- System Prompt ----

  buildSystemPrompt(): string {
    const now = new Date().toISOString().split('T')[0];
    const osInfo = `${process.platform} ${process.arch}`;
    const memory = loadMemory();
    const sections = [
      `你是 my-coder，一个AI编程助手。始终用中文回复用户。`,
      `CWD: ${process.cwd()}  |  Date: ${now}  |  OS: ${osInfo}`,
      ``,
      ...(memory ? [`## 用户记忆`, memory, ``] : []),
      `## 规则`,
      `- 先说再干，说完立刻调工具。复杂任务先规划步骤：分析需求→分解子任务→逐步执行→综合结果。`,
      `- 编辑前先Read。小改用Edit。独立任务并行调工具。`,
      `- 有后台Agent时：Task(wait, 15s)→超时→Task(list)→Task(check)卡住的→Task(direct)调控或Task(kill)后重试。`,
      `- WebSearch/WebFetch如果连续失败→换关键词重试一次，再失败就靠已有知识。不要反复重试同一个失败的搜索。`,
      `- 子Agent完成后检查成功/失败，失败的重试，最终汇总结构化报告。`,
      `- 工具结果重要信息记在回复里（旧结果可能被清除）。卡住时解释试了什么。`,
      `- 不主动用emoji。不重复调已有结果的工具。不擅改git config/跳过hooks/强推。`,
      `- 提交前：git status+diff+log了解上下文。add具体文件不add -A。不擅提交擅amend。`,
      ``,
      `## 工具`,
      `- Bash: git/npm/测试/文件操作。不用cat/head/tail/sed/awk——用Read/Edit`,
      `- Read: 带行号，offset+limit分页，检测二进制/图片`,
      `- Edit: 精确字符串替换(含空格缩进)，replace_all批量改名。失败先Read确认`,
      `- Write: 原子写入，自动建父目录，空内容警告`,
      `- Grep/Glob: ripgrep优先(.gitignore感知)`,
      `- Agent: description=标题, prompt=指令, background=true批量并行。子Agent英文执行，用中文汇报`,
      `- Task: list/check/wait/kill/inbox/direct`,
      ``,
      `## Tools`,
      ...this.tools.map(t => `- **${t.name}**`),
    ];
    return sections.join('\n');
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
    try {
      const tick = setInterval(() => {
        onProgress?.({ type: 'thinking_tick', label: thinkLabel, elapsedMs: Date.now() - thinkStart });
      }, 100);

      const formattedTools = this.provider.formatTools(this.tools);
      const result = await this.provider.call(
        this.systemPrompt, messages, this.apiKey, this.model,
        formattedTools, this.openaiBase,
      );
      clearInterval(tick);

      const elapsedMs = Date.now() - thinkStart;
      const toolCount = (result.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;

      onProgress?.({ type: 'thinking_end', label: thinkLabel, elapsedMs, toolCount });

      return result;
    } finally {
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

  // ---- 主 Agent 循环 ----

  async run(
    userInput: string,
    onProgress?: (e: ProgressEvent) => void,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    this.flushNotifications();
    this.sessionMessages.push({ role: 'user', content: userInput });

    for (let i = 0; i < 25; i++) {
      const lastMsg = this.sessionMessages[this.sessionMessages.length - 1]?.content;
      const phase = i === 0 ? 'analyzing' :
        typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results';
      const response = await this.callLLM(this.sessionMessages, phase, onProgress);

      if (response.stop_reason === 'end_turn') {
        this.sessionMessages.push({ role: 'assistant', content: response.content });
        const text = (response.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
        const tc = (response.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;
        this.onTurnComplete?.(this.sessionMessages, tc);
        return { text, ms: Date.now() - startTime };
      }

      if (response.stop_reason === 'tool_use') {
        // 思考文字 — 走事件
        const thoughts = (response.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
        if (thoughts) onProgress?.({ type: 'thought', text: thoughts });

        this.sessionMessages.push({ role: 'assistant', content: response.content });

        // 并行执行工具
        const toolUses = (response.content as Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }>)
          .filter(b => b.type === 'tool_use' && b.name && b.id);

        const calls: ToolCall[] = await Promise.all(toolUses.map(async b => {
          const tool = this.toolMap.get(b.name!);
          let toolOutput: string;
          if (tool) {
            try {
              const result = await tool.call(b.input || {}, this.toolContext);
              toolOutput = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
            } catch (e) { toolOutput = `Error: ${(e as Error).message}`; }
          } else {
            toolOutput = `Unknown tool: ${b.name}`;
          }
          return { name: b.name!, id: b.id!, input: b.input || {}, output: toolOutput };
        }));

        // 合并 → 发事件给 CLI
        onProgress?.({ type: 'tool_display', calls: this.mergeToolCalls(calls) });

        // 组装 tool results
        const toolResults: Array<unknown> = [];
        for (const c of calls) {
          toolResults.push(this.provider.formatToolResult(c.id, c.output));
        }
        if (this.provider.name === 'openai') {
          for (const tr of toolResults) this.sessionMessages.push(tr as ChatMessage);
        } else {
          this.sessionMessages.push({ role: 'user', content: toolResults });
        }
      } else {
        return { text: `Unexpected: ${response.stop_reason}`, ms: Date.now() - startTime };
      }
    }
    return { text: '(max iterations)', ms: Date.now() - startTime };
  }

  // ---- 子 Agent 引擎（静默——不传 onProgress） ----

  async runSubAgent(taskPrompt: string, agentId: string): Promise<string> {
    const task = this.taskRegistry.get(agentId);
    if (task) task.status = 'running';

    const messages: ChatMessage[] = [
      { role: 'user', content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` },
    ];

    try {
      for (let i = 0; i < 10; i++) {
        if (task?.pendingInstruction) {
          messages.push({ role: 'user', content: `[MAIN AGENT INSTRUCTION — follow this]: ${task.pendingInstruction}` });
          task.pendingInstruction = undefined;
        }
        if (task?.abortController?.signal.aborted) {
          if (task) { task.status = 'killed'; task.endTime = Date.now(); }
          return '(killed)';
        }

        // 子 Agent 不传 onProgress → callLLM 静默
        const response = await this.callLLM(messages);

        if (response.stop_reason === 'end_turn') {
          const text = (response.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
          this.completeTask(agentId, text);
          return text || '(done)';
        }

        if (response.stop_reason === 'tool_use') {
          if (task?.agentLoop) {
            task.agentLoop.roundCount = i + 1;
            task.agentLoop.toolUseCount += (response.content as Array<{ type: string }>)
              .filter(b => b.type === 'tool_use').length;
          }
          messages.push({ role: 'assistant', content: response.content });

          const toolResults: Array<unknown> = [];
          for (const block of response.content) {
            const b = block as { type: string; name?: string; id?: string; input?: Record<string, unknown> };
            if (b.type === 'tool_use' && b.name && b.id) {
              const tool = this.toolMap.get(b.name);
              let out = '';
              if (tool) {
                try {
                  const r = await tool.call(b.input || {}, this.toolContext);
                  out = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
                } catch (e) { out = `Error: ${(e as Error).message}`; }
              } else { out = `Unknown: ${b.name}`; }

              if (task?.agentLoop) {
                const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name;
                task.agentLoop.lastActivity = `${b.name}(${summary})`;
                task.agentLoop.lastOutput = out.slice(0, 200);
              }

              toolResults.push(this.provider.formatToolResult(b.id, out));
            }
          }

          if (this.provider.name === 'openai') {
            for (const tr of toolResults) messages.push(tr as ChatMessage);
          } else {
            messages.push({ role: 'user', content: toolResults } as ChatMessage);
          }
        }
      }
      return '(max iterations)';
    } catch (e) {
      return `(crashed: ${(e as Error).message})`;
    }
  }
}
