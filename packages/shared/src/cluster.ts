import { z } from 'zod';

/** An SSH host alias from the owner's own SSH configuration, never a command or option. */
export const clusterAliasSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/,
    'Use the SSH host alias from your SSH configuration.',
  );
export const clusterSettingsSchema = z
  .object({
    enabled: z.boolean(),
    alias: clusterAliasSchema,
    label: z.string().trim().min(1).max(60),
    /** Recent accounting window. Some sites reject sacct ranges of a week or more. */
    accountingDays: z.number().int().min(1).max(6).default(3),
  })
  .strict();
export const clusterSettingsRequestSchema = z
  .object({ key: z.string().uuid(), settings: clusterSettingsSchema })
  .strict();
export const clusterRefreshSchema = z.object({ key: z.string().uuid() }).strict();

export const clusterConnectionStateSchema = z.enum([
  'not-configured',
  'checking',
  'connected',
  'sign-in-needed',
  'host-key',
  'unreachable',
  'error',
]);
export const clusterConnectionSchema = z
  .object({
    state: clusterConnectionStateSchema,
    /** The owner's native SSH control master on this computer, checked locally. */
    master: z.enum(['running', 'absent', 'unknown']),
    checkedAt: z.string().datetime().nullable(),
    connectedAt: z.string().datetime().nullable(),
    message: z.string().max(400),
  })
  .strict();

const count = z.number().int().nonnegative();
const seconds = z.number().int().nonnegative().nullable();
const bytes = z.number().nonnegative().nullable();
const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => z.string().max(max).nullable();

export const clusterTrackedOwnerSchema = z
  .object({
    agentId: z.string().uuid(),
    agentName: text(200),
    projectId: z.string().uuid(),
    projectName: text(200),
  })
  .strict();
export const clusterQueueJobSchema = z
  .object({
    jobId: text(80),
    baseJobId: text(40),
    name: text(200),
    state: text(40),
    reason: text(200),
    partition: text(200),
    account: text(100),
    qos: text(100),
    submittedAt: optionalText(40),
    /** Running: actual start. Pending: Slurm's current estimate, which can move. */
    startAt: optionalText(40),
    timeLimit: text(40),
    timeUsed: text(40),
    cpus: count.nullable(),
    memory: text(40),
    gres: text(200),
    nodes: count.nullable(),
    nodeList: text(400),
    priority: z.number().nonnegative().nullable(),
    workDir: text(1000),
    owner: clusterTrackedOwnerSchema.nullable(),
  })
  .strict();
export const clusterPriorityFactorSchema = z
  .object({
    jobId: text(80),
    priority: z.number().nonnegative().nullable(),
    age: z.number().nonnegative().nullable(),
    fairshare: z.number().nonnegative().nullable(),
    jobSize: z.number().nonnegative().nullable(),
    partition: z.number().nonnegative().nullable(),
    qos: z.number().nonnegative().nullable(),
  })
  .strict();
export const clusterFairshareSchema = z
  .object({
    account: text(100),
    /**
     * sshare's FairShare factor for this person in the account, 0–1, under whichever fairshare
     * algorithm the site configures. Higher contributes more priority; it does not set start order.
     */
    fairShare: z.number().min(0).max(1).nullable(),
    /** LevelFS, reported only under Fair Tree; null otherwise. */
    levelFairShare: z.number().nonnegative().nullable(),
    accountNormShares: z.number().nonnegative().nullable(),
    accountEffectiveUsage: z.number().nonnegative().nullable(),
    accountRawUsage: z.number().nonnegative().nullable(),
    userRawUsage: z.number().nonnegative().nullable(),
  })
  .strict();
export const clusterAssociationSchema = z
  .object({
    cluster: text(100),
    account: text(100),
    partition: text(100),
    qos: z.array(text(100)).max(100),
    defaultQos: text(100),
    maxJobs: count.nullable(),
    maxSubmit: count.nullable(),
    maxWall: text(40),
    maxTres: text(400),
    maxTresPerNode: text(400),
    grpJobs: count.nullable(),
    grpSubmit: count.nullable(),
    grpTres: text(400),
    grpTresRunMins: text(400),
    grpWall: text(40),
  })
  .strict();
/** An account-level association (own accounts and their parents); it applies to all members. */
export const clusterAccountLimitSchema = clusterAssociationSchema
  .extend({ parent: text(100) })
  .strict();
export const clusterQosSchema = z
  .object({
    name: text(100),
    maxJobsPerUser: count.nullable(),
    maxSubmitPerUser: count.nullable(),
    maxTresPerUser: text(400),
    maxJobsPerAccount: count.nullable(),
    maxSubmitPerAccount: count.nullable(),
    maxTresPerAccount: text(400),
    maxTres: text(400),
    maxTresPerNode: text(400),
    maxWall: text(40),
    grpJobs: count.nullable(),
    grpSubmit: count.nullable(),
    grpTres: text(400),
    flags: text(400),
  })
  .strict();
/** Site-wide scheduler settings from `scontrol show config`; null fields were not reported. */
export const clusterSiteLimitsSchema = z
  .object({
    maxArraySize: count.nullable(),
    maxJobCount: count.nullable(),
    /** AccountingStorageEnforce: which association/QOS limits the site enforces. */
    enforce: text(200),
    priorityType: text(80),
    priorityFlags: text(200),
  })
  .strict();
export const clusterPartitionSchema = z
  .object({
    name: text(100),
    state: text(40),
    maxTime: text(40),
    defaultTime: text(40),
    maxNodes: text(40),
    maxCpusPerNode: text(40),
    defMemPerCpu: text(40),
    defMemPerNode: text(40),
    maxMemPerNode: text(40),
    qos: text(100),
    preemptMode: text(40),
    priorityTier: count.nullable(),
    totalCpus: count.nullable(),
    totalNodes: count.nullable(),
    gres: text(400),
    /** CPUs allocated/idle/other/total from sinfo; a snapshot, not a reservation. */
    cpus: z
      .object({ allocated: count, idle: count, other: count, total: count })
      .strict()
      .nullable(),
    /** True when the partition admits one of this person's groups and accounts. */
    accessible: z.boolean().nullable(),
  })
  .strict();
export const clusterRecentJobSchema = z
  .object({
    jobId: text(80),
    baseJobId: text(40),
    name: text(200),
    partition: text(200),
    account: text(100),
    state: text(80),
    exitCode: text(20),
    submittedAt: optionalText(40),
    startedAt: optionalText(40),
    endedAt: optionalText(40),
    elapsedSeconds: seconds,
    timeLimitSeconds: seconds,
    cpus: count.nullable(),
    memoryBytes: bytes,
    gpus: count.nullable(),
    cpuSeconds: seconds,
    maxRssBytes: bytes,
    /** TotalCPU / (Elapsed × allocated CPUs). */
    cpuEfficiency: z.number().nonnegative().nullable(),
    /** Largest step MaxRSS / allocated memory; per-task maximum, so approximate. */
    memoryEfficiency: z.number().nonnegative().nullable(),
    workDir: text(1000),
    stdout: text(1000),
    stderr: text(1000),
    owner: clusterTrackedOwnerSchema.nullable(),
  })
  .strict();
export const clusterTrackedJobSchema = z
  .object({
    jobId: z.string().regex(/^\d{1,20}$/),
    /** The configured SSH alias when the job was observed; job IDs are unique per cluster. */
    alias: clusterAliasSchema,
    agentId: z.string().uuid(),
    projectId: z.string().uuid(),
    runId: z.string().uuid().nullable(),
    /** Native Codex thread or Claude session that submitted the job. */
    sessionId: z.string().max(200).nullable(),
    entryId: z.string().max(400),
    detectedAt: z.string().datetime(),
    source: z.enum(['submission-output']),
    state: text(80).nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    reportedAt: z.string().datetime().nullable(),
  })
  .strict();

const section = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .object({
      observedAt: z.string().datetime().nullable(),
      error: z.string().max(400).nullable(),
      items: z.array(item).max(max),
      omitted: count,
    })
    .strict();
export const clusterQueueSectionSchema = section(clusterQueueJobSchema, 500).extend({
  priority: z.array(clusterPriorityFactorSchema).max(200),
});
export const clusterFairshareSectionSchema = section(clusterFairshareSchema, 50);
export const clusterLimitsSectionSchema = section(clusterAssociationSchema, 50).extend({
  accounts: z.array(clusterAccountLimitSchema).max(100),
  qos: z.array(clusterQosSchema).max(100),
  partitions: z.array(clusterPartitionSchema).max(200),
  site: clusterSiteLimitsSchema.nullable(),
});
/** Native readings that failed, were unsupported or were missing from the latest reply. */
export const clusterUnavailableSchema = z
  .object({
    section: z.enum([
      'queue',
      'priority',
      'recent',
      'tracked',
      'version',
      'groups',
      'fairshare',
      'assoc',
      'accounts',
      'qos',
      'partitions',
      'sinfo',
      'config',
    ]),
    message: text(300),
  })
  .strict();
export const clusterRecentSectionSchema = section(clusterRecentJobSchema, 400);

export const clusterStatusSchema = z
  .object({
    configured: z.boolean(),
    settings: clusterSettingsSchema.nullable(),
    revision: count,
    connection: clusterConnectionSchema,
    scheduler: z
      .object({ version: text(40), cluster: text(100) })
      .strict()
      .nullable(),
    queue: clusterQueueSectionSchema,
    fairshare: clusterFairshareSectionSchema,
    limits: clusterLimitsSectionSchema,
    recent: clusterRecentSectionSchema,
    tracked: z
      .array(clusterTrackedJobSchema.extend({ owner: clusterTrackedOwnerSchema.nullable() }))
      .max(200),
    unavailable: z.array(clusterUnavailableSchema).max(20),
    refreshing: z.boolean(),
    nextRefreshAt: z.string().datetime().nullable(),
    stale: z.boolean(),
    notice: text(1000),
  })
  .strict();

export type ClusterSettings = z.infer<typeof clusterSettingsSchema>;
export type ClusterConnection = z.infer<typeof clusterConnectionSchema>;
export type ClusterQueueJob = z.infer<typeof clusterQueueJobSchema>;
export type ClusterPriorityFactor = z.infer<typeof clusterPriorityFactorSchema>;
export type ClusterFairshare = z.infer<typeof clusterFairshareSchema>;
export type ClusterAssociation = z.infer<typeof clusterAssociationSchema>;
export type ClusterAccountLimit = z.infer<typeof clusterAccountLimitSchema>;
export type ClusterSiteLimits = z.infer<typeof clusterSiteLimitsSchema>;
export type ClusterUnavailable = z.infer<typeof clusterUnavailableSchema>;
export type ClusterQos = z.infer<typeof clusterQosSchema>;
export type ClusterPartition = z.infer<typeof clusterPartitionSchema>;
export type ClusterRecentJob = z.infer<typeof clusterRecentJobSchema>;
export type ClusterTrackedJob = z.infer<typeof clusterTrackedJobSchema>;
export type ClusterTrackedOwner = z.infer<typeof clusterTrackedOwnerSchema>;
export type ClusterStatus = z.infer<typeof clusterStatusSchema>;

/** In-app SSH sign-in. Answers are typed into native SSH and never stored or returned. */
export const clusterSignInStartSchema = z.object({ key: z.string().uuid() }).strict();
export const clusterSignInRespondSchema = z
  .object({
    id: z.string().uuid(),
    promptId: z.number().int().positive(),
    response: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u001f\u007f]+$/, 'Enter the answer on one line.'),
  })
  .strict();
export const clusterSignInSchema = z
  .object({
    id: z.string().uuid().nullable(),
    state: z.enum([
      'idle',
      'starting',
      'prompt',
      'waiting',
      'connected',
      'failed',
      'expired',
      'cancelled',
    ]),
    prompt: z
      .object({
        id: z.number().int().positive(),
        kind: z.enum(['password', 'code']),
        label: z.string().max(80),
      })
      .strict()
      .nullable(),
    message: z.string().max(300),
    startedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ClusterSignIn = z.infer<typeof clusterSignInSchema>;

/** A private notebook tunnel on this computer's loopback; its token is never stored. */
export const clusterNotebookSchema = z
  .object({
    /** The SSH alias whose sign-in carries the forward; never reissued through another alias. */
    alias: clusterAliasSchema,
    jobId: z.string().regex(/^\d{1,20}$/),
    node: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
    remotePort: z.number().int().min(1024).max(65535),
    localPort: z.number().int().min(1024).max(65535),
    openedAt: z.string().datetime(),
    /** Older jobs use / and remain available in the local browser. */
    baseUrl: z
      .string()
      .regex(/^(?:\/|\/notebooks\/\d{1,20}\/)$/)
      .optional(),
  })
  .strict();
export const clusterNotebookOpenSchema = z
  .object({ key: z.string().uuid(), jobId: z.string().regex(/^\d{1,20}$/) })
  .strict();
export const clusterNotebookCloseSchema = z
  .object({ jobId: z.string().regex(/^\d{1,20}$/) })
  .strict();
export const clusterNotebooksSchema = z
  .object({
    localBrowser: z.boolean(),
    remoteAvailable: z.boolean().default(false),
    remoteMessage: z
      .string()
      .max(300)
      .default('Phone notebooks need a separate notebook address on this computer.'),
    notebooks: z.array(clusterNotebookSchema.extend({ running: z.boolean() })).max(8),
  })
  .strict();
export type ClusterNotebook = z.infer<typeof clusterNotebookSchema>;

/** A one-use notebook-only handoff. No Jupyter or app credentials appear in it. */
export const clusterNotebookLaunchResultSchema = z
  .object({ jobId: z.string().regex(/^\d{1,20}$/), url: z.string().url() })
  .strict();
export const clusterNotebookLaunchKeySchema = z.object({ key: z.string().uuid() }).strict();
export type ClusterNotebookLaunchResult = z.infer<typeof clusterNotebookLaunchResultSchema>;
