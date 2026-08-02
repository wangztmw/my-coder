/**
 * Config 持久化 — ~/.mycoder.json + ~/.mycoder/MYCODER.md
 *
 * 优先级：环境变量 > 配置文件
 * 设计原则：轻量（无锁、无监听、无备份），单用户单进程场景
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface MyCoderConfig {
  apiKey?: string;
  model?: string;
  provider?: 'anthropic' | 'openai';
  openaiBase?: string;
}

// ---- 路径 ----

function getConfigDir(): string {
  return join(homedir(), '.mycoder');
}

function getConfigPath(): string {
  return join(homedir(), '.mycoder.json');
}

export function getMemoryPath(): string {
  return join(getConfigDir(), 'MYCODER.md');
}

// ---- 配置文件读写 ----

/** 从 ~/.mycoder.json 加载配置 */
export function loadConfig(): MyCoderConfig {
  try {
    if (!existsSync(getConfigPath())) return {};
    const raw = readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      provider: parsed.provider === 'anthropic' || parsed.provider === 'openai' ? parsed.provider : undefined,
      openaiBase: typeof parsed.openaiBase === 'string' ? parsed.openaiBase : undefined,
    };
  } catch {
    return {};
  }
}

/** 合并写入 ~/.mycoder.json（读取 → 合并 → 写入） */
export function saveConfig(partial: Partial<MyCoderConfig>): void {
  try {
    const current = loadConfig();
    const merged: MyCoderConfig = { ...current, ...partial };
    // 清理 undefined
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined) cleaned[k] = v;
    }
    writeFileSync(getConfigPath(), JSON.stringify(cleaned, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // 静默失败——配置文件不是关键路径
  }
}

// ---- 用户记忆 ----

/** 加载 ~/.mycoder/MYCODER.md 内容 */
export function loadMemory(): string {
  try {
    const p = getMemoryPath();
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** 写入 ~/.mycoder/MYCODER.md */
export function saveMemory(content: string): void {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getMemoryPath(), content, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // 静默失败
  }
}

/**
 * 解析最终配置：环境变量 > ~/.mycoder.json
 * 返回完整的 ProviderConfig
 */
export function resolveConfig(): {
  apiKey: string;
  model: string;
  provider: 'anthropic' | 'openai';
  openaiBase: string;
} {
  const fileConfig = loadConfig();
  const envApiKey = process.env.MYCODER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const apiKey = envApiKey || fileConfig.apiKey || '';

  if (!apiKey) {
    console.error('Error: Set MYCODER_API_KEY or run with --api-key, or add apiKey to ~/.mycoder.json');
    process.exit(1);
  }

  let provider: 'anthropic' | 'openai' = 'anthropic';
  if (apiKey.startsWith('sk-')) provider = 'openai';
  else if (apiKey.startsWith('sk-ant-')) provider = 'anthropic';

  const model = process.env.MYCODER_MODEL
    || fileConfig.model
    || (provider === 'openai' ? 'deepseek-chat' : 'claude-sonnet-5-20251001');

  const openaiBase = process.env.OPENAI_BASE_URL || fileConfig.openaiBase || 'https://api.deepseek.com';

  return { apiKey, model, provider, openaiBase };
}
