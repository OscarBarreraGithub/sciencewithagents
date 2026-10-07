import { z } from 'zod';
import {
  groupIdSchema,
  groupMemberIdSchema,
  groupInstallationIdSchema,
  groupEventIdSchema,
} from './groups.js';

const id = z.uuid();
const revision = z.number().int().nonnegative().safe();
/** Exact original of a native manager's task-creation receipt. Only the
 * authenticated host publishes this after its authoritative Store operation. */
export const groupOwnedTaskReceiptSchema = z.strictObject({
  kind: z.literal('group-owned-task'),
  taskId: id,
  managerId: id,
  sharedGoalId: groupEventIdSchema,
  title: z.string().trim().min(1).max(160),
});
export type GroupOwnedTaskReceipt = z.infer<typeof groupOwnedTaskReceiptSchema>;
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
export const groupActionWorkSchema = z.strictObject({
  workId: id,
  title: z.string().trim().min(1).max(160),
  owner: groupActionActorSchema,
  taskId: id,
  managerId: id,
  sharedGoalId: groupEventIdSchema,
  revision,
  desired: z.enum(['start', 'stop']),
  latest: z.strictObject({
    actionId: id.nullable(),
    actor: groupActionActorSchema,
    at: z.string().datetime(),
    origin: groupActionOriginSchema,
  }),
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
});
export const groupActionNoticeSchema = z.strictObject({
  noticeId: id,
  affectedMemberId: groupMemberIdSchema,
  actionId: id,
  actor: groupActionActorSchema,
  at: z.string().datetime(),
  text: z.string().max(500),
});
export const groupActionsBoardSchema = z.strictObject({
  instructions: z.array(groupActionInstructionSchema).max(50),
  works: z.array(groupActionWorkSchema).max(50),
  proposals: z.array(groupActionProposalSchema).max(50),
  actions: z.array(groupActionSchema).max(50),
  notices: z.array(groupActionNoticeSchema).max(50),
  after: revision,
  continuation: revision.nullable(),
});
export const groupActionEvidenceSchema = z.strictObject({
  sourceId: z.string().max(120),
  version: z.literal(1),
  groupId: groupIdSchema,
  sequence: revision,
  kind: z.string().max(40),
  originalJson: z.string().max(24000),
  instructionEventId: groupEventIdSchema.nullable(),
  proposalId: id.nullable(),
  actionId: id.nullable(),
  sharedGoalId: groupEventIdSchema.nullable(),
  taskId: id.nullable(),
  managerId: id.nullable(),
  workerId: id.nullable(),
  outcomeId: id.nullable(),
  jobId: id.nullable(),
  gitEventId: groupEventIdSchema.nullable(),
});
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
