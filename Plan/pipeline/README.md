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
| [**★ 完整调研与计划**](./agent-cluster-research.md) | **CC 源码全量调研 + Mycoder 差距矩阵 + 四迭代实施计划** |
| [Claude Code 执行机制研究](./claude-code-study/findings.md) | CC query 循环 + 五层精妙机制 + 对比 |
| [QueryEngine 详解](./claude-code-study/queryengine-analysis.md) | QueryEngine 外层会话管理 |
| [query.ts 详解](./claude-code-study/query-analysis.md) | 核心 agent 循环逐段分析 |
| [辅助基础设施](./claude-code-study/helpers-analysis.md) | 权限/上下文/派生/Agent 上下文 |
| [**★ 完整运行链路**](./claude-code-study/runtime-trace.md) | **全链路逐层拆解：入口→QueryEngine→query→服务→工具→权限（22K行核心）** |

---

## 核心结论

当前 Mycoder 的内联模式（run() 里直接调工具、管子 Agent）适合个人开发，但限制了"让大模型良好组织活动"的能力。管道模式把 LLM 调用、工具执行、子 Agent 编排变成三个平等的黑盒环节，引擎只调度不包办。

**2026-08-05 完整调研后补充**：Claude Code 的架构不是管道——是单层流式反应循环。但它有五种子 Agent 创建模式（Regular/Fork/InProcess/Process/Remote）、六种内置 Agent 类型、多级工具权限过滤。Mycoder 只实现了其中最基础的一种。详见 [[agent-cluster-research.md]]。

**实施路线**（四迭代）：
1. 抽取 `executeToolCalls()` 消除重复 —— 最小可验证步
2. 引入角色系统（Scout/Builder/Reviewer/General）—— 工具权限差异化
3. Agent 间通信 + 集群组织 —— 双向消息 + 协作
4. 管道化正式解耦（Think/Act/Orchestrate Stage）
