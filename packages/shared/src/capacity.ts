import { z } from 'zod';

export const capacityProviderSchema = z.enum(['codex', 'claude']);
export const capacityWindowSchema = z
  .object({
    id: z.string().min(1).max(160),
    label: z.string().max(160),
    scope: z.enum(['general', 'model', 'other']),
    model: z.string().max(120).nullable(),
    usedPercent: z.number().finite().min(0).max(100),
    windowMinutes: z.number().positive().nullable(),
    resetsAt: z.string().datetime().nullable(),
  })
  .strict();
export const providerCapacitySchema = z
  .object({
    provider: capacityProviderSchema,
    account: z.literal('local-sign-in'),
    label: z.string().max(120),
    plan: z.string().max(120).nullable(),
    source: z.enum(['codexbar-oauth', 'claude-native-oauth', 'codex-native']),
    observedAt: z.string().datetime().nullable(),
    attemptedAt: z.string().datetime().nullable(),
    nextRefreshAt: z.string().datetime().nullable(),
    state: z.enum(['ready', 'unknown', 'error']),
    stale: z.boolean(),
    message: z.string().max(500),
    windows: z.array(capacityWindowSchema).max(40),
    weeklyPolicy: z.enum(['reported', 'not-reported', 'owner-reported-none']),
  })
  .strict();
export const machineCapacitySchema = z
  .object({
    observedAt: z.string().datetime(),
    cpuCount: z.number().int().positive(),
    cpuUsedPercent: z.number().min(0).max(100).nullable(),
    memoryTotalBytes: z.number().nonnegative(),
    memoryAvailableBytes: z.number().nonnegative(),
    memoryBasis: z.enum(['free-only', 'free-plus-reclaimable-estimate']).optional(),
    diskAvailableBytes: z.number().nonnegative().nullable(),
    loadPerCore: z.number().nonnegative(),
  })
  .strict();
export const capacityStatusSchema = z
  .object({
    providers: z.array(providerCapacitySchema),
    machine: machineCapacitySchema.nullable(),
    refreshing: z.boolean(),
    refreshSeconds: z.number().int().positive(),
    notice: z.string(),
  })
  .strict();
export const capacityRefreshSchema = z
  .object({ provider: capacityProviderSchema.optional() })
  .strict();
export type CapacityProvider = z.infer<typeof capacityProviderSchema>;
export type CapacityWindow = z.infer<typeof capacityWindowSchema>;
export type ProviderCapacity = z.infer<typeof providerCapacitySchema>;
export type MachineCapacity = z.infer<typeof machineCapacitySchema>;
export type CapacityStatus = z.infer<typeof capacityStatusSchema>;

/** Some usage endpoints reconstruct reset timestamps with small sub-second clock drift. */
export function sameAllowanceReset(a: string | null, b: string | null) {
  return a === b || (a !== null && b !== null && Math.abs(Date.parse(a) - Date.parse(b)) < 60_000);
}
export const projectRateHistorySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  estimatedPercent: z.number().nonnegative().nullable(),
  estimatedPercentPerHour: z.number().nonnegative().nullable(),
  coverageMinutes: z.number().min(0).max(30),
  samples: z.number().int().nonnegative(),
  resetsAt: z.string().nullable(),
  resetBoundary: z.boolean(),
});
/** Advisory per-window project pace. Suggestion only; a saved explicit cap stays authoritative. */
export const adaptivePaceSchema = z.object({
  state: z.enum(['ready', 'idle', 'blocked', 'unknown']),
  percentPerHour: z.number().nonnegative().nullable(),
  reason: z.string(),
  demandProjects: z.number().int().nonnegative(),
  observedAt: z.string().datetime().nullable(),
  resetsAt: z.string().nullable(),
});
export type AdaptivePace = z.infer<typeof adaptivePaceSchema>;
export const accountRateForecastSchema = z.object({
  provider: capacityProviderSchema,
  windowId: z.string(),
  label: z.string(),
  observedAt: z.string().datetime().nullable(),
  remainingPercent: z.number().min(0).max(100),
  savedReservePercent: z.number().min(0).max(100),
  effectiveReservePercent: z.number().min(0).max(100),
  reserveReleased: z.boolean(),
  resetsAt: z.string().datetime().nullable(),
  estimatedPercentPerHour: z.number().nonnegative().nullable(),
  reserveAt: z.string().datetime().nullable(),
  exhaustionAt: z.string().datetime().nullable(),
  resetBeforeReserve: z.boolean().nullable(),
  stale: z.boolean(),
  configuredProjectPercentPerHour: z.number().nonnegative(),
  uncappedProjects: z.number().int().nonnegative(),
});
export const projectRatesSchema = z.object({
  observedAt: z.string().datetime(),
  rates: z.array(
    z.object({
      projectId: z.string().uuid(),
      provider: capacityProviderSchema,
      windowId: z.string(),
      label: z.string(),
      resetsAt: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      estimatedPercentPerHour: z.number().nonnegative().nullable(),
      estimatedPercent: z.number().nonnegative(),
      samples: z.number().int().nonnegative(),
      stale: z.boolean(),
      history: z.array(projectRateHistorySchema).max(24).default([]),
      historyCoverageMinutes: z.number().min(0).max(720).default(0),
      /** Absent from older hosts. */
      adaptive: adaptivePaceSchema.optional(),
    }),
  ),
  accounts: z.array(accountRateForecastSchema).default([]),
  historyFrom: z.string().datetime().optional(),
  historyTruncated: z.boolean().default(false),
  notice: z.string(),
});
export type ProjectRates = z.infer<typeof projectRatesSchema>;

/** Friendly durations only where the provider actually reports that window. */
export function allowanceWindowLabel(
  window: Pick<CapacityWindow, 'label' | 'scope' | 'windowMinutes'>,
) {
  if (window.scope === 'general' && window.windowMinutes === 300) return 'Five-hour';
  if (window.scope === 'general' && window.windowMinutes === 10080) return 'Weekly';
  return window.label;
}
