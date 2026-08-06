/**
 * CLI REPL —— readline 事件驱动 + 输入队列
 *
 * Phase 55: 使用 readline 的 'line' 事件替代 question()。
 * readline 提供完整的行编辑能力（方向键、退格、删除等），
 * 事件驱动模型保证 stdin 始终可读，agent 忙碌时输入进入队列。
 */
import { createInterface } from 'node:readline';
import { mdToANSI, B, b, C, c, D, d } from './ansi.js';
import type { AgentEngine, ProgressEvent, MergedTool } from '../agent_def.js';
import { agentLoop } from '../session_loop.js';
import { unlockSession } from '../session.js';

// ---- 渲染函数 — 唯一调用 mdToANSI 和 ANSI 常量的地方 ----

function renderProgress(event: ProgressEvent): void {
  try {
    switch (event.type) {
      case 'thinking_start':
        process.stderr.write(`  ● ${B}Thinking${b} (0.0s) — ${event.label}`);
        break;
      case 'thinking_tick':
        process.stderr.write(`\r  ● ${B}Thinking${b} (${(event.elapsedMs / 1000).toFixed(1)}s) — ${event.label}`);
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

// ---- REPL（readline 事件驱动） ----

export async function startCLI(engine: AgentEngine, tools: ReadonlyArray<{ name: string }>) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const PROMPT = `${C}${B}mycoder${b}${c} ${B}>>>${b} `;
  const pendingInputs: string[] = [];
  let agentBusy = false;
  let stdinClosed = false;

  rl.on('close', () => {
    stdinClosed = true;
    if (!agentBusy) { console.log('\nBye.'); process.exit(0); }
  });

  rl.on('line', (line: string) => {
    let trimmed = line.trim();
    if (!trimmed) {
      if (!agentBusy) rl.prompt();
      return;
    }
    if (trimmed === '/exit' || trimmed === '/quit') {
      unlockSession();
      console.log('Bye.');
      process.exit(0);
    }
    if (trimmed === '/help') {
      console.log(`Tools: ${tools.map(t => t.name).join(', ')}\nCommands: /exit, /help`);
      if (!agentBusy) rl.prompt();
      return;
    }

    if (agentBusy) {
      pendingInputs.push(trimmed);
      process.stderr.write(`  ${D}[queued: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '...' : ''}]${d}\n`);
    } else {
      processLine(trimmed);
    }
  });

  async function processLine(line: string): Promise<void> {
    agentBusy = true;
    let current: string | undefined = line;

    while (current !== undefined) {
      // agent 处理期间暂停 readline：防止其终端状态机与
      // 我们的输出（ANSI 渲染 + 工具调用）产生交互导致 Terminal 异常
      rl.pause();
      const drainTimer = setInterval(() => {
        while (process.stdin.read() !== null) { /* drain */ }
      }, 100);

      try {
        console.log('');
        const startTime = Date.now();
        engine.flushNotifications();
        engine.sessionMessages.push({ role: 'user', content: current });

        const loopResult = await agentLoop(engine, {
          messages: engine.sessionMessages,
          maxRounds: 25,
          onProgress: renderProgress,
          onTurnComplete: (msgs, tc) => engine.onTurnComplete?.(msgs, tc),
          phaseLabel: (i, lastMsg) => i === 0 ? 'analyzing' :
            typeof lastMsg === 'string' && lastMsg.length < 200 ? 'continuing' : 'reviewing results',
          preRoundCheck: () => {
            // 检查树信号
            if ((engine as any).pendingNotifications.some((n: any) => n.content?.startsWith?.('[TREE]'))) {
              engine.flushNotifications();
              return null; // 已注入 messages，继续正常执行
            }
            return null;
          },
        });

        const result = { text: loopResult.text, ms: Date.now() - startTime };
        console.log(`\n${mdToANSI(result.text)}\n[${result.ms}ms]\n`);
      } catch (e) {
        const err = e as Error & { cause?: Error };
        const detail = err.cause?.message || err.message;
        console.error(`Error: ${detail}\n`);
      }

      clearInterval(drainTimer);
      rl.resume();
      engine.flushNotifications();
      current = pendingInputs.shift();
      if (current) {
        process.stderr.write(`  ${D}[processing queued: ${current.slice(0, 60)}${current.length > 60 ? '...' : ''}]${d}\n`);
      }
    }

    agentBusy = false;
    if (stdinClosed) { console.log('Bye.'); process.exit(0); }
    rl.prompt();
  }

  rl.setPrompt(PROMPT);
  rl.prompt();
}
