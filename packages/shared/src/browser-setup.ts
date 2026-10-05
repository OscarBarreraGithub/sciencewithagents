import { z } from 'zod';

export const browserSetupSchema = z.object({
  checkedAt: z.string().nullable(),
  checking: z.boolean(),
  state: z.enum(['unchecked', 'connected', 'setup-needed', 'unavailable']),
  message: z.string().max(1000),
  nativeTools: z.boolean(),
  connectedBrowsers: z.number().int().nonnegative(),
});
export type BrowserSetupStatus = z.infer<typeof browserSetupSchema>;
export const browserSetupActionSchema = z
  .object({
    action: z.enum(['codex', 'claude']),
  })
  .strict();
