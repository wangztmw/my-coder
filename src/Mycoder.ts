/**
 * my-coder — Minimal AI Coding Agent
 * 入口：检测配置 → 选 Provider → 加载工具 → 启动 Agent → 进入 REPL
 */

import { detectProvider } from './provider.js';
import { anthropicProvider } from './llm/anthropic.js';
import { openaiProvider } from './llm/openai.js';
import { AgentEngine } from './agent.js';
import { startCLI } from './cli.js';
import { getAllTools } from './tools-v2/index.js';
import { initAgentTool } from './tools-v2/AgentTool/AgentTool.js';
import { initBashBg } from './tools-v2/BashTool/BashTool.js';
import { initTaskTool } from './tools-v2/TaskTool/TaskTool.js';
import { createTask, completeTask, getTaskRegistry } from './task.js';

// ---- 启动 ----

async function main() {
  const config = detectProvider();
  const provider = config.provider === 'anthropic' ? anthropicProvider : openaiProvider;
  const tools = getAllTools();
  const taskRegistry = getTaskRegistry();

  // 创建 Agent 引擎
  const engine = new AgentEngine(provider, tools, config, {
    taskRegistry,
    createTask,
    completeTask,
  });

  // 初始化依赖 Agent 引擎的工具
  initAgentTool({
    taskRegistry,
    runSubAgent: (msgs, id) => engine.runSubAgent(
      typeof msgs[0]?.content === 'string' ? msgs[0].content : '', id
    ),
    buildSubAgentContext: (taskPrompt: string) => [
      { role: 'user' as const, content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` },
    ],
    notify: (msg: string) => engine.notify(msg),
  });

  initBashBg({
    createTask: createTask as (t: string, d: string) => unknown,
    completeTask,
    notify: (msg: string) => engine.notify(msg),
  });

  initTaskTool({
    taskRegistry,
    notify: (msg: string) => engine.notify(msg),
    pendingNotifications: engine.pendingNotifications,
  });

  // 启动横幅
  console.log(`my-coder v0.4.0`);
  console.log(`Provider: ${config.provider}  |  Model: ${config.model}  |  Tools: ${tools.length}`);
  console.log('Type /help for commands, /exit to quit\n');

  // 进入 REPL
  await startCLI(engine, tools);
}

main().catch(console.error);
