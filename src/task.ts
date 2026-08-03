/**
 * Task 生命周期管理 — 共享状态注册表 + 磁盘持久化
 *
 * 主 Agent / 子 Agent / 后台 Bash 三方通过此模块读写任务状态。
 * 输出原子写入磁盘（tmp + rename），内存只存摘要。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

export interface TaskState {
  id: string;
  type: 'local_agent' | 'local_bash';
  status: TaskStatus;
  subject: string;
  description?: string;
  startTime: number;
  endTime?: number;
  output?: string;           // 内存摘要（前 500 字），完整内容在磁盘
  outputFile: string;        // ~/.mycoder/tasks/{id}.txt
  outputOffset: number;      // 当前写入偏移量（增量追加）
  notified: boolean;         // 完成通知是否已发送（防重复）
  toolUseId?: string;        // LLM 工具调用 id，可追溯到创建时机
  abortController?: AbortController;
  agentLoop?: {
    roundCount: number;
    toolUseCount: number;
    lastActivity?: string;
    lastOutput?: string;
  };
  pendingInstruction?: string;
}

const TASK_DIR = join(homedir(), '.mycoder', 'tasks');
const taskRegistry = new Map<string, TaskState>();

function ensureTaskDir() {
  if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });
}

function taskOutputPath(id: string): string {
  return join(TASK_DIR, `${id}.txt`);
}

/** 原子写磁盘：先写 tmp 再 rename，防止写一半崩溃留下损坏文件 */
export function saveTaskOutput(id: string, text: string): void {
  ensureTaskDir();
  const path = taskOutputPath(id);
  const tmp = path + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** 读取完整磁盘输出 */
export function readTaskOutput(id: string): string {
  try { return readFileSync(taskOutputPath(id), 'utf-8'); } catch { return ''; }
}

/** 启动时清理 7 天前旧文件 */
export function cleanOldTasks(): void {
  try {
    if (!existsSync(TASK_DIR)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(TASK_DIR)) {
      const p = join(TASK_DIR, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* 静默 */ }
}

export function createTask(type: 'local_agent' | 'local_bash', subject: string, desc?: string): TaskState {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const task: TaskState = {
    id, type, status: 'pending', subject,
    description: desc,
    startTime: Date.now(),
    outputFile: taskOutputPath(id),
    outputOffset: 0,
    notified: false,
    abortController: new AbortController(),
  };
  if (type === 'local_agent') task.agentLoop = { roundCount: 0, toolUseCount: 0 };
  taskRegistry.set(id, task);
  return task;
}

export function completeTask(id: string, output: string) {
  const t = taskRegistry.get(id);
  if (t) {
    t.status = 'completed';
    t.endTime = Date.now();
    t.output = output.slice(0, 500); // 内存存摘要
    t.outputOffset = output.length;
    saveTaskOutput(id, output);       // 完整内容写磁盘
  }
}

export function appendTaskOutput(id: string, text: string) {
  const t = taskRegistry.get(id);
  if (t) {
    t.output = text.slice(-500);      // 内存只保留最后 500 字
    t.outputOffset += text.length;
    saveTaskOutput(id, text);
  }
}

export function getTask(id: string): TaskState | undefined {
  return taskRegistry.get(id);
}

export function getTaskRegistry(): Map<string, TaskState> {
  return taskRegistry;
}
