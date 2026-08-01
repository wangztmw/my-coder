import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file'),
  offset: z.number().optional().describe('Line number to start from (1-based)'),
  limit: z.number().optional().describe('Max lines to read (default 2000)'),
});

export const FileReadTool = buildTool({
  name: 'Read',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call({ file_path, offset, limit }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    try {
      const content = readFileSync(resolve(file_path), 'utf-8');
      const lines = content.split('\n');
      const start = (offset || 1) - 1;
      const end = start + (limit || 2000);
      const selected = lines.slice(start, end);
      const numbered = selected.map((l, i) => `${String(start + i + 1).padStart(6, ' ')}\t${l}`).join('\n');
      const header = lines.length > end ? `(showing ${start + 1}-${end} of ${lines.length} lines)\n` : '';
      return { data: header + numbered };
    } catch (e) { return { data: `Error reading ${file_path}: ${(e as Error).message}` }; }
  },
  async prompt() { return `## Read\n${DESCRIPTION}\nInput: { file_path, offset?, limit? }`; },
  userFacingName: () => 'Read',
  getToolUseSummary({ file_path }: Partial<z.infer<typeof inputSchema>>) { return file_path ? `Read: ${file_path}` : null; },
});
