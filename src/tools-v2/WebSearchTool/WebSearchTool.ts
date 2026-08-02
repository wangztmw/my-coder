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
      // DuckDuckGo Lite — no API key needed, returns HTML
      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'my-coder/0.3' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { data: `Search failed: ${r.status}` };
      const html = await r.text();

      // 从Lite版HTML提取结果: <a rel="nofollow" href="URL">title</a> + 后面的描述
      const results: string[] = [];
      const linkRe = /<a\s+rel="nofollow"\s+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*(?:<span[^>]*>([^<]*)<\/span>)?/gi;
      let m;
      while ((m = linkRe.exec(html)) !== null) {
        const url = m[1]!;
        const title = m[2]!.replace(/<[^>]*>/g, '').trim();
        const desc = (m[3] || '').replace(/<[^>]*>/g, '').trim();
        results.push(`${title}\n  ${url}${desc ? `\n  ${desc.slice(0, 150)}` : ''}`);
        if (results.length >= 10) break;
      }

      if (results.length === 0) {
        return { data: `(no results for: ${query})` };
      }
      return { data: results.join('\n\n') };
    } catch (e) { return { data: `Search error: ${(e as Error).message}` }; }
  },
  async prompt() { return `## WebSearch\n${DESCRIPTION}\nInput: { query }`; },
  userFacingName: () => 'WebSearch',
  getToolUseSummary({ query }: Partial<z.infer<typeof inputSchema>>) { return query ? `"${query.slice(0, 50)}"` : null; },
});
