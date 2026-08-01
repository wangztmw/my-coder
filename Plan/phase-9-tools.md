# Phase 9: 逐个修复工具

> **状态**：进行中 | **时间**：2026-08-01

## Phase 7-8 总结与指导

两个已验证的模式直接复用：

**模式一：删 > 修。** UI.tsx/React组件直接删，不修。
**模式二：Stub替代深层修复。** 遥测/feature()导入用空函数替，不逐个改调用点。

修复顺序（简→难）：Glob→WebSearch→Grep→FileWrite→MCPTool→WebFetch→Skill→FileRead→FileEdit→Bash

---

## 操作记录
