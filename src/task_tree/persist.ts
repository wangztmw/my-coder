/**
 * 任务树系统 — 持久化模块
 *
 * 负责 TaskTree 的磁盘读写与过期清理。
 * 本模块不 import lock.ts —— 加锁由调用者在更外层处理。
 * 所有磁盘操作均有 try-catch，错误通过 console.error 输出。
 */

import { join } from 'path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from 'fs';
import type { TaskTree } from './types.js';
import { treePath, sessionDir, SESSIONS_DIR, oldTreePath, OLD_TREE_DIR } from './paths.js';

// ---- 内部工具函数 ----

/**
 * 确保指定 session 的目录存在。
 * 幂等：已存在时不报错。
 */
function ensureDirs(sessionId: string): void {
  try {
    mkdirSync(sessionDir(sessionId), { recursive: true });
  } catch (e) {
    console.error(`[persist] ensureDirs failed for session "${sessionId}":`, e);
  }
}

// ---- 导出函数 ----

/**
 * 原子保存任务树到磁盘。
 *
 * 流程：先 ensureDirs，再 writeFileSync(tmp) → renameSync(tmp, target)。
 * 若 renameSync 抛出 EXDEV（跨文件系统），回退到 copyFileSync + unlinkSync。
 * 写入前自动更新 tree.updatedAt。
 *
 * @param tree - 要持久化的任务树
 */
export function saveTree(tree: TaskTree): void {
  try {
    ensureDirs(tree.sessionId);
    const target = treePath(tree.sessionId);
    const tmp = target + '.tmp';

    tree.updatedAt = Date.now();
    writeFileSync(tmp, JSON.stringify(tree, null, 2), 'utf-8');

    try {
      renameSync(tmp, target);
    } catch (e: any) {
      if (e.code === 'EXDEV') {
        // 跨文件系统回退：复制后删除临时文件
        copyFileSync(tmp, target);
        unlinkSync(tmp);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error(`[persist] saveTree failed for session "${tree.sessionId}":`, e);
  }
}

/**
 * 从磁盘加载任务树，自动迁移旧格式。
 *
 * @param sessionId - 会话 ID
 * @returns 解析成功的 TaskTree，若文件不存在或 JSON 损坏则返回 null
 */
export function loadTree(sessionId: string): TaskTree | null {
  // 1. 新格式
  const newPath = treePath(sessionId);
  if (existsSync(newPath)) {
    try {
      const raw = readFileSync(newPath, 'utf-8');
      return JSON.parse(raw) as TaskTree;
    } catch (e) {
      console.error(`[persist] loadTree: corrupted file for "${sessionId}":`, e);
      return null;
    }
  }
  // 2. 旧格式 → 自动迁移
  const oldPath = oldTreePath(sessionId);
  if (existsSync(oldPath)) {
    try {
      const raw = readFileSync(oldPath, 'utf-8');
      const tree = JSON.parse(raw) as TaskTree;
      saveTree(tree); // 写到新位置
      try { unlinkSync(oldPath); } catch {}
      return tree;
    } catch (e) {
      console.error(`[persist] loadTree: failed to migrate old format for "${sessionId}":`, e);
      return null;
    }
  }
  return null;
}

/**
 * 清理超过指定时长的旧会话目录及旧格式残留。
 *
 * @param maxAgeMs - 最大保留时长（毫秒），默认 7 天
 */
export function cleanOldSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  try {
    if (!existsSync(SESSIONS_DIR)) return;
    const cutoff = Date.now() - maxAgeMs;
    const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const treeFile = treePath(d.name);
      try {
        if (statSync(treeFile).mtimeMs < cutoff) rmSync(sessionDir(d.name), { recursive: true, force: true });
      } catch { /* 目录可能已被清理 */ }
    }
    // 清理旧 trees/ 目录下的残留
    if (existsSync(OLD_TREE_DIR)) {
      for (const f of readdirSync(OLD_TREE_DIR)) {
        if (f.endsWith('.json') || f.endsWith('.tmp')) {
          const p = join(OLD_TREE_DIR, f);
          try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch {}
        }
      }
    }
  } catch { /* 静默 */ }
}
