import { z } from 'zod/v4';
import { execSync, spawn } from 'node:child_process';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  description: z.string().optional().describe('Brief description of what this does'),
  timeout: z.number().optional().describe('Timeout in ms (default 120000, max 600000)'),
  run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bgHooks: { createTask: (t: string, d: string) => any; completeTask: (id: string, o: string) => void; notify: (msg: string) => void } | null = null;
export function initBashBg(hooks: { createTask: (t: string, d: string) => any; completeTask: (id: string, o: string) => void; notify: (msg: string) => void }) { _bgHooks = hooks; }

// 危险命令检测
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s*\/\b/, msg: 'recursive force delete from root' },
  { pattern: /rm\s+(-[a-z]*r[a-z]*f[a-z]*)\s*~\b/, msg: 'recursive force delete from home' },
  { pattern: />\s*\/dev\/sd[a-z]\d*/, msg: 'overwriting raw disk device' },
  { pattern: /mkfs\./, msg: 'creating filesystem (destroys data)' },
  { pattern: /dd\s+if=.*of=\/dev\//, msg: 'writing raw image to disk device' },
  { pattern: /:\s*\{\s*:\|:\s*&\s*\};/, msg: 'fork bomb pattern' },
  { pattern: /chmod\s+(-R\s+)?777\s*\/\b/, msg: 'world-writable permissions on root' },
];

export const BashTool = buildTool({
  name: 'Bash',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,

  async call({ command, description, timeout, run_in_background }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    // 危险命令检查
    for (const { pattern, msg } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { data: `BLOCKED: Dangerous command detected — ${msg}.\nCommand: ${command}` };
      }
    }

    // 后台执行
    if (run_in_background && _bgHooks) {
      const task = _bgHooks.createTask('local_bash', description || command.slice(0, 80));
      const child = spawn('sh', ['-c', command], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', code => {
        const out = code === 0 ? stdout || '(no output)' : `Exit ${code}\n${stdout}\n${stderr}`;
        _bgHooks!.completeTask(task.id, out);
        _bgHooks!.notify(`[Bash "${description || command.slice(0, 60)}" completed${code === 0 ? '' : ` (exit ${code})`}]:\n${out.slice(0, 1000)}`);
      });
      return { data: `Background task spawned: ${task.id} ("${description || command.slice(0, 60)}")` };
    }

    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: Math.min(timeout || 120000, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { data: stdout || '(completed successfully, no output)' };
    } catch (e: unknown) {
      const err = e as {
        stdout?: Buffer | string; stderr?: Buffer | string;
        status?: number; signal?: NodeJS.Signals; message?: string;
      };
      const out = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString() || '';
      const errOut = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() || '';

      if (err.signal) {
        return { data: `Killed by signal ${err.signal}\nMessage: ${err.message || ''}\nStdout:\n${out}\nStderr:\n${errOut}` };
      }
      return {
        data: `Exit: ${err.status ?? 'unknown'}${err.message ? ' — ' + err.message : ''}\nStdout:\n${out}\nStderr:\n${errOut}`,
      };
    }
  },

  isConcurrencySafe: () => false,
  async prompt() { return `## Bash\n${DESCRIPTION}\nInput: { command, description?, timeout? }`; },
  userFacingName: () => 'Bash',
  getToolUseSummary({ command }: Partial<z.infer<typeof inputSchema>>) {
    return command ? `Bash: ${command.slice(0, 80)}` : null;
  },
});
