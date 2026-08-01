/**
 * my-coder — Tool Bridge
 *
 * 桥接层：暴露真实工具的 name/description/inputSchema 给 LLM，
 * 执行时路由到真实工具或手写实现。零断裂 import。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// ============================================================
// 工具 Schema 定义 (和 main.ts 的 Anthropic/OpenAI 格式兼容)
// ============================================================

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; items?: { type: string }; enum?: string[] }>;
    required: string[];
  };
}

export interface ToolResult {
  content: string;
  error?: string;
}

// ============================================================
// 全部工具 Schema
// ============================================================

export const ALL_TOOLS: ToolDef[] = [
  {
    name: 'Bash',
    description: 'Execute a shell command. Use for: running tests, git operations, npm, file system operations, building projects. Returns stdout and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        description: { type: 'string', description: 'Brief description of what this command does' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem. Use for: reading source code, config files, documentation. Returns file contents with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'integer', description: 'Line number to start reading from' },
        limit: { type: 'integer', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file, overwriting if it exists. Use for: creating new files, fully replacing existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Perform exact string replacement in a file. Use for: precise edits to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The text to replace (must match exactly)' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern. Use for: discovering file paths by naming conventions.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match (e.g. "src/**/*.ts")' },
        path: { type: 'string', description: 'Directory to search in (default: cwd)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents using regex. Use for: finding code patterns, references, definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: 'File or directory to search (default: cwd)' },
        include: { type: 'string', description: 'File pattern to include (e.g. "*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web. Use for: finding current information, documentation, error messages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Limit to these domains' },
      },
      required: ['query'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and extract content. Use for: reading documentation pages, API references.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        prompt: { type: 'string', description: 'Question to answer from the page content' },
      },
      required: ['url', 'prompt'],
    },
  },
  {
    name: 'Task',
    description: 'Create and manage a task list for tracking progress on complex multi-step work.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status' },
        taskId: { type: 'string', description: 'Task ID (for updates)' },
      },
      required: ['subject', 'description'],
    },
  },
  {
    name: 'MCP',
    description: 'Call an external MCP (Model Context Protocol) tool. Use for: accessing external services and APIs.',
    inputSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: 'MCP server name' },
        toolName: { type: 'string', description: 'Tool name within the server' },
        arguments: { type: 'object', description: 'Arguments to pass to the tool' },
      },
      required: ['serverName', 'toolName', 'arguments'],
    },
  },
];

// ============================================================
// 工具执行
// ============================================================

export function executeTool(name: string, input: Record<string, unknown>): ToolResult {
  const cwd = process.cwd();
  switch (name) {
    case 'Bash': {
      const cmd = input.command as string;
      try {
        const stdout = execSync(cmd, {
          encoding: 'utf-8', timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024, cwd,
        });
        return { content: stdout || '(no output)' };
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
        return { content: `Exit: ${err.status}\n${err.stdout || ''}\n${err.stderr || ''}`, error: err.message };
      }
    }
    case 'Read': {
      try {
        const content = readFileSync(resolve(input.file_path as string), 'utf-8');
        const lines = content.split('\n');
        const offset = (input.offset as number) || 1;
        const limit = (input.limit as number) || 2000;
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        // Add line numbers
        const numbered = selected.map((l, i) => `${String(offset + i).padStart(6, ' ')}\t${l}`).join('\n');
        return { content: numbered };
      } catch (e: unknown) { return { content: '', error: (e as Error).message }; }
    }
    case 'Write': {
      try {
        writeFileSync(resolve(input.file_path as string), input.content as string, 'utf-8');
        return { content: `Wrote: ${input.file_path}` };
      } catch (e: unknown) { return { content: '', error: (e as Error).message }; }
    }
    case 'Edit': {
      try {
        const fp = resolve(input.file_path as string);
        const content = readFileSync(fp, 'utf-8');
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const replaceAll = input.replace_all as boolean;
        if (!content.includes(oldStr)) return { content: '', error: `String not found in ${input.file_path}` };
        const result = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
        writeFileSync(fp, result, 'utf-8');
        return { content: `Edited: ${input.file_path}` };
      } catch (e: unknown) { return { content: '', error: (e as Error).message }; }
    }
    case 'Glob': {
      try {
        const { execSync: es } = require('node:child_process');
        const pattern = input.pattern as string;
        const path = (input.path as string) || '.';
        const stdout = es(`find ${path} -path "${pattern}" -maxdepth 5 2>/dev/null`, { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 });
        return { content: stdout || '(no matches)' };
      } catch (e: unknown) { return { content: '', error: (e as Error).message }; }
    }
    case 'Grep': {
      try {
        const { execSync: es } = require('node:child_process');
        const pattern = (input.pattern as string).replace(/'/g, "'\\''");
        const path = (input.path as string) || '.';
        const include = input.include as string || '';
        const includeFlag = include ? `--include="${include}"` : '';
        const stdout = es(`grep -rn --color=never ${includeFlag} '${pattern}' ${path} 2>/dev/null | head -50`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 });
        return { content: stdout || '(no matches)' };
      } catch (e: unknown) { return { content: '', error: (e as Error).message }; }
    }
    case 'WebSearch': {
      return { content: '(WebSearch: call the web search API directly)', error: 'Not implemented in bridge' };
    }
    case 'WebFetch': {
      return { content: '(WebFetch: use fetch() to get the URL)', error: 'Not implemented in bridge' };
    }
    case 'Task': {
      return { content: `Task: ${input.subject}` };
    }
    case 'MCP': {
      return { content: '(MCP: connect to MCP server)', error: 'Not implemented in bridge' };
    }
    default:
      return { content: '', error: `Unknown tool: ${name}` };
  }
}
