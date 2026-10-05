import { z } from 'zod';
import { pulsarJobSchema } from './pulsar.js';

/** A saved job projection. Full text and tool evidence remain in its conversation. */
export const jobDetailTextSchema = z
  .object({ text: z.string().max(8192), truncated: z.boolean() })
  .strict();
export const jobDetailSchema = z
  .object({
    job: pulsarJobSchema,
    projectId: z.string().uuid(),
    request: jobDetailTextSchema,
    kind: z.enum(['user', 'delegation', 'message', 'report', 'resume']),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    worker: z
      .object({
        role: z.string().max(100),
        status: z.string().max(100),
        model: z.string().max(500).nullable(),
        modelBasis: z.enum(['admission', 'current']),
      })
      .strict(),
    task: z
      .object({
        id: z.string().uuid(),
        title: z.string().max(500),
        status: z.string().max(100),
        goal: jobDetailTextSchema,
        acceptance: jobDetailTextSchema,
        review: jobDetailTextSchema.nullable(),
        closure: z
          .object({ reason: jobDetailTextSchema, closedAt: z.string() })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    queueHold: z.enum(['editing', 'steering']).nullable(),
    approval: z
      .object({ id: z.string().uuid(), title: z.string().max(500) })
      .strict()
      .nullable(),
    outcome: z
      .array(
        z
          .object({
            id: z.string().max(500),
            kind: z.enum(['assistant', 'system']),
            title: z.string().max(500),
            text: jobDetailTextSchema,
            createdAt: z.string(),
          })
          .strict(),
      )
      .max(3),
    moreOutcome: z.boolean(),
  })
  .strict();
export type JobDetail = z.infer<typeof jobDetailSchema>;
export type JobDetailText = z.infer<typeof jobDetailTextSchema>;
