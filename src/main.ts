/**
 * my-coder — Minimal AI Coding Agent
 *
 * 支持多 provider: Anthropic (Claude) / OpenAI / DeepSeek
 * 不依赖框架，纯 fetch + Node.js 标准库
 */

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

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

// 根据 key 前缀自动判断 provider
if (API_KEY.startsWith('sk-')) {
  PROVIDER = 'openai';
  // DeepSeek 也用 sk- 前缀
  if (!MODEL) MODEL = 'deepseek-chat';
} else if (API_KEY.startsWith('sk-ant-')) {
  PROVIDER = 'anthropic';
  if (!MODEL) MODEL = 'claude-sonnet-5-20251001';
} else {
  // 默认 Anthropic
  if (!MODEL) MODEL = 'claude-sonnet-5-20251001';
}

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';

console.log(`my-coder v0.1.0`);
console.log(`Provider: ${PROVIDER}  |  Model: ${MODEL}`);
console.log('Type /help for commands, /exit to quit\n');

// ============================================================
// Tool 定义 (同时兼容 Anthropic 和 OpenAI 格式)
// ============================================================
const TOOLS_ANTHROPIC = [
  {
    name: 'Bash',
    description: 'Execute a shell command. Returns stdout and stderr.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command' },
        description: { type: 'string', description: 'What this does' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'File path' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file, overwriting if exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
];

const TOOLS_OPENAI = TOOLS_ANTHROPIC.map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
}));

// ============================================================
// LLM 调用 (多 provider)
// ============================================================
interface ChatMessage {
  role: string;
  content: string | Array<unknown>;
  tool_calls?: Array<unknown>;
  tool_call_id?: string;
}

async function callLLM_Anthropic(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const url = 'https://api.anthropic.com/v1/messages';
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
      role: m.role,
      content: m.content,
    })),
    tools: TOOLS_ANTHROPIC,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return {
    content: (data.content as Array<unknown>) || [],
    stop_reason: (data.stop_reason as string) || '',
  };
}

async function callLLM_OpenAI(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const url = `${OPENAI_BASE}/v1/chat/completions`;

  // Build messages array with system prompt first
  const apiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
  ];

  for (const m of messages) {
    if (m.role === 'user') {
      apiMessages.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' };
      if (typeof m.content === 'string') {
        entry.content = m.content;
      } else {
        // tool_calls 或 content blocks
        const textBlocks = (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('\n');
        if (textBlocks) entry.content = textBlocks;

        const toolCalls = (m.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>)
          .filter(b => b.type === 'tool_use');
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
        }
      }
      apiMessages.push(entry);
    } else if (m.role === 'tool') {
      apiMessages.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || '',
        content: m.content,
      });
    }
  }

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: apiMessages,
    max_tokens: 4096,
    tools: TOOLS_OPENAI,
    tool_choice: 'auto',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;

  if (!msg) {
    return { content: [], stop_reason: 'end_turn' };
  }

  // 转换 OpenAI tool_calls → Anthropic-style content blocks
  const content: Array<unknown> = [];
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of (msg.tool_calls as Array<Record<string, unknown>>)) {
      const fn = tc.function as Record<string, unknown>;
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: fn.name,
        input: typeof fn.arguments === 'string' ? JSON.parse(fn.arguments as string) : fn.arguments,
      });
    }
  }

  const finishReason = choice.finish_reason as string || 'stop';
  return {
    content,
    stop_reason: finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
  };
}

const callLLM = PROVIDER === 'anthropic' ? callLLM_Anthropic : callLLM_OpenAI;

// ============================================================
// Tool 执行
// ============================================================
function executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': {
      const cmd = input.command as string;
      try {
        const stdout = execSync(cmd, {
          encoding: 'utf-8',
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          cwd: process.cwd(),
        });
        return stdout || '(no output)';
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
        return `Exit: ${err.status}\n${err.stdout || ''}\n${err.stderr || ''}`;
      }
    }
    case 'Read': {
      try {
        const content = readFileSync(resolve(input.file_path as string), 'utf-8');
        const lines = content.split('\n');
        return lines.slice(0, 2000).join('\n');
      } catch (e: unknown) {
        return `Error: ${(e as Error).message}`;
      }
    }
    case 'Write': {
      try {
        writeFileSync(resolve(input.file_path as string), input.content as string, 'utf-8');
        return `Written: ${input.file_path}`;
      } catch (e: unknown) {
        return `Error: ${(e as Error).message}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ============================================================
// Agent 循环
// ============================================================
const SYSTEM_PROMPT = `You are my-coder, a minimal AI coding assistant.
You have tools: Bash (run commands), Read (read files), Write (create files).
Use tools when needed. Be concise. Respond in the user's language.`;

async function runAgent(userInput: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'user', content: userInput },
  ];

  let iteration = 0;
  const MAX = 25;

  while (iteration < MAX) {
    iteration++;
    const response = await callLLM(SYSTEM_PROMPT, messages);

    if (response.stop_reason === 'end_turn') {
      const text = (response.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n');
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      // 追加 assistant 消息 (含 tool_use blocks)
      messages.push({ role: 'assistant', content: response.content });

      // 执行工具
      const toolResults: Array<unknown> = [];
      for (const block of response.content) {
        const b = block as { type: string; name?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.name && b.id) {
          console.error(`  [tool] ${b.name}...`);
          const result = executeTool(b.name, b.input || {});

          if (PROVIDER === 'openai') {
            toolResults.push({
              role: 'tool',
              tool_call_id: b.id,
              content: result,
            });
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: b.id,
              content: result,
            });
          }
        }
      }

      // OpenAI: tool results 是独立消息; Anthropic: 嵌入 user 消息
      if (PROVIDER === 'openai') {
        for (const tr of toolResults) {
          messages.push(tr as ChatMessage);
        }
      } else {
        messages.push({ role: 'user', content: toolResults });
      }
      continue;
    }
    return `Unexpected: ${response.stop_reason}`;
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
    if (input.trim() === '/help') {
      console.log('Commands: /exit, /help\nTools: Bash, Read, Write');
      continue;
    }

    try {
      console.log('');
      const start = Date.now();
      const result = await runAgent(input.trim());
      console.log(`\n${result}\n[${Date.now() - start}ms]\n`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}\n`);
    }
  }
  rl.close();
  console.log('Bye.');
}

main().catch(console.error);
