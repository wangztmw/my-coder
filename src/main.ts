/**
 * my-coder — Minimal Claude Code Runtime
 *
 * 极简 Agent 循环: LLM + 工具 + while loop
 * 不依赖企业功能、遥测、UI框架
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// ============================================================
// 最小配置
// ============================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MYCODER_MODEL || 'claude-sonnet-5-20251001';
const BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

if (!ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

// ============================================================
// 最小 HTTP 客户端 (不依赖 @anthropic-ai/sdk 全部的复杂初始化)
// ============================================================
async function callLLM(
  systemPrompt: string,
  messages: Array<{ role: string; content: string | Array<unknown> }>,
  tools: Array<unknown>,
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const url = `${BASE_URL}/v1/messages`;
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return {
    content: (data.content as Array<unknown>) || [],
    stop_reason: (data.stop_reason as string) || '',
  };
}

// ============================================================
// 最小消息历史
// ============================================================
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Array<unknown>;
}

const messages: ChatMessage[] = [];

function addUserMessage(content: string) {
  messages.push({ role: 'user', content });
}

function addAssistantMessage(content: Array<unknown>) {
  messages.push({ role: 'assistant', content } as ChatMessage);
}

// ============================================================
// 最小系统提示词
// ============================================================
const SYSTEM_PROMPT = `You are my-coder, a minimal AI coding assistant.
You have access to tools for reading/writing files and executing shell commands.
Use tools when needed. Be concise.`;

// ============================================================
// 最小工具定义 (Bash + FileRead + FileWrite)
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const TOOLS = [
  {
    name: 'Bash',
    description: 'Execute a shell command. Returns stdout and stderr.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        description: { type: 'string', description: 'Brief description of what this command does' },
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
        file_path: { type: 'string', description: 'Path to the file to read' },
        limit: { type: 'integer', description: 'Max lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file, overwriting if it exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
];

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
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return `Exit code: ${(e as { status?: number }).status}\nStdout: ${err.stdout || ''}\nStderr: ${err.stderr || ''}\nError: ${err.message || ''}`;
      }
    }
    case 'Read': {
      const filePath = input.file_path as string;
      try {
        const content = readFileSync(resolve(filePath), 'utf-8');
        // Truncate to ~2000 lines
        const lines = content.split('\n');
        const truncated = lines.slice(0, 2000).join('\n');
        const header = lines.length > 2000 ? `(showing first 2000 of ${lines.length} lines)\n` : '';
        return header + truncated;
      } catch (e: unknown) {
        return `Error reading file: ${(e as Error).message}`;
      }
    }
    case 'Write': {
      const filePath = input.file_path as string;
      const content = input.content as string;
      try {
        writeFileSync(resolve(filePath), content, 'utf-8');
        return `File written: ${filePath}`;
      } catch (e: unknown) {
        return `Error writing file: ${(e as Error).message}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ============================================================
// 最小 Agent 循环
// ============================================================
async function runAgent(userInput: string): Promise<string> {
  addUserMessage(userInput);

  let iteration = 0;
  const MAX_ITERATIONS = 25;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const response = await callLLM(SYSTEM_PROMPT, messages, TOOLS);

    if (response.stop_reason === 'end_turn') {
      // Model responded without tool calls
      const textBlocks = response.content
        .filter((b: unknown) => (b as { type: string }).type === 'text')
        .map((b: unknown) => (b as { text: string }).text)
        .join('\n');
      addAssistantMessage(response.content);
      return textBlocks;
    }

    if (response.stop_reason === 'tool_use') {
      // Model wants to use tools
      addAssistantMessage(response.content);

      const toolResults: Array<unknown> = [];
      for (const block of response.content) {
        const b = block as { type: string; name?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.name && b.id) {
          const result = executeTool(b.name, b.input || {});
          toolResults.push({
            type: 'tool_result',
            tool_use_id: b.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults } as ChatMessage);
      continue;
    }

    // Unknown stop reason
    return `Unexpected stop_reason: ${response.stop_reason}`;
  }

  return '(max iterations reached)';
}

// ============================================================
// CLI 入口
// ============================================================
async function main() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('my-coder — minimal Claude Code runtime');
  console.log(`Model: ${MODEL}`);
  console.log('Type /help for commands, /exit to quit\n');

  const askQuestion = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  while (true) {
    const input = await askQuestion('> ');
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === '/exit' || trimmed === '/quit') break;
    if (trimmed === '/help') {
      console.log('Commands: /exit, /help');
      continue;
    }

    try {
      console.log('');
      const result = await runAgent(trimmed);
      console.log(`\n${result}\n`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
    }
  }

  rl.close();
  console.log('Goodbye.');
}

main().catch(console.error);
