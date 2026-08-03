/**
 * OpenAI / DeepSeek Provider 实现
 */

import { z } from 'zod/v4';
import type { Tools } from '../tools-v2/Tool.js';
import type { LLMProvider, ChatMessage, LLMResponse } from './types.js';
import { fetchWithRetry } from './retry.js';

export const openaiProvider: LLMProvider = {
  name: 'openai',

  formatTools(tools: Tools) {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (z as unknown as { toJSONSchema: (s: z.ZodType) => Record<string, unknown> }).toJSONSchema(t.inputSchema),
      },
    }));
  },

  formatToolResult(toolCallId: string, output: string): ChatMessage {
    return { role: 'tool', tool_call_id: toolCallId, content: output } as unknown as ChatMessage;
  },

  async call(systemPrompt: string, messages: ChatMessage[], apiKey: string, model: string, tools: unknown[], openaiBase?: string): Promise<LLMResponse> {
    const baseUrl = openaiBase || 'https://api.deepseek.com';
    const apiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];

    for (const m of messages) {
      if (m.role === 'user') {
        apiMessages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const entry: Record<string, unknown> = { role: 'assistant' };
        if (typeof m.content === 'string') {
          entry.content = m.content;
        } else {
          const blocks = m.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
          entry.content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n') || null;
          const tcs = blocks.filter(b => b.type === 'tool_use');
          if (tcs.length) {
            entry.tool_calls = tcs.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }));
          }
        }
        apiMessages.push(entry);
      } else if (m.role === 'tool') {
        const toolMsg = m as unknown as Record<string, unknown>;
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolMsg.tool_call_id,
          content: m.content,
        });
      }
    }

    const r = await fetchWithRetry(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        max_tokens: 4096,
        tools,
        tool_choice: 'auto',
      }),
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as Record<string, unknown>;
    const choice = (d.choices as Array<Record<string, unknown>>)?.[0];
    const msg = choice?.message as Record<string, unknown> | undefined;

    if (!msg) return { content: [], stop_reason: 'end_turn' };

    const content: Array<unknown> = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
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
    return {
      content,
      stop_reason: (choice.finish_reason as string) === 'tool_calls' ? 'tool_use' : 'end_turn',
    };
  },
};
