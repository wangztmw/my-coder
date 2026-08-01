/**
 * my-coder — Minimal MCP auth stub
 *
 * 原始 2,465 行 — OAuth/SSO/企业认证。
 * 独立 Agent 不需要，返回空配置。
 */

export async function getOAuthCredentials(): Promise<Record<string, string>> {
  return {}
}

export function isOAuthEnabled(): boolean {
  return false
}
