import { z } from 'zod';
import { providerIdSchema } from './providers.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceId = z.string().min(1).max(256);
const observedAt = z.string().datetime();
export const tokenCountsSchema = z
  .object({
    totalTokens: count.nullable(),
    inputTokens: count.nullable(),
    cachedInputTokens: count.nullable(),
    cacheWriteInputTokens: count.nullable(),
    outputTokens: count.nullable(),
    reasoningOutputTokens: count.nullable(),
  })
  .strict();

/** Provider-reported thread snapshot, never an event delta or a billing estimate. */
export const tokenUsageSnapshotSchema = z
  .object({
    provider: providerIdSchema,
    projectId: z.string().uuid(),
    agentId: z.string().uuid(),
    threadId: sourceId,
    turnId: sourceId.nullable(),
    runId: z.string().uuid().nullable(),
    modelAtObservation: z.string().max(100).nullable(),
    modelScope: z.literal('context-only-not-billing'),
    coverage: z.enum(['whole-tree', 'main-loop', 'observed-steps']).optional(),
    observedModels: z.array(sourceId).max(100).optional(),
    total: tokenCountsSchema,
    last: tokenCountsSchema,
    modelContextWindow: count.nullable(),
    observedAt,
  })
  .strict();

export const quotaWindowSchema = z
  .object({
    usedPercent: z.number().finite().nonnegative().max(1_000_000),
    windowDurationMins: count.nullable(),
    resetsAt: count.nullable(),
    observedAt,
  })
  .strict();
export const quotaBucketSchema = z
  .object({
    id: z.string().min(1).max(100).nullable(),
    name: z.string().max(200).nullable(),
    normalModel: z.string().max(100).nullable(),
    primary: quotaWindowSchema.nullable(),
    secondary: quotaWindowSchema.nullable(),
    spendControlReached: z.boolean().nullable(),
    rateLimitReachedType: z.string().max(100).nullable(),
    observedAt,
  })
  .strict();
export const quotaSnapshotSchema = z
  .object({
    provider: providerIdSchema,
    projectId: z.string().uuid(),
    agentId: z.string().uuid(),
    scope: z.literal('provider-local-installation'),
    accountAffinity: z.literal('unknown'),
    source: z.enum(['read', 'update']),
    ordinaryUsageAllowed: z.boolean().nullable(),
    ordinaryUsageObservedAt: observedAt.nullable(),
    buckets: z.array(quotaBucketSchema).max(32),
    observedAt,
  })
  .strict();

export const usageSummarySchema = z
  .object({
    projectId: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    asOf: observedAt,
    tokenSnapshots: z
      .array(
        tokenUsageSnapshotSchema.extend({
          currentContext: z.boolean(),
          stale: z.boolean(),
        }),
      )
      .max(50),
    quotaSnapshots: z
      .array(
        quotaSnapshotSchema.extend({
          stale: z.boolean(),
          ordinaryUsageStale: z.boolean().nullable(),
          buckets: z
            .array(
              quotaBucketSchema.extend({
                primaryStale: z.boolean().nullable(),
                secondaryStale: z.boolean().nullable(),
              }),
            )
            .max(32),
        }),
      )
      .max(50),
    unknownTokenAgentIds: z.array(z.string().uuid()).max(50),
    unknownQuotaAgentIds: z.array(z.string().uuid()).max(50),
    omitted: z.object({ tokenSnapshots: count, quotaSnapshots: count, agents: count }).strict(),
    notice: z.string().max(1600),
  })
  .strict();

export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export type TokenUsageSnapshot = z.infer<typeof tokenUsageSnapshotSchema>;
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;
export type QuotaBucket = z.infer<typeof quotaBucketSchema>;
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** Small default context; full peer evidence remains an explicit inspection. */
export const usageContextSchema = z
  .object({
    agentId: z.string().uuid(),
    provider: providerIdSchema,
    asOf: observedAt,
    tokens: tokenUsageSnapshotSchema
      .pick({
        threadId: true,
        modelAtObservation: true,
        modelScope: true,
        coverage: true,
        observedModels: true,
        total: true,
        last: true,
        modelContextWindow: true,
        observedAt: true,
      })
      .extend({ stale: z.boolean() })
      .nullable(),
    quota: z
      .object({
        scope: z.literal('provider-local-installation'),
        accountAffinity: z.literal('unknown'),
        observedAt,
        stale: z.boolean(),
        ordinaryUsageAllowed: z.boolean().nullable(),
        ordinaryUsageStale: z.boolean().nullable(),
        buckets: z
          .array(
            z
              .object({
                id: z.string().max(100).nullable(),
                normalModel: z.string().max(100).nullable(),
                primary: quotaWindowSchema.extend({ stale: z.boolean() }).nullable(),
                secondary: quotaWindowSchema.extend({ stale: z.boolean() }).nullable(),
                spendControlReached: z.boolean().nullable(),
                observedAt,
              })
              .strict(),
          )
          .max(4),
        omittedBuckets: count,
      })
      .strict()
      .nullable(),
    notice: z.string().max(1600),
  })
  .strict();
export type UsageContext = z.infer<typeof usageContextSchema>;
