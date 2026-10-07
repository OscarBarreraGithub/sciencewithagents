import { z } from 'zod';

const base = { handle: z.uuid() };
const operation = { ...base, key: z.uuid() };
/** Opaque saved owner contexts only. Host resources and native commands never cross this port. */
export const groupNativeOwnerInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...base, action: z.literal('status'), requestId: z.uuid().optional() }),
  z.strictObject({ ...operation, action: z.literal('prepare') }),
  z.strictObject({ ...operation, action: z.literal('sign-in'), requestId: z.uuid().optional() }),
  z.strictObject({
    ...operation,
    action: z.literal('restart-sign-in'),
    requestId: z.uuid().optional(),
  }),
  z.strictObject({ ...operation, action: z.literal('verify-tools') }),
  z.strictObject({
    ...operation,
    action: z.literal('verify-stop'),
    kind: z.enum(['explicit', 'crash']),
  }),
  z.strictObject({ ...operation, action: z.literal('approve') }),
  z.strictObject({ ...operation, action: z.literal('reject'), requestId: z.uuid().optional() }),
  z.strictObject({ ...operation, action: z.literal('continue'), requestId: z.uuid() }),
  z.strictObject({ ...operation, action: z.literal('reconnect'), requestId: z.uuid() }),
]);
export type GroupNativeOwnerInput = z.infer<typeof groupNativeOwnerInputSchema>;
export const groupNativeOwnerStatusSchema = z.strictObject({
  executionMode: z.enum(['host', 'isolated']).optional(),
  hostEnabled: z.boolean().optional(),
  configured: z.boolean(),
  productionReady: z.boolean(),
  provider: z.enum(['codex', 'claude']).nullable(),
  setupId: z.uuid().nullable(),
  state: z.enum([
    'unconfigured',
    'not-started',
    'queued',
    'signed-out',
    'pending',
    'authenticated',
    'checking',
    'verified',
    'stopped',
    'rejected',
    'unknown',
    'error',
  ]),
  message: z.string().max(1000),
  canRetrySignIn: z.boolean().optional(),
  canReconnect: z.boolean().optional(),
  device: z
    .strictObject({
      verificationUrl: z.url().refine((v) => new URL(v).origin === 'https://auth.openai.com'),
      userCode: z.string().min(1).max(128),
    })
    .optional(),
  terminalId: z.uuid().optional(),
});
export type GroupNativeOwnerStatus = z.infer<typeof groupNativeOwnerStatusSchema>;
