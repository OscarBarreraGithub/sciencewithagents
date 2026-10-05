import { z } from 'zod';
import { tokenCountsSchema } from './usage.js';

const id = z.string().uuid();
const percent = z.number().finite().min(0).max(100);
export const windowPacingSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  windowId: z.string(),
  label: z.string(),
  remainingPercent: percent,
  reservePercent: percent,
  savedReservePercent: percent.optional(),
  reserveReleased: z.boolean().default(false),
  releaseEnabled: z.boolean().default(false),
  releaseBeforeResetMinutes: z.number().int().positive().optional(),
  resetsAt: z.string().nullable(),
  minutesToReset: z.number().nonnegative().nullable(),
  observedPercentPerHour: z.number().nonnegative().nullable(),
  targetPercentPerHour: z.number().nonnegative().nullable(),
  projectedRemainingPercent: percent.nullable(),
  observedAt: z.string().datetime().nullable().default(null),
  reserveAt: z.string().datetime().nullable().default(null),
  exhaustionAt: z.string().datetime().nullable().default(null),
  resetBeforeReserve: z.boolean().nullable().default(null),
  state: z.enum(['unknown', 'protected', 'underused', 'on-track', 'fast']),
  message: z.string(),
});
export const managerLeaseSchema = z
  .object({
    id,
    runId: id,
    managerId: id,
    projectId: id,
    provider: z.enum(['codex', 'claude']),
    model: z.string().nullable(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    // Absence preserves existing signed lease bytes and ordinary orchestration authority.
    scope: z.enum(['orchestration', 'conversation']).optional(),
  })
  .strict();
export const chatQuarkPolicySchema = z
  .object({
    agentId: id,
    enabled: z.boolean().default(false),
    revision: z.number().int().nonnegative().default(0),
  })
  .strict();
export const chatQuarkPolicySaveSchema = z
  .object({
    key: id,
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const pauseWorkerSchema = z
  .object({
    agentId: id,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const quarkSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    bufferPercent: percent.max(10).default(2),
    cacheEnabled: z.boolean().default(false),
    cacheMinutes: z
      .object({
        claude: z.number().int().min(5).max(1440).nullable().default(60),
        codex: z.number().int().min(5).max(1440).nullable().default(null),
      })
      .strict()
      .default({ claude: 60, codex: null }),
    maxNudgesPerAgentDay: z.number().int().min(0).max(24).default(2),
  })
  .strict();
export const quarkSettingsUpdateSchema = z
  .object({ key: id, settings: quarkSettingsSchema })
  .strict();
export const allowanceFieldsSchema = z
  .object({
    key: id,
    id: id.optional(),
    expectedRevision: z.number().int().nonnegative().default(0),
    projectId: id,
    taskId: id.nullable().default(null),
    provider: z.enum(['codex', 'claude']),
    windowId: z.string().min(1).max(160),
    period: z.enum(['window', 'hour']).default('window'),
    enabled: z.boolean().default(true),
    limitPercent: percent,
  })
  .strict();
const validAllowance = (value: { period: string; limitPercent: number }) =>
  value.period === 'hour' || value.limitPercent > 0;
export const allowanceRequestSchema = allowanceFieldsSchema.refine(validAllowance, {
  message: 'Only hourly rates can be zero. Total allowance caps must be positive.',
  path: ['limitPercent'],
});
export const managerAllowanceSchema = allowanceFieldsSchema
  .omit({ key: true, id: true, expectedRevision: true, projectId: true })
  .extend({ taskId: id })
  .refine(validAllowance);
export const allowanceSchema = allowanceFieldsSchema
  .omit({ key: true, expectedRevision: true })
  .extend({
    id,
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    startSequence: z.number().int().nonnegative(),
    source: z.enum(['owner', 'manager', 'agent-client']),
  })
  .refine(validAllowance);
export const quotaHoldSchema = z.object({
  runId: id,
  agentId: id,
  projectId: id,
  reason: z.string(),
  // Old holds remain explicit. Never infer automatic recovery from message text.
  cause: z
    .enum([
      'budget',
      'hourly',
      'monitoring',
      'reset',
      'headroom',
      'manual',
      'lease',
      'cache',
      'project',
    ])
    .default('manual'),
  createdAt: z.string().datetime(),
  stopAcknowledgedAt: z.string().datetime().nullable().default(null),
  releasedAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export const quarkRunSchema = z.object({
  runId: id,
  agentId: id,
  projectId: id,
  taskId: id.nullable(),
  taskAncestors: z.array(id),
  nativeRootId: id.nullable(),
  provider: z.enum(['codex', 'claude']),
  model: z.string().nullable(),
  observedModels: z.array(z.string().max(256)).max(100).optional(),
  threadId: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime().nullable(),
  baseline: tokenCountsSchema,
  tokens: tokenCountsSchema,
  lastTotal: tokenCountsSchema.optional(),
  basis: z.enum(['measured', 'partial', 'unknown']),
  expectedTokens: z.number(),
  quotaPercent: z.number(),
  expectedSeconds: z.number(),
  cacheNudge: z.boolean(),
});
export const quarkStatusSchema = z.object({
  settings: quarkSettingsSchema,
  since: z.string().datetime(),
  budgets: z.array(
    allowanceSchema.safeExtend({
      spentPercent: z.number(),
      reservedPercent: z.number(),
      remainingPercent: z.number(),
      nextEligibleAt: z.string().datetime().nullable().default(null),
      reason: z.string().nullable(),
    }),
  ),
  holds: z.array(quotaHoldSchema),
  runs: z.array(
    quarkRunSchema.extend({ agentName: z.string(), projectName: z.string(), status: z.string() }),
  ),
  omittedRuns: z.number().int().nonnegative(),
  totals: z.array(
    z.object({
      projectId: id,
      agentId: id.nullable(),
      provider: z.enum(['codex', 'claude']),
      name: z.string(),
      tokens: tokenCountsSchema,
      measuredRuns: z.number(),
      incompleteRuns: z.number(),
      nativeOverlap: z.boolean(),
    }),
  ),
  windows: z.array(
    z.object({
      provider: z.enum(['codex', 'claude']),
      windowId: z.string(),
      label: z.string(),
      resetsAt: z.string().nullable(),
      observedAt: z.string(),
      deltaPercent: z.number(),
      unattributedPercent: z.number(),
      samples: z.number(),
      projects: z.array(
        z.object({ projectId: id, name: z.string(), estimatedPercent: z.number() }),
      ),
    }),
  ),
  cache: z.array(
    z.object({
      agentId: id,
      name: z.string(),
      provider: z.enum(['codex', 'claude']),
      observedAt: z.string().nullable(),
      estimatedExpiresAt: z.string().nullable(),
      cachedTokens: z.number().nullable(),
      nudgesToday: z.number(),
      state: z.string(),
    }),
  ),
  notice: z.string(),
});
export const quotaResumeSchema = z.object({ key: id, runId: id }).strict();
export type QuarkSettings = z.infer<typeof quarkSettingsSchema>;
export type Allowance = z.infer<typeof allowanceSchema>;
export type QuarkRun = z.infer<typeof quarkRunSchema>;
export type QuotaHold = z.infer<typeof quotaHoldSchema>;
export type QuarkStatus = z.infer<typeof quarkStatusSchema>;
