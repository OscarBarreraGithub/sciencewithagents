import { z } from 'zod';

export const jobPrioritySchema = z.enum(['interactive', 'high', 'normal', 'background']);
export const jobEstimateSchema = z
  .object({
    priority: jobPrioritySchema.default('normal'),
    expectedTokens: z.number().int().min(100).max(10_000_000).default(12_000),
    tokenBudget: z.number().int().min(100).max(100_000_000).default(500_000),
    quotaPercent: z.number().min(0.1).max(100).default(3),
    expectedSeconds: z.number().int().min(1).max(604800).default(300),
    cpuCores: z.number().min(0.1).max(256).default(0.25),
    memoryMb: z.number().int().min(64).max(1_048_576).default(512),
    estimatedCostUsd: z.number().nonnegative().max(1_000_000).nullable().default(null),
    estimateNote: z
      .string()
      .max(500)
      .default(
        'Crude planning estimate; subscription percentages are not convertible to tokens or a bill.',
      ),
    deadline: z.string().datetime().nullable().default(null),
  })
  .strict();
export const pulsarPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    reservePercent: z.number().min(5).max(80).default(20),
    claudeConcurrent: z.number().int().min(1).max(4).default(1),
    codexConcurrent: z.number().int().min(1).max(4).default(3),
    backgroundGapSeconds: z.number().int().min(0).max(3600).default(120),
    maxCpuPercent: z.number().min(20).max(100).default(85),
    memoryReserveMb: z.number().int().min(256).max(131072).default(1024),
    maxAutomaticTurns: z.number().int().min(12).max(1000).default(100),
  })
  .strict();
export const pulsarPolicyUpdateSchema = z
  .object({ key: z.string().uuid(), policy: pulsarPolicySchema })
  .strict();
export const jobControlSchema = z
  .object({
    key: z.string().uuid(),
    runId: z.string().uuid(),
    action: z.enum(['hold', 'release', 'cancel', 'override', 'configure']),
    estimate: jobEstimateSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.action !== 'configure' || !!value.estimate,
    'Configure needs an estimate.',
  );
export const taskScheduleSchema = z
  .object({ taskId: z.string().uuid(), estimate: jobEstimateSchema })
  .strict();
export const pulsarJobSchema = z
  .object({
    runId: z.string().uuid(),
    agentId: z.string().uuid(),
    taskId: z.string().uuid().nullable(),
    projectName: z.string(),
    agentName: z.string(),
    provider: z.enum(['codex', 'claude']),
    status: z.string(),
    estimate: jobEstimateSchema,
    held: z.boolean(),
    override: z.boolean(),
    reason: z.string(),
    eligible: z.boolean(),
    expectedFinishAt: z.string().datetime().nullable(),
    tokensCharged: z.number().nonnegative(),
    tokenBasis: z.enum(['measured', 'estimated', 'reserved', 'none']),
  })
  .strict();
export const pulsarStatusSchema = z
  .object({
    // Accept the previous display name while a running host awaits its next safe restart.
    name: z.enum(['QUARK', 'PULSAR']),
    policy: pulsarPolicySchema,
    jobs: z.array(pulsarJobSchema),
    history: z.array(pulsarJobSchema).default([]),
    notice: z.string(),
  })
  .strict();
export type JobEstimate = z.infer<typeof jobEstimateSchema>;
export type PulsarPolicy = z.infer<typeof pulsarPolicySchema>;
export type PulsarStatus = z.infer<typeof pulsarStatusSchema>;
