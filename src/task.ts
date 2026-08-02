/**
 * Task 生命周期管理
 * 主 Agent 与子 Agent / 后台 Bash 的统一任务注册表
 */

export interface TaskState {
  id: string;
  type: 'local_agent' | 'local_bash';
  status: 'running' | 'completed' | 'failed' | 'killed';
  subject: string;
  description?: string;
  startTime: number;
  endTime?: number;
  output?: string;
  abortController?: AbortController;
  agentLoop?: {
    roundCount: number;
    toolUseCount: number;
    lastActivity?: string;
    lastOutput?: string;
  };
  pendingInstruction?: string;
}

const taskRegistry = new Map<string, TaskState>();

export function createTask(type: 'local_agent' | 'local_bash', subject: string, desc?: string): TaskState {
  const id = type[0] + Math.random().toString(36).slice(2, 10);
  const task: TaskState = { id, type, status: 'running', subject, description: desc, startTime: Date.now() };
  if (type === 'local_agent') task.agentLoop = { roundCount: 0, toolUseCount: 0 };
  taskRegistry.set(id, task);
  return task;
}

export function completeTask(id: string, output: string) {
  const t = taskRegistry.get(id);
  if (t) { t.status = 'completed'; t.endTime = Date.now(); t.output = output; }
}

export function getTask(id: string): TaskState | undefined {
  return taskRegistry.get(id);
}

export function getTaskRegistry(): Map<string, TaskState> {
  return taskRegistry;
}
