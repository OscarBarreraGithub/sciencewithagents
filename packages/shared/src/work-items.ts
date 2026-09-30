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
export const workItemKindSchema = z.enum(['human', 'internal', 'general']);
export const workItemStatusSchema = z.enum(['open', 'in_progress', 'waiting', 'done']);

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
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
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
  })
  .strict();

/** Scope comes from the authenticated manager, never from tool-supplied IDs. */
export const managerWorkItemRequestSchema = workItemRequestSchema.omit({
  projectId: true,
  managerId: true,
  humanReply: true,
});

export const workItemQuerySchema = z.object({ projectId: workItemId.optional() }).strict();
export const workItemsSchema = z.object({ items: z.array(workItemSchema) }).strict();

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
