/**
 * CLI REPL 循环
 * readline 交互 + Phase 45 EOF 优雅退出
 *
 * Phase 50: 这里是唯一渲染入口 — 所有 ANSI 输出集中在此。
 */

import { createInterface } from 'node:readline';
import { mdToANSI, B, b, c } from './ansi.js';
import type { AgentEngine, ProgressEvent, MergedTool } from './agent.js';

const C = '\x1b[36m';  // cyan

// ---- 渲染函数 — 唯一调用 mdToANSI 和 ANSI 常量的地方 ----

function renderProgress(event: ProgressEvent): void {
  try {
    switch (event.type) {
      case 'thinking_start':
        process.stderr.write(`  ● ${B}Thinking${b} (${event.label})`);
        break;
      case 'thinking_end': {
        const s = (event.elapsedMs / 1000).toFixed(1);
        const hint = event.toolCount > 0 ? ` → ${event.toolCount} tool${event.toolCount > 1 ? 's' : ''}` : '';
        process.stderr.write(`\r  ● ${B}Thinking${b} (${s}s) — ${event.label}${hint}\n`);
        break;
      }
      case 'thought':
        process.stderr.write(`  ${mdToANSI(event.text.slice(0, 300))}\n`);
        break;
      case 'tool_display':
        renderMergedTools(event.calls);
        break;
      case 'error':
        console.error(`  ✗ ${event.message}`);
        break;
    }
  } catch {
    // 渲染回调不应抛异常中断 Agent 循环
  }
}

function renderMergedTools(merged: MergedTool[]): void {
  for (const m of merged) {
    const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
    const params = m.inputs.join(', ');
    const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
    console.error(`  ● ${B}${label}${b}: ${params}  ${info}`);
  }
}

// ---- REPL ----

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
      const result = await engine.run(input.trim(), renderProgress);
      console.log(`\n${mdToANSI(result.text)}\n[${result.ms}ms]\n`);
    } catch (e) {
      const err = e as Error & { cause?: Error };
      const detail = err.cause?.message || err.message;
      console.error(`Error: ${detail}\n`);
    }
  }
  rl.close();
  console.log('Bye.');
}
