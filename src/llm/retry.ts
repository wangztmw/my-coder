/**
 * LLM API 重试策略
 *
 * 瞬态错误（网络抖动/服务端临时故障）→ 重试 3 次
 * 永久错误（DNS 失败/鉴权失败）→ 立即失败，给出明确提示
 */

/** 判断是否值得重试 */
export function isRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // DNS/网络配置问题 — 重试没用
  if (msg.includes('enotfound')) return false;
  if (msg.includes('eai_again')) return false; // DNS 临时故障（罕见，但也重试没用）
  // 鉴权/请求错误 — 重试没用
  if (msg.includes('401') || msg.includes('403')) return false;
  // 瞬态网络错误 + 服务端错误 — 重试
  return true;
}

/**
 * 带重试的 fetch。
 * - 首次尝试用 keep-alive（复用连接，快 ~150ms）
 * - 遇到 ECONNRESET（服务端关了旧连接）→ 下次重试自动走新连接
 * - 5xx/429 → 退避重试
 * - DNS 失败/鉴权失败 → 不重试
 */
export async function fetchWithRetry(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, init);
      if ((r.status >= 500 || r.status === 429) && attempt < retries - 1) {
        lastErr = new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e as Error;
      if (!isRetryable(e as Error) || attempt >= retries - 1) throw e;
      // ECONNRESET 等网络错误：等一等让旧连接彻底断开，下次循环自动建新连接
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Request failed');
}
