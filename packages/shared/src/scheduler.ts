import { z } from 'zod';
export const schedulerSettingsSchema = z
  .object({
    paused: z.boolean(),
    maxConcurrent: z.number().int().min(1).max(4),
  })
  .strict();
export const schedulerUpdateSchema = z
  .object({ key: z.string().uuid(), settings: schedulerSettingsSchema })
  .strict();
export const schedulerStatusSchema = z
  .object({
    settings: schedulerSettingsSchema,
    items: z.array(
      z
        .object({
          id: z.string().uuid(),
          agentId: z.string().uuid(),
          projectId: z.string().uuid(),
          projectName: z.string(),
          agentName: z.string(),
          status: z.enum(['queued', 'running']),
          createdAt: z.string(),
          explanation: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type SchedulerStatus = z.infer<typeof schedulerStatusSchema>;
