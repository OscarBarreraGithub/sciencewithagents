import { z } from 'zod';

const draftKey = z
  .string()
  .startsWith('dock:')
  .max(512)
  .refine((key) => !key.startsWith('dock:local-access:'));
const draftValue = z.string().max(2 * 1024 * 1024);
const entries = z
  .array(z.tuple([draftKey, draftValue]))
  .max(4000)
  .refine((values) => new Set(values.map(([key]) => key)).size === values.length);

export const browserDraftTransferSchema = z
  .object({
    version: z.literal(1),
    local: entries,
    session: entries,
  })
  .strict();
export type BrowserDraftTransfer = z.infer<typeof browserDraftTransferSchema>;

export const retainedBrowserDraftsSchema = z
  .object({
    version: z.literal(1),
    source: z.string().max(256),
    createdAt: z.string().datetime(),
    entries: z
      .array(
        z.object({ kind: z.enum(['local', 'session']), key: draftKey, value: draftValue }).strict(),
      )
      .max(8000),
  })
  .strict();
export type RetainedBrowserDrafts = z.infer<typeof retainedBrowserDraftsSchema>;
