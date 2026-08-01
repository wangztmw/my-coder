/**
 * my-coder — Cleaned Tool interface
 *
 * 从 Claude Code 原始 Tool.ts (792行) 精简。
 * 删除：遥测字段、React UI 类型、已删除模块的 import。
 * 保留：核心 Tool 接口、buildTool 工厂、ToolUseContext。
 */

import type {
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { ThinkingConfig } from './utils/thinking.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type { Message } from './types/message.js'
import type {
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
import type { FileStateCache } from './utils/fileStateCache.js'

// These types no longer exist — define stubs for now
type AgentDefinition = { name: string; description: string }
type AgentDefinitionsResult = AgentDefinition[]

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    refreshTools?: () => Tools
  }
  abortController: AbortController
  readFileState: FileStateCache
  messages: Message[]
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
}

// ============================================================
// ToolResult
// ============================================================
export type ToolResult<T> = {
  data: T
  newMessages?: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

// ============================================================
// Tool interface (core)
// ============================================================
export type Tool<
  Input extends z.ZodType<{ [key: string]: unknown }> = z.ZodType<{ [key: string]: unknown }>,
  Output = unknown,
> = {
  aliases?: string[]
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  readonly inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: z.ZodType<unknown>
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive?(input: z.infer<Input>): boolean
  interruptBehavior?(): 'cancel' | 'block'
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  readonly name: string
  maxResultSizeChars: number
  mcpInfo?: { serverName: string; toolName: string }
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
  getPath?(input: z.infer<Input>): string
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>
  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
}

// ============================================================
// ToolPermissionContext (simplified)
// ============================================================
export type ToolPermissionContext = {
  mode: PermissionMode
  isBypassPermissionsModeAvailable: boolean
}

export const getEmptyToolPermissionContext = (): ToolPermissionContext => ({
  mode: 'default',
  isBypassPermissionsModeAvailable: false,
})

// ============================================================
// Validation
// ============================================================
export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }

// ============================================================
// Utils
// ============================================================
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

// ============================================================
// Tools collection type
// ============================================================
export type Tools = readonly Tool[]

// ============================================================
// ToolDef and buildTool
// ============================================================
export type ToolDef<
  Input extends z.ZodType<{ [key: string]: unknown }> = z.ZodType<{ [key: string]: unknown }>,
  Output = unknown,
> = Partial<Tool<Input, Output>> & { name: string; inputSchema: Input; call: Tool<Input, Output>['call'] }

export type ToolCallProgress = (progress: { toolUseID: string; data: unknown }) => void

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input: { [key: string]: unknown }): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

type ToolDefaults = typeof TOOL_DEFAULTS

export function buildTool<D extends ToolDef>(def: D): Tool {
  const result = { ...TOOL_DEFAULTS, userFacingName: () => (def as { name: string }).name, ...def }
  return result as unknown as Tool
}

// Stub types that tools import from deleted modules
export type PermissionDecision = {
  behavior: 'allow' | 'deny' | 'ask'
  updatedInput?: Record<string, unknown>
  message?: string
}
