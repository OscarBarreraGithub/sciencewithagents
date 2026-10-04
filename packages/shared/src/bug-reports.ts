import { z } from 'zod';

export const bugReportRequestSchema = z
  .object({
    key: z.string().uuid(),
    description: z.string().trim().min(1).max(8000),
    page: z
      .string()
      .max(500)
      .regex(/^#\/[a-zA-Z0-9/_:%.-]*$/),
  })
  .strict();
export const bugReportSchema = bugReportRequestSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  managerId: z.string().uuid(),
  workItemId: z.string().uuid(),
  runId: z.string().uuid(),
  folder: z.string(),
  status: z.enum(['open', 'in_progress', 'waiting', 'done']),
  message: z.string(),
  fileSaved: z.boolean(),
});
export const bugReportsSchema = z.object({ items: z.array(bugReportSchema) });
export type BugReport = z.infer<typeof bugReportSchema>;
