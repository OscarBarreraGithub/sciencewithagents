import { z } from 'zod';

const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().trim().min(1).max(80);
const agentIds = z
  .array(uuid)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Open each conversation once.');

export const workspaceClientSchema = z
  .object({
    id: uuid,
    label,
    revision,
    openAgentIds: agentIds,
    selectedAgentId: uuid.nullable(),
    updatedAt: z.string(),
  })
  .strict();
export const workspaceSnapshotSchema = z
  .object({
    hostId: uuid,
    client: workspaceClientSchema,
    others: z.array(workspaceClientSchema).max(100),
  })
  .strict();
/** Read-only provider reattachment outcomes; no submitted turn or delivery receipt. */
export const workspaceRestoreResultsSchema = z
  .array(
    z
      .object({
        agentId: uuid,
        state: z.enum(['ready', 'connected', 'inspect', 'unavailable']),
        message: z.string().min(1).max(1000),
      })
      .strict(),
  )
  .max(100);
export const workspaceRegisterSchema = z.object({ key: uuid, label }).strict();
export const workspaceUpdateSchema = z
  .object({
    key: uuid,
    hostId: uuid,
    revision,
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('open'), agentId: uuid }).strict(),
      z.object({ kind: z.literal('close'), agentId: uuid }).strict(),
      z
        .object({ kind: z.literal('adopt'), sourceClientId: uuid, sourceRevision: revision })
        .strict(),
      z.object({ kind: z.literal('rename'), label }).strict(),
    ]),
  })
  .strict();
export const workspaceUpdateResultSchema = z
  .object({
    status: z.enum(['applied', 'conflict']),
    state: workspaceSnapshotSchema,
    reason: z.string().optional(),
  })
  .strict();

export const workspaceDraftSchema = z
  .object({
    clientId: uuid,
    agentId: uuid,
    revision,
    text: z.string().max(24_000),
    deliveryKey: uuid.nullable(),
    submitted: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();
export const workspaceDraftsSchema = z
  .object({
    hostId: uuid,
    clientId: uuid,
    agentId: uuid,
    own: workspaceDraftSchema,
    others: z.array(workspaceDraftSchema.extend({ label })).max(100),
  })
  .strict();
export const workspaceDraftUpdateSchema = z
  .object({
    key: uuid,
    hostId: uuid,
    revision,
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('save'), text: z.string().max(24_000) }).strict(),
      z
        .object({ kind: z.literal('copy'), sourceClientId: uuid, sourceRevision: revision })
        .strict(),
    ]),
  })
  .strict();
export const workspaceDraftUpdateResultSchema = z
  .object({
    status: z.enum(['applied', 'conflict']),
    state: workspaceDraftsSchema,
    reason: z.string().optional(),
  })
  .strict();

/** Optional structured-chat guard; never used to replay terminal bytes. */
export const workspaceDraftSubmissionSchema = z
  .object({ hostId: uuid, clientId: uuid, revision, deliveryKey: uuid })
  .strict();

export type WorkspaceClient = z.infer<typeof workspaceClientSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type WorkspaceRestoreResults = z.infer<typeof workspaceRestoreResultsSchema>;
export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;
export type WorkspaceUpdateResult = z.infer<typeof workspaceUpdateResultSchema>;
export type WorkspaceDraft = z.infer<typeof workspaceDraftSchema>;
export type WorkspaceDrafts = z.infer<typeof workspaceDraftsSchema>;
export type WorkspaceDraftUpdate = z.infer<typeof workspaceDraftUpdateSchema>;
export type WorkspaceDraftUpdateResult = z.infer<typeof workspaceDraftUpdateResultSchema>;
export type WorkspaceDraftSubmission = z.infer<typeof workspaceDraftSubmissionSchema>;

export const workspaceDraftHistorySchema = z
  .object({ versions: z.array(workspaceDraftSchema).max(20), nextBefore: revision.nullable() })
  .strict();
export type WorkspaceDraftHistory = z.infer<typeof workspaceDraftHistorySchema>;
