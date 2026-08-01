import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  query: z.string().describe('Search query'),
});

export const WebSearchTool = buildTool({
  name: 'WebSearch',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call({ query }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    try {
      const r = await fetch(`https://api.anthropic.com/v1/search?q=${encodeURIComponent(query)}`, {
        headers: { 'x-api-key': process.env.MYCODER_API_KEY || process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { data: `Search failed: ${r.status}` };
      const d = await r.json() as { results?: Array<{ title: string; url: string }> };
      return { data: (d.results || []).map(r => `${r.title}\n  ${r.url}`).join('\n\n') || '(no results)' };
    } catch (e) { return { data: `Search error: ${(e as Error).message}` }; }
  },
  async prompt() { return `## WebSearch\n${DESCRIPTION}\nInput: { query }`; },
  userFacingName: () => 'WebSearch',
  getToolUseSummary({ query }: Partial<z.infer<typeof inputSchema>>) { return query ? `Search: ${query}` : null; },
});
