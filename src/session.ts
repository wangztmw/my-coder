/**
 * 会话持久化 — 保存到 ~/.mycoder/sessions/
 *
 * 每次 agent 对话完成时自动保存。启动时检测未完成会话可恢复。
 * 崩溃/断电后不会丢失对话上下文。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSION_DIR = join(homedir(), '.mycoder', 'sessions');
const LOCK_FILE = join(SESSION_DIR, '.lock');

export interface SessionData {
  id: string;
  startedAt: number;
  messages: Array<{ role: string; content: unknown }>;
  toolCount: number;
}

function ensureDir() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(SESSION_DIR, `${id}.json`);
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
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** 保存当前会话到磁盘 */
export function saveSession(id: string, messages: Array<{ role: string; content: unknown }>, toolCount: number): void {
  ensureDir();
  const data: SessionData = {
    id,
    startedAt: Date.now(),
    messages,
    toolCount,
  };
  writeFileSync(sessionPath(id), JSON.stringify(data, null, 2));
}

/** 列出历史会话 */
export function listSessions(): Array<{ id: string; path: string }> {
  try {
    ensureDir();
    return readdirSync(SESSION_DIR)
      .filter(f => f.endsWith('.json') && f !== '.lock')
      .map(f => ({ id: f.replace('.json', ''), path: join(SESSION_DIR, f) }))
      .sort((a, b) => b.id.localeCompare(a.id));
  } catch {
    return [];
  }
}
