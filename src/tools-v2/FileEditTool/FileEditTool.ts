import { z } from 'zod/v4';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to edit'),
  old_string: z.string().describe('Text to replace (must match exactly)'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace all occurrences'),
});

export const FileEditTool = buildTool({
  name: 'Edit',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  async call({ file_path, old_string, new_string, replace_all }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    try {
      const fp = resolve(file_path);
      const content = readFileSync(fp, 'utf-8');
      if (!content.includes(old_string)) return { data: `Error: old_string not found in ${file_path}` };
      const result = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      writeFileSync(fp, result, 'utf-8');
      return { data: `Edited ${file_path}` };
    } catch (e) { return { data: `Error: ${(e as Error).message}` }; }
  },
  async prompt() { return `## Edit\n${DESCRIPTION}\nInput: { file_path, old_string, new_string, replace_all? }`; },
  userFacingName: () => 'Edit',
  getToolUseSummary({ file_path }: Partial<z.infer<typeof inputSchema>>) { return file_path ? `Edit: ${file_path}` : null; },
});
