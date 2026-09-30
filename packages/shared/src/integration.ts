import { z } from 'zod';
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
export const integrationRequestSchema = z
  .object({
    key: z.string().uuid(),
    source: commit,
    target: commit,
  })
  .strict();
export const integrationPreviewSchema = z
  .object({
    taskId: z.string().uuid(),
    source: commit,
    target: commit,
    changes: z.string(),
    patch: z.string(),
    canApply: z.boolean(),
    relation: z.enum(['fast-forward', 'already-present', 'diverged']),
    reconciliationTaskId: z.string().uuid().nullable(),
  })
  .strict();
export type IntegrationPreview = z.infer<typeof integrationPreviewSchema>;
