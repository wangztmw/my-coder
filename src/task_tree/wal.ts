/**
 * 任务树系统 — WAL（预写日志）模块
 *
 * 设计：
 * - Append-only JSON 行文件，每条日志一行。
 * - 每次写操作前先写 WAL，再执行实际树变更（Write-Ahead）。
 * - 崩溃恢复：loadTree（全量快照）→ replayWal（增量 WAL）→ 重建最新状态。
 * - Compaction：全量快照后删除 WAL，减少回放开销。
 * - 7 天自动清理过期 WAL 文件。
 *
 * 依赖：types.ts（类型）、tree.ts（saveTree，用于 compaction）
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WalEntry, TaskTree } from './types.js';
import { saveTree } from './persist.js';
import { walPath, sessionDir, OLD_WAL_DIR } from './paths.js';

// ---- 常量 ----

/** WAL 条目数达到此阈值时触发 compaction */
export const COMPACTION_THRESHOLD = 50;

// ---- 运行时状态 ----

/** 每个 session 的 WAL 序列号计数器（运行时，重启后通过 initWal 恢复） */
const seqCounters = new Map<string, number>();

// ---- 路径工具 ----

/** 确保 WAL 目录存在（幂等） */
function ensureDir(sessionId: string): void {
  try {
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    console.error(`[WAL] 创建 WAL 目录失败: ${sessionDir(sessionId)}`, e);
    throw e;
  }
}

// ---- 公开 API ----

/**
 * 初始化 WAL 子系统。
 *
 * - 创建 WAL 目录（如不存在）。
 * - 从已有 WAL 文件恢复 seq 计数器（取最大 seq，确保单调递增）。
 *
 * @param sessionId - 会话 ID
 */
export function initWal(sessionId: string): void {
  ensureDir(sessionId);

  try {
    const entries = readWal(sessionId);
    if (entries.length > 0) {
      const maxSeq = entries.reduce((max, e) => Math.max(max, e.seq), 0);
      seqCounters.set(sessionId, maxSeq + 1);
    } else {
      seqCounters.set(sessionId, 0);
    }
  } catch (e) {
    console.error(`[WAL] initWal 恢复 seq 失败，从 0 开始。sessionId=${sessionId}`, e);
    seqCounters.set(sessionId, 0);
  }
}

/**
 * 追加一条 WAL 日志。
 *
 * append-only 追加到 WAL 文件末尾，seq 自增。
 * 任何磁盘错误都会被捕获并记录——WAL 写入失败不抛出让调用者崩溃。
 *
 * @param sessionId - 会话 ID
 * @param nodeId    - 涉及的树节点 ID
 * @param event     - 事件类型
 * @param payload   - 可选的事件载荷
 */
export function appendWal(
  sessionId: string,
  nodeId: string,
  event: WalEntry['event'],
  payload?: WalEntry['payload'],
): void {
  ensureDir(sessionId);

  const seq = seqCounters.get(sessionId) ?? 0;
  seqCounters.set(sessionId, seq + 1);

  const entry: WalEntry = {
    seq,
    ts: Date.now(),
    sessionId,
    nodeId,
    event,
    payload: payload ?? {},
  };

  try {
    appendFileSync(walPath(sessionId), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error(
      `[WAL] 写入 WAL 失败: sessionId=${sessionId}, seq=${seq}, event=${event}`,
      e,
    );
    // 不回滚 seq——序号已消耗，保证后续条目 seq 唯一
  }
}

/**
 * 读取指定 session 的 WAL 文件全部条目，按 seq 升序排列。
 *
 * 如果 WAL 文件不存在或无法解析，返回空数组。
 *
 * @param sessionId - 会话 ID
 * @returns 按 seq 排序的 WAL 条目数组
 */
export function readWal(sessionId: string): WalEntry[] {
  const path = walPath(sessionId);

  try {
    if (!existsSync(path)) {
      return [];
    }

    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');

    const entries: WalEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as WalEntry;
        entries.push(entry);
      } catch {
        // 单行解析失败——跳过损坏行，继续解析其余行
        console.warn(`[WAL] 跳过损坏的 WAL 行: ${line.slice(0, 80)}...`);
      }
    }

    entries.sort((a, b) => a.seq - b.seq);
    return entries;
  } catch (e) {
    console.error(`[WAL] 读取 WAL 失败: ${path}`, e);
    return [];
  }
}

/**
 * 回放 WAL → 在内存 Tree 对象上重建最新状态。
 *
 * 不写磁盘——调用者负责在回放后调用 saveTree 持久化。
 * 按 seq 顺序逐条 apply，处理规则：
 *
 * | event            | 行为                                          |
 * |------------------|-----------------------------------------------|
 * | node_dispatched  | status → 'running', assignedAgentId → agentId |
 * | node_completed   | status → 'completed', result → payload.result |
 * | node_failed      | status → 'failed'                             |
 * | node_blocked     | status → 'blocked'                            |
 * | node_replanned   | replanCount++                                 |
 * | child_added      | 向节点 children 追加（去重）                   |
 * | subtree_replaced | 删除旧 children，加入新 children               |
 * | node_created     | 如果节点不存在，创建最小占位节点               |
 *
 * @param sessionId - 会话 ID（用于日志）
 * @param tree      - 已加载的最新全量快照 Tree
 * @returns 回放后的 Tree（同一个对象的引用，已原地修改）
 */
export function replayWal(sessionId: string, tree: TaskTree): TaskTree {
  const entries = readWal(sessionId);

  if (entries.length === 0) {
    return tree;
  }

  for (const entry of entries) {
    try {
      applyEntry(entry, tree);
    } catch (e) {
      console.error(
        `[WAL] 回放条目失败: sessionId=${sessionId}, seq=${entry.seq}, event=${entry.event}`,
        e,
      );
      // 跳过损坏条目，继续回放后续条目（尽力恢复）
    }
  }

  return tree;
}

/**
 * Compaction：将当前树状态保存为全量快照，然后删除 WAL 文件。
 *
 * ★ 关键顺序：先 saveTree → 再 unlinkSync WAL。绝不反序。
 *   如果先删 WAL 再 saveTree，中间崩溃则数据永久丢失。
 *
 * 调用者负责：
 * - 外部持有 TreeWriteLock
 * - 确认 WAL 条目数 >= COMPACTION_THRESHOLD 后才调用
 * - 传入已加载的最新 tree
 *
 * @param sessionId - 会话 ID
 * @param tree      - 当前完整的 TaskTree
 */
export function compactWal(sessionId: string, tree: TaskTree): void {
  const path = walPath(sessionId);

  // 如果 WAL 文件不存在，跳过（可能已被其他进程 compact 或尚未创建）
  if (!existsSync(path)) {
    return;
  }

  try {
    // ★ 步骤 1：先保存全量快照（原子写入）
    saveTree(tree);

    // ★ 步骤 2：再删除 WAL 文件
    // 如果步骤 1 成功但步骤 2 失败（如权限问题），
    // 下次启动时 WAL 条目会被重新回放（idempotent → 安全）
    unlinkSync(path);

    // 重置 seq 计数器——compaction 后从 0 重新开始
    seqCounters.set(sessionId, 0);
  } catch (e) {
    console.error(`[WAL] compaction 失败: sessionId=${sessionId}`, e);
    throw e;
  }
}

/**
 * 清理旧格式残留的 WAL 文件。
 *
 * 新格式 WAL 存储在会话目录内（sessionDir/wal.jsonl），
 * 由 persist.ts 的 cleanOldSessions 统一清理。
 * 此函数仅清理迁移前 OLD_WAL_DIR 下的 .wal 残留文件。
 */
export function cleanOldWals(): void {
  try {
    if (!existsSync(OLD_WAL_DIR)) {
      return;
    }

    const files = readdirSync(OLD_WAL_DIR);
    for (const file of files) {
      if (!file.endsWith('.wal')) {
        continue;
      }

      const filePath = join(OLD_WAL_DIR, file);
      try {
        unlinkSync(filePath);
        console.log(`[WAL] 清理旧格式 WAL: ${file}`);
      } catch (e) {
        console.error(`[WAL] 清理旧 WAL 文件失败: ${filePath}`, e);
      }
    }
  } catch (e) {
    console.error('[WAL] cleanOldWals 遍历旧目录失败', e);
  }
}

// ---- 内部辅助 ----

/**
 * 将单条 WAL 条目 apply 到内存 tree 对象（原地修改）。
 *
 * @param entry - WAL 条目
 * @param tree  - 内存树（会被修改）
 */
function applyEntry(entry: WalEntry, tree: TaskTree): void {
  const node = tree.nodes[entry.nodeId];

  // node_created: 如果节点不存在于快照中，创建一个最小占位节点
  // （通常节点已在快照中存在——WAL 仅记录状态变更）
  if (entry.event === 'node_created') {
    if (!node) {
      tree.nodes[entry.nodeId] = {
        id: entry.nodeId,
        parentId: null,
        meaning: '',
        context: { files: [], concepts: [] },
        task: '',
        role: 'worker',
        status: 'pending',
        assignedAgentId: entry.payload.agentId ?? null,
        depth: 0,
        maxRounds: 10,
        tools: null,
        result: null,
        replanCount: 0,
        children: [],
        touchedFiles: { read: [], written: [] },
      };
    }
    return;
  }

  // 其余事件需要目标节点存在
  if (!node) {
    console.warn(
      `[WAL] replay: 节点 ${entry.nodeId} 不存在于快照中，跳过 event=${entry.event} seq=${entry.seq}`,
    );
    return;
  }

  switch (entry.event) {
    case 'node_dispatched':
      node.status = 'running';
      node.assignedAgentId = entry.payload.agentId ?? node.assignedAgentId;
      break;

    case 'node_completed':
      node.status = 'completed';
      node.result = entry.payload.result ?? node.result;
      break;

    case 'node_failed':
      node.status = 'failed';
      node.result = entry.payload.reason ?? node.result;
      break;

    case 'node_blocked':
      node.status = 'blocked';
      break;

    case 'node_replanned':
      node.replanCount += 1;
      break;

    case 'child_added': {
      // 向 node.children 追加新 childId（去重）
      // nodeId 是父节点 ID，childId 在 payload 中
      const childId = entry.payload.childId;
      if (childId && !node.children.includes(childId)) {
        node.children.push(childId);
      }
      break;
    }

    case 'subtree_replaced': {
      // 删除旧 children，加入新 children
      // 同时将旧 children 对应节点从 tree.nodes 中移除
      if (entry.payload.oldChildren) {
        for (const oldId of entry.payload.oldChildren) {
          delete tree.nodes[oldId];
        }
      }
      node.children = entry.payload.newChildren ?? [];
      break;
    }

    case 'children_all_done':
      // children_all_done 是派生状态，WAL 回放时不需修改节点
      // 崩溃恢复后在 resume.ts 中重算
      break;

    default:
      // 忽略未知事件类型（向前兼容）
      console.warn(`[WAL] replay: 未知事件类型 ${(entry as { event: string }).event}`);
  }
}
