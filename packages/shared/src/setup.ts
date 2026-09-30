import { z } from 'zod';
import { modelPolicyStatusSchema } from './model-policy.js';
import { providerIdSchema } from './providers.js';

export const providerAccountStateSchema = z.enum([
  'unchecked',
  'signed-in',
  'sign-in',
  'custom',
  'unavailable',
]);
export type ProviderAccountState = z.infer<typeof providerAccountStateSchema>;
export const setupStatusSchema = z.object({
  policy: modelPolicyStatusSchema,
  accounts: z.array(
    z.object({
      provider: providerIdSchema,
      state: providerAccountStateSchema,
      checkedAt: z.string().nullable(),
    }),
  ),
  checking: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;
export const signInRequestSchema = z.object({ key: z.string().uuid() }).strict();
export const signInStatusSchema = z.object({
  key: z.string().uuid().nullable(),
  state: z.enum(['idle', 'starting', 'pending', 'completed', 'expired', 'failed']),
  verificationUrl: z.string().url().nullable(),
  userCode: z.string().max(128).nullable(),
  expiresAt: z.string().nullable(),
});
export type SignInStatus = z.infer<typeof signInStatusSchema>;
export const claudeSignInStatusSchema = z.object({
  available: z.boolean(),
  attempt: z
    .object({
      key: z.uuid(),
      state: z.enum(['opened', 'uncertain']),
      openedAt: z.string().datetime(),
    })
    .nullable(),
});
export type ClaudeSignInStatus = z.infer<typeof claudeSignInStatusSchema>;
