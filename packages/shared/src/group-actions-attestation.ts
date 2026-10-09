import { z } from 'zod';
import { groupEventSchema, type GroupEvent } from './groups.js';
import { publicationCanonical, publicationEnvelopeSchema } from './group-delivery.js';
import {
  groupOwnedTaskReceiptSchema,
  type GroupActionActor,
  type GroupActionCommand,
  type GroupActionOrigin,
  type GroupActionWork,
} from './group-actions.js';
import { GroupActionsAccessDenied, type GroupActionsSql } from './group-actions-authority.js';

/** Exact committed bytes plus immutable local→remote source registration. Local
 * source IDs deliberately need not equal the enrollment's remote aliases. */
export function verifyGroupCommittedSource(
  sql: GroupActionsSql,
  event: GroupEvent,
  actor: Pick<GroupActionActor, 'groupId' | 'memberId' | 'installationId'>,
) {
  const row = sql.rows<{
    operation_id: string;
    header: string;
    source_id: string;
    installation_id: string;
    member_id: string;
  }>(
    `SELECT o.operation_id,o.header,o.source_id,a.installation_id,a.member_id FROM delivery_operations o JOIN delivery_authors a USING(operation_id) WHERE o.event_id=? AND o.state='committed'`,
    event.eventId,
  )[0];
  if (!row || row.installation_id !== actor.installationId || row.member_id !== actor.memberId)
    throw new GroupActionsAccessDenied();
  const chunks = sql.rows<{ chunk: string }>(
    'SELECT chunk FROM delivery_chunks WHERE operation_id=? ORDER BY chunk_index',
    row.operation_id,
  );
  const { header } = publicationEnvelopeSchema.parse({
    header: JSON.parse(row.header),
    chunks: chunks.map((row) => JSON.parse(row.chunk)),
  });
  if (
    publicationCanonical(header.event) !== publicationCanonical(event) ||
    header.operationId !== row.operation_id ||
    header.binding.remoteGroupId !== actor.groupId
  )
    throw new GroupActionsAccessDenied();
  const identity = sql.rows<{
    local_group_id: string;
    local_installation_id: string;
    local_member_id: string;
    remote_member_id: string;
    binding: string;
  }>('SELECT * FROM delivery_identities WHERE installation_id=?', actor.installationId)[0];
  const source = sql.rows<{
    installation_id: string;
    binding: string;
    member_id: string;
    provider: string;
    native_id: string;
    message_id: string;
    session_id: string;
  }>('SELECT * FROM delivery_messages WHERE source_id=?', row.source_id)[0];
  const binding = publicationCanonical(header.binding),
    ref = event.scope.source;
  if (
    !identity ||
    identity.remote_member_id !== actor.memberId ||
    identity.local_group_id !== event.scope.groupId ||
    identity.local_installation_id !== event.scope.installationId ||
    identity.local_member_id !== event.scope.memberId ||
    identity.binding !== binding ||
    !source ||
    source.installation_id !== actor.installationId ||
    source.binding !== binding ||
    source.member_id !== event.scope.memberId ||
    source.provider !== ref.provider ||
    source.native_id !== ref.nativeSessionId ||
    source.message_id !== ref.messageId ||
    source.session_id !== ref.sessionId
  )
    throw new GroupActionsAccessDenied();
}

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
    event.scope.visibility !== 'shared' ||
    event.scope.source.provider === 'owner' ||
    !['Decision', 'Action'].includes(event.category) ||
    event.manifest.bytes > 2048 ||
    event.manifest.chunks.length !== 1
  )
    throw new GroupActionsAccessDenied();
  verifyGroupCommittedSource(sql, event, actor);
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
