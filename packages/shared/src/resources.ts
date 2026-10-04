import { z } from 'zod';
import { machineCapacitySchema } from './capacity.js';
import { effortSchema, providerIdSchema } from './providers.js';

export const resourceGroupSchema = z
  .object({
    name: z.string().max(100),
    processes: z.number().int().nonnegative(),
    cpuPercent: z.number().nonnegative().nullable(),
    memoryBytes: z.number().nonnegative(),
    memoryChangeBytes: z.number().nullable(),
  })
  .strict();
export const resourceJobSchema = resourceGroupSchema.extend({
  id: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().max(200).nullable(),
  kind: z.enum(['agent', 'local']),
  status: z.string().max(40),
});
export const resourceProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    name: z.string().max(100),
    entrypoint: z.string().max(200).nullable(),
    parentName: z.string().max(100).nullable(),
    cpuPercent: z.number().nonnegative().nullable(),
    memoryBytes: z.number().nonnegative(),
    jobId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
  })
  .strict();
export const resourceSampleSchema = z
  .object({
    observedAt: z.string().datetime(),
    machine: machineCapacitySchema.nullable(),
    hottestCorePercent: z.number().min(0).max(100).nullable(),
    memoryPressure: z.enum(['normal', 'warning', 'critical', 'unknown']),
    compressedBytes: z.number().nonnegative().nullable(),
    swapUsedBytes: z.number().nonnegative().nullable(),
    swapOutBytesPerSecond: z.number().nonnegative().nullable(),
    diskTotalBytes: z.number().nonnegative().nullable(),
    groups: z.array(resourceGroupSchema).max(20),
    jobs: z.array(resourceJobSchema).max(100).default([]),
    processes: z.array(resourceProcessSchema).max(20).default([]),
    processCount: z.number().int().nonnegative().nullable(),
    unavailable: z.array(z.string()).max(12),
  })
  .strict();
export const resourceFindingSchema = z
  .object({
    id: z.string(),
    level: z.enum(['warning', 'critical']),
    title: z.string(),
    detail: z.string(),
    since: z.string().datetime(),
    sustained: z.boolean(),
  })
  .strict();
export const resourceSettingsSchema = z
  .object({
    automatic: z.boolean().default(false),
    // Accepted only to migrate old clients; selection now belongs to Model settings.
    model: z.enum(['sonnet', 'terra']).optional(),
    checkpointHours: z.number().int().min(1).max(24).default(6),
  })
  .strict();
export const resourceSettingsRequestSchema = z
  .object({
    key: z.string().uuid(),
    settings: resourceSettingsSchema,
  })
  .strict();
export const resourceAskSchema = z
  .object({
    key: z.string().uuid(),
    agentId: z.string().uuid().optional(),
    provider: providerIdSchema.optional(),
    model: z.string().trim().min(1).max(100).optional(),
    effort: effortSchema.optional(),
    question: z
      .string()
      .trim()
      .max(1000)
      .default('Why might this computer be slow? What should I do?'),
  })
  .strict();
export const resourceStopSchema = z
  .object({ key: z.string().uuid(), checkId: z.string().uuid() })
  .strict();
export const resourceCheckSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    runId: z.string().uuid(),
    createdAt: z.string().datetime(),
    reason: z.enum(['asked', 'checkpoint', 'pressure']),
    model: z.string(),
    tier: z.enum(['undergrad', 'grad']).optional(),
    escalatedFrom: z.string().uuid().optional(),
    state: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
    summary: z.string(),
    waitReason: z.string().nullable(),
  })
  .strict();
export const resourceStatusSchema = z
  .object({
    latest: resourceSampleSchema.nullable(),
    history: z.array(resourceSampleSchema).max(1441),
    stale: z.boolean(),
    findings: z.array(resourceFindingSchema),
    settings: resourceSettingsSchema,
    checks: z.array(resourceCheckSchema).max(20),
    projectId: z.string().uuid().nullable(),
    nextCheckpointAt: z.string().datetime().nullable(),
    automaticChecksToday: z.number().int().nonnegative(),
    message: z.string(),
    intervalSeconds: z.literal(15),
  })
  .strict();
export type ResourceSample = z.infer<typeof resourceSampleSchema>;
export type ResourceGroup = z.infer<typeof resourceGroupSchema>;
export type ResourceJob = z.infer<typeof resourceJobSchema>;
export type ResourceProcess = z.infer<typeof resourceProcessSchema>;
export type ResourceFinding = z.infer<typeof resourceFindingSchema>;
export type ResourceCheck = z.infer<typeof resourceCheckSchema>;
export type ResourceStatus = z.infer<typeof resourceStatusSchema>;
