import { z } from 'zod';

/** Browser-safe advisory reply. Publication hashing stays in the host transport. */
export const groupDocumentCapacitySchema = z.strictObject({
  kind: z.literal('capacity'),
  logical: z.strictObject({
    usedBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().positive(),
    requiredBytes: z.number().int().nonnegative(),
  }),
  physical: z.strictObject({
    usedBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().positive(),
    reservedBytes: z.number().int().nonnegative(),
    requiredBytes: z.number().int().nonnegative(),
  }),
  pending: z.number().int().nonnegative(),
  pendingLimit: z.number().int().positive(),
  fits: z.boolean(),
  reason: z.enum(['available', 'logical-limit', 'physical-limit', 'pending-limit']),
});
export type GroupDocumentCapacity = z.infer<typeof groupDocumentCapacitySchema>;
