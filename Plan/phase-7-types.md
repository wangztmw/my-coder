# Phase 7: 修复基础——类型系统 + 核心接口

> **状态**：进行中 | **开始**：2026-08-01

---

## ✅ Tool.ts — 重写完成
- 793→202行
- 删除：12个断裂import、8个React UI渲染方法、遥测字段(querySource/pushApiMetricsEntry/discoveredSkillNames)、Anthropic内部(GrowthBook reference)
- 保留：核心Tool接口、buildTool工厂、精简版ToolUseContext

## ✅ Task.ts — 修复完成
- 126→98行
- 删除：AppState依赖(state/)、AgentId依赖(types/ids)
- 保留：Task类型定义、generateTaskId、createTaskStateBase

## ✅ commands.ts — 重写完成
- 754→15行
- 删除：70+已删除commands/子模块、所有遥测/feature()调用
- 保留：Command类型重导出、getSlashCommandToolSkills stub

## ✅ tools.ts — 重写完成
- 389→25行
- 删除：所有feature()条件加载、已删除工具import
- 保留：10个核心工具 + getAllBaseTools()

## 待完成
- [ ] types/ 目录清理
- [ ] 编译验证
