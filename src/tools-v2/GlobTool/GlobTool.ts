/**
 * GlobTool — File pattern matching
 *
 * 按 Claude Code 原始架构重写。Zod 校验 + buildTool 工厂。
 */

import { z } from 'zod/v4';
import { execSync } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult, type ToolPermissionContext, type Tools } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match, e.g. "src/**/*.ts"'),
  path: z.string().optional().describe('Directory to search in (default: current directory)'),
});

export const GlobTool = buildTool({
  name: 'Glob',
  inputSchema,

  async description(): Promise<string> {
    return DESCRIPTION;
  },

  isReadOnly(): boolean {
    return true;
  },

  isConcurrencySafe(): boolean {
    return true;
  },

  async call(
    { pattern, path }: z.infer<typeof inputSchema>,
    _context: ToolUseContext,
  ): Promise<ToolResult<string>> {
    const dir = path || '.';
    try {
      const stdout = execSync(
        `find "${dir}" -path "${pattern}" -not -path '*/node_modules/*' -not -path '*/.git/*' -maxdepth 8 2>/dev/null | head -500`,
        { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      const files = stdout.trim().split('\n').filter(Boolean).sort();
      if (files.length === 0) return { data: '(no matches)' };
      if (files.length >= 500) return { data: files.join('\n') + '\n(truncated at 500)' };
      return { data: files.join('\n') };
    } catch {
      return { data: '(no matches)' };
    }
  },

  async prompt({ getToolPermissionContext, tools }: {
    getToolPermissionContext(): Promise<ToolPermissionContext>;
    tools: Tools;
  }): Promise<string> {
    return `## GlobTool
${DESCRIPTION}

Input: { pattern: string, path?: string }
Output: newline-separated file paths

Available tools: ${tools.map(t => t.name).join(', ')}`;
  },

  userFacingName(): string {
    return 'Glob';
  },

  getToolUseSummary({ pattern }: Partial<z.infer<typeof inputSchema>>): string | null {
    return pattern ? `Glob: ${pattern}` : null;
  },
});
