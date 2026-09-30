import { z } from 'zod';

export const recoveryCopySchema = z
  .object({
    id: z.string().uuid(),
    state: z.enum(['creating', 'verified', 'failed']),
    createdAt: z.string().datetime(),
    checkedAt: z.string().datetime().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    counts: z
      .object({
        projects: z.number().int().nonnegative(),
        conversations: z.number().int().nonnegative(),
        entries: z.number().int().nonnegative(),
        images: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    message: z.string(),
  })
  .strict();
export const recoveryCopiesSchema = z
  .object({
    copies: z.array(recoveryCopySchema).max(20),
    creating: z.boolean(),
  })
  .strict();
export const recoveryCopyRequestSchema = z.object({ key: z.string().uuid() }).strict();
export type RecoveryCopy = z.infer<typeof recoveryCopySchema>;
export type RecoveryCopies = z.infer<typeof recoveryCopiesSchema>;
