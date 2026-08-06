/**
 * TreeWriteLock — 进程内 Promise 队列互斥锁。
 *
 * 所有树写操作（saveTree、addChildNode、replaceSubtree 等）必须通过此锁。
 * 读操作（loadTree、checkSubtreeStatus）不加锁——rename 保证读到完整版本。
 *
 * 特性：
 * - 无竞争时同步获取（不创建 Promise），零开销
 * - 有竞争时排队，FIFO
 * - 30s 超时 → 触发 holder 的 abortController 通知 + 强制释放
 * - 可重入检测：同一 id 重复 acquire 警告但不阻塞
 * - batch(fn)：在持锁期间执行回调，保证原子性
 */

interface QueueEntry {
  id: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
}

export class TreeWriteLock {
  private locked = false;
  private holder: string | null = null;
  private queue: QueueEntry[] = [];
  private holderAbortController: AbortController | null = null;
  private readonly TIMEOUT_MS = 30_000;

  /**
   * 获取锁。
   *
   * - 如果当前无人持锁，立即将调用者设为 holder，同步返回（不进入事件循环）。
   * - 如果调用者已是 holder（可重入），打印 warn 并立即同步返回。
   * - 如果锁被他人持有，将调用者加入 FIFO 队列并返回 Promise；
   *   锁释放后按队列顺序唤醒。
   * - 如果 30s 内未能获取锁：触发当前 holder 的 abortController，
   *   强制释放锁，并让队列头部获得锁。
   *
   * @param id - 调用者标识，用于日志和可重入检测
   * @param abortController - 可选，超时时会被 abort()，供 holder 感知强制释放
   */
  async acquire(id: string, abortController?: AbortController): Promise<void> {
    // 无竞争：锁空闲，直接获取
    if (!this.locked) {
      this.locked = true;
      this.holder = id;
      this.holderAbortController = abortController ?? null;
      return;
    }

    // 有竞争：进入 FIFO 队列等待。同一 id 的并发调用也必须排队。
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handleTimeout(id);
      }, this.TIMEOUT_MS);

      this.queue.push({ id, resolve, reject, timer, abortController });
    });
  }

  /**
   * 释放锁。
   *
   * - 只有当前 holder 可以释放。非 holder 调用时打印 warn 并忽略。
   * - 如果有排队等待者，按 FIFO 顺序将锁交给队列头部。
   * - 释放时清除 holder 信息和 abortController。
   *
   * @param id - 调用者标识，必须与当前 holder 匹配才能释放
   */
  release(id: string): void {
    if (this.holder !== id) {
      console.warn(
        `[TreeWriteLock] 非持有者尝试释放锁：调用者=${id}，当前持有者=${this.holder ?? '无'}。忽略本次 release。`
      );
      return;
    }

    this.holder = null;
    this.holderAbortController = null;

    // 将锁交给队列中的下一个等待者
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      this.holder = next.id;
      this.holderAbortController = next.abortController ?? null;
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  /**
   * 在持锁期间执行批量操作，保证原子性。
   *
   * 自动 acquire → 执行 fn → release，即使 fn 抛出异常也会在 finally 中 release。
   *
   * @param id - 调用者标识
   * @param fn  - 在持锁期间执行的异步回调
   * @returns fn 的返回值
   */
  async batch<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(id);
    try {
      return await fn();
    } finally {
      this.release(id);
    }
  }

  /**
   * 处理超时：触发当前 holder 的 abortController，然后强制释放锁。
   *
   * 将从队列中找到最先超时的条目（如果有），
   * 可选地 abort 其关联的 abortController，并从队列移除。
   *
   * @param timedOutId - 触发超时的等待者 id
   */
  private handleTimeout(timedOutId: string): void {
    // 找到队列中对应条目
    const idx = this.queue.findIndex((entry) => entry.id === timedOutId);
    if (idx === -1) {
      return; // 条目已被移除（可能在 release 中已出队）
    }

    const entry = this.queue[idx];
    // 从队列中移除此超时条目
    this.queue.splice(idx, 1);

    // 如果当前 holder 存在，abort 它的 controller 通知它超时
    if (this.holderAbortController) {
      try {
        this.holderAbortController.abort();
      } catch {
        // abort 可能因已 aborted 而抛出，忽略
      }
    }

    // 强制释放当前 holder
    if (this.holder !== null) {
      console.warn(
        `[TreeWriteLock] ${entry.id} 等待锁超时（${this.TIMEOUT_MS}ms），持有者 ${this.holder} 的 abortController 已被触发，强制释放锁。`
      );
      this.holder = null;
      this.holderAbortController = null;
    }

    // 将锁交给下一个等待者（如果有）
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      this.holder = next.id;
      this.holderAbortController = next.abortController ?? null;
      next.resolve();
    } else {
      this.locked = false;
    }

    // 拒绝超时条目的 Promise
    entry.reject(
      new Error(
        `[TreeWriteLock] acquire 超时：${entry.id} 在 ${this.TIMEOUT_MS}ms 内未获取到锁。`
      )
    );
  }
}

export const sharedLock = new TreeWriteLock();
