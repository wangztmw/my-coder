import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';
import { createTask, completeTask } from '../../task.js';

const inputSchema = z.object({
  description: z.string().describe('Short (3-5 word) description'),
  prompt: z.string().describe('The task for the sub-agent to complete. Be specific.'),
  subagent_type: z.enum(['general-purpose', 'explore']).optional(),
  run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete.'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tasks: Map<string, any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _runSubAgent: ((messages: any[], agentId: string) => Promise<string>) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _buildSubAgentContext: ((task: string) => any[]) | null = null;
let _notify: ((msg: string) => void) | null = null;

export function initAgentTool(deps: {
  taskRegistry: Map<string, any>;
  runSubAgent: (...args: any[]) => Promise<string>;
  buildSubAgentContext: (task: string) => any[];
  notify: (msg: string) => void;
}) {
  _tasks = deps.taskRegistry;
  _runSubAgent = deps.runSubAgent;
  _buildSubAgentContext = deps.buildSubAgentContext;
  _notify = deps.notify;
}

export const AgentTool = buildTool({
  name: 'Agent',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call({ description, prompt, subagent_type: _type, run_in_background }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    if (!_tasks || !_runSubAgent || !_buildSubAgentContext || !_notify) {
      return { data: 'Agent system not initialized.' };
    }

    // Phase 56: 使用 createTask 创建 pending 状态任务
    const task = createTask('local_agent', description, prompt.slice(0, 200));
    const msgs = _buildSubAgentContext(prompt);

    if (run_in_background) {
      // 后台执行：pending → running → completeTask
      _runSubAgent(msgs, task.id).then(result => {
        completeTask(task.id, result);
        const active = [..._tasks!.values()].filter((x: any) => x.status === 'running').length;
        _notify!(`[Agent "${description}" completed${active > 0 ? ` — ${active} running` : ''}]:\n${result.slice(0, 1500)}${result.length > 1500 ? `\n... (${result.length - 1500} more chars. Use Task(check, ${task.id}) for full report.)` : ''}`);
      }).catch(err => {
        const t = _tasks!.get(task.id) as any;
        if (t) { t.status = 'failed'; t.endTime = Date.now(); t.output = `(crashed: ${(err as Error).message})`; }
        _notify!(`[Agent "${description}" failed]: ${(err as Error).message}`);
      });
      return { data: `Agent spawned: ${task.id} ("${description}" pending in background)` };
    }

    // 同步模式：pending → 执行 → completeTask
    const result = await _runSubAgent(msgs, task.id);
    completeTask(task.id, result);
    return { data: `[Agent "${description}" report]:\n${result}` };
  },

  async prompt() { return `## Agent\n${DESCRIPTION}\nInput: { description, prompt, subagent_type?, run_in_background? }`; },
  userFacingName: () => 'Agent',
  getToolUseSummary({ description }: Partial<z.infer<typeof inputSchema>>) { return description ? `Agent: ${description}` : 'Agent'; },
});
