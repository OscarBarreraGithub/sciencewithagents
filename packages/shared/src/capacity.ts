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
    source: z.enum(['codexbar-oauth', 'claude-native-oauth']),
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
    }),
  ),
  notice: z.string(),
});
export type ProjectRates = z.infer<typeof projectRatesSchema>;
