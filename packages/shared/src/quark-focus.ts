import { z } from 'zod';

export const quarkFocusStartSchema = z
  .object({ key: z.string().uuid(), projectId: z.string().uuid() })
  .strict();
export const quarkFocusReleaseSchema = z
  .object({ key: z.string().uuid(), focusId: z.string().uuid() })
  .strict();
export const quarkFocusSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    projectName: z.string(),
    startedAt: z.string().datetime(),
    releasedAt: z.string().datetime().nullable(),
    projects: z.array(
      z
        .object({
          projectId: z.string().uuid(),
          name: z.string(),
          // Null means it was already paused; this focus never owns that pause.
          pausedRevision: z.number().int().nonnegative().nullable(),
          restored: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const quarkFocusStatusSchema = z.object({ active: quarkFocusSchema.nullable() }).strict();
export type QuarkFocusRecord = z.infer<typeof quarkFocusSchema>;
