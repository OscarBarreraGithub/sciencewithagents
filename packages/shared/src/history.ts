import { z } from 'zod';
import { providerIdSchema } from './providers.js';

const historyId = z.string().uuid();
export const historySourceSchema = z.enum(['entry', 'decision']);
export const historyQuerySchema = z
  .object({
    agentId: historyId.optional(),
    taskId: historyId.optional(),
    source: z.enum(['all', 'conversations', 'messages', 'decisions']).default('all'),
    query: z.string().trim().max(200).default(''),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const historyReadSchema = z
  .object({
    source: historySourceSchema,
    id: z.string().min(1).max(1024),
    offset: z.number().int().min(0).max(10_000_000).default(0),
    limit: z.number().int().min(1).max(24_000).default(8000),
  })
  .strict();
export const historyItemSchema = z
  .object({
    source: historySourceSchema,
    id: z.string(),
    projectId: historyId,
    agentId: historyId,
    taskId: historyId.nullable(),
    runId: historyId.nullable(),
    senderId: historyId.nullable(),
    kind: z.string(),
    title: z.string().max(2000),
    text: z.string().max(24_000),
    status: z.string(),
    createdAt: z.string(),
    offset: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const historyPageSchema = z
  .object({
    items: z.array(historyItemSchema).max(50),
    nextCursor: z.string().nullable(),
    throughEventId: z.number().int().nonnegative(),
    notice: z.string(),
  })
  .strict();

export const recoveryReasonSchema = z.enum([
  'turn_finished',
  'interrupted',
  'context_changed',
  'host_restart',
  'manual',
]);
const recoveryRunSchema = z
  .object({
    id: historyId,
    kind: z.string(),
    status: z.string(),
    sourceId: historyId.nullable(),
    turnId: z.string().nullable(),
  })
  .strict();
export const recoveryRecordSchema = z
  .object({
    id: historyId,
    recordedAt: z.string(),
    throughEventId: z.number().int().nonnegative(),
    reason: recoveryReasonSchema,
    author: z.literal('host'),
    projectId: historyId,
    agentId: historyId,
    agentName: z.string(),
    status: z.string(),
    parentId: historyId.nullable(),
    nativeRootId: historyId.nullable(),
    provider: providerIdSchema.default('codex'),
    threadId: z.string().nullable(),
    turnId: z.string().nullable(),
    checkpointAvailable: z.boolean(),
    historyOrigin: z.enum(['managed', 'imported']),
    task: z
      .object({
        id: historyId,
        managerId: historyId,
        title: z.string(),
        status: z.string(),
        revisions: z.number().int().nonnegative(),
        review: z.string().nullable(),
        baseCommit: z.string().nullable(),
        reviewedCommit: z.string().nullable(),
      })
      .strict()
      .nullable(),
    recentEntryIds: z.array(z.string()).max(12),
    latestRun: recoveryRunSchema.nullable(),
    unsettledRuns: z.array(recoveryRunSchema).max(20),
    unsettledRunCount: z.number().int().nonnegative(),
    queuedRunCount: z.number().int().nonnegative(),
    approvals: z
      .array(
        z
          .object({ id: historyId, kind: z.string(), status: z.string(), createdAt: z.string() })
          .strict(),
      )
      .max(20),
    pendingApprovalCount: z.number().int().nonnegative(),
    nextAction: z.enum([
      'inspect_interruption',
      'answer_approval',
      'wait',
      'ready',
      'parent_controls',
    ]),
    notice: z.string(),
  })
  .strict();

export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryRead = z.infer<typeof historyReadSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
export type RecoveryReason = z.infer<typeof recoveryReasonSchema>;

export const catalogQuerySchema = z
  .object({
    kind: z.enum(['agents', 'tasks']),
    query: z.string().trim().max(200).default(''),
    status: z
      .enum([
        'all',
        'active',
        'idle',
        'queued',
        'running',
        'waiting',
        'interrupted',
        'failed',
        'open',
        'working',
        'review',
        'needs_decision',
        'done',
        'integrated',
        'split',
      ])
      .default('all'),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const catalogItemSchema = z
  .object({
    id: historyId,
    projectId: historyId,
    kind: z.enum(['agents', 'tasks']),
    title: z.string(),
    summary: z.string().max(3000),
    status: z.string(),
    role: z.string().nullable(),
    managerId: historyId.nullable(),
    parentId: historyId.nullable(),
    taskId: historyId.nullable(),
    createdAt: z.string(),
  })
  .strict();
export const catalogPageSchema = z
  .object({
    items: z.array(catalogItemSchema).max(50),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
    notice: z.string(),
  })
  .strict();
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export type CatalogPage = z.infer<typeof catalogPageSchema>;
