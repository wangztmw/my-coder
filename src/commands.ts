/**
 * my-coder — Minimal Command system
 *
 * 原始 754 行，大量引用已删除的 commands/ 子模块。
 * 精简为 Command 类型重导出 + 最小 Skill 命令支持。
 */

export type {
  Command,
  CommandBase,
  CommandAvailability,
  LocalCommandResult,
  PromptCommand,
} from './types/command.js'

export { getCommandName, isCommandEnabled } from './types/command.js'

// Stub: 原始版本从 skills 目录加载 Skill 工具命令
// 后续 Phase 9 接入 SkillTool 后补全
export function getSlashCommandToolSkills(): Array<{ name: string; description: string }> {
  return []
}
