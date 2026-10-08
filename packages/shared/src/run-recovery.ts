import { z } from 'zod';

export const runRecoveryRequestSchema = z
  .object({
    key: z.uuid(),
    runId: z.uuid(),
    failureId: z.uuid(),
    action: z.enum(['retry', 'continue']),
  })
  .strict();
export const runRecoveryViewSchema = z
  .object({
    runId: z.uuid(),
    failureId: z.uuid(),
    action: z.enum(['retry', 'continue']),
    explanation: z.string(),
  })
  .strict();
export const runRecoveryReceiptSchema = z
  .object({
    sourceRunId: z.uuid(),
    failureId: z.uuid(),
    runId: z.uuid(),
    action: z.enum(['retry', 'continue']),
  })
  .strict();
export type RunRecoveryRequest = z.infer<typeof runRecoveryRequestSchema>;
export type RunRecoveryView = z.infer<typeof runRecoveryViewSchema>;
