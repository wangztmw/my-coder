export const DESCRIPTION = `Launch a sub-agent to handle complex tasks. REQUIRED for: research, investigation, multi-file work, parallel searches.
- Spawn multiple agents in parallel when tasks are independent. Use run_in_background: true.
- If you created a tree node with TreeCmd(add_child), pass the returned nodeId as parent_node_id to link this agent to the task tree. The tree will automatically track agent completion.
- Sub-agents work in English internally. You MUST summarize their results in Chinese for the user.
- Each agent gets its own context. Returns a concise report when done.`;
