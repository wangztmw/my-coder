import { z } from 'zod/v4';
import { buildTool, type ToolUseContext, type ToolResult } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';
import { addMember, completeMember } from '../../agent_team.js';
import type { AgentEngine } from '../../agent_def.js';
import { agentLoop } from '../../session_loop.js';
import type { ChatMessage } from '../../llm/types.js';

const inputSchema = z.object({
  description: z.string().describe('Short (3-5 word) description'),
  prompt: z.string().describe('The task for the sub-agent to complete. Be specific.'),
  subagent_type: z.enum(['general-purpose', 'explore']).optional(),
  run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete.'),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tasks: Map<string, any> | null = null;
let _engine: AgentEngine | null = null;
let _notify: ((msg: string) => void) | null = null;

export function initAgentTool(deps: {
  taskRegistry: Map<string, any>;
  engine: AgentEngine;
  notify: (msg: string) => void;
}) {
  _tasks = deps.taskRegistry;
  _engine = deps.engine;
  _notify = deps.notify;
}

export const AgentTool = buildTool({
  name: 'Agent',
  inputSchema,
  async description() { return DESCRIPTION; },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call({ description, prompt, subagent_type: _type, run_in_background }: z.infer<typeof inputSchema>, _ctx: ToolUseContext): Promise<ToolResult<string>> {
    if (!_tasks || !_engine || !_notify) {
      return { data: 'Agent system not initialized.' };
    }

    const task = addMember('local_agent', description, prompt.slice(0, 200));
    const messages: ChatMessage[] = [
      { role: 'user', content: `Complete this task:\n${prompt}\n\nReturn a concise report.` },
    ];

    const subConfig = {
      messages,
      maxRounds: 10,
      serialTools: true as const,  // ★ 子Agent保持串行
      onComplete: (text: string) => { completeMember(task.id, text); },
      preRoundCheck: () => {
        if (task.pendingInstruction) {
          messages.push({ role: 'user', content: `[MAIN AGENT INSTRUCTION — follow this]: ${task.pendingInstruction}` });
          task.pendingInstruction = undefined;
          return null;
        }
        if (task.abortController?.signal.aborted) {
          task.status = 'killed';
          return '(killed)';
        }
        return null;
      },
      updateStats: (name: string, summary: string, output: string, feedback?: string) => {
        if (task.agentLoop) {
          task.agentLoop.lastActivity = `${name}(${summary})`;
          task.agentLoop.lastOutput = output.slice(0, 200);
        }
        if (feedback) {
          task.feedback = feedback;
          task.feedbackAt = Date.now();
          if (feedback.startsWith('BLOCKED:')) task.status = 'blocked';
        }
      },
    };

    if (run_in_background) {
      // 后台执行：pending → agentLoop → completeMember
      agentLoop(_engine, subConfig).then(result => {
        completeMember(task.id, result);
        const active = [..._tasks!.values()].filter((x: any) => x.status === 'running').length;
        _notify!(`[Agent "${description}" completed${active > 0 ? ` — ${active} running` : ''}]:\n${result.slice(0, 1500)}${result.length > 1500 ? `\n... (${result.length - 1500} more chars. Use AgentTeam(check, ${task.id}) for full report.)` : ''}`);
      }).catch(err => {
        const t = _tasks!.get(task.id) as any;
        if (t) { t.status = 'failed'; t.endTime = Date.now(); t.output = `(crashed: ${(err as Error).message})`; }
        _notify!(`[Agent "${description}" failed]: ${(err as Error).message}`);
      });
      return { data: `Agent spawned: ${task.id} ("${description}" pending in background)` };
    }

    // 同步模式：pending → agentLoop → completeMember
    try {
      const result = await agentLoop(_engine, subConfig);
      completeMember(task.id, result);
      return { data: `[Agent "${description}" report]:\n${result}` };
    } catch (e) {
      task.status = 'failed';
      task.endTime = Date.now();
      task.output = `(crashed: ${(e as Error).message})`;
      return { data: `Agent error: ${(e as Error).message}` };
    }
  },

  async prompt() { return `## Agent\n${DESCRIPTION}\nInput: { description, prompt, subagent_type?, run_in_background? }`; },
  userFacingName: () => 'Agent',
  getToolUseSummary({ description }: Partial<z.infer<typeof inputSchema>>) { return description ? `Agent: ${description}` : 'Agent'; },
});
