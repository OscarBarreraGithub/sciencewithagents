import { z } from 'zod';
import { providerIdSchema } from './providers.js';
export const providerMaintenanceRequestSchema = z
  .object({ key: z.string().uuid(), provider: providerIdSchema })
  .strict();
export const providerMaintenanceStateSchema = z.object({
  provider: providerIdSchema,
  state: z.enum(['idle', 'waiting', 'updating', 'updated', 'current', 'needs-help']),
  message: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  checkedAt: z.string().nullable(),
  command: z.string().nullable(),
});
export type ProviderMaintenanceState = z.infer<typeof providerMaintenanceStateSchema>;
