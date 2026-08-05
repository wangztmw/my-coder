/**
 * 统一 Agent 循环 — agentLoop() 一份代码驱动主Agent和子Agent
 *
 * agent_def.ts 包含引擎完整定义。本文件提供唯一的执行循环。
 * 主Agent 和子Agent 的区别全在 AgentLoopParams 配置中。
 */
import { AgentEngine, type ProgressEvent, type AgentResult } from './agent_def.js';
import type { ChatMessage } from './llm/types.js';

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
): Promise<Array<{ name: string; id: string; input: Record<string, unknown>; output: string }>> {
  const toolUses = (response.content as any[])
    .filter((b: any) => b.type === 'tool_use' && b.name && b.id);
  const toolMap = (engine as any).toolMap;
  const toolContext = (engine as any).toolContext;

  const executeOne = async (b: any) => {
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
): Promise<string> {
  const { messages, maxRounds, onProgress, onTurnComplete, onComplete,
          preRoundCheck, updateStats, phaseLabel, serialTools } = params;

  for (let i = 0; i < maxRounds; i++) {
    if (preRoundCheck) {
      const signal = preRoundCheck(messages);
      if (signal) return signal;
    }

    const lastMsg = messages[messages.length - 1]?.content;
    const phase = phaseLabel?.(i, lastMsg) ?? 'processing';

    const response = await (engine as any).callLLM(messages, phase, onProgress);

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content });
      const text = extractText(response);
      const tc = countToolUses(response);
      onTurnComplete?.(messages, tc);
      onComplete?.(text);
      return text || '(done)';
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
        feedback ? (n, s, o) => updateStats?.(n, s, o, feedback!) : updateStats, serialTools);
      pushResults(messages, engine, toolResults);
    } else {
      return `Unexpected: ${response.stop_reason}`;
    }
  }
  return '(max iterations)';
}
