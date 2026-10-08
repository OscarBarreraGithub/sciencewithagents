import { z } from 'zod';
import { clusterAliasSchema } from './cluster.js';
import { providerIdSchema, effortSchema } from './providers.js';
import { modelPolicySchema } from './model-policy.js';
import { slurmSubmissionPolicySchema, slurmDevelopmentReviewResultSchema } from './slurm-review.js';
import { clusterFolderDescriptorSchema } from './cluster-workspace.js';

const id = z.uuid();
export const clusterProjectCreateSchema = z
  .object({
    key: id,
    folderId: id,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(''),
    manager: z
      .object({
        provider: providerIdSchema,
        model: z.string().min(1).max(100).nullable().default(null),
        effort: effortSchema,
      })
      .strict(),
  })
  .strict();
export const clusterProjectActionSchema = z.object({ key: id }).strict();
export const clusterDevelopmentStateSchema = z.enum([
  'absent',
  'allocating',
  'uncertain',
  'pending',
  'ready',
  'disconnected',
  'idle',
  'released',
  'rejected',
  'error',
]);
export const clusterDevelopmentStatusSchema = z
  .object({
    state: clusterDevelopmentStateSchema,
    jobId: z
      .string()
      .regex(/^\d{1,20}$/)
      .nullable(),
    node: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/)
      .nullable(),
    observedAt: z.string().datetime().nullable(),
    message: z.string().max(500),
  })
  .strict();
export const clusterProjectOpeningSchema = z
  .object({
    state: z.enum(['preparing', 'waiting', 'ready', 'error']),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    message: z.string().max(500),
  })
  .strict();
export const clusterProjectSummarySchema = z
  .object({
    id,
    name: z.string(),
    description: z.string(),
    alias: clusterAliasSchema,
    folderId: id,
    createdAt: z.string().datetime(),
    provider: providerIdSchema,
    hostId: id,
    remoteProjectId: id.nullable(),
    remoteManagerId: id.nullable(),
    development: clusterDevelopmentStatusSchema,
    setupRequired: z.string().max(500).nullable(),
    needsTracking: z.boolean().default(false),
    review: slurmDevelopmentReviewResultSchema.nullable().default(null),
    opening: clusterProjectOpeningSchema.nullable().default(null),
  })
  .strict();
export const clusterProjectListSchema = z.array(clusterProjectSummarySchema).max(100);
export const clusterProjectOpenedSchema = z
  .object({
    project: clusterProjectSummarySchema,
    destination: z.object({ hostId: id, projectId: id, managerId: id }).strict().nullable(),
  })
  .strict();
/** Server-private durable execution identity: never return paths or gateway credentials to browsers. */
export const clusterProjectRecordSchema = z
  .object({
    id,
    controllerHostId: id,
    hostId: id,
    name: z.string(),
    description: z.string(),
    createdAt: z.string().datetime(),
    folder: clusterFolderDescriptorSchema,
    manager: clusterProjectCreateSchema.shape.manager,
    policy: modelPolicySchema,
    slurmReviewPolicy: slurmSubmissionPolicySchema.nullable().default(null),
    trackingConsent: z
      .object({
        key: id,
        folderIdentity: z.string().regex(/^\d+:\d+$/),
        confirmedAt: z.string().datetime(),
      })
      .strict()
      .nullable()
      .default(null),
    remoteProjectId: id.nullable(),
    remoteManagerId: id.nullable(),
    remoteWorkspaceId: id.nullable(),
  })
  .strict();
export type ClusterProjectRecord = z.infer<typeof clusterProjectRecordSchema>;
export type ClusterProjectSummary = z.infer<typeof clusterProjectSummarySchema>;
export type ClusterDevelopmentStatus = z.infer<typeof clusterDevelopmentStatusSchema>;
