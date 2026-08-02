import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';

const inputSchema = z.object({
  description: z.string().describe('Short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the sub-agent to complete. Be specific.'),
  subagent_type: z.enum(['general-purpose', 'explore']).optional().default('general-purpose'),
  run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete.'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _runSubAgent: ((messages: any[], taskId?: string) => Promise<string>) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _buildSubAgentContext: ((task: string) => any[]) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sessionMessages: any[] | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _createTask: ((type: any, desc: string) => any) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _completeTask: ((id: string, out: string) => void) | null = null;

export function initSubAgent(deps: {
  runSubAgent: NonNullable<typeof _runSubAgent>;
  buildSubAgentContext: NonNullable<typeof _buildSubAgentContext>;
  sessionMessages: NonNullable<typeof _sessionMessages>;
  createTask: NonNullable<typeof _createTask>;
  completeTask: NonNullable<typeof _completeTask>;
}) {
  _runSubAgent = deps.runSubAgent;
  _buildSubAgentContext = deps.buildSubAgentContext;
  _sessionMessages = deps.sessionMessages;
  _createTask = deps.createTask;
  _completeTask = deps.completeTask;
}

export const AgentTool = buildTool({
  name: 'Agent',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call({ description, prompt, run_in_background }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    if (!_runSubAgent || !_buildSubAgentContext || !_sessionMessages) {
      return { data: 'Sub-agent system not initialized.' };
    }

    const messages = _buildSubAgentContext(prompt);

    if (run_in_background && _createTask && _completeTask) {
      const task = _createTask('local_agent', description);
      _runSubAgent(messages, task.id).then(result => {
        _completeTask!(task.id, result);
        _sessionMessages!.push({
          role: 'user',
          content: `[Agent "${description}" completed]:\n${result.slice(0, 1000)}`,
        });
      });
      return { data: `Agent spawned: ${task.id} ("${description}" running in background)` };
    }

    const result = await _runSubAgent(messages);
    return { data: `[Agent "${description}" report]:\n${result}` };
  },

  async prompt() { return `## Agent\n${DESCRIPTION}\nInput: { description, prompt, subagent_type?, run_in_background? }`; },
  userFacingName: () => 'Agent',
  getToolUseSummary({ description }: Partial<z.infer<typeof inputSchema>>) { return description ? `Agent: ${description}` : 'Agent'; },
});
