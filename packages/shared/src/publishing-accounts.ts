import { z } from 'zod';

export const publishingAccountIdSchema = z.enum(['github', 'cloudflare']);
/** Only a successful read-only account request establishes `connected`. */
export const publishingAccountStateSchema = z.enum([
  'unchecked',
  'connected',
  'signed_out',
  'missing',
  'unavailable',
]);
export const publishingAccountSchema = z
  .object({
    id: publishingAccountIdSchema,
    state: publishingAccountStateSchema,
    /** Public GitHub login only; never an email address or credential. */
    identity: z.string().nullable(),
    message: z.string(),
    checkedAt: z.string().datetime().nullable(),
  })
  .strict();
export const publishingAccountsSchema = z
  .object({
    /** False where this installation does not run account checks (demo and tests). */
    available: z.boolean(),
    checking: z.boolean(),
    accounts: z.array(publishingAccountSchema),
  })
  .strict();
export const publishingCheckRequestSchema = z
  .object({ force: z.boolean().default(false) })
  .strict();

export type PublishingAccount = z.infer<typeof publishingAccountSchema>;
export type PublishingAccounts = z.infer<typeof publishingAccountsSchema>;
export type PublishingAccountId = z.infer<typeof publishingAccountIdSchema>;
