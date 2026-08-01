import { z } from 'zod/v4';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to write'),
  content: z.string().describe('Content to write'),
});

export const FileWriteTool = buildTool({
  name: 'Write',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  async call({ file_path, content }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    try {
      const fp = resolve(file_path);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content, 'utf-8');
      return { data: `Wrote ${file_path}` };
    } catch (e) { return { data: `Error: ${(e as Error).message}` }; }
  },
  async prompt() { return `## Write\n${DESCRIPTION}\nInput: { file_path, content }`; },
  userFacingName: () => 'Write',
  getToolUseSummary({ file_path }: Partial<z.infer<typeof inputSchema>>) { return file_path ? `Write: ${file_path}` : null; },
});
