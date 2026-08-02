import { z } from 'zod/v4';
import { buildTool } from '../Tool.js';
import { DESCRIPTION } from './prompt.js';
const inputSchema = z.object({
    description: z.string().describe('Short (3-5 word) description'),
    prompt: z.string().describe('The task for the sub-agent to complete. Be specific.'),
    subagent_type: z.enum(['general-purpose', 'explore']).optional(),
    run_in_background: z.boolean().optional().describe('Run in background; you will be notified when complete.'),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tasks = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _runSubAgent = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _buildSubAgentContext = null;
let _notify = null;
export function initAgentTool(deps) {
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
    async call({ description, prompt, subagent_type: _type, run_in_background }, _ctx) {
        if (!_tasks || !_runSubAgent || !_buildSubAgentContext || !_notify) {
            return { data: 'Agent system not initialized.' };
        }
        const id = 'a' + Math.random().toString(36).slice(2, 10);
        const msgs = _buildSubAgentContext(prompt);
        // 在共享 taskRegistry 里创建 TaskState
        _tasks.set(id, {
            id, type: 'local_agent', status: 'running', subject: description,
            startTime: Date.now(),
            agentLoop: { roundCount: 0, toolUseCount: 0 },
            abortController: new AbortController(),
        });
        if (run_in_background) {
            _runSubAgent(msgs, id).then(result => {
                const t = _tasks.get(id);
                if (t) {
                    t.status = 'completed';
                    t.endTime = Date.now();
                    t.output = result;
                }
                const active = [..._tasks.values()].filter((x) => x.status === 'running').length;
                _notify(`[Agent "${description}" completed${active > 0 ? ` — ${active} running` : ''}]:\n${result.slice(0, 1000)}`);
            }).catch(err => {
                const t = _tasks.get(id);
                if (t) {
                    t.status = 'failed';
                    t.endTime = Date.now();
                    t.output = `(crashed: ${err.message})`;
                }
                _notify(`[Agent "${description}" failed]: ${err.message}`);
            });
            return { data: `Agent spawned: ${id} ("${description}" running in background)` };
        }
        // 同步模式
        const result = await _runSubAgent(msgs, id);
        const t = _tasks.get(id);
        if (t) {
            t.status = 'completed';
            t.endTime = Date.now();
            t.output = result;
        }
        return { data: `[Agent "${description}" report]:\n${result}` };
    },
    async prompt() { return `## Agent\n${DESCRIPTION}\nInput: { description, prompt, subagent_type?, run_in_background? }`; },
    userFacingName: () => 'Agent',
    getToolUseSummary({ description }) { return description ? `Agent: ${description}` : 'Agent'; },
});
