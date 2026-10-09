export * from './coordination-reviews.js';
import { coordinationReviewReadSchema } from './coordination-reviews.js';
export * from './groups.js';
export * from './prompt-text.js';
import { draftTextSchema, promptTextSchema } from './prompt-text.js';
export * from './group-membership.js';
export * from './mirror-outbox.js';
export * from './queued-message.js';
export * from './work-items.js';
export * from './archive.js';
export * from './project-workflow.js';
export * from './conversations.js';
export * from './conversation-chronology.js';
import { conversationSurfaceSchema } from './conversations.js';
import {
  workItemPageQuerySchema,
  ownerRequestQuerySchema,
  ownerTicketMetadataSchema,
  workItemSchema,
} from './work-items.js';
import { z } from 'zod';
export * from './browser-drafts.js';
export * from './local-access.js';
export * from './mirror-page.js';
export * from './codex-transcript.js';
export * from './codex-history.js';
import { allowanceFieldsSchema, allowanceSchema } from './quark.js';
import { mcpFormSchema, mcpFormValuesSchema } from './mcp-forms.js';
import { mcpUrlRequestSchema } from './mcp-urls.js';
import { backupStatusSchema } from './backups.js';
import { catalogQuerySchema, historyQuerySchema, historyReadSchema } from './history.js';
import { workspaceDraftSubmissionSchema } from './workspace-state.js';
import { folderBreadcrumbSchema, folderLocationSchema } from './folder-navigation.js';
import { jobEstimateSchema } from './pulsar.js';
import {
  providerIdSchema,
  effortSchema,
  executionRequestSchema,
  assignmentSchema,
} from './providers.js';
export * from './providers.js';
export * from './usage.js';
export * from './capacity.js';
export * from './resources.js';
export * from './cluster.js';
export * from './cluster-workspace.js';
export * from './cluster-project.js';
export * from './cluster-runtime-identity.js';
export * from './slurm-review.js';
export * from './pulsar.js';
export * from './job-detail.js';
export * from './local-jobs.js';
export * from './mcp-forms.js';
export * from './mcp-urls.js';
export * from './phone.js';
export * from './backups.js';
export * from './recovery-backups.js';
export * from './attention.js';
export * from './notifications.js';
export * from './scheduler.js';
export * from './history.js';
export * from './workspace-state.js';
export * from './hosts.js';
export * from './frontdesk.js';
export * from './conversation-visibility.js';

export const id = z.string().uuid();
export const providerThreadId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const text = z.string().trim().min(1).max(24_000);
export const roleSchema = z.enum(['manager', 'planner', 'implementer', 'reviewer', 'researcher']);
export const statusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting',
  'interrupted',
  'failed',
]);
export const permissionSchema = z.enum(['read-only', 'workspace-write']);
export const webSearchSchema = z.enum(['disabled', 'cached', 'indexed', 'live']);
export const mcpNameSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.-]+$/);
export const mcpSelectionSchema = z
  .array(mcpNameSchema)
  .max(32)
  .refine((names) => new Set(names).size === names.length, 'Select each MCP server once.');
export const mcpCatalogSchema = z.array(z.object({ name: mcpNameSchema }).strict()).max(200);
// An owner grants a ceiling; each new delegation requests only the capabilities it needs.
export const workerToolsSchema = z
  .object({
    mcpServers: mcpSelectionSchema.default([]),
    pluginsEnabled: z.boolean().default(false),
    webSearch: webSearchSchema.default('disabled'),
    imageGeneration: z.boolean().default(false),
  })
  .strict();
export const projectToolsSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    // Saved policies predating inheritance are explicit restrictions.
    toolPolicy: z.enum(['native', 'restricted']).default('restricted'),
    codex: workerToolsSchema.default(() => workerToolsSchema.parse({})),
    updatedAt: z.string().nullable().default(null),
  })
  .strict();
export const projectToolsRequestSchema = z
  .object({
    key: id,
    revision: z.number().int().nonnegative(),
    // Omission retains old-client semantics and the exact durable receipt input.
    toolPolicy: z.enum(['native', 'restricted']).optional(),
    codex: workerToolsSchema,
  })
  .strict();
export type WorkerTools = z.infer<typeof workerToolsSchema>;
export type ProjectTools = z.infer<typeof projectToolsSchema>;
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'coalesced',
]);
export const agentRunActivitySchema = z
  .object({ id, status: runStatusSchema, createdAt: z.string() })
  .strict();
export const agentSchema = z.object({
  id,
  projectId: id,
  parentId: id.nullable(),
  taskId: id.nullable(),
  name: z.string(),
  role: roleSchema,
  scope: z.string().default(''),
  status: statusSchema,
  provider: providerIdSchema.default('codex'),
  assignment: assignmentSchema.nullable().default(null),
  modelSelection: z.enum(['policy', 'exact', 'native']).optional(),
  surface: conversationSurfaceSchema.optional(),
  resourceAssistant: z
    .object({
      mode: z.enum(['interactive', 'snapshot']),
      // Absent only when a legacy resource identity has no retained origin evidence.
      reason: z.enum(['asked', 'checkpoint', 'pressure']).optional(),
    })
    .optional(),
  interview: z
    .object({
      sourceAgentId: id,
      sourceTaskId: id.nullable(),
      capturedAt: z.string(),
      continuity: z.enum(['saved-evidence', 'native-fork']),
      sourceThreadId: providerThreadId.optional(),
      sourceTurnId: z.string().min(1).max(200).optional(),
      sourceMessageId: z.uuid().optional(),
    })
    .optional(),
  model: z.string().nullable(),
  effort: effortSchema,
  permission: permissionSchema,
  // Missing on saved conversations means the earlier explicit app restrictions.
  toolPolicy: z.enum(['native', 'restricted']).optional(),
  // Omission inherits the owner's native Chrome preference without changing it.
  nativeChrome: z.enum(['inherit', 'enabled']).optional(),
  mcpServers: mcpSelectionSchema.default([]),
  pluginsEnabled: z.boolean().default(false),
  webSearch: webSearchSchema.default('disabled'),
  imageGeneration: z.boolean().default(false),
  nativeRootId: id.nullable().default(null),
  nativePath: z.string().nullable().default(null),
  checkpoint: z.string(),
  // Read-only snapshot projection. Omission means the host has not reported run evidence.
  latestRun: agentRunActivitySchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Derived from retained owner/reply entries; status/configuration changes are separate.
  lastActivityAt: z.string().optional(),
  archivedAt: z.string().optional(),
});
export const projectSchema = z.object({
  id,
  internal: z.boolean().optional(),
  name: z.string(),
  description: z.string(),
  managerId: id,
  createdAt: z.string(),
});
export const projectCreateSchema = z
  .object({
    key: id,
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    description: z.string().trim().max(2000).default(''),
    provider: providerIdSchema.optional(),
  })
  .strict();
export const projectOptionsSchema = z
  .object({ canChooseFolder: z.boolean(), folderBrowser: z.boolean().optional() })
  .strict();
export const folderBrowseRequestSchema = z
  .object({
    folderId: id.optional(),
    offset: z.coerce.number().int().nonnegative().max(1000000).default(0),
    query: z.string().trim().min(1).max(120).optional(),
    scope: z.enum(['children', 'descendants']).default('descendants'),
    hidden: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();
export const folderBrowseSchema = z
  .object({
    current: z.object({ id, name: z.string().max(255), canSelect: z.boolean() }).strict(),
    parentId: id.nullable(),
    folders: z
      .array(z.object({ id, name: z.string().max(255), location: z.string().optional() }).strict())
      .max(100),
    nextOffset: z.number().int().nonnegative().nullable(),
    breadcrumbs: z.array(folderBreadcrumbSchema).default([]),
    locations: z.array(folderLocationSchema).default([]),
    search: z.object({ query: z.string(), partial: z.boolean() }).strict().nullable().default(null),
  })
  .strict();
export const projectFolderSchema = z
  .object({
    key: id,
    name: projectCreateSchema.shape.name.optional(),
    provider: providerIdSchema.optional(),
    selectOnly: z.boolean().optional(),
    fresh: z.boolean().optional(),
    folderId: id.optional(),
  })
  .strict();
export const projectTrackingSchema = z.object({ key: id, name: z.string().max(255) }).strict();
export const projectFolderSelectionSchema = projectTrackingSchema.extend({
  needsTracking: z.boolean(),
});
export const projectTrackingRequestSchema = z
  .object({ key: id, confirmedTracking: z.literal(true) })
  .strict();
export const projectConnectionSchema = z
  .object({
    project: projectSchema.nullable(),
    tracking: projectTrackingSchema.optional(),
    selection: projectFolderSelectionSchema.optional(),
  })
  .strict();
export const taskStatusSchema = z.enum([
  'open',
  'working',
  'review',
  'needs_decision',
  'done',
  'integrated',
  'split',
  'cancelled',
]);
export const taskCancelSchema = z
  .object({ key: id, reason: z.string().trim().min(1).max(2000) })
  .strict();
export const taskSchema = z.object({
  id,
  projectId: id,
  managerId: id,
  parentId: id.nullable(),
  title: z.string(),
  goal: z.string(),
  acceptance: z.string(),
  scheduling: jobEstimateSchema.default(() => jobEstimateSchema.parse({})),
  ownerTicket: ownerTicketMetadataSchema.optional(),
  status: taskStatusSchema,
  closure: z.object({ reason: z.string(), closedAt: z.string().datetime() }).optional(),
  revisions: z.number(),
  review: z.string().nullable(),
  // A reviewed commit beyond the task's base; integration still needs a fresh preview.
  hasReviewedChanges: z.boolean().default(false),
  reconciliationTaskId: z.string().uuid().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ownerTicketResultSchema = z
  .object({
    task: taskSchema,
    workerId: id,
    runId: id,
    items: z.array(workItemSchema),
  })
  .strict();
export const generatedImageSchema = z
  .object({
    id,
    mimeType: z.literal('image/png'),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .strict();
export const entrySchema = z.object({
  id: z.string(),
  agentId: id,
  runId: id.nullable(),
  kind: z.enum(['user', 'assistant', 'tool', 'system', 'message']),
  title: z.string(),
  text: z.string(),
  urlRequest: mcpUrlRequestSchema.optional(),
  image: generatedImageSchema.optional(),
  status: z.string(),
  createdAt: z.string(),
  // Assistant replies only: the provider's explicit message phase. Absent means unknown;
  // never inferred from wording, status or turn completion.
  phase: z.enum(['commentary', 'final']).optional(),
  ownerInput: z
    .object({ delivery: z.enum(['submitted', 'uncertain']) })
    .strict()
    .optional(),
  // Derived from the retained run when reading app history, never from message wording.
  coordination: z
    .object({ kind: z.enum(['message', 'report']), sourceId: id.nullable() })
    .strict()
    .optional(),
});
export const runSchema = z.object({
  id,
  agentId: id,
  sourceId: id.nullable(),
  text: z.string(),
  kind: z.enum(['user', 'delegation', 'message', 'report', 'resume']),
  status: runStatusSchema,
  createdAt: z.string(),
  queueEditable: z.boolean().optional(),
  queueRevision: z.number().int().nonnegative().optional(),
  queueEdit: z
    .object({
      clientId: id,
      text: draftTextSchema,
      state: z.enum(['editing', 'steering']),
      operationKey: id.optional(),
    })
    .nullable()
    .optional(),
});
export const queuedMessageReceiptSchema = z
  .object({
    status: z.enum(['applied', 'uncertain', 'not_found']),
    run: runSchema,
  })
  .strict();
export const approvalSchema = z.object({
  id,
  agentId: id,
  kind: z.enum(['command', 'file', 'permissions', 'input', 'mcp', 'mcp_form', 'mcp_url']),
  title: z.string(),
  details: z.string(),
  form: mcpFormSchema.optional(),
  urlRequest: mcpUrlRequestSchema.optional(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        header: z.string(),
        question: z.string(),
        multiSelect: z.boolean().optional(),
        allowCustom: z.boolean().optional(),
        options: z
          .array(z.object({ label: z.string(), description: z.string() }))
          .nullable()
          .optional(),
      }),
    )
    .default([]),
  status: z.enum(['pending', 'accepted', 'declined', 'expired']),
  createdAt: z.string(),
});
export const decisionSchema = z.object({
  id,
  projectId: id,
  taskId: id.nullable(),
  agentId: id,
  kind: z.string(),
  rationale: z.string(),
  evidence: z.string(),
  createdAt: z.string(),
});
export const eventSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  projectId: id.nullable(),
  agentId: id.nullable(),
  data: z.unknown(),
  createdAt: z.string(),
});
export const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  efforts: z.array(z.string()),
});
export const snapshotSchema = z.object({
  backups: z.array(backupStatusSchema).default([]),
  projects: z.array(projectSchema),
  agents: z.array(agentSchema),
  tasks: z.array(taskSchema),
  approvals: z.array(approvalSchema),
  decisions: z.array(decisionSchema),
  eventId: z.number(),
  provider: z.object({ ready: z.boolean(), version: z.string(), message: z.string() }),
  schedulingError: z.string().nullable().optional(),
});
export const agentDetailChannelSchema = z.enum(['all', 'conversation', 'coordination']);
export type AgentDetailChannel = z.infer<typeof agentDetailChannelSchema>;
export const agentDetailQuerySchema = z
  .object({
    before: z.string().min(1).max(120).optional(),
    channel: agentDetailChannelSchema.default('all'),
  })
  .strict();
export const detailSchema = z.object({
  agent: agentSchema,
  entries: z.array(entrySchema),
  runs: z.array(runSchema),
  hasMore: z.boolean(),
  nativeDiscussion: z.enum(['available', 'prepared']).optional(),
});
export const sendSchema = z
  .object({
    key: id,
    text: promptTextSchema,
    steer: z.boolean().default(false),
    draft: workspaceDraftSubmissionSchema.optional(),
    scheduling: jobEstimateSchema.optional(),
  })
  .strict();
export const interviewRequestSchema = z
  .object({
    key: id,
    continuity: z.enum(['saved-evidence', 'native-fork']).optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    provider: providerIdSchema.optional(),
    model: z.string().min(1).max(100).nullable(),
    effort: effortSchema,
    permission: permissionSchema,
    toolPolicy: z.enum(['native', 'restricted']).optional(),
    nativeChrome: z.enum(['inherit', 'enabled']).optional(),
    mcpServers: mcpSelectionSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    webSearch: webSearchSchema.optional(),
    imageGeneration: z.boolean().optional(),
  })
  .strict();
export const approvalReplySchema = z
  .object({
    decision: z.enum(['accept', 'decline']),
    answers: z.record(z.string(), z.array(z.string().max(8000))).optional(),
    formValues: mcpFormValuesSchema.optional(),
  })
  .strict();
export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    goal: text,
    acceptance: z.string().trim().min(1).max(2000),
    parentId: id.nullable().optional(),
    scheduling: jobEstimateSchema.optional(),
  })
  .strict();
export const managerRemoveSchema = z.object({ key: id }).strict();
export const managerCreateSchema = z
  .object({
    key: id,
    name: z.string().trim().min(1).max(80),
    scope: z.string().trim().min(1).max(2000),
    provider: providerIdSchema.optional(),
  })
  .strict();
export const sessionSchema = z.object({
  id: providerThreadId,
  title: z.string().max(160),
  preview: z.string().max(1000),
  updatedAt: z.number(),
  agentId: id.nullable(),
});
export const sessionListSchema = z.object({
  data: z.array(sessionSchema),
  nextCursor: z.string().max(4096).nullable(),
});
export const sessionImportSchema = z
  .object({
    key: id,
    threadId: providerThreadId,
    managerId: id,
    confirmedStopped: z.literal(true),
  })
  .strict();
export const taskRequestSchema = z
  .object({ key: id, managerId: id.optional(), task: taskCreateSchema })
  .strict();
export const delegateSchema = z
  .object({
    taskId: id,
    role: roleSchema.exclude(['manager']),
    name: z.string().trim().min(1).max(80),
    instruction: text,
    execution: executionRequestSchema.optional(),
    tools: workerToolsSchema.optional(),
  })
  .strict();
export const messageSchema = z.object({ agentId: id, message: text }).strict();
export const decisionInputSchema = z
  .object({
    taskId: id,
    kind: z.enum(['accept', 'revise', 'split', 'complete', 'note']),
    rationale: z.string().trim().min(20).max(4000),
    evidence: z.string().trim().min(1).max(4000),
  })
  .strict();
export const reviewSchema = z
  .object({
    verdict: z.enum(['approve', 'changes_requested']),
    findings: z.string().max(5000),
    evidence: z.string().min(1).max(5000),
  })
  .strict();
// z.toJSONSchema cannot express the refinement below, so advertise it as text.
const inspectTargetRule =
  'Choose one inspection target per call: agentId, taskId, history, read, catalog, workItems, ownerRequests, goal, models, capacity, resources, scheduling, accounting, coordination or cluster. {} reads the project overview; changes:true requires taskId and provider applies only with models:true.';
export const inspectSchema = z
  .object({
    agentId: id.optional(),
    taskId: id.optional(),
    history: historyQuerySchema.optional(),
    read: historyReadSchema.optional(),
    catalog: catalogQuerySchema.optional(),
    workItems: workItemPageQuerySchema.optional(),
    ownerRequests: ownerRequestQuerySchema.optional(),
    coordination: coordinationReviewReadSchema.optional(),
    goal: z.literal(true).optional(),
    models: z.literal(true).optional(),
    provider: providerIdSchema.optional(),
    changes: z.literal(true).optional(),
    capacity: z.literal(true).optional(),
    resources: z.literal(true).optional(),
    scheduling: z.literal(true).optional(),
    accounting: z.literal(true).optional(),
    cluster: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => !value.provider || value.models,
    'A provider can be chosen only for model discovery.',
  )
  .refine((value) => !value.changes || !!value.taskId, 'File changes require a task ID.')
  .refine(
    (value) =>
      [
        value.agentId,
        value.taskId,
        value.history,
        value.read,
        value.catalog,
        value.workItems,
        value.ownerRequests,
        value.goal,
        value.coordination,
        value.models,
        value.capacity,
        value.resources,
        value.scheduling,
        value.accounting,
        value.cluster,
      ].filter(Boolean).length <= 1,
    `${inspectTargetRule} Make separate dock_inspect calls, for example {workItems:{...}} and then {ownerRequests:{...}}.`,
  )
  .describe(inspectTargetRule);
export const checkpointSchema = z.object({ summary: z.string().min(1).max(8000) }).strict();
export const commandSchema = z
  .object({ key: id, command: z.enum(['compact', 'new', 'resume', 'interrupt']) })
  .strict();
// Native names are provider-discovered; the browser never chooses an RPC or executable.
export const nativeCommandNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
export const nativeCommandCatalogSchema = z
  .object({
    provider: providerIdSchema,
    commands: z.array(nativeCommandNameSchema).max(500),
    note: z.string().max(2000),
  })
  .strict();
export const nativeCommandRequestSchema = z
  .object({
    key: id,
    text: z
      .string()
      .trim()
      .min(2)
      .max(200_000)
      .regex(/^\/[a-zA-Z0-9][a-zA-Z0-9_.:-]*(?:\s[^\0]*)?$/),
  })
  .strict();
export const nativeCommandReceiptSchema = z
  .object({
    key: id,
    agentId: id,
    text: z.string().min(2).max(200_000),
    run: runSchema,
  })
  .strict();
export const terminalInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(8192) }).strict(),
  z
    .object({
      type: z.literal('resize'),
      cols: z.number().int().min(20).max(300),
      rows: z.number().int().min(5).max(120),
    })
    .strict(),
]);
export const terminalOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('transferred'), agentId: id }).strict(),
  z.object({ type: z.literal('output'), data: z.string().max(1_000_000) }).strict(),
  z.object({ type: z.literal('error'), message: z.string().max(2000) }).strict(),
  z.object({ type: z.literal('exit'), code: z.number().int() }).strict(),
]);
export type Agent = z.infer<typeof agentSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Run = z.infer<typeof runSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type DockEvent = z.infer<typeof eventSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type AgentDetail = z.infer<typeof detailSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Role = Agent['role'];
export type SavedSession = z.infer<typeof sessionSchema>;
export * from './mirror.js';

export * from './model-policy.js';
export * from './quark.js';
export * from './quark-coordinator.js';
export * from './conversation-search.js';
export * from './quark-focus.js';
export * from './provider-maintenance.js';
export * from './integration.js';

export * from './project-drafts.js';
export * from './setup.js';
export * from './documents.js';
export * from './folder-navigation.js';

/** An outside agent can create new capped work, never revise or raise existing caps. */
export const agentTaskRequestSchema = taskRequestSchema
  .extend({
    projectId: id,
    task: taskCreateSchema.extend({
      scheduling: jobEstimateSchema.default(() =>
        jobEstimateSchema.parse({ priority: 'background' }),
      ),
    }),
    allowances: z
      .array(
        allowanceFieldsSchema
          .pick({
            provider: true,
            windowId: true,
            limitPercent: true,
          })
          .extend({ limitPercent: z.number().positive().max(100) }),
      )
      .min(1)
      .max(40)
      .refine(
        (items) =>
          new Set(items.map((item) => `${item.provider}:${item.windowId}`)).size === items.length,
        'Select each provider window once.',
      ),
  })
  .strict();
export const agentTaskResultSchema = z
  .object({
    task: taskSchema,
    runId: id,
    allowances: z.array(allowanceSchema),
  })
  .strict();

export * from './bug-reports.js';
export * from './app-updates.js';
export * from './browser-setup.js';
export * from './latex-reading.js';
export * from './chat-images.js';
export * from './chat-files.js';
export * from './project-apps.js';
export * from './publishing-accounts.js';

export * from './owner-terminal.js';
export * from './native-goal.js';
export * from './managed-goal.js';
export * from './run-recovery.js';
export * from './cluster-admission.js';
export * from './cluster-admission-ledger.js';
export * from './cluster-account-controls.js';
export * from './cluster-coordination.js';
