import { id, queuedMessageActionSchema, runSchema, type QueuedMessageAction } from '@dock/shared';
import { api } from './api';
import { workspaceStorageKey } from './useWorkspaceState';

export type QueueRecovery = { runId: string; input: QueuedMessageAction };
const prefix = (agentId: string) => workspaceStorageKey(`queued-action:${agentId}:`);
const key = (agentId: string, runId: string, operationKey: string) =>
  `${prefix(agentId)}${runId}:${operationKey}`;
export function queuedActionRecoveries(agentId: string): QueueRecovery[] {
  const found: QueueRecovery[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(prefix(agentId))) continue;
      try {
        const raw = JSON.parse(localStorage.getItem(name) ?? 'null') as QueueRecovery;
        const value = {
          runId: id.parse(raw.runId),
          input: queuedMessageActionSchema.parse(raw.input),
        };
        if (name === key(agentId, value.runId, value.input.key)) found.push(value);
      } catch {
        /* A malformed record cannot hide another action's receipt. */
      }
    }
  } catch {
    /* Malformed/denied browser storage cannot authorize a send. */
  }
  return found;
}
export function clearQueuedAction(agentId: string, recovery: QueueRecovery) {
  localStorage.removeItem(key(agentId, recovery.runId, recovery.input.key));
}
export async function submitQueuedAction(
  agentId: string,
  runId: string,
  input: QueuedMessageAction,
) {
  // Persist the exact immutable attempt before the request. Reload only offers inspection/retry.
  localStorage.setItem(key(agentId, runId, input.key), JSON.stringify({ runId, input }));
  const result = runSchema.parse(await api(`/agents/${agentId}/queued/${runId}`, input));
  clearQueuedAction(agentId, { runId, input });
  if (input.action === 'remove')
    for (const saved of queuedActionRecoveries(agentId)) {
      if (saved.runId === runId) clearQueuedAction(agentId, saved);
    }
  return result;
}
