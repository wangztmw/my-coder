/**
 * CLI REPL 循环
 * readline 交互 + Phase 45 EOF 优雅退出
 */

import { createInterface } from 'node:readline';
import { mdToANSI, B, b, c } from './ansi.js';
import type { AgentEngine } from './agent.js';

const C = '\x1b[36m';  // cyan

export async function startCLI(engine: AgentEngine, tools: ReadonlyArray<{ name: string }>) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Phase 45: stdin EOF 优雅退出
  let inputClosed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pendingResolve: ((v: string | undefined) => void) | null = null;
  rl.on('close', () => {
    inputClosed = true;
    if (pendingResolve) { pendingResolve(undefined); pendingResolve = null; }
  });

  const ask = (p: string) => new Promise<string | undefined>(r => {
    if (inputClosed) { r(undefined); return; }
    pendingResolve = r;
    rl.question(p, ans => {
      pendingResolve = null;
      if (inputClosed) { r(undefined); return; }
      r(ans);
    });
  });

  while (true) {
    const input = await ask(`${C}${B}mycoder${b}${c} ${B}>>>${b} `);
    if (input === undefined) {
      console.log('Bye.');
      rl.close();
      process.exit(0);
    }
    if (!input.trim()) continue;
    if (input.trim() === '/exit' || input.trim() === '/quit') break;
    if (input.trim() === '/help') {
      console.log(`Tools: ${tools.map(t => t.name).join(', ')}\nCommands: /exit, /help`);
      continue;
    }
    try {
      console.log('');
      const start = Date.now();
      const result = await engine.run(input.trim());
      console.log(`\n${mdToANSI(result)}\n[${Date.now() - start}ms]\n`);
    } catch (e) {
      const err = e as Error & { cause?: Error };
      const detail = err.cause?.message || err.message;
      console.error(`Error: ${detail}\n`);
    }
  }
  rl.close();
  console.log('Bye.');
}
