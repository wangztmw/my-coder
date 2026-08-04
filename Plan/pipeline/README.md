# 管道化 Agent 架构

> **创建时间**：2026-08-03
> **来源**：对 Claude Code vs Mycoder 工具编排方式的深入讨论
> **目标**：将 Agent 的 Think（LLM）、Act（工具）、Orchestrate（子Agent）解耦为三个平等的管道环节

---

## 目录

| 文件 | 内容 |
|------|------|
| [管道设计讨论](./pipeline-design.md) | 管道模式的架构、优劣、与 Claude Code 的区别 |
| [全量对话记录](./conversation-log.md) | 完整讨论过程 |
| [明日计划：解耦 Agent 组织](./plan-decouple-agent.md) | 第一步——抽出 executeToolCalls，验证解耦可行性 |
| [明日计划：探索集群构造](./plan-cluster-explore.md) | 第二步——多 Agent 集群的组织方式 |

---

## 核心结论

当前 Mycoder 的内联模式（run() 里直接调工具、管子 Agent）适合个人开发，但限制了"让大模型良好组织活动"的能力。管道模式把 LLM 调用、工具执行、子 Agent 编排变成三个平等的黑盒环节，引擎只调度不包办。

**明天计划**：
1. 从最小步开始——把 run()/runSubAgent() 重复的工具执行抽成 `executeToolCalls()`
2. 在此基础上探索三个 Stage 的正式解耦
3. 讨论多 Agent 集群的构造方案
