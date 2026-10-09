import { z } from 'zod';
import { groupEventSchema } from './groups.js';

export const GROUP_EVIDENCE_LIMITS = {
  pageSize: 8,
  pageBytes: 256 * 1024,
  records: 8192,
  queries: 4096,
  facts: 16,
  bytes: 64 * 1024 * 1024,
} as const;
const key = z.string().min(1).max(256);
const ids = z
  .array(key)
  .max(16)
  .refine((a) => new Set(a).size === a.length);
export const groupEvidenceKindSchema = z.enum([
  'decision',
  'action',
  'finding',
  'conflict',
  'file',
  'job',
  'responsibility',
  'unresolved',
  'blocker',
  'instruction',
  'question',
  'idea',
]);
export const groupEvidenceEdgeSchema = z.strictObject({
  fromId: key,
  toId: key,
  relation: z.enum([
    'caused',
    'evidence',
    'instruction',
    'proposal',
    'action',
    'goal',
    'task',
    'manager',
    'worker',
    'outcome',
    'corrects',
  ]),
});
export const groupEvidenceFactsSchema = z.strictObject({
  sourceId: key,
  sourceVersion: z.union([z.number().int().positive().max(2147483647), z.string().min(1).max(128)]),
  kinds: z.array(groupEvidenceKindSchema).min(1).max(12),
  subjectIds: ids,
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(512)
        .refine(
          (p) => !p.startsWith('/') && !p.split('/').some((s) => s === '..') && !/[\\\0]/.test(p),
        ),
    )
    .max(16),
  instructionIds: z.array(z.uuid()).max(16),
  originalIds: z.partialRecord(
    z.enum([
      'instructionEventId',
      'proposalId',
      'actionId',
      'sharedGoalId',
      'taskId',
      'managerId',
      'workerId',
      'outcomeId',
      'fileId',
      'jobId',
      'memberId',
    ]),
    key.nullable(),
  ),
  edges: z.array(groupEvidenceEdgeSchema).max(16),
  autonomous: z.boolean().nullable(),
  unresolved: z.boolean().nullable(),
});
export const groupEvidenceQuerySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('who_working'), memberId: z.uuid() }),
  z.strictObject({ type: z.literal('why_stopped'), subjectId: key }),
  z.strictObject({ type: z.literal('who_decided'), eventId: z.uuid() }),
  z.strictObject({ type: z.literal('offline_changes') }),
  z.strictObject({ type: z.literal('instruction_actions'), instructionEventId: z.uuid() }),
  z.strictObject({ type: z.literal('file_changes'), path: z.string().min(1).max(512) }),
  z.strictObject({ type: z.literal('unresolved') }),
  z.strictObject({ type: z.literal('autonomous_decisions') }),
]);
export const groupEvidenceRequestSchema = z.strictObject({
  handle: z.uuid(),
  queryId: z.uuid(),
  query: groupEvidenceQuerySchema,
  limit: z.number().int().min(1).max(GROUP_EVIDENCE_LIMITS.pageSize),
  continuation: z.uuid().nullable(),
});
export const groupEvidenceRecordSchema = z.strictObject({
  event: groupEventSchema,
  facts: groupEvidenceFactsSchema.nullable(),
});
export const groupEvidencePageSchema = z.strictObject({
  records: z.array(groupEvidenceRecordSchema).max(GROUP_EVIDENCE_LIMITS.pageSize),
  watermark: z.number().int().nonnegative().safe(),
  continuation: z.uuid().nullable(),
  coverage: z.literal('indexed_shared_sources'),
  unknown: z.array(z.string().max(256)).max(8),
});
export type GroupEvidenceFacts = z.infer<typeof groupEvidenceFactsSchema>;
export type GroupEvidenceQuery = z.infer<typeof groupEvidenceQuerySchema>;
export type GroupEvidenceRecord = z.infer<typeof groupEvidenceRecordSchema>;
export type GroupEvidencePage = z.infer<typeof groupEvidencePageSchema>;
