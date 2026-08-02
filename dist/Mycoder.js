/**
 * my-coder — Minimal AI Coding Agent
 * 入口：检测配置 → 选 Provider → 加载工具 → 启动 Agent → 进入 REPL
 *
 * 配置优先级：环境变量 > ~/.mycoder.json
 * 用户记忆：~/.mycoder/MYCODER.md → 自动注入系统提示词
 */
import { resolveConfig, saveConfig } from './config.js';
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
    // 支持 --api-key 参数
    const i = process.argv.indexOf('--api-key');
    if (i !== -1 && process.argv[i + 1])
        process.env.MYCODER_API_KEY = process.argv[i + 1];
    const config = resolveConfig(); // env > ~/.mycoder.json
    const provider = config.provider === 'anthropic' ? anthropicProvider : openaiProvider;
    const tools = getAllTools();
    const taskRegistry = getTaskRegistry();
    // 持久化当前配置（下次启动不需要环境变量）
    // 如果 API key 来自环境变量，写入配置文件（仅此一次）
    const envApiKey = process.env.MYCODER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    saveConfig({
        ...(envApiKey ? { apiKey: envApiKey } : {}),
        model: config.model,
        provider: config.provider,
        openaiBase: config.openaiBase,
    });
    // 创建 Agent 引擎
    const engine = new AgentEngine(provider, tools, config, {
        taskRegistry,
        createTask,
        completeTask,
    });
    // 初始化依赖 Agent 引擎的工具
    initAgentTool({
        taskRegistry,
        runSubAgent: (msgs, id) => engine.runSubAgent(typeof msgs[0]?.content === 'string' ? msgs[0].content : '', id),
        buildSubAgentContext: (taskPrompt) => [
            { role: 'user', content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` },
        ],
        notify: (msg) => engine.notify(msg),
    });
    initBashBg({
        createTask: createTask,
        completeTask,
        notify: (msg) => engine.notify(msg),
    });
    initTaskTool({
        taskRegistry,
        notify: (msg) => engine.notify(msg),
        pendingNotifications: engine.pendingNotifications,
    });
    // 启动横幅
    console.log(`my-coder v0.4.0`);
    console.log(`Provider: ${config.provider}  |  Model: ${config.model}  |  Tools: ${tools.length}`);
    console.log(`Config: ~/.mycoder/config.json  |  Memory: ~/.mycoder/MYCODER.md`);
    console.log('Type /help for commands, /exit to quit\n');
    // 进入 REPL
    await startCLI(engine, tools);
}
main().catch(console.error);
