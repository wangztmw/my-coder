/**
 * LLM API 重试策略
 *
 * 瞬态错误（网络抖动/服务端临时故障）→ 重试 3 次
 * 永久错误（DNS 失败/鉴权失败）→ 立即失败，给出明确提示
 * ★ 修复：fetch 加 AbortController 超时（单次 120s + 总 180s），防止 TCP 连接成功但服务器不回数据导致永久挂起
 */

/** 判断是否值得重试 */
export function isRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // 超时/中止/JSON残废 — 重试（下次请求可能正常）
  if (msg.includes('abort') || msg.includes('timeout') || msg.includes('unterminated')) return true;
  // DNS/网络配置问题 — 重试没用
  if (msg.includes('enotfound')) return false;
  if (msg.includes('eai_again')) return false;
  // 鉴权/请求错误 — 重试没用
  if (msg.includes('401') || msg.includes('403')) return false;
  // 瞬态网络错误 + 服务端错误 — 重试
  return true;
}

/**
 * 带重试和超时的 fetch。
 * - 单次请求超时 120s（perRequestTimeoutMs）
 * - 所有重试总超时 180s（totalTimeoutMs）
 * - 总超时触发 → 级联 abort 当前正在执行的 fetch → 直接抛出，不再重试
 * - 5xx/429 → 退避重试
 * - ECONNRESET → 退避重试（指数退避 1s/2s/4s）
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 10,
  perRequestTimeoutMs = 18_000,
  totalTimeoutMs = 300_000,
): Promise<Response> {
  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), totalTimeoutMs);

  let lastErr: Error | null = null;

  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      if (totalController.signal.aborted) {
        throw new Error(`Fetch aborted: total timeout (${totalTimeoutMs / 1000}s) exceeded`);
      }

      const reqController = new AbortController();
      const reqTimer = setTimeout(() => reqController.abort(), perRequestTimeoutMs);

      // 总超时时级联 abort 当前请求
      const onTotalAbort = () => reqController.abort();
      totalController.signal.addEventListener('abort', onTotalAbort, { once: true });

      try {
        const r = await fetch(url, { ...init, signal: reqController.signal });

        if ((r.status >= 500 || r.status === 429) && attempt < retries - 1) {
          lastErr = new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        return r;
      } catch (e) {
        lastErr = e as Error;
        // 总超时触发 → 不再重试
        if (totalController.signal.aborted) throw lastErr;
        // 非重试错误或最后一次 → 抛出
        if (!isRetryable(e as Error) || attempt >= retries - 1) throw e;
        // 指数退避 1s/2s/4s
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 30_000)));
      } finally {
        clearTimeout(reqTimer);
        totalController.signal.removeEventListener('abort', onTotalAbort);
      }
    }
    throw lastErr || new Error('Request failed');
  } finally {
    clearTimeout(totalTimer);
  }
}
