import { z } from 'zod';
import {
  groupIdSchema,
  groupMemberIdSchema,
  groupInstallationIdSchema,
  groupEventIdSchema,
} from './groups.js';

const id = z.uuid();
const revision = z.number().int().nonnegative().safe();
export const GROUP_ACTION_LIMITS = {
  memberAdmissionReceipts: 2048,
  retainedAdmissionReceipts: 8192,
  memberOpenProposals: 16,
  memberUnfinishedActions: 8,
  unfinishedActions: 32,
  recentTerminalActions: 50,
  lifecycleLogicalReserve: 384 * 1024,
  lifecyclePhysicalReserve: 512 * 1024,
} as const;
export const groupActionMembershipSchema = z.enum(['active', 'revoked', 'unavailable']);
export const groupActionActorSchema = z.strictObject({
  groupId: groupIdSchema,
  memberId: groupMemberIdSchema,
  installationId: groupInstallationIdSchema,
  displayName: z.string().min(1).max(120),
});
export const groupActionOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('instruction'), eventId: groupEventIdSchema }),
  z.strictObject({
    kind: z.literal('autonomous'),
    eventId: groupEventIdSchema,
    sharedGoalId: groupEventIdSchema,
    managerId: id,
  }),
]);
export const groupActionInstructionSchema = z.strictObject({
  eventId: groupEventIdSchema,
  actor: groupActionActorSchema,
  text: z
    .string()
    .min(1)
    .max(8000)
    .refine((v) => v.trim().length > 0 && new TextEncoder().encode(v).length <= 8000),
  at: z.string().datetime(),
});
export const groupOwnedTaskReceiptSchema = z.strictObject({
  kind: z.literal('group-owned-task'),
  taskId: id,
  managerId: id,
  sharedGoalId: groupEventIdSchema,
  title: z.string().trim().min(1).max(160),
});
export type GroupOwnedTaskReceipt = z.infer<typeof groupOwnedTaskReceiptSchema>;
export const groupActionWorkSchema = z.strictObject({
  workId: id,
  title: z.string().trim().min(1).max(160),
  owner: groupActionActorSchema,
  taskId: id,
  managerId: id,
  sharedGoalId: groupEventIdSchema,
  revision,
  availability: z.enum(['available', 'owner-revoked', 'unavailable']).default('available'),
  desired: z.enum(['start', 'stop']),
  latest: z.strictObject({
    actionId: id.nullable(),
    actor: groupActionActorSchema,
    at: z.string().datetime(),
    origin: groupActionOriginSchema,
  }),
});
export const groupActionHumanConfirmationSchema = z.strictObject({
  receiptId: id,
  proposalId: id,
  revision,
  operationId: id,
  confirmedBy: groupActionActorSchema,
  at: z.string().datetime(),
});
export const groupActionProposalSchema = z.strictObject({
  proposalId: id,
  workId: id,
  kind: z.enum(['start', 'stop']),
  origin: groupActionOriginSchema,
  actor: groupActionActorSchema,
  at: z.string().datetime(),
  observed: groupActionWorkSchema,
  overrideRequired: z.boolean(),
});
export const groupActionSchema = z.strictObject({
  actionId: id,
  proposal: groupActionProposalSchema,
  revision,
  state: z.enum([
    'pending-owner',
    'dispatching',
    'uncertain',
    'completed',
    'superseded',
    'revoked',
  ]),
  outcome: z
    .strictObject({
      taskId: id,
      workerId: id.nullable(),
      outcomeId: id,
      jobId: id.optional(),
      gitEventId: groupEventIdSchema.optional(),
      status: z.enum(['started', 'stopped', 'blocked']),
      message: z.string().max(2000),
    })
    .nullable(),
  humanConfirmation: groupActionHumanConfirmationSchema.nullable().default(null),
  reconciliationReceiptId: id.optional(),
  authorization: z
    .strictObject({
      owner: groupActionMembershipSchema,
      requester: groupActionMembershipSchema,
    })
    .optional(),
});
export const groupActionRetainedReceiptSchema = z.strictObject({
  receiptId: id,
  actionId: id,
  revision,
  owner: groupActionActorSchema,
  effect: z.enum(['completed', 'absent']),
  outcome: groupActionSchema.shape.outcome.unwrap(),
});
export const groupActionNoticeSchema = z.strictObject({
  noticeId: id,
  affectedMemberId: groupMemberIdSchema,
  actionId: id,
  actor: groupActionActorSchema,
  at: z.string().datetime(),
  text: z.string().max(500),
  visibility: z.literal('private').default('private'),
  requesterOrigin: groupActionOriginSchema.optional(),
});
export const groupActionsBoardSchema = z.strictObject({
  instructions: z.array(groupActionInstructionSchema).max(50),
  works: z.array(groupActionWorkSchema).max(50),
  proposals: z.array(groupActionProposalSchema).max(50),
  actions: z
    .array(groupActionSchema)
    .max(GROUP_ACTION_LIMITS.unfinishedActions + GROUP_ACTION_LIMITS.recentTerminalActions),
  notices: z.array(groupActionNoticeSchema).max(50),
  after: revision,
  continuation: revision.nullable(),
});
/** Producer facts from exact immutable action JSON. Promotion must separately
 * verify the shared event and anchor actual instruction refs before E ingestion. */
const factKey = z.string().min(1).max(256);
export const groupActionSourceFactsSchema = z.strictObject({
  sourceId: factKey,
  sourceVersion: z.literal(1),
  kinds: z
    .array(z.enum(['instruction', 'action', 'decision', 'conflict', 'blocker', 'responsibility']))
    .min(1)
    .max(12),
  subjectIds: z
    .array(factKey)
    .max(16)
    .refine((v) => new Set(v).size === v.length),
  paths: z.array(z.string()).length(0),
  // Raw ga instruction identities are NOT proof of a published GroupEvent.
  // B fills E's instructionIds only after verified shared event-ref attachment.
  instructionIds: z.array(z.uuid()).length(0),
  originalIds: z.strictObject({
    instructionEventId: groupEventIdSchema.nullable(),
    proposalId: id.nullable(),
    actionId: id.nullable(),
    sharedGoalId: groupEventIdSchema.nullable(),
    taskId: id.nullable(),
    managerId: id.nullable(),
    workerId: id.nullable(),
    outcomeId: id.nullable(),
    jobId: id.nullable(),
    memberId: groupMemberIdSchema.nullable(),
  }),
  edges: z
    .array(
      z.strictObject({
        fromId: factKey,
        toId: factKey,
        relation: z.enum([
          'evidence',
          'instruction',
          'proposal',
          'action',
          'goal',
          'task',
          'manager',
          'worker',
          'outcome',
        ]),
      }),
    )
    .max(16),
  autonomous: z.boolean().nullable(),
  unresolved: z.null(),
});
export type GroupActionSourceFacts = z.infer<typeof groupActionSourceFactsSchema>;
export const groupActionEvidenceSchema = z
  .strictObject({
    sourceId: z.string().max(120),
    version: z.literal(1),
    groupId: groupIdSchema,
    sequence: revision,
    kind: z.string().max(40),
    originalJson: z.string().max(24000),
    facts: groupActionSourceFactsSchema,
    instructionEventId: groupEventIdSchema.nullable(),
    autonomousEventId: groupEventIdSchema.nullable(),
    proposalId: id.nullable(),
    actionId: id.nullable(),
    sharedGoalId: groupEventIdSchema.nullable(),
    taskId: id.nullable(),
    managerId: id.nullable(),
    workerId: id.nullable(),
    outcomeId: id.nullable(),
    jobId: id.nullable(),
    gitEventId: groupEventIdSchema.nullable(),
  })
  .refine((record) => {
    if (
      record.sourceId !== `group-action:${record.groupId}:${record.sequence}` ||
      record.sequence < 1
    )
      return false;
    if (record.facts.sourceId !== record.sourceId || record.facts.sourceVersion !== record.version)
      return false;
    const keys = [
      'instructionEventId',
      'proposalId',
      'actionId',
      'sharedGoalId',
      'taskId',
      'managerId',
      'workerId',
      'outcomeId',
      'jobId',
    ] as const;
    if (keys.some((key) => record.facts.originalIds[key] !== record[key])) return false;
    const known = new Set([
      record.sourceId,
      ...Object.values(record.facts.originalIds).filter((value): value is string => value !== null),
    ]);
    return (
      record.facts.subjectIds.every((value) => known.has(value)) &&
      record.facts.edges.every((edge) => known.has(edge.fromId) && known.has(edge.toId))
    );
  }, 'Facts must preserve exact source identity and record identifiers');
const operationId = id;
export const groupActionCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('instruction'),
    operationId,
    text: groupActionInstructionSchema.shape.text,
  }),
  z.strictObject({
    kind: z.literal('register-work'),
    operationId,
    title: z.string().trim().min(1).max(160),
    taskId: id,
    managerId: id,
    sharedGoalId: groupEventIdSchema,
    origin: groupActionOriginSchema,
  }),
  z.strictObject({
    kind: z.literal('propose'),
    operationId,
    workId: id,
    expectedRevision: revision,
    action: z.enum(['start', 'stop']),
    origin: groupActionOriginSchema,
  }),
  z.strictObject({
    kind: z.literal('confirm'),
    operationId,
    proposalId: id,
    expectedRevision: revision,
    override: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('evidence'),
    after: revision,
    limit: z.number().int().min(1).max(25),
  }),
  z.strictObject({
    kind: z.literal('board'),
    after: revision,
    limit: z.number().int().min(1).max(50),
  }),
  z.strictObject({
    kind: z.literal('owner-pending'),
    after: revision,
    limit: z.number().int().min(1).max(25),
  }),
  z.strictObject({ kind: z.literal('work'), workId: id }),
  z.strictObject({ kind: z.literal('claim'), operationId, actionId: id }),
  z.strictObject({
    kind: z.literal('complete'),
    operationId,
    actionId: id,
    outcome: groupActionSchema.shape.outcome.unwrap(),
  }),
  z.strictObject({ kind: z.literal('uncertain'), operationId, actionId: id }),
]);
export const groupActionReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('instruction'), instruction: groupActionInstructionSchema }),
  z.strictObject({ kind: z.literal('work'), work: groupActionWorkSchema }),
  z.strictObject({ kind: z.literal('proposal'), proposal: groupActionProposalSchema }),
  z.strictObject({ kind: z.literal('action'), action: groupActionSchema }),
  z.strictObject({
    kind: z.literal('evidence'),
    records: z.array(groupActionEvidenceSchema).max(25),
    continuation: revision.nullable(),
  }),
  z.strictObject({ kind: z.literal('board'), board: groupActionsBoardSchema }),
  z.strictObject({
    kind: z.literal('owner-pending'),
    actions: z.array(groupActionSchema).max(25),
    continuation: revision.nullable(),
  }),
]);
export const groupActionResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: groupActionReplySchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['denied', 'invalid', 'conflict', 'stale', 'limit', 'unavailable']),
    current: groupActionWorkSchema.optional(),
  }),
]);
export const groupActionRequestSchema = z.strictObject({
  handle: id,
  command: groupActionCommandSchema,
});
export type GroupActionActor = z.infer<typeof groupActionActorSchema>;
export type GroupActionOrigin = z.infer<typeof groupActionOriginSchema>;
export type GroupActionWork = z.infer<typeof groupActionWorkSchema>;
export type GroupActionProposal = z.infer<typeof groupActionProposalSchema>;
export type GroupAction = z.infer<typeof groupActionSchema>;
export type GroupActionCommand = z.infer<typeof groupActionCommandSchema>;
export type GroupActionReply = z.infer<typeof groupActionReplySchema>;
export type GroupActionResult = z.infer<typeof groupActionResultSchema>;

export type GroupActionInstruction = z.infer<typeof groupActionInstructionSchema>;

export type GroupActionNotice = z.infer<typeof groupActionNoticeSchema>;
export type GroupActionHumanConfirmation = z.infer<typeof groupActionHumanConfirmationSchema>;
export type GroupActionMembership = z.infer<typeof groupActionMembershipSchema>;
export type GroupActionRetainedReceipt = z.infer<typeof groupActionRetainedReceiptSchema>;
export type GroupActionEvidence = z.infer<typeof groupActionEvidenceSchema>;
/** Existing receipt namespaces, fixed to three lifecycle operations per action. */
export function groupActionLifecycleOperationId(
  actionId: string,
  kind: 'claim' | 'uncertain' | 'complete',
) {
  id.parse(actionId);
  if (kind === 'complete') return actionId;
  return (
    actionId.slice(0, -1) +
    (parseInt(actionId.at(-1)!, 16) ^ (kind === 'claim' ? 1 : 2)).toString(16)
  );
}
