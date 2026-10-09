import { groupContextSchema } from '@dock/shared';
import { z } from 'zod';
import { Conflict, type Store, type PrivateRun } from './store.js';
import { publicationCanonical } from './group-publication-protocol.js';
import { captureGroupRunTransition } from './group-native-activity-producers.js';

export const groupHostTurnSchema = z.object({
  requestId: z.uuid(),
  intent: z.enum(['ask', 'work']),
  context: groupContextSchema,
  originRunId: z.uuid().optional(),
  parentRunId: z.uuid().optional(),
  permission: z.enum(['read-only', 'workspace-write']).optional(),
});
const agentScopeSchema = z.object({
  context: groupContextSchema,
  anchor: groupContextSchema,
  enrollmentHandle: z.uuid(),
});
export const groupHostStopKey = (requestId: string) =>
  `group:host-native-stopped-request:${requestId}`;
export function groupHostWorkStopped(store: Store, run: PrivateRun) {
  const turn = groupHostTurnSchema.safeParse(store.getSetting(`group:host-native-run:${run.id}`));
  return turn.success && Boolean(store.getSetting(groupHostStopKey(turn.data.requestId)));
}
/** Called in the enqueue transaction, only from ordinary admitted app coordination.
 * Remote group evidence cannot create this lineage or supply its request identity. */
export function inheritGroupHostWork(
  store: Store,
  source: PrivateRun,
  target: Pick<PrivateRun, 'id' | 'agentId' | 'kind' | 'sourceId'>,
) {
  const scopeValue = store.getSetting(`group:host-native-agent:${source.agentId}`);
  if (!scopeValue) return;
  const scope = agentScopeSchema.parse(scopeValue);
  const turn = groupHostTurnSchema.parse(store.getSetting(`group:host-native-run:${source.id}`));
  const sender = store.agent(source.agentId),
    receiver = store.agent(target.agentId);
  if (
    turn.intent !== 'work' ||
    groupHostWorkStopped(store, source) ||
    publicationCanonical(turn.context) !== publicationCanonical(scope.context) ||
    sender.projectId !== receiver.projectId ||
    target.sourceId !== sender.id
  )
    throw new Conflict('The original local Work turn must authorize this continuation.');
  if (target.kind === 'report' && sender.parentId !== receiver.id)
    throw new Conflict('A Work report must return to its owning parent.');
  if (
    target.kind === 'delegation' &&
    receiver.parentId !== sender.id &&
    receiver.parentId !== sender.parentId
  )
    throw new Conflict('A Work delegation must retain its owning manager.');
  const previous = store.getSetting(`group:host-native-agent:${receiver.id}`);
  if (previous && publicationCanonical(previous) !== publicationCanonical(scope))
    throw new Conflict('A continuation cannot cross group conversation contexts.');
  store.setSetting(`group:host-native-agent:${receiver.id}`, scope);
  store.setSetting(`group:host-native-run:${target.id}`, {
    ...turn,
    originRunId: turn.originRunId ?? source.id,
    parentRunId: source.id,
    // Read-only reviewers/researchers retain their ordinary assigned permission.
    permission: receiver.role === 'manager' ? 'workspace-write' : receiver.permission,
  });
  captureGroupRunTransition(store, target.id, `run:${target.id}:queued`);
}
/** Exact durable request family; no project-wide/most-recent-agent lookup. */
export function groupHostWorkFamily(store: Store, original: PrivateRun) {
  const root = groupHostTurnSchema.parse(store.getSetting(`group:host-native-run:${original.id}`));
  const projectId = store.agent(original.agentId).projectId;
  return store.db
    .prepare(
      `SELECT r.id FROM runs r JOIN settings s ON s.key='group:host-native-run:'||r.id
    WHERE s.key>='group:host-native-run:' AND s.key<'group:host-native-run;'
    AND json_extract(s.value,'$.requestId')=? ORDER BY r.rowid`,
    )
    .all(root.requestId)
    .map((row) => store.run(String(row.id)))
    .filter((run) => {
      const turn = groupHostTurnSchema.parse(store.getSetting(`group:host-native-run:${run.id}`));
      return (
        store.agent(run.agentId).projectId === projectId &&
        publicationCanonical(turn.context) === publicationCanonical(root.context) &&
        (run.id === original.id || turn.originRunId === original.id)
      );
    });
}
