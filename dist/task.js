/**
 * Task 生命周期管理
 * 主 Agent 与子 Agent / 后台 Bash 的统一任务注册表
 */
const taskRegistry = new Map();
export function createTask(type, subject, desc) {
    const id = type[0] + Math.random().toString(36).slice(2, 10);
    const task = { id, type, status: 'running', subject, description: desc, startTime: Date.now() };
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
        t.output = output;
    }
}
export function getTask(id) {
    return taskRegistry.get(id);
}
export function getTaskRegistry() {
    return taskRegistry;
}
