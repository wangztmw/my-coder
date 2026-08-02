/**
 * my-coder — Minimal AI Coding Agent
 *
 * 支持多 provider: Anthropic (Claude) / OpenAI / DeepSeek
 * 10个工具通过 tools-bridge 桥接层暴露
 */

import { createInterface } from 'node:readline';
import { getAllTools } from './tools-v2/index.js';
import { initAgentTool } from './tools-v2/AgentTool/AgentTool.js';
import { initBashBg } from './tools-v2/BashTool/BashTool.js';
import { initTaskTool } from './tools-v2/TaskTool/TaskTool.js';
import { z } from 'zod/v4';

// ============================================================
// Provider 自动检测
// ============================================================
type Provider = 'anthropic' | 'openai';

let API_KEY = process.env.MYCODER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
let PROVIDER: Provider = 'anthropic';
let MODEL = process.env.MYCODER_MODEL || '';

if (!API_KEY) {
  console.error('Error: Set MYCODER_API_KEY or ANTHROPIC_API_KEY');
  process.exit(1);
}

if (API_KEY.startsWith('sk-')) {
  PROVIDER = 'openai';
  if (!MODEL) MODEL = 'deepseek-chat';
} else if (API_KEY.startsWith('sk-ant-')) {
  PROVIDER = 'anthropic';
  if (!MODEL) MODEL = 'claude-sonnet-5-20251001';
} else {
  if (!MODEL) MODEL = 'claude-sonnet-5-20251001';
}

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';

const tools = getAllTools();
console.log(`my-coder v0.3.0`);
console.log(`Provider: ${PROVIDER}  |  Model: ${MODEL}  |  Tools: ${tools.length}`);
console.log('Type /help for commands, /exit to quit\n');

// ============================================================
// Tool 定义 (来自 tools-v2 — Zod → JSON Schema)
// ============================================================
function zodToJSON(schema: z.ZodType): Record<string, unknown> {
  return (z as unknown as { toJSONSchema: (s: z.ZodType) => Record<string, unknown> }).toJSONSchema(schema);
}

const TOOLS_ANTHROPIC = tools.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJSON(t.inputSchema),
}));

const TOOLS_OPENAI = tools.map(t => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: zodToJSON(t.inputSchema) },
}));

// 工具执行映射
const toolMap = new Map(tools.map(t => [t.name, t]));
const toolContext: import('./tools-v2/Tool.js').ToolUseContext = {
  options: { tools, verbose: false, isNonInteractiveSession: false, mainLoopModel: MODEL, debug: false },
  abortController: new AbortController(),
};

// ============================================================
// LLM 调用
// ============================================================
interface ChatMessage {
  role: string;
  content: string | Array<unknown>;
}

async function callLLM_Anthropic(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const body: Record<string, unknown> = {
    model: MODEL, max_tokens: 4096, system: systemPrompt,
    messages: messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content })),
    tools: TOOLS_ANTHROPIC,
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  const d = await r.json() as Record<string, unknown>;
  return { content: (d.content as Array<unknown>) || [], stop_reason: (d.stop_reason as string) || '' };
}

async function callLLM_OpenAI(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ content: Array<unknown>; stop_reason: string }> {
  const apiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'user') apiMessages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' };
      if (typeof m.content === 'string') { entry.content = m.content; }
      else {
        const blocks = m.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        entry.content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n') || null;
        const tcs = blocks.filter(b => b.type === 'tool_use');
        if (tcs.length) entry.tool_calls = tcs.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }));
      }
      apiMessages.push(entry);
    } else if (m.role === 'tool') {
      apiMessages.push({ role: 'tool', tool_call_id: (m as unknown as Record<string, unknown>).tool_call_id as string, content: m.content });
    }
  }
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: apiMessages, max_tokens: 4096, tools: TOOLS_OPENAI, tool_choice: 'auto' }),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  const d = await r.json() as Record<string, unknown>;
  const choice = (d.choices as Array<Record<string, unknown>>)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;
  if (!msg) return { content: [], stop_reason: 'end_turn' };
  const content: Array<unknown> = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (msg.tool_calls) {
    for (const tc of (msg.tool_calls as Array<Record<string, unknown>>)) {
      const fn = tc.function as Record<string, unknown>;
      content.push({ type: 'tool_use', id: tc.id, name: fn.name, input: typeof fn.arguments === 'string' ? JSON.parse(fn.arguments as string) : fn.arguments });
    }
  }
  return { content, stop_reason: (choice.finish_reason as string) === 'tool_calls' ? 'tool_use' : 'end_turn' };
}

const callLLM = PROVIDER === 'anthropic' ? callLLM_Anthropic : callLLM_OpenAI;

// ============================================================
// Agent 循环
// ============================================================
async function buildSystemPrompt(): Promise<string> {
  const now = new Date().toISOString().split('T')[0];
  const osInfo = `${process.platform} ${process.arch}`;
  const sections = [
    `你是 my-coder，一个 AI 编程助手。始终用中文回复用户。`,
    `CWD: ${process.cwd()}  |  Date: ${now}  |  OS: ${osInfo}`,
    ``,
    `## 规则`,
    `- 编辑文件前必须先读取。没读过就编辑会报错。`,
    `- 小改动优先用 Edit，不要用 Write 覆盖整个文件。尽量编辑已有文件，不要新建。`,
    `- 多个独立任务可以并行调用工具，不要一个一个等。`,
    `- 工具返回的重要信息要记在回复里——旧结果可能被清除。`,
    `- 卡住时解释你试了什么、需要什么。`,
    `- 不要主动用 emoji，除非用户要求。`,
    `- 关键：需要工具的任务（读文件、执行命令、启动 Agent、搜索），必须调用工具。不要只说"我会做"——说完立刻调工具。`,
    `- 你有完整的对话历史。可以引用之前说过的任何内容。`,
    `- 重复调同一个工具前，先确认对话历史里是否已经有结果。不要重复做一样的事。`,
    `- 有后台子Agent在跑时，定期调 Task(list) 查看进度。如果有子Agent卡住了，用 Task(check) 查看它在干什么。用 Task(wait) 等它们完成。`,
    ``,
    `## 工具用法`,
    `- Bash: 用于 git、npm、测试、构建、文件操作（ls、mkdir、cp、mv、find）。不要用 cat/head/tail/sed/awk ——用 Read/Edit 替代，体验更好。`,
    `- Read: 读取文件，带行号。支持 offset+limit 分页。自动检测二进制/图片。`,
    `- Edit: 精确字符串替换。old_string 必须完全匹配（含缩进和空格）。失败时先 Read 确认内容。replace_all 用于批量改名。`,
    `- Write: 创建文件，自动建父目录，原子写入。空内容会警告。`,
    `- Grep: 正则搜索，支持 -C 上下文行。Glob: 文件匹配。两者优先用 ripgrep（.gitignore 感知）。`,
    `- Agent: 启动子Agent处理复杂任务。description 是简短标题，prompt 是具体指令。用 run_in_background: true 批量并行启动。子Agent内部用英文执行，你用中文向用户汇报结果。`,
    `- Task: list 查看所有任务状态，check 查看单个任务详情，wait 等待完成，kill 终止任务，inbox 查看通知队列。`,
    ``,
    `## Git 安全`,
    `- 永远不要改 git config、跳过 hooks（--no-verify）、强推到 main/master。`,
    `- 永远不要执行破坏性命令（push --force、reset --hard、clean -f），除非用户明确要求。`,
    `- 提交前：git status + git diff + git log，了解上下文，匹配合适的提交信息风格。`,
    `- 尽量 git add 具体文件，不要 git add -A。`,
    `- 没被明确要求就不要提交。不要擅自 amend。`,
    ``,
    `## Tools`,
    ...tools.map(t => `- **${t.name}**`),
  ];
  return sections.join('\n');
}

// 启动时构建，后续会话复用
let SYSTEM_PROMPT = '';

// 摘要一行工具结果
function briefResult(data: string): string {
  const firstLine = data.split('\n')[0].slice(0, 80);
  return firstLine.length < data.length ? firstLine + '...' : firstLine;
}

// 跨轮对话——messages 在外面, 每轮追加
const sessionMessages: ChatMessage[] = [];
// 后台任务通知队列 — 不在中途注入, 下轮对话前flush
const pendingNotifications: Array<{ role: string; content: string }> = [];
function flushNotifications() {
  while (pendingNotifications.length > 0) {
    sessionMessages.push(pendingNotifications.shift()! as ChatMessage);
  }
}

async function runAgent(userInput: string): Promise<string> {
  flushNotifications();  // 先把上轮的异步通知注入
  sessionMessages.push({ role: 'user', content: userInput });
  for (let i = 0; i < 25; i++) {
    const response = await callLLM(SYSTEM_PROMPT, sessionMessages);
    if (response.stop_reason === 'end_turn') {
      sessionMessages.push({ role: 'assistant', content: response.content });
      return (response.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    }
    if (response.stop_reason === 'tool_use') {
      // 打印 assistant 的思考文字
      const thoughts = (response.content as Array<{ type: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
      if (thoughts) console.error(`  ${thoughts.slice(0, 200)}`);

      sessionMessages.push({ role: 'assistant', content: response.content });

      // Buffer 本轮的 tool_use，用于合并同工具
      interface ToolCall { name: string; id: string; input: Record<string, unknown>; output: string; }
      const calls: ToolCall[] = [];

      for (const block of response.content) {
        const b = block as { type: string; name?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.name && b.id) {
          const tool = toolMap.get(b.name);
          let toolOutput: string;
          if (tool) {
            try {
              const result = await tool.call(b.input || {}, toolContext);
              toolOutput = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
            } catch (e) { toolOutput = `Error: ${(e as Error).message}`; }
          } else {
            toolOutput = `Unknown tool: ${b.name}`;
          }
          calls.push({ name: b.name, id: b.id, input: b.input || {}, output: toolOutput });
        }
      }

      // 合并同工具连续调用 + 输出
      const merged: Array<{ name: string; count: number; inputs: string[]; lines: number; sample: string }> = [];
      for (const c of calls) {
        const last = merged[merged.length - 1];
        let summary = toolMap.get(c.name)?.getToolUseSummary?.(c.input as never) || c.name;
        // 去掉工具名前缀 (如 "Bash: ls" → "ls")
        if (summary.startsWith(c.name + ': ')) summary = summary.slice(c.name.length + 2);
        else if (summary.startsWith(c.name + ' ')) summary = summary.slice(c.name.length + 1);
        if (last && last.name === c.name) {
          last.count++;
          last.inputs.push(summary);
          const lc = c.output.split('\n').length;
          last.lines += lc;
        } else {
          merged.push({ name: c.name, count: 1, inputs: [summary], lines: c.output.split('\n').length, sample: briefResult(c.output) });
        }
      }
      for (const m of merged) {
        const label = m.count > 1 ? `${m.name} ×${m.count}` : m.name;
        const params = m.inputs.join(', ');
        const info = m.count > 1 ? `(${m.lines} lines total)` : `→ ${m.sample}`;
        console.error(`  ● ${label}: ${params}  ${info}`);
      }

      // 组装 toolResults
      const toolResults: Array<unknown> = [];
      for (const c of calls) {
        if (PROVIDER === 'openai') {
          toolResults.push({ role: 'tool', tool_call_id: c.id, content: c.output });
        } else {
          toolResults.push({ type: 'tool_result', tool_use_id: c.id, content: c.output });
        }
      }
      if (PROVIDER === 'openai') {
        for (const tr of toolResults) sessionMessages.push(tr as ChatMessage);
      } else {
        sessionMessages.push({ role: 'user', content: toolResults });
      }
    } else { return `Unexpected: ${response.stop_reason}`; }
  }
  return '(max iterations)';
}

// ============================================================
// Task 系统 — 增强版异步任务管理
// ============================================================
interface TaskState {
  id: string; type: 'local_agent' | 'local_bash';
  status: 'running' | 'completed' | 'failed' | 'killed';
  subject: string; description?: string;
  startTime: number; endTime?: number; output?: string;
  abortController?: AbortController;
  agentLoop?: { roundCount: number; toolUseCount: number; lastActivity?: string; lastOutput?: string };
}
const taskRegistry = new Map<string, TaskState>();
function createTask(type: 'local_agent' | 'local_bash', subject: string, desc?: string): TaskState {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const task: TaskState = { id, type, status: 'running', subject, description: desc, startTime: Date.now() };
  if (type === 'local_agent') task.agentLoop = { roundCount: 0, toolUseCount: 0 };
  taskRegistry.set(id, task);
  return task;
}

function completeTask(id: string, output: string) {
  const t = taskRegistry.get(id); if (t) { t.status = 'completed'; t.endTime = Date.now(); t.output = output; }
}

// ============================================================
// 子Agent引擎
// ============================================================
const SUB_AGENT_PROMPT = 'You are a sub-agent. Complete the assigned task using the available tools. Return a concise report of what was done and any key findings. Do not ask questions — just complete the work and report.';

function buildSubAgentContext(taskPrompt: string): ChatMessage[] {
  return [{ role: 'user', content: `Complete this task:\n${taskPrompt}\n\nReturn a concise report.` }];
}

async function runSubAgent(messages: ChatMessage[], agentId: string): Promise<string> {
  const task = taskRegistry.get(agentId);
  if (task) task.status = 'running';
  let errors = 0;
  try {
  for (let i = 0; i < 10; i++) {
    if (task?.abortController?.signal.aborted) {
      if (task) { task.status = 'killed'; task.endTime = Date.now(); }
      return '(killed)';
    }
    const response = await callLLM(SUB_AGENT_PROMPT, messages);
    if (response.stop_reason === 'end_turn') {
      const text = (response.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      completeTask(agentId, text);
      return text || '(done)';
    }
    if (response.stop_reason === 'tool_use') {
      if (task?.agentLoop) {
        task.agentLoop.roundCount = i + 1;
        task.agentLoop.toolUseCount += (response.content as Array<{ type: string }>).filter(b => b.type === 'tool_use').length;
      }
      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Array<unknown> = [];
      for (const block of response.content) {
        const b = block as { type: string; name?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.name && b.id) {
          const tool = toolMap.get(b.name);
          let out = '';
          if (tool) {
            try { const r = await tool.call(b.input || {}, toolContext); out = typeof r.data === 'string' ? r.data : JSON.stringify(r.data); }
            catch (e) { out = `Error: ${(e as Error).message}`; }
          } else { out = `Unknown: ${b.name}`; }
          if (task?.agentLoop) {
            const summary = tool?.getToolUseSummary?.(b.input || {}) || b.name;
            task.agentLoop.lastActivity = `${b.name}(${summary})`;
            task.agentLoop.lastOutput = out.slice(0, 200);
          }
          // 子Agent静默执行 — 不往主CLI打进度，避免刷屏
          toolResults.push(PROVIDER === 'openai'
            ? { role: 'tool', tool_call_id: b.id, content: out }
            : { type: 'tool_result', tool_use_id: b.id, content: out });
        }
      }
      if (PROVIDER === 'openai') {
        for (const tr of toolResults) messages.push(tr as ChatMessage);
      } else {
        messages.push({ role: 'user', content: toolResults } as ChatMessage);
      }
    }
  }
  return '(max iterations)';
  } catch (e) {
    console.error(`  ✗ Sub-agent ${task?.subject || agentId} crashed: ${(e as Error).message}`);
    return `(crashed: ${(e as Error).message})`;
  }
}

// ============================================================
// Markdown → ANSI 终端格式化
// ============================================================
const B = '\x1b[1m';   const b = '\x1b[22m';   // bold
const D = '\x1b[2m';   const d = '\x1b[22m';   // dim
const U = '\x1b[4m';   const u = '\x1b[24m';   // underline
const C = '\x1b[36m';  const c = '\x1b[39m';   // cyan
const G = '\x1b[90m';                           // gray

function mdToANSI(text: string): string {
  // 非TTY(管道/重定向) → 纯文本
  if (!process.stdout.isTTY) return text.replace(/```[\s\S]*?```/g, '[code]').replace(/[*#`|>-]/g, '');

  let result = text;
  // 代码块
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) =>
    `\n${D}${code.trim()}${d}\n`);
  // 行内代码
  result = result.replace(/`([^`]+)`/g, `${D}$1${d}`);
  // 粗体
  result = result.replace(/\*\*(.+?)\*\*/g, `${B}$1${b}`);
  // 标题（先处理长标题再短，避免###被##误匹配）
  result = result.replace(/^### (.+)$/gm,  `${B}$1${b}`);
  result = result.replace(/^## (.+)$/gm,   `${B}$1${b}`);
  result = result.replace(/^# (.+)$/gm,    `${B}$1${b}`);
  // 列表
  result = result.replace(/^(\s*)- /gm, '  • ');
  // 表格分隔行
  result = result.replace(/^\|[-| ]+\|$/gm, '');
  // 表格行
  result = result.replace(/^\|(.+)\|$/gm, (_, row) => {
    const cells = row.split('|').map((s: string) => s.trim());
    return '  ' + cells.map((s: string) => s.padEnd(20)).join(' ').trim();
  });
  // 水平线
  result = result.replace(/^---$/gm, `${G}${'─'.repeat(60)}${c}`);
  // 引用
  result = result.replace(/^> (.+)$/gm, `${G}│ $1${c}`);
  // 安全：删除未配对的ANSI码
  result = result.replace(/\x1b\[/g, m => (result.indexOf(m) < result.lastIndexOf(m) ? m : ''));
  return result;
}

// ============================================================
// CLI
// ============================================================
async function main() {
  SYSTEM_PROMPT = await buildSystemPrompt();
  const notify = (msg: string) => { pendingNotifications.push({ role: 'user', content: msg }); };
  initAgentTool({ taskRegistry, runSubAgent, buildSubAgentContext, notify });
  initBashBg({ createTask: createTask as (t: string, d: string) => unknown, completeTask, notify });
  initTaskTool({ taskRegistry, notify, pendingNotifications });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (p: string) => new Promise<string>(r => rl.question(p, r));
  while (true) {
    const input = await ask('> ');
    if (!input.trim()) continue;
    if (input.trim() === '/exit' || input.trim() === '/quit') break;
    if (input.trim() === '/help') { console.log(`Tools: ${tools.map(t => t.name).join(', ')}\nCommands: /exit, /help`); continue; }
    try {
      console.log('');
      const start = Date.now();
      const result = await runAgent(input.trim());
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
main().catch(console.error);
