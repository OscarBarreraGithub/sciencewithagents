import { z } from 'zod';

export const coordinationReviewRequestSchema = z
  .object({
    key: z.uuid(),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const coordinationReviewReadSchema = z
  .object({
    batchRunId: z.uuid(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(20).default(20),
    sourceRunId: z.uuid().optional(),
    textOffset: z.number().int().min(0).max(1000000).default(0),
    textLimit: z.number().int().min(1).max(8192).default(1024),
  })
  .strict();
export type CoordinationReviewRead = z.infer<typeof coordinationReviewReadSchema>;
