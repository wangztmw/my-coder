import { z } from 'zod/v4';
import { execSync } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for'),
  path: z.string().optional().describe('File or directory to search (default: current directory)'),
  include: z.string().optional().describe('File pattern filter, e.g. "*.ts"'),
});

export const GrepTool = buildTool({
  name: 'Grep',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call({ pattern, path, include }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    const dir = path || '.';
    const inc = include ? `--include="${include.replace(/"/g, '\\"')}"` : '';
    const escPattern = pattern.replace(/'/g, "'\\''");
    try {
      const stdout = execSync(
        `grep -rn --color=never ${inc} '${escPattern}' "${dir}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null | head -100`,
        { encoding: 'utf-8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      );
      return { data: stdout.trim() || '(no matches)' };
    } catch { return { data: '(no matches)' }; }
  },
  async prompt() { return `## GrepTool\n${DESCRIPTION}\nInput: { pattern, path?, include? }`; },
  userFacingName: () => 'Grep',
  getToolUseSummary({ pattern }: Partial<z.infer<typeof inputSchema>>) { return pattern ? `Grep: ${pattern}` : null; },
});
