import { z } from 'zod/v4';
import { execSync } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  description: z.string().optional().describe('Brief description of what this does'),
  timeout: z.number().optional().describe('Timeout in ms (default 120000, max 600000)'),
});

export const BashTool = buildTool({
  name: 'Bash',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  async call({ command, description: _desc, timeout }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: Math.min(timeout || 120000, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
      });
      return { data: stdout || '(no output)' };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
      return { data: `Exit: ${err.status}\nStdout:\n${err.stdout || ''}\nStderr:\n${err.stderr || ''}` };
    }
  },
  async prompt() { return `## Bash\n${DESCRIPTION}\nInput: { command, description?, timeout? }`; },
  userFacingName: () => 'Bash',
  getToolUseSummary({ command }: Partial<z.infer<typeof inputSchema>>) { return command ? `Bash: ${command.slice(0, 80)}` : null; },
});
