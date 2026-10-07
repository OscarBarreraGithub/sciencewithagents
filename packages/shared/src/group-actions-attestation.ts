import { z } from 'zod';
import { groupEventSchema } from './groups.js';
import {
  groupOwnedTaskReceiptSchema,
  type GroupActionActor,
  type GroupActionCommand,
  type GroupActionOrigin,
  type GroupActionWork,
} from './group-actions.js';
import { GroupActionsAccessDenied, type GroupActionsSql } from './group-actions-authority.js';

/** Reads a completed immutable native task receipt from this group's existing
 * delivery ledger. UUID syntax, a local mirror or model text is not authority. */
function ownedReceipt(sql: GroupActionsSql, eventId: string, actor: GroupActionActor) {
  const row = sql.rows<{
    operation_id: string;
    header: string;
    member_id: string;
    installation_id: string;
  }>(
    `SELECT o.operation_id,o.header,a.member_id,a.installation_id FROM delivery_operations o
     JOIN delivery_authors a ON a.operation_id=o.operation_id WHERE o.event_id=? AND o.state='committed'`,
    eventId,
  )[0];
  if (!row || row.member_id !== actor.memberId || row.installation_id !== actor.installationId)
    throw new GroupActionsAccessDenied();
  const { event } = z.object({ event: groupEventSchema }).parse(JSON.parse(row.header));
  if (
    event.scope.groupId !== actor.groupId ||
    event.scope.visibility !== 'shared' ||
    event.scope.source.provider === 'owner' ||
    !['Decision', 'Action'].includes(event.category) ||
    event.manifest.bytes > 2048 ||
    event.manifest.chunks.length !== 1
  )
    throw new GroupActionsAccessDenied();
  const chunks = sql.rows<{ chunk: string }>(
    'SELECT chunk FROM delivery_chunks WHERE operation_id=? ORDER BY chunk_index',
    row.operation_id,
  );
  if (chunks.length !== 1) throw new GroupActionsAccessDenied();
  const original = z
    .object({ index: z.literal(0), text: z.string().max(2048) })
    .parse(JSON.parse(chunks[0].chunk));
  const receipt = groupOwnedTaskReceiptSchema.parse(JSON.parse(original.text));
  if (!event.scope.causalRefs.includes(receipt.sharedGoalId)) throw new GroupActionsAccessDenied();
  return { event, receipt };
}
type Binding = {
  manager_id: string;
  installation_id: string;
  member_id: string;
  provider: string;
  native_session_id: string;
  session_id: string;
};
function bindingMatches(
  binding: Binding | undefined,
  actor: GroupActionActor,
  source: ReturnType<typeof ownedReceipt>['event']['scope']['source'],
) {
  return (
    binding?.installation_id === actor.installationId &&
    binding.member_id === actor.memberId &&
    binding.provider === source.provider &&
    binding.native_session_id === source.nativeSessionId &&
    binding.session_id === source.sessionId
  );
}
export function verifyGroupOwnedTask(
  sql: GroupActionsSql,
  command: Extract<GroupActionCommand, { kind: 'register-work' }>,
  actor: GroupActionActor,
) {
  const { event, receipt } = ownedReceipt(sql, command.origin.eventId, actor);
  if (
    receipt.taskId !== command.taskId ||
    receipt.managerId !== command.managerId ||
    receipt.sharedGoalId !== command.sharedGoalId ||
    receipt.title !== command.title
  )
    throw new GroupActionsAccessDenied();
  const binding = sql.rows<Binding>(
    'SELECT * FROM ga_manager_bindings WHERE manager_id=?',
    command.managerId,
  )[0];
  if (binding && !bindingMatches(binding, actor, event.scope.source))
    throw new GroupActionsAccessDenied();
  if (!binding)
    sql.rows(
      'INSERT INTO ga_manager_bindings VALUES(?,?,?,?,?,?)',
      command.managerId,
      actor.installationId,
      actor.memberId,
      event.scope.source.provider,
      event.scope.source.nativeSessionId,
      event.scope.source.sessionId,
    );
}
export function verifyGroupManager(
  sql: GroupActionsSql,
  origin: Extract<GroupActionOrigin, { kind: 'autonomous' }>,
  actor: GroupActionActor,
  work?: GroupActionWork,
) {
  const { event, receipt } = ownedReceipt(sql, origin.eventId, actor);
  const binding = sql.rows<Binding>(
    'SELECT * FROM ga_manager_bindings WHERE manager_id=?',
    origin.managerId,
  )[0];
  if (
    receipt.managerId !== origin.managerId ||
    receipt.sharedGoalId !== origin.sharedGoalId ||
    (work && receipt.taskId !== work.taskId) ||
    !bindingMatches(binding, actor, event.scope.source)
  )
    throw new GroupActionsAccessDenied();
}
