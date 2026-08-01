/**
 * my-coder — Minimal AI Coding Agent
 *
 * 支持多 provider: Anthropic (Claude) / OpenAI / DeepSeek
 * 10个工具通过 tools-bridge 桥接层暴露
 */

import { createInterface } from 'node:readline';
import { getAllTools } from './tools-v2/index.js';
import { z } from 'zod/v4';

// ============================================================
// Provider 自动检测
// ============================================================
type Provider = 'anthropic' | 'openai';

let API_KEY = process.env.MYCODER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
let PROVIDER: Provider = 'anthropic';
let MODEL = process.env.MYCODER_MODEL || '';

if (!API_KEY) {
  console.error('Error: Set MYCODER_API_KEY or ANTHROPIC_API_KEY');
  process.exit(1);
}

if (API_KEY.startsWith('sk-')) {
  PROVIDER = 'openai';
  if (!MODEL) MODEL = 'deepseek-chat';
} else if (API_KEY.startsWith('sk-ant-')) {
  PROVIDER = 'anthropic';
  if (!MODEL) MODEL = 'claude-sonnet-5-20251001';
} else {
  if (!MODEL) MODEL = 'claude-sonnet-5-20251001';
}

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';

const tools = getAllTools();
console.log(`my-coder v0.3.0`);
console.log(`Provider: ${PROVIDER}  |  Model: ${MODEL}  |  Tools: ${tools.length}`);
console.log('Type /help for commands, /exit to quit\n');

// ============================================================
// Tool 定义 (来自 tools-v2 — Zod → JSON Schema)
// ============================================================
function zodToJSON(schema: z.ZodType): Record<string, unknown> {
  return (z as unknown as { toJSONSchema: (s: z.ZodType) => Record<string, unknown> }).toJSONSchema(schema);
}

const TOOLS_ANTHROPIC = tools.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJSON(t.inputSchema),
}));

const TOOLS_OPENAI = tools.map(t => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: zodToJSON(t.inputSchema) },
}));

// 工具执行映射
const toolMap = new Map(tools.map(t => [t.name, t]));
const toolContext: import('./tools-v2/Tool.js').ToolUseContext = {
  options: { tools, verbose: false, isNonInteractiveSession: false, mainLoopModel: MODEL, debug: false },
  abortController: new AbortController(),
};

// ============================================================
// LLM 调用
// ============================================================
interface ChatMessage {
  role: string;
  content: string | Array<unknown>;
}

async function callLLM_Anthropic(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const body: Record<string, unknown> = {
    model: MODEL, max_tokens: 4096, system: systemPrompt,
    messages: messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
    tools: TOOLS_ANTHROPIC,
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  const d = await r.json() as Record<string, unknown>;
  return { content: (d.content as Array<unknown>) || [], stop_reason: (d.stop_reason as string) || '' };
}

async function callLLM_OpenAI(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const apiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'user') apiMessages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' };
      if (typeof m.content === 'string') { entry.content = m.content; }
      else {
        const blocks = m.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        entry.content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n') || null;
        const tcs = blocks.filter(b => b.type === 'tool_use');
        if (tcs.length) entry.tool_calls = tcs.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }));
      }
      apiMessages.push(entry);
    } else if (m.role === 'tool') {
      apiMessages.push({ role: 'tool', tool_call_id: (m as unknown as Record<string, unknown>).tool_call_id as string, content: m.content });
    }
  }
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: apiMessages, max_tokens: 4096, tools: TOOLS_OPENAI, tool_choice: 'auto' }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  const d = await r.json() as Record<string, unknown>;
  const choice = (d.choices as Array<Record<string, unknown>>)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;
  if (!msg) return { content: [], stop_reason: 'end_turn' };
  const content: Array<unknown> = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (msg.tool_calls) {
    for (const tc of (msg.tool_calls as Array<Record<string, unknown>>)) {
      const fn = tc.function as Record<string, unknown>;
      content.push({ type: 'tool_use', id: tc.id, name: fn.name, input: typeof fn.arguments === 'string' ? JSON.parse(fn.arguments as string) : fn.arguments });
    }
  }
  return { content, stop_reason: (choice.finish_reason as string) === 'tool_calls' ? 'tool_use' : 'end_turn' };
}

const callLLM = PROVIDER === 'anthropic' ? callLLM_Anthropic : callLLM_OpenAI;

// ============================================================
// Agent 循环
// ============================================================
const SYSTEM_PROMPT = `You are my-coder, a minimal AI coding assistant.
You have tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, MCP.
Use tools when needed. Be concise. Respond in the user's language.`;

async function runAgent(userInput: string): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'user', content: userInput }];
  for (let i = 0; i < 25; i++) {
    const response = await callLLM(SYSTEM_PROMPT, messages);
    if (response.stop_reason === 'end_turn') {
      return (response.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    }
    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Array<unknown> = [];
      for (const block of response.content) {
        const b = block as { type: string; name?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.name && b.id) {
          console.error(`  [tool] ${b.name}...`);
          const tool = toolMap.get(b.name);
          let toolOutput: string;
          if (tool) {
            try {
              const result = await tool.call(b.input || {}, toolContext);
              toolOutput = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
            } catch (e) { toolOutput = `Tool error: ${(e as Error).message}`; }
          } else {
            toolOutput = `Unknown tool: ${b.name}`;
          }
          if (PROVIDER === 'openai') {
            toolResults.push({ role: 'tool', tool_call_id: b.id, content: toolOutput });
          } else {
            toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: toolOutput });
          }
        }
      }
      if (PROVIDER === 'openai') {
        for (const tr of toolResults) messages.push(tr as ChatMessage);
      } else {
        messages.push({ role: 'user', content: toolResults });
      }
    } else { return `Unexpected: ${response.stop_reason}`; }
  }
  return '(max iterations)';
}

// ============================================================
// CLI
// ============================================================
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (p: string) => new Promise<string>(r => rl.question(p, r));
  while (true) {
    const input = await ask('> ');
    if (!input.trim()) continue;
    if (input.trim() === '/exit' || input.trim() === '/quit') break;
    if (input.trim() === '/help') { console.log(`Tools: ${tools.map(t => t.name).join(', ')}\nCommands: /exit, /help`); continue; }
    try {
      console.log('');
      const start = Date.now();
      const result = await runAgent(input.trim());
      console.log(`\n${result}\n[${Date.now() - start}ms]\n`);
    } catch (e) { console.error(`Error: ${(e as Error).message}\n`); }
  }
  rl.close();
  console.log('Bye.');
}
main().catch(console.error);
