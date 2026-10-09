import type { Agent, Snapshot, Task } from '@dock/shared';

/** Follow retained ownership, including nested native helpers, without guessing from text. */
export function controllingManager(state: Snapshot, agent: Agent): Agent | undefined {
  let current: Agent | undefined = agent;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.interview) {
      current = state.agents.find((a) => a.id === current!.interview!.sourceAgentId);
      continue;
    }
    if (current.role === 'manager' && !current.nativeRootId) return current;
    const task = state.tasks.find((t) => t.id === current!.taskId);
    const parent = current.nativeRootId ?? task?.managerId ?? current.parentId;
    current = state.agents.find((a) => a.id === parent);
  }
}

export const subagentsRoute = (managerId: string) => `#/chat/${managerId}/subagents`;
export const workerRoute = (managerId: string, workerId: string) =>
  `${subagentsRoute(managerId)}/${workerId}`;

export function workerActivity(agent: Agent) {
  const status = agent.status === 'idle' ? agent.latestRun?.status : agent.status;
  switch (status) {
    case 'running':
      return { state: 'running', label: 'Running' };
    case 'queued':
      return { state: 'queued', label: 'Queued' };
    case 'waiting':
      return { state: 'waiting', label: 'Waiting for input' };
    case 'interrupted':
    case 'cancelled':
      return { state: 'stopped', label: 'Stopped' };
    case 'failed':
      return { state: 'failed', label: 'Error' };
    case 'completed':
      return { state: 'completed', label: 'Turn completed' };
    default:
      return { state: 'idle', label: 'Idle' };
  }
}

const taskLabels: Record<Task['status'], string> = {
  open: 'Not started',
  working: 'In progress',
  review: 'Awaiting review',
  needs_decision: 'Decision needed',
  done: 'Completed',
  integrated: 'Changes applied',
  split: 'Split into smaller tasks',
  cancelled: 'Closed',
};
export const workerTaskStatus = (task: Task) => taskLabels[task.status];
