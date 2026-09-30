import { z } from 'zod';
import { jobPrioritySchema } from './pulsar.js';

export const localResourcesSchema = z
  .object({
    priority: jobPrioritySchema.default('interactive'),
    cpuCores: z.number().int().min(1).max(8).default(2),
    memoryMb: z.number().int().min(512).max(16384).default(1024),
    expectedSeconds: z.number().int().min(1).max(86400).default(300),
    deadline: z.string().datetime().nullable().default(null),
  })
  .strict();
export const transcriptionRequestSchema = z
  .object({
    key: z.string().uuid(),
    url: z.string().url().max(2000),
    projectId: z.string().uuid().nullable().default(null),
    taskId: z.string().uuid().nullable().default(null),
    resources: localResourcesSchema.default(() => localResourcesSchema.parse({})),
  })
  .strict();
export const localJobSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal('youtube-transcription'),
    projectId: z.string().uuid().nullable(),
    taskId: z.string().uuid().nullable(),
    requestedBy: z.string().uuid().nullable(),
    url: z.string(),
    resources: localResourcesSchema,
    status: z.enum([
      'queued',
      'running',
      'paused',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ]),
    phase: z.enum([
      'waiting',
      'preparing',
      'downloading',
      'converting',
      'transcribing',
      'finished',
    ]),
    message: z.string(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    autoPaused: z.boolean(),
    attempt: z.number().int().positive(),
    transcriptAvailable: z.boolean(),
    expectedFinishAt: z.string().nullable(),
  })
  .strict();
export const localJobControlSchema = z
  .object({
    key: z.string().uuid(),
    jobId: z.string().uuid(),
    action: z.enum(['pause', 'resume', 'cancel', 'retry', 'override']),
  })
  .strict();
export const localJobReadSchema = z
  .object({ jobId: z.string().uuid(), offset: z.number().int().nonnegative().default(0) })
  .strict();
export const localJobsStatusSchema = z
  .object({
    jobs: z.array(localJobSchema),
    toolsReady: z.boolean(),
    modelReady: z.boolean(),
    setupMessage: z.string(),
  })
  .strict();
export type LocalJob = z.infer<typeof localJobSchema>;
export type LocalResources = z.infer<typeof localResourcesSchema>;
export type LocalJobsStatus = z.infer<typeof localJobsStatusSchema>;
