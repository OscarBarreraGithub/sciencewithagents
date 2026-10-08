import { projectSchedulerKey } from './quark-project.js';
import type { PrivateAgent, PrivateRun, Store } from './store.js';

/** Owner chat preference never applies to workers, native children or automated messages. */
export const managedChat = (agent: PrivateAgent) =>
  agent.role === 'manager' &&
  !agent.taskId &&
  !agent.nativeRootId &&
  !agent.interview &&
  agent.surface !== 'terminal' &&
  !agent.archivedAt;

export function chatBypassRun(store: Store, run: PrivateRun) {
  return (
    run.kind === 'user' &&
    run.sourceId === null &&
    managedChat(store.agent(run.agentId)) &&
    store.getSetting(`quark:chat-bypass-run:${run.id}`) === true
  );
}

/** Observed provider helpers belong to the owned family, never to chat-only authority. */
export function chatBypassAllowed(store: Store, run: PrivateRun) {
  if (!chatBypassRun(store, run)) return false;
  // Once the owner uses the project switch, it supersedes older reply-only choices.
  if (store.getSetting(projectSchedulerKey(store.agent(run.agentId).projectId)) !== null)
    return false;
  const active = new Set(store.runs(['queued', 'running']).map((item) => item.agentId));
  return !store
    .agents()
    .some(
      (agent) =>
        agent.nativeRootId === run.agentId &&
        (['running', 'waiting'].includes(agent.status) || active.has(agent.id)),
    );
}
