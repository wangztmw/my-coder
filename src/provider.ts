/**
 * Provider 自动检测与配置
 * 纯函数：输入环境变量，输出配置对象
 */

export type Provider = 'anthropic' | 'openai';

export interface ProviderConfig {
  apiKey: string;
  provider: Provider;
  model: string;
  openaiBase: string;
}

export function detectProvider(): ProviderConfig {
  let apiKey = process.env.MYCODER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  let provider: Provider = 'anthropic';
  let model = process.env.MYCODER_MODEL || '';

  if (!apiKey) {
    console.error('Error: Set MYCODER_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  if (apiKey.startsWith('sk-')) {
    provider = 'openai';
    if (!model) model = 'deepseek-chat';
  } else if (apiKey.startsWith('sk-ant-')) {
    provider = 'anthropic';
    if (!model) model = 'claude-sonnet-5-20251001';
  } else {
    if (!model) model = 'claude-sonnet-5-20251001';
  }

  return {
    apiKey,
    provider,
    model,
    openaiBase: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  };
}
