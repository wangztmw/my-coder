/**
 * Task 生命周期管理 — 共享状态注册表 + 磁盘持久化
 *
 * 主 Agent / 子 Agent / 后台 Bash 三方通过此模块读写任务状态。
 * 输出原子写入磁盘（tmp + rename），内存只存摘要。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const TASK_DIR = join(homedir(), '.mycoder', 'tasks');
const taskRegistry = new Map();
function ensureTaskDir() {
    if (!existsSync(TASK_DIR))
        mkdirSync(TASK_DIR, { recursive: true });
}
function taskOutputPath(id) {
    return join(TASK_DIR, `${id}.txt`);
}
/** 原子写磁盘：先写 tmp 再 rename，防止写一半崩溃留下损坏文件 */
export function saveTaskOutput(id, text) {
    ensureTaskDir();
    const path = taskOutputPath(id);
    const tmp = path + '.tmp';
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}
/** 读取完整磁盘输出 */
export function readTaskOutput(id) {
    try {
        return readFileSync(taskOutputPath(id), 'utf-8');
    }
    catch {
        return '';
    }
}
/** 启动时清理 7 天前旧文件 */
export function cleanOldTasks() {
    try {
        if (!existsSync(TASK_DIR))
            return;
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const f of readdirSync(TASK_DIR)) {
            const p = join(TASK_DIR, f);
            try {
                if (statSync(p).mtimeMs < cutoff)
                    unlinkSync(p);
            }
            catch { /* skip */ }
        }
    }
    catch { /* 静默 */ }
}
export function createTask(type, subject, desc) {
    const id = type[0] + Math.random().toString(36).slice(2, 10);
    const task = {
        id, type, status: 'pending', subject,
        description: desc,
        startTime: Date.now(),
        outputFile: taskOutputPath(id),
        outputOffset: 0,
        notified: false,
        abortController: new AbortController(),
    };
    if (type === 'local_agent')
        task.agentLoop = { roundCount: 0, toolUseCount: 0 };
    taskRegistry.set(id, task);
    return task;
}
export function completeTask(id, output) {
    const t = taskRegistry.get(id);
    if (t) {
        t.status = 'completed';
        t.endTime = Date.now();
        t.output = output.slice(0, 500); // 内存存摘要
        t.outputOffset = output.length;
        saveTaskOutput(id, output); // 完整内容写磁盘
    }
}
export function appendTaskOutput(id, text) {
    const t = taskRegistry.get(id);
    if (t) {
        t.output = text.slice(-500); // 内存只保留最后 500 字
        t.outputOffset += text.length;
        saveTaskOutput(id, text);
    }
}
export function getTask(id) {
    return taskRegistry.get(id);
}
export function getTaskRegistry() {
    return taskRegistry;
}
