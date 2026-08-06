/**
 * 会话持久化 — 保存到 ~/.mycoder/sessions/
 *
 * 每次 agent 对话完成时自动保存。启动时检测未完成会话可恢复。
 * 崩溃/断电后不会丢失对话上下文。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionPath, sessionDir, SESSIONS_DIR, oldSessionPath } from './task_tree/paths.js';

const LOCK_FILE = join(SESSIONS_DIR, '.lock');

export interface SessionData {
  id: string;
  startedAt: number;
  messages: Array<{ role: string; content: unknown }>;
  toolCount: number;
  treeId?: string;              // ★ 关联的任务树 ID
  fileLocks?: Record<string, string>;  // ★ 恢复时重建文件锁
}

function ensureDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

/** 标记会话开始 */
export function lockSession(sessionId: string): void {
  ensureDir();
  writeFileSync(LOCK_FILE, JSON.stringify({ id: sessionId, startedAt: Date.now() }));
}

/** 解除会话锁（正常退出时调用） */
export function unlockSession(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* 不存在无所谓 */ }
}

/** 检查是否有未完成的上次会话 */
export function hasUnfinishedSession(): boolean {
  try {
    if (!existsSync(LOCK_FILE)) return false;
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    const path = sessionPath(lock.id);
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 恢复上次未完成的会话 */
export function loadSession(): SessionData | null {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    const path = sessionPath(lock.id);

    // 新格式优先
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }

    // 旧格式回退：{id}.json（扁平文件）
    const oldPath = oldSessionPath(lock.id);
    if (existsSync(oldPath)) {
      const data = JSON.parse(readFileSync(oldPath, 'utf-8'));
      // 自动 migrate 到新格式
      mkdirSync(sessionDir(lock.id), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 2));
      unlinkSync(oldPath);
      return data;
    }

    return null;
  } catch {
    return null;
  }
}

/** 保存当前会话到磁盘 */
export function saveSession(id: string, messages: Array<{ role: string; content: unknown }>, toolCount: number, treeId?: string): void {
  ensureDir();
  mkdirSync(sessionDir(id), { recursive: true });
  const data: SessionData = {
    id,
    startedAt: Date.now(),
    messages,
    toolCount,
  };
  if (treeId) data.treeId = treeId;
  // TODO: fileLocks 持久化 — fileOwnershipMap 是内存结构，序列化成本高，暂不做深度持久化。
  // 恢复时 fileLocks 传 undefined，由 file_tracker 在运行时重新构建锁状态。
  writeFileSync(sessionPath(id), JSON.stringify(data, null, 2));
}

/** 列出历史会话 */
export function listSessions(): Array<{ id: string; path: string }> {
  try {
    ensureDir();
    return readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ id: d.name, path: sessionPath(d.name) }))
      .sort((a, b) => b.id.localeCompare(a.id));
  } catch {
    return [];
  }
}
