import { z } from 'zod';
import { clusterAliasSchema, clusterPartitionSchema } from './cluster.js';
import { projectWorkflowSchema } from './project-workflow.js';

const id = z.uuid();
const date = z.string().datetime().nullable();
const name = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
export const clusterWorkspaceSiteRulesSchema = z.enum(['fasrc-cannon']).nullable();
/** Owner setup metadata only. Execution requests select generated folder IDs. */
export const clusterRootPathSchema = z
  .string()
  .trim()
  .min(2)
  .max(1000)
  .regex(/^(?:\/|~\/)[^\0\r\n]*$/, 'Choose an absolute cluster folder or a folder under ~/.');
export const clusterDevelopmentSchema = z
  .object({
    partition: name.nullable().default(null),
    qos: name.nullable().default(null),
    cpus: z.number().int().min(1).max(128).default(2),
    memoryMb: z.number().int().min(512).max(1048576).default(8192),
    timeMinutes: z.number().int().min(1).max(720).default(120),
    idleMinutes: z.number().int().min(1).max(120).default(20),
  })
  .strict();
export type ClusterDevelopment = z.infer<typeof clusterDevelopmentSchema>;
export const clusterIndexEntrySchema = z
  .object({
    id,
    relativePath: z
      .string()
      .min(1)
      .max(1000)
      .refine(
        (value) =>
          value === '.' ||
          (!value.startsWith('/') &&
            !/[\0\r\n]/.test(value) &&
            value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')),
        'Use metadata paths relative to the saved root.',
      ),
    kind: z.enum(['directory', 'file', 'symlink']),
    size: z.number().int().nonnegative().nullable(),
    modifiedAt: date,
    /** A .git marker exists; no Git configuration or file contents were read. */
    git: z.boolean(),
  })
  .strict();
export const clusterRootIndexSchema = z
  .object({
    state: z.enum(['stale', 'indexing', 'ready', 'error', 'truncated']),
    observedAt: date,
    connectionId: id.nullable(),
    canonicalPath: z.string().max(1000).nullable(),
    error: z.string().max(400).nullable(),
    entries: z.array(clusterIndexEntrySchema).max(300),
    /** At least this many metadata entries were omitted; traversal is bounded. */
    omitted: z.number().int().nonnegative(),
  })
  .strict();
export const clusterWorkspaceRootSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(100),
    path: clusterRootPathSchema,
    index: clusterRootIndexSchema,
  })
  .strict();
export const clusterWorkspaceSetupSchema = z
  .object({
    username: z.string().max(100).nullable(),
    defaultAccount: name.nullable(),
    accounts: z
      .array(z.object({ name, fairShare: z.number().min(0).max(1).nullable() }).strict())
      .max(50),
    partitions: z.array(clusterPartitionSchema).max(200),
    selectedAccount: name.nullable(),
    accountConfirmed: z.boolean(),
    observedAt: date,
    fairshareObservedAt: date.default(null),
    partitionsObservedAt: date.default(null),
    developmentSuggestion: z.string().max(400).nullable().default(null),
    suggestedDevelopment: clusterDevelopmentSchema.nullable().default(null),
    error: z.string().max(400).nullable(),
  })
  .strict();
export const clusterWorkspaceLeaseSchema = z
  .object({
    enabled: z.boolean(),
    expiresAt: date,
    state: z.enum(['off', 'holding', 'reconnecting', 'expired', 'error']),
    message: z.string().max(400),
  })
  .strict();
export const clusterWorkspaceSchema = z
  .object({
    alias: clusterAliasSchema.nullable(),
    revision: z.number().int().nonnegative(),
    connectionId: id.nullable(),
    connected: z.boolean(),
    setup: clusterWorkspaceSetupSchema,
    roots: z.array(clusterWorkspaceRootSchema).max(8),
    development: clusterDevelopmentSchema,
    siteRules: clusterWorkspaceSiteRulesSchema.default(null),
    /** Source/worktree application review; separate from Slurm submission review. */
    workflow: projectWorkflowSchema,
    keepConnected: clusterWorkspaceLeaseSchema,
  })
  .strict();
export type ClusterWorkspaceStatus = z.infer<typeof clusterWorkspaceSchema>;
export type ClusterWorkspaceRoot = z.infer<typeof clusterWorkspaceRootSchema>;
export const clusterWorkspaceSettingsSchema = z
  .object({
    key: id,
    alias: clusterAliasSchema,
    revision: z.number().int().nonnegative(),
    roots: z
      .array(
        z
          .object({
            id: id.optional(),
            label: z.string().trim().min(1).max(100),
            path: clusterRootPathSchema,
          })
          .strict(),
      )
      .max(8),
    /** Null saves setup without account approval. Multiple accounts require an explicit choice. */
    account: name.nullable(),
    development: clusterDevelopmentSchema,
    /** Omission preserves older setup drafts; null explicitly clears the site preset. */
    siteRules: clusterWorkspaceSiteRulesSchema.optional(),
    workflow: projectWorkflowSchema,
  })
  .strict()
  .refine(
    (input) => new Set(input.roots.map((root) => root.path)).size === input.roots.length,
    'Save each cluster root once.',
  );
export const clusterWorkspaceLeaseRequestSchema = z
  .object({
    key: id,
    alias: clusterAliasSchema,
    revision: z.number().int().nonnegative(),
    /** An explicit request; null stops only the app's held client. No credentials are retained. */
    hours: z.number().int().min(1).max(72).nullable(),
  })
  .strict();
export const clusterWorkspaceRefreshSchema = z
  .object({ key: id, alias: clusterAliasSchema })
  .strict();
export const clusterWorkspaceUpdateResultSchema = z
  .object({
    status: z.enum(['saved', 'conflict']),
    state: clusterWorkspaceSchema,
    reason: z.string().max(400).nullable(),
  })
  .strict();
export type ClusterWorkspaceUpdateResult = z.infer<typeof clusterWorkspaceUpdateResultSchema>;
/** Private snapshot resolved on the host, never an execution path accepted from a browser. */
export const clusterFolderDescriptorSchema = z
  .object({
    alias: clusterAliasSchema,
    rootId: id,
    folderId: id,
    path: z.string().min(1).max(1000),
    directoryIdentity: z
      .string()
      .regex(/^\d+:\d+$/)
      .nullable()
      .default(null),
    // Private owner snapshot; device numbers are local to each login/compute host.
    directoryOwnerUid: z.number().int().nonnegative().nullable().optional(),
    gitMarker: z.boolean().nullable().default(null),
    username: z.string().min(1).max(100),
    account: name,
    development: clusterDevelopmentSchema,
    siteRules: clusterWorkspaceSiteRulesSchema.default(null),
    workflow: projectWorkflowSchema,
    indexObservedAt: z.string().datetime(),
    connectionId: id,
  })
  .strict();
export type ClusterFolderDescriptor = z.infer<typeof clusterFolderDescriptorSchema>;
