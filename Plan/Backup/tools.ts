/**
 * my-coder — Minimal Tool Registry
 *
 * 原始 389 行，大量 feature() 条件加载和已删除工具的 import。
 * 只保留 10 个现存的核心工具。
 */

import { type Tool, type Tools } from './Tool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { MCPTool } from './tools/MCPTool/MCPTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'

export function getAllBaseTools(): Tools {
  const tools: Tool[] = [
    BashTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    WebFetchTool,
    WebSearchTool,
    MCPTool,
    SkillTool,
  ]
  return tools.filter(t => t.isEnabled())
}
