import { z } from 'zod';
import type { CapacityWindow, ProviderCapacity } from './capacity.js';

export const jobPrioritySchema = z.enum(['interactive', 'high', 'normal', 'background']);
export const jobEstimateSchema = z
  .object({
    priority: jobPrioritySchema.default('normal'),
    expectedTokens: z.number().int().min(100).max(10_000_000).default(12_000),
    tokenBudget: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .default(500_000)
      .describe(
        'Deprecated legacy estimate. Never enforced as a spending limit; use provider allowance caps.',
      ),
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
export const providerReserveSchema = z
  .object({
    reservePercent: z.number().min(0).max(100).default(20),
    releaseEnabled: z.boolean().default(false),
    releaseBeforeResetMinutes: z.number().int().min(1).max(10080),
  })
  .strict();
export const pulsarPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    revision: z.number().int().nonnegative().default(0),
    // Retained for older clients. Independent provider settings take precedence.
    reservePercent: z.number().min(0).max(100).default(20),
    providerReserves: z
      .object({
        codex: providerReserveSchema,
        claude: providerReserveSchema,
      })
      .strict()
      .optional(),
    claudeConcurrent: z.number().int().min(1).max(4).default(1),
    codexConcurrent: z.number().int().min(1).max(4).default(3),
    backgroundGapSeconds: z.number().int().min(0).max(3600).default(120),
    maximizeClaudeFiveHour: z.boolean().default(false),
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
    // Optional for compatibility with hosts awaiting a safe restart.
    budgetBlock: z
      .object({ kind: z.enum(['tokens', 'allowance']), targetId: z.string().uuid() })
      .strict()
      .optional(),
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

/** Older saved global reserves migrate to both providers without lowering either. */
export function providerReservePolicy(policy: PulsarPolicy, provider: 'codex' | 'claude') {
  return (
    policy.providerReserves?.[provider] ?? {
      reservePercent: policy.reservePercent,
      releaseEnabled: false,
      releaseBeforeResetMinutes: provider === 'codex' ? 720 : 45,
    }
  );
}
/** Timed release applies to each actual reported window; elapsed resets never grant capacity. */
export function effectiveProviderReserve(
  policy: PulsarPolicy,
  capacity: ProviderCapacity,
  window: CapacityWindow,
  now: number,
) {
  const saved = providerReservePolicy(policy, capacity.provider);
  const minutes = window.resetsAt ? (Date.parse(window.resetsAt) - now) / 60_000 : null;
  const released =
    saved.releaseEnabled &&
    capacity.state === 'ready' &&
    !capacity.stale &&
    !!capacity.observedAt &&
    minutes !== null &&
    minutes > 0 &&
    minutes <= saved.releaseBeforeResetMinutes;
  return { ...saved, effectivePercent: released ? 0 : saved.reservePercent, released };
}
