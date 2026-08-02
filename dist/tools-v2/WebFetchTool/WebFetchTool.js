import { z } from 'zod/v4';
import { buildTool } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';
const inputSchema = z.object({
    url: z.string().describe('URL to fetch'),
    prompt: z.string().describe('What to extract from the page'),
});
export const WebFetchTool = buildTool({
    name: 'WebFetch',
    inputSchema,
    async description() { return DESCRIPTION; },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call({ url, prompt }, _ctx) {
        try {
            const r = await fetch(url.startsWith('http') ? url : `https://${url}`, {
                headers: { 'User-Agent': 'my-coder/0.2' },
                signal: AbortSignal.timeout(8000),
            });
            if (!r.ok)
                return { data: `Fetch failed: ${r.status} ${r.statusText}` };
            const html = await r.text();
            // Simple text extraction: remove tags
            const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
            return { data: `${text}\n\n(Prompt: ${prompt})` };
        }
        catch (e) {
            return { data: `Fetch error: ${e.message}` };
        }
    },
    async prompt() { return `## WebFetch\n${DESCRIPTION}\nInput: { url, prompt }`; },
    userFacingName: () => 'WebFetch',
    getToolUseSummary({ url }) { return url ? `Fetch: ${url}` : null; },
});
