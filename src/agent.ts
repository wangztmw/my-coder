/**
 * Agent 引擎 — 主 Agent 循环 + 子 Agent 引擎
 * 消除全局状态：sessionMessages、pendingNotifications 全部收敛为实例属性
 */

import type { Tool, Tools, ToolUseContext } from './tools-v2/Tool.js';
import type { LLMProvider, ChatMessage } from './llm/types.js';
import type { TaskState } from './task.js';
import { mdToANSI, B, b } from './ansi.js';
import { loadMemory } from './config.js';

const SUB_AGENT_PROMPT = 'You are a sub-agent. Complete the assigned task using the available tools. If web tools (WebSearch/WebFetch) fail 2+ times, stop using them and rely on your existing knowledge. Do not keep retrying failed network calls. Return a concise report — prioritize completing quickly over exhaustive searching. Do not ask questions.';

function briefResult(data: string): string {
  const firstLine = data.split('\n')[0].slice(0, 80);
  return firstLine.length < data.length ? firstLine + '...' : firstLine;
}

export class AgentEngine {
  private provider: LLMProvider;
  private tools: Tools;
  private toolMap: Map<string, Tool>;
  private toolContext: ToolUseContext;
  private apiKey: string;
  private model: string;
  private openaiBase: string;
  private systemPrompt: string;

  // 实例级状态 — 不再用全局变量
  sessionMessages: ChatMessage[] = [];
  pendingNotifications: Array<{ role: string; content: string }> = [];

  // 外部注入的依赖
  taskRegistry: Map<string, TaskState>;
  createTask: (type: 'local_agent' | 'local_bash', subject: string, desc?: string) => TaskState;
  completeTask: (id: string, output: string) => void;
  notify: (msg: string) => void;

  constructor(
    provider: LLMProvider,
    tools: Tools,
    config: { apiKey: string; model: string; openaiBase: string },
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
      `- 先说再干，说完立刻调工具。两轮之间给简短状态更新。`,
      `- 编辑前先Read。小改用Edit。独立任务并行调工具。`,
      `- 有后台Agent时：Task(wait, 15s)→超时→Task(list)→Task(check)卡住的→Task(direct)调控或Task(kill)后重试。`,
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

  // ---- LLM 调用（含思考状态显示） ----

  private async callLLM(messages: ChatMessage[], label?: string): Promise<{ content: Array<unknown>; stop_reason: string }> {
    const thinkStart = Date.now();
    const thinkLabel = label || (messages.length <= 2 ? 'analyzing request' : 'processing');
    process.stderr.write(`  ● ${B}Thinking${b} (${thinkLabel})`);

    const formattedTools = this.provider.formatTools(this.tools);
    const result = await this.provider.call(
      this.systemPrompt, messages, this.apiKey, this.model,
      formattedTools, this.openaiBase,
    );

    const elapsed = ((Date.now() - thinkStart) / 1000).toFixed(1);
    const toolCount = (result.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;
    const hint = toolCount > 0 ? ` → ${toolCount} tool${toolCount > 1 ? 's' : ''}` : '';
    process.stderr.write(`\r  ● ${B}Thinking${b} (${elapsed}s) — ${thinkLabel}${hint}\n`);

    return result;
  }

  // ---- 通知管理 ----

  flushNotifications() {
    while (this.pendingNotifications.length > 0) {
      this.sessionMessages.push(this.pendingNotifications.shift()! as ChatMessage);
    }
  }

  // ---- 主 Agent 循环 ----

  async run(userInput: string): Promise<string> {
    this.flushNotifications();
    this.sessionMessages.push({ role: 'user', content: userInput });

    for (let i = 0; i < 25; i++) {
      const lastMsg = this.sessionMessages[this.sessionMessages.length - 1]?.content;
      const phase = i === 0 ? 'analyzing' :
        typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results';
      const response = await this.callLLM(this.sessionMessages, phase);

      if (response.stop_reason === 'end_turn') {
        this.sessionMessages.push({ role: 'assistant', content: response.content });
        return (response.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      }

      if (response.stop_reason === 'tool_use') {
        // 打印思考文字
        const thoughts = (response.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
        if (thoughts) console.error(`  ${mdToANSI(thoughts.slice(0, 300))}`);

        this.sessionMessages.push({ role: 'assistant', content: response.content });

        // 并行执行工具
        const toolUses = (response.content as Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }>)
          .filter(b => b.type === 'tool_use' && b.name && b.id);

        interface ToolCall { name: string; id: string; input: Record<string, unknown>; output: string; }
        const calls = await Promise.all(toolUses.map(async b => {
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

        // 合并显示
        this.displayMergedTools(calls);

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
        return `Unexpected: ${response.stop_reason}`;
      }
    }
    return '(max iterations)';
  }

  // ---- 子 Agent 引擎 ----

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
      console.error(`  ✗ Sub-agent ${task?.subject || agentId} crashed: ${(e as Error).message}`);
      return `(crashed: ${(e as Error).message})`;
    }
  }

  // ---- 工具输出显示 ----

  private displayMergedTools(calls: Array<{ name: string; id: string; input: Record<string, unknown>; output: string }>) {
    const merged: Array<{ name: string; count: number; inputs: string[]; lines: number; sample: string }> = [];
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
    for (const m of merged) {
      const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
      const params = m.inputs.join(', ');
      const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
      console.error(`  ● ${B}${label}${b}: ${params}  ${info}`);
    }
  }
}
