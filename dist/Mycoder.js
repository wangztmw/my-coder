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
import { AgentEngine } from './agent_def.js';
import { startCLI } from './cli/cli.js';
import { getAllTools } from './tools-v2/core/index.js';
import { initAgentTool } from './tools-v2/agent/AgentTool/AgentTool.js';
import { initBashBg } from './tools-v2/exec/BashTool/BashTool.js';
import { initTaskTool } from './tools-v2/agent/AgentTeamTool/AgentTeamTool.js';
import { addMember, completeMember, getTeam, cleanOldMembers } from './agent_team.js';
import { protectTerminal } from './cli/term-wrap.js';
import { lockSession, hasUnfinishedSession, loadSession, saveSession } from './session.js';
import { cleanOldSessions } from './task_tree/persist.js';
// ---- 启动 ----
async function main() {
    protectTerminal(); // 终端行宽保护：必须在任何输出之前注册
    cleanOldMembers(); // 清理 7 天前旧成员文件
    try {
        cleanOldSessions();
    }
    catch { /* 降级 */ }
    // 支持 --resume 恢复上次未完成会话
    const resumeIdx = process.argv.indexOf('--resume');
    const shouldResume = resumeIdx !== -1;
    // 支持 --api-key 参数
    const i = process.argv.indexOf('--api-key');
    if (i !== -1 && process.argv[i + 1])
        process.env.MYCODER_API_KEY = process.argv[i + 1];
    const config = resolveConfig(); // env > ~/.mycoder.json
    const provider = config.provider === 'anthropic' ? anthropicProvider : openaiProvider;
    const tools = getAllTools();
    const teamReg = getTeam();
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
    const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let toolCount = 0;
    const engine = new AgentEngine(provider, tools, config, {
        teamReg,
        addMember,
        completeMember,
    });
    // ★ 注入树桥接（解决 task_tree ↔ agent_team 循环依赖）
    try {
        const { setMemberGetter } = await import('./task_tree/validate.js');
        setMemberGetter((id) => teamReg.get(id));
    }
    catch { /* validate.ts 可能未加载 */ }
    // 恢复未完成会话（必须在 lockSession 之前，否则 lockSession 会覆盖旧 .lock）
    if (shouldResume && hasUnfinishedSession()) {
        const session = loadSession();
        if (session) {
            console.log(`Resuming session ${session.id} (${session.messages.length} messages, ${session.toolCount} tools used)\n`);
            engine.sessionMessages = session.messages;
            toolCount = session.toolCount;
            // 恢复任务树（使用旧会话的 treeId 或 id）
            const oldTreeId = session.treeId || session.id;
            try {
                const { resumeSessionOrchestrator } = await import('./task_tree/resume.js');
                const result = resumeSessionOrchestrator(oldTreeId, (id) => teamReg.get(id));
                if (result.resumedTree) {
                    console.log(`[tree] ${result.summary}`);
                    engine.setActiveTree(oldTreeId);
                }
            }
            catch { /* task_tree 模块可能未完全初始化 */ }
        }
    }
    // 所有恢复完成后才锁定新会话
    lockSession(sessionId);
    // 每次 agent 完成一轮后保存会话
    engine.onTurnComplete = (messages, tc) => {
        toolCount += tc;
        saveSession(sessionId, messages, toolCount, engine.activeTreeId || undefined);
    };
    // 初始化依赖 Agent 引擎的工具
    initAgentTool({
        taskRegistry: teamReg,
        engine,
        notify: (msg) => engine.notify(msg),
    });
    initBashBg({
        createTask: addMember,
        completeTask: completeMember,
        notify: (msg) => engine.notify(msg),
    });
    initTaskTool({
        taskRegistry: teamReg,
        notify: (msg) => engine.notify(msg),
        pendingNotifications: engine.pendingNotifications,
    });
    // 启动横幅
    console.log(`my-coder v0.6.0`);
    console.log(`Provider: ${config.provider}  |  Model: ${config.model}  |  Tools: ${tools.length}`);
    console.log(`Config: ~/.mycoder/config.json  |  Memory: ~/.mycoder/MYCODER.md`);
    console.log('Type /help for commands, /exit to quit\n');
    // 进入 REPL
    await startCLI(engine, tools);
}
main().catch(console.error);
