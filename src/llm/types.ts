/**
 * LLM Provider 统一接口
 * 屏蔽 Anthropic vs OpenAI/DeepSeek 的消息格式差异
 */

import type { Tools } from '../tools-v2/core/Tool.js';

// ---- 通用类型 ----

export interface ChatMessage {
  role: string;
  content: string | Array<unknown>;
}

export interface LLMResponse {
  content: Array<unknown>;
  stop_reason: string;
}

// ---- Provider 接口 ----

export interface LLMProvider {
  /** 提供商名称 */
  name: string;
  /** 格式化工具定义为 API 接受的格式 */
  formatTools(tools: Tools): unknown[];
  /** 格式化工具结果为 API 消息格式 */
  formatToolResult(toolCallId: string, output: string): ChatMessage;
  /** 调用 LLM API */
  call(
    systemPrompt: string,
    messages: ChatMessage[],
    apiKey: string,
    model: string,
    tools: unknown[],
    openaiBase?: string,
  ): Promise<LLMResponse>;
}
