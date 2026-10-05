import { z } from 'zod';

export const appUpdateCheckSchema = z.object({
  id: z.string().uuid(),
  checkedAt: z.string().datetime(),
  state: z.enum(['current', 'available', 'error']),
  message: z.string(),
  localChanges: z.boolean(),
});
export const appUpdateStartSchema = z
  .object({
    key: z.string().uuid(),
    checkId: z.string().uuid(),
  })
  .strict();
export const appUpdateJobSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  managerId: z.string().uuid(),
  workItemId: z.string().uuid(),
  runId: z.string().uuid(),
  recoveryCopyId: z.string().uuid(),
  state: z.enum(['queued', 'working', 'attention', 'ready']),
  message: z.string(),
});
export const appUpdatesSchema = z.object({
  check: appUpdateCheckSchema.nullable(),
  job: appUpdateJobSchema.nullable(),
});
export type AppUpdateCheck = z.infer<typeof appUpdateCheckSchema>;
export type AppUpdateJob = z.infer<typeof appUpdateJobSchema>;
