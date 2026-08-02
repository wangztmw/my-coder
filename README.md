# my-coder

Minimal AI coding agent — stripped from Claude Code, rebuilt from scratch. **~1,800 lines, 12 tools, multi-agent, zero bloat.**

## Install

```bash
npm i -g my-coder
```

Requires Node.js ≥ 18.

## Configure

Set your API key via environment variable:

```bash
export MYCODER_API_KEY=sk-ant-...   # Anthropic (Claude)
# or
export MYCODER_API_KEY=sk-...       # DeepSeek / OpenAI
```

Optional: set model and provider in `~/.mycoder.json` (auto-created on first run):

```json
{
  "model": "deepseek-chat",
  "provider": "openai",
  "openaiBase": "https://api.deepseek.com"
}
```

User memory: write personal preferences to `~/.mycoder/MYCODER.md` — automatically injected into every session.

## Usage

```bash
mycoder
```

```
my-coder v0.4.0
Provider: openai  |  Model: deepseek-chat  |  Tools: 12
Config: ~/.mycoder.json  |  Memory: ~/.mycoder/MYCODER.md

mycoder >>> What is 2+2?

2 + 2 = 4

mycoder >>> /exit
Bye.
```

### Commands

| Command | Action |
|---------|--------|
| `/help` | List all tools |
| `/exit` or `/quit` | Quit |
| Any other input | Sent to the AI agent |

### Tools (12 total)

**Code**: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`
**Web**: `WebSearch`, `WebFetch`
**AI**: `Agent` (parallel sub-agents), `Task` (lifecycle management)
**Extension**: `MCP`, `Skill` (stubs for future use)

### Multi-agent

```bash
# Spawn parallel sub-agents for research, code review, etc.
mycoder >>> Use Agent to research topic A, topic B, topic C in parallel, then summarize
```

## Development

```bash
git clone https://github.com/wangztmw/my-coder.git
cd my-coder
npm install
npm run build
MYCODER_API_KEY=sk-... node dist/Mycoder.js
```

## Architecture

```
src/
├── Mycoder.ts         65行  入口：检测配置 → 连线 → 启动
├── cli.ts             60行  REPL 循环 + EOF 优雅退出
├── agent.ts          294行  核心引擎（主Agent + 子Agent）
├── config.ts         120行  配置持久化（~/.mycoder.json）
├── task.ts            46行  Task 生命周期
├── ansi.ts            56行  Markdown→ANSI 终端渲染
├── provider.ts        41行  Provider 检测
├── llm/
│   ├── types.ts       38行  统一 LLMProvider 接口
│   ├── anthropic.ts   53行  Anthropic 实现
│   └── openai.ts     100行  OpenAI/DeepSeek 实现
└── tools-v2/              12 个原生工具
```

## License

MIT
