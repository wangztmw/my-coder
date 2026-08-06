/**
 * 存储路径工具 — 所有模块通过此文件获取路径，避免各自硬编码。
 *
 * 会话目录结构:
 *   ~/.mycoder/sessions/{sessionId}/
 *     session.json       — 对话
 *     tree.json          — 任务树
 *     wal.jsonl          — 预写日志
 *     agents/            — Agent 输出
 *       {agentId}.txt
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = join(homedir(), '.mycoder');

/** 会话根目录 */
export const SESSIONS_DIR = join(BASE, 'sessions');

/** 特定会话的目录 */
export function sessionDir(id: string): string { return join(SESSIONS_DIR, id); }

/** 会话文件路径 */
export function sessionPath(id: string): string { return join(sessionDir(id), 'session.json'); }

/** 树文件路径 */
export function treePath(id: string): string { return join(sessionDir(id), 'tree.json'); }

/** WAL 文件路径 */
export function walPath(id: string): string { return join(sessionDir(id), 'wal.jsonl'); }

/** Agent 输出目录 */
export function agentDir(sessionId: string): string { return join(sessionDir(sessionId), 'agents'); }

/** Agent 输出文件路径 */
export function agentOutputPath(sessionId: string, agentId: string): string { return join(agentDir(sessionId), `${agentId}.txt`); }

// ---- 旧格式路径（迁移窗口期使用，v0.7.0 后可移除）----

/** 旧树目录 */
export const OLD_TREE_DIR = join(BASE, 'trees');
/** 旧 WAL 目录 */
export const OLD_WAL_DIR = join(OLD_TREE_DIR, 'wal');
/** 旧树文件路径 */
export function oldTreePath(id: string): string { return join(OLD_TREE_DIR, `${id}.json`); }
/** 旧会话文件路径 */
export function oldSessionPath(id: string): string { return join(SESSIONS_DIR, `${id}.json`); }
