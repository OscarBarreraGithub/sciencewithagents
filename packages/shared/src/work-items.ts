import { z } from 'zod';

const workItemId = z.string().uuid();
const revision = z.number().int().nonnegative();
const title = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'Keep the title to one concise line.',
  });
const detail = z.string().trim().max(8_000);
const humanReply = z.string().trim().min(1).max(8_000);
export const workItemKindSchema = z.enum(['human', 'internal', 'general', 'idea']);
export const workItemStatusSchema = z.enum(['open', 'in_progress', 'waiting', 'done']);
/** Saved app entry identity, not a quoted title or a filesystem path. */
export const ownerMessageReferenceSchema = z
  .object({
    agentId: workItemId,
    entryId: z.string().min(1).max(1024),
  })
  .strict();
const sourceMessages = z
  .array(ownerMessageReferenceSchema)
  .max(50)
  .refine(
    (values) =>
      new Set(values.map((value) => `${value.agentId}:${value.entryId}`)).size === values.length,
    'Link each source message once.',
  );

export const workItemSchema = z
  .object({
    id: workItemId,
    projectId: workItemId.nullable(),
    managerId: workItemId.nullable(),
    taskId: workItemId.nullable(),
    kind: workItemKindSchema,
    title,
    detail,
    status: workItemStatusSchema,
    revision: revision.min(1),
    humanReply: humanReply.nullable(),
    repliedAt: z.string().datetime().nullable(),
    replyRunId: workItemId.nullable(),
    assignmentRunId: workItemId.nullable(),
    ownerTicketId: workItemId.nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    sourceMessages: sourceMessages.default([]),
    sourceDisposition: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .strict();

/** Omit id to create. Updating an existing item requires its observed revision. */
export const workItemRequestSchema = z
  .object({
    key: workItemId,
    id: workItemId.optional(),
    expectedRevision: revision.optional(),
    projectId: workItemId.nullable().optional(),
    managerId: workItemId.nullable().optional(),
    taskId: workItemId.nullable().optional(),
    kind: workItemKindSchema.optional(),
    title: title.optional(),
    detail: detail.optional(),
    status: workItemStatusSchema.optional(),
    humanReply: humanReply.optional(),
    sourceMessages: sourceMessages.optional(),
    sourceDisposition: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict();

/** Scope comes from the authenticated manager, never from tool-supplied IDs. */
export const managerWorkItemRequestSchema = workItemRequestSchema
  .omit({
    projectId: true,
    managerId: true,
    humanReply: true,
  })
  .extend({ kind: workItemKindSchema.exclude(['idea']).optional() });

const ticketLevel = z.number().int().min(1).max(5);
export const ownerTicketMetadataSchema = z
  .object({
    id: workItemId,
    priority: ticketLevel,
    estimatedCompute: ticketLevel,
    sourceItems: z
      .array(z.object({ id: workItemId, revision: revision.min(1), title }).strict())
      .min(1)
      .max(20),
  })
  .strict();
/** Owner-approved work goes directly to the existing worker queue, without a manager ask. */
export const ownerTicketRequestSchema = z
  .object({
    key: workItemId,
    projectId: workItemId,
    items: z
      .array(z.object({ id: workItemId, expectedRevision: revision.min(1) }).strict())
      .min(1)
      .max(20)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        'Select each to-do once.',
      ),
    title: z.string().trim().min(1).max(160),
    brief: z.string().trim().max(8000).default(''),
    acceptance: z.string().trim().min(1).max(2000),
    priority: ticketLevel.default(3),
    estimatedCompute: ticketLevel.default(3),
  })
  .strict();

export const workItemQuerySchema = z.object({ projectId: workItemId.optional() }).strict();
export const workItemsSchema = z.object({ items: z.array(workItemSchema) }).strict();

/** Agent reads are scoped by the host. A cursor is an existing item in that project. */
export const workItemPageQuerySchema = z
  .object({
    cursor: workItemId.optional(),
    limit: z.number().int().min(1).max(60).default(30),
    includeDone: z.boolean().default(false),
  })
  .strict();
export const workItemPageSchema = z
  .object({
    items: z.array(workItemSchema),
    total: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    nextCursor: workItemId.nullable(),
  })
  .strict();

export const ownerRequestQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    includeHandled: z.boolean().default(false),
  })
  .strict();
export const ownerRequestHttpQuerySchema = ownerRequestQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  includeHandled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export const ownerRequestPageSchema = z
  .object({
    items: z
      .array(
        ownerMessageReferenceSchema
          .extend({
            text: z.string().max(1200),
            totalCharacters: z.number().int().nonnegative(),
            createdAt: z.string(),
            delivery: z.string(),
            coverage: z.enum(['untriaged', 'linked', 'triaged']),
            workItemIds: z.array(workItemId),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
    notice: z.string(),
  })
  .strict();

export const projectNotesSchema = z
  .object({
    projectId: workItemId,
    text: z.string().max(24_000),
    revision,
    updatedAt: z.string().datetime().nullable(),
    updatedByManagerId: workItemId.nullable(),
  })
  .strict();
export const projectNotesRequestSchema = z
  .object({
    key: workItemId,
    expectedRevision: revision,
    text: z.string().max(24_000),
  })
  .strict();

export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkItemRequest = z.infer<typeof workItemRequestSchema>;
export type ManagerWorkItemRequest = z.infer<typeof managerWorkItemRequestSchema>;
export type ProjectNotes = z.infer<typeof projectNotesSchema>;
export type ProjectNotesRequest = z.infer<typeof projectNotesRequestSchema>;
