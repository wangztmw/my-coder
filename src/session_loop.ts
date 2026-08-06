/**
 * 统一 Agent 循环 — agentLoop() 一份代码驱动主Agent和子Agent
 *
 * agent_def.ts 包含引擎完整定义。本文件提供唯一的执行循环。
 * 主Agent 和子Agent 的区别全在 AgentLoopParams 配置中。
 */
import { AgentEngine, type ProgressEvent, type AgentResult } from './agent_def.js';
import type { ChatMessage } from './llm/types.js';
import type { LoopResult, AgentMeta } from './task_tree/types.js';

// ---- 参数接口 ----

export interface AgentLoopParams {
  messages: ChatMessage[];
  maxRounds: number;
  onProgress?: (e: ProgressEvent) => void;
  onTurnComplete?: (messages: ChatMessage[], toolCount: number) => void;
  onComplete?: (text: string) => void;
  preRoundCheck?: (messages: ChatMessage[]) => string | null;
  updateStats?: (name: string, summary: string, output: string, feedback?: string) => void;
  phaseLabel?: (i: number, lastMsg: unknown) => string;
  /** 工具执行模式：true=串行(子Agent)，默认false=并行(主Agent) */
  serialTools?: boolean;
  /** 当前 Agent 的树角色元数据（任务树系统注入） */
  agentMeta?: AgentMeta;
  /** 文件操作追踪 hook（任务树系统注入） */
  fileTracker?: (toolName: string, input: Record<string, unknown>) => void;
}

// ---- 辅助函数 ----

function extractText(response: any): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
}

function countToolUses(response: any): number {
  return (response.content as Array<{ type: string }>)
    .filter(b => b.type === 'tool_use').length;
}

function extractThoughts(response: any): string {
  return (response.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
}

async function executeTools(
  engine: AgentEngine,
  response: any,
  onProgress?: (e: ProgressEvent) => void,
  updateStats?: (name: string, summary: string, output: string) => void,
  serial?: boolean,
  fileTracker?: (toolName: string, input: Record<string, unknown>) => void,
): Promise<Array<{ name: string; id: string; input: Record<string, unknown>; output: string }>> {
  const toolUses = (response.content as any[])
    .filter((b: any) => b.type === 'tool_use' && b.name && b.id);
  const toolMap = (engine as any).toolMap;
  const toolContext = (engine as any).toolContext;

  const executeOne = async (b: any) => {
    // ★ 文件追踪 hook
    if (fileTracker) fileTracker(b.name!, b.input || {});
    const tool = toolMap.get(b.name!);
    let output = '';
    if (tool) {
      try {
        const r = await tool.call(b.input || {}, toolContext);
        output = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      } catch (e) { output = `Error: ${(e as Error).message}`; }
    } else { output = `Unknown tool: ${b.name}`; }
    if (updateStats) {
      const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name!;
      updateStats(b.name!, summary, output);
    }
    return { name: b.name!, id: b.id!, input: b.input || {}, output };
  };

  // 主Agent: Promise.all并行。子Agent: reduce串行(子Agent工具间可能有数据依赖)
  const calls = serial
    ? await toolUses.reduce(async (prev, b) => {
        const acc = await prev;
        acc.push(await executeOne(b));
        return acc;
      }, Promise.resolve([] as any[]))
    : await Promise.all(toolUses.map(executeOne));

  if (onProgress) {
    onProgress({ type: 'tool_display', calls: (engine as any).mergeToolCalls(calls) });
  }
  return calls;
}

function pushResults(
  messages: ChatMessage[],
  engine: AgentEngine,
  toolCalls: Array<{ id: string; output: string }>,
): void {
  const provider = (engine as any).provider;
  const toolResults: Array<unknown> = [];
  for (const c of toolCalls) toolResults.push(provider.formatToolResult(c.id, c.output));
  if (provider.name === 'openai') {
    for (const tr of toolResults) messages.push(tr as ChatMessage);
  } else {
    messages.push({ role: 'user', content: toolResults });
  }
}

// ---- 统一循环 ----

export async function agentLoop(
  engine: AgentEngine,
  params: AgentLoopParams,
): Promise<LoopResult> {
  const { messages, maxRounds, onProgress, onTurnComplete, onComplete,
          preRoundCheck, updateStats, phaseLabel, serialTools, fileTracker } = params;

  for (let i = 0; i < maxRounds; i++) {
    if (preRoundCheck) {
      const signal = preRoundCheck(messages);
      if (signal) {
        // ★ 硬 break：blocked 信号不依赖 LLM 理解文本
        if (signal.startsWith('BLOCKED:') || signal.startsWith('blocked:')) {
          const reason = signal.replace(/^BLOCKED:\s*/i, '');
          onComplete?.('(blocked)');
          return { status: 'blocked', text: `(blocked: ${reason})`, blockedReason: reason, roundCount: i + 1 };
        }
        // kill 信号
        if (signal === '(killed)' || signal.startsWith('killed')) {
          onComplete?.('(killed)');
          return { status: 'killed', text: signal, roundCount: i + 1 };
        }
        // 其他信号：注入 messages 让 LLM 处理（兼容旧行为）
        messages.push({ role: 'user', content: `[SIGNAL] ${signal}` });
      }
    }

    const lastMsg = messages[messages.length - 1]?.content;
    const phase = phaseLabel?.(i, lastMsg) ?? 'processing';

    let response: { content: Array<unknown>; stop_reason: string };
    try {
      response = await (engine as any).callLLM(messages, phase, onProgress);
    } catch (e) {
      const errMsg = (e as Error).message || String(e);
      return { status: 'crashed', text: `LLM call failed: ${errMsg}`, roundCount: i + 1 };
    }

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content });
      const text = extractText(response);
      const tc = countToolUses(response);
      onTurnComplete?.(messages, tc);
      onComplete?.(text);
      return { status: 'success', text: text || '(done)', roundCount: i + 1 };
    }

    if (response.stop_reason === 'tool_use') {
      const thoughts = extractThoughts(response);
      if (thoughts && onProgress) onProgress({ type: 'thought', text: thoughts });
      messages.push({ role: 'assistant', content: response.content });

      // 提取反馈标记: [FEEDBACK: xxx] 或 [BLOCKED: xxx]
      let feedback: string | undefined;
      if (thoughts) {
        const fm = thoughts.match(/\[FEEDBACK:\s*(.+?)\]/);
        const bm = thoughts.match(/\[BLOCKED:\s*(.+?)\]/);
        if (bm) feedback = `BLOCKED: ${bm[1]}`;
        else if (fm) feedback = fm[1];
      }

      const toolResults = await executeTools(engine, response, onProgress,
        feedback ? (n, s, o) => updateStats?.(n, s, o, feedback!) : updateStats, serialTools, fileTracker);
      pushResults(messages, engine, toolResults);
    } else {
      return { status: 'crashed', text: `Unexpected stop_reason: ${response.stop_reason}`, roundCount: i + 1 };
    }
  }
  return { status: 'max_rounds', text: '(max iterations)', roundCount: maxRounds };
}
