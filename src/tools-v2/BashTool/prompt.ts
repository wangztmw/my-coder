export const DESCRIPTION = `Execute a shell command. This is the primary tool for: running code, tests, git, npm, file ops.

⚠️ PROCESS SAFETY RULES (HARD CONSTRAINTS — ignored commands WILL be blocked):
- NEVER use pkill, killall, or any broadcast process-kill command
- NEVER use "ps | grep ... | xargs kill" or similar pipelines
- NEVER use kill -9 (SIGKILL) — it's too forceful
- To stop sub-agents, use TaskTool (kill action), NOT shell commands
- For background bash tasks, use the run_in_background parameter
- You do NOT need to manually "clean up" processes — let the system manage them

- Commands run in the project working directory.
- Returns stdout and stderr.
- Timeout: 120 seconds. Use for ANY non-trivial system interaction.`;
