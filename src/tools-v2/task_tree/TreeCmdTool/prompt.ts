export const DESCRIPTION = `Manage the task tree structure for complex multi-step tasks.

Use this tool when you need to:
- **create**: Start a new task tree for a complex request that requires decomposition
- **add_child**: Decompose a node into smaller sub-tasks
- **status**: Check the current state of the tree (which nodes are running/completed/failed)
- **report**: Submit a result for a completed node
- **replace**: Replace a failed subtree with a new plan (don't retry — replan)
- **get_leaves**: Find leaf nodes that are ready to execute

The task tree enables parallel execution of independent sub-tasks. Each node represents one semantic unit of work. Leaf nodes are executed by worker agents. Branch nodes supervise their children. The root node coordinates the entire task.`;
