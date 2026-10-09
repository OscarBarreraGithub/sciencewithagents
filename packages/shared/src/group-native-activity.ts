import { z } from 'zod';
import { GROUP_LIMITS, groupContextSchema, groupEventIdSchema } from './groups.js';
import { groupActionOriginSchema } from './group-actions.js';
import { groupEvidenceFactsSchema, type GroupEvidenceFacts } from './group-evidence.js';

const id = z.uuid();
const state = z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);
export const groupNativeActivityEntryIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v) && new TextEncoder().encode(v).length <= 1024);
export const groupNativeActivityDetailSchema = z.discriminatedUnion('producer', [
  z.strictObject({
    producer: z.literal('manager'),
    actionId: id,
    proposalId: id,
    outcomeId: id.nullable(),
    state: z.enum(['started', 'stopped', 'blocked', 'uncertain']),
    jobId: id.nullable(),
    origin: groupActionOriginSchema,
  }),
  z
    .strictObject({
      producer: z.literal('worker'),
      state,
      result: z
        .strictObject({
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          bytes: z.number().int().nonnegative().nullable(),
          availability: z.enum(['complete', 'local-only', 'unavailable']),
          text: z.string().max(GROUP_LIMITS.payloadBytes).nullable(),
          reason: z
            .enum([
              'missing-final',
              'not-completed',
              'unsupported-source',
              'original-capacity',
              'capture-failed',
            ])
            .nullable(),
          entryIds: z.array(groupNativeActivityEntryIdSchema).max(16),
        })
        .refine((r) =>
          r.availability === 'complete'
            ? r.text !== null &&
              new TextEncoder().encode(r.text).length === r.bytes &&
              r.sha256 !== null &&
              r.reason === null
            : r.text === null &&
              (r.availability === 'local-only'
                ? r.sha256 !== null && r.bytes !== null && r.reason === null
                : r.reason !== null && r.sha256 === null && r.bytes === null),
        ),
    })
    .refine((r) => r.state === 'completed' || r.result.availability === 'unavailable'),
  z.strictObject({
    producer: z.literal('quark'),
    state: z.enum(['held', 'resumed']),
    cause: z.enum([
      'manual',
      'budget',
      'lease',
      'capacity',
      'headroom',
      'reset',
      'resource',
      'other',
    ]),
  }),
  z.strictObject({
    producer: z.literal('file'),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    paths: groupEvidenceFactsSchema.shape.paths,
    omitted: z.boolean(),
  }),
  z.strictObject({
    producer: z.literal('job'),
    jobId: id,
    state: z.enum([
      'queued',
      'running',
      'paused',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ]),
  }),
]);
/** Host producer snapshot, never accepted as browser work authority. No account readings,
 * commands, host paths, draft state or private conversation text are in this contract. */
export const groupNativeActivitySchema = z
  .strictObject({
    kind: z.literal('group-native-activity'),
    version: z.literal(1),
    receiptId: id,
    producerReceipt: z.string().min(1).max(256),
    context: groupContextSchema,
    requestId: id,
    rootRunId: id,
    runId: id,
    managerId: id,
    taskId: id.nullable(),
    workerId: id.nullable(),
    workId: id.nullable(),
    sharedGoalId: groupEventIdSchema.nullable(),
    instructionEventId: groupEventIdSchema.nullable(),
    origin: groupActionOriginSchema.nullable(),
    detail: groupNativeActivityDetailSchema,
  })
  .refine((r) => r.context.visibility === 'shared' && r.context.provider !== 'owner')
  .refine((r) =>
    r.origin?.kind === 'autonomous'
      ? r.instructionEventId === null && r.origin.sharedGoalId === r.sharedGoalId
      : r.origin?.kind === 'instruction'
        ? r.origin.eventId === r.instructionEventId
        : true,
  )
  .refine(
    (r) =>
      r.detail.producer !== 'manager' ||
      JSON.stringify(r.detail.origin) === JSON.stringify(r.origin),
  );
export type GroupNativeActivity = z.infer<typeof groupNativeActivitySchema>;
export const groupNativeActivityReadSchema = z.strictObject({
  handle: z.uuid(),
  receiptId: z.uuid(),
  start: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024)
    .default(0),
  count: z.number().int().min(1).max(16).default(1),
});
export const groupNativeActivityOriginalSchema = z.strictObject({
  receiptId: z.uuid(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  encoding: z.literal('base64'),
  start: z.number().int().nonnegative(),
  next: z.number().int().nonnegative().nullable(),
  data: z.string().max(350000),
});
export const groupNativeActivityStatusSchema = z.strictObject({
  retained: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  gaps: z
    .array(
      z.strictObject({
        reason: z.enum([
          'receipt-capacity',
          'original-capacity',
          'unsupported-source',
          'capture-failed',
        ]),
        count: z.number().int().positive(),
      }),
    )
    .max(4),
  limits: z.strictObject({
    receipts: z.literal(8192),
    receiptBytes: z.literal(67108864),
    originalBytes: z.literal(67108864),
  }),
});

export function groupNativeActivityFacts(r: GroupNativeActivity): GroupEvidenceFacts {
  const d = r.detail,
    autonomous = r.origin ? r.origin.kind === 'autonomous' : null,
    stopped =
      (d.producer === 'manager' && ['blocked', 'uncertain'].includes(d.state)) ||
      (d.producer === 'quark' && d.state === 'held') ||
      ((d.producer === 'worker' || d.producer === 'job') &&
        ['failed', 'interrupted', 'cancelled', 'paused'].includes(d.state)),
    originalIds: GroupEvidenceFacts['originalIds'] = {
      memberId: r.context.memberId,
      managerId: r.managerId,
      taskId: r.taskId,
      workerId: r.workerId,
      jobId: d.producer === 'manager' || d.producer === 'job' ? d.jobId : r.runId,
      instructionEventId: r.instructionEventId,
      sharedGoalId: r.sharedGoalId,
      ...(d.producer === 'manager'
        ? { actionId: d.actionId, proposalId: d.proposalId, outcomeId: d.outcomeId }
        : {}),
      ...(d.producer === 'file' ? { fileId: r.receiptId } : {}),
    },
    edges: GroupEvidenceFacts['edges'] = [];
  const link = (
    from: string | null,
    to: string | null,
    relation: GroupEvidenceFacts['edges'][number]['relation'],
  ) => {
    if (from && to && from !== to) edges.push({ fromId: from, toId: to, relation });
  };
  link(r.instructionEventId, r.taskId ?? originalIds.jobId ?? null, 'instruction');
  link(r.taskId, r.managerId, 'manager');
  link(r.taskId, r.workerId, 'worker');
  link(r.workerId ?? r.managerId, originalIds.jobId ?? null, 'outcome');
  link(r.taskId, r.sharedGoalId, 'goal');
  if (d.producer === 'manager') {
    link(
      r.origin?.kind === 'autonomous' ? r.origin.eventId : r.instructionEventId,
      d.proposalId,
      'proposal',
    );
    link(d.proposalId, d.actionId, 'action');
    link(d.actionId, d.outcomeId, 'outcome');
    link(d.outcomeId, r.workerId, 'worker');
  }
  if (d.producer === 'file') link(r.runId, r.receiptId, 'outcome');
  return groupEvidenceFactsSchema.parse({
    sourceId: `native-activity:${d.producer}:${d.producer === 'manager' ? d.actionId : d.producer === 'job' ? d.jobId : r.runId}`,
    sourceVersion: r.receiptId,
    kinds: [
      ...new Set([
        d.producer === 'file'
          ? 'file'
          : d.producer === 'job'
            ? 'job'
            : d.producer === 'worker'
              ? 'finding'
              : d.producer === 'manager' && autonomous
                ? 'decision'
                : 'action',
        ...(stopped ? ['blocker'] : []),
      ]),
    ],
    subjectIds: [
      ...new Set([
        r.context.memberId,
        ...Object.values(originalIds).filter((v): v is string => Boolean(v)),
      ]),
    ].slice(0, 16),
    paths: d.producer === 'file' ? d.paths : [],
    instructionIds: r.instructionEventId ? [r.instructionEventId] : [],
    originalIds,
    edges,
    autonomous,
    unresolved: stopped,
  });
}
