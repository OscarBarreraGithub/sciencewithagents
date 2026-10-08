import { z } from 'zod';
import { providerIdSchema } from './providers.js';

export const conversationVisibilityTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('shared'),
      provider: providerIdSchema,
      threadId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[^\u0000-\u001f\u007f]+$/),
    })
    .strict(),
]);
export type ConversationVisibilityTarget = z.infer<typeof conversationVisibilityTargetSchema>;
/** Stable across editor reconnects; never use a window ID as conversation identity. */
export function conversationVisibilityIdentity(target: ConversationVisibilityTarget) {
  return target.kind === 'agent'
    ? `agent:${target.agentId}`
    : `shared:${target.provider}:${target.threadId}`;
}
export const conversationVisibilitySchema = z
  .object({
    id: z.string().uuid(),
    target: conversationVisibilityTargetSchema,
    revision: z.number().int().positive(),
    archived: z.boolean(),
    archivedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
    lastActivityAt: z.string().datetime().optional(),
    provider: providerIdSchema,
    source: z.enum(['app', 'vscode', 'codex-daemon']),
    title: z.string().max(500),
    caption: z.string().max(200),
  })
  .strict();
export type ConversationVisibility = z.infer<typeof conversationVisibilitySchema>;
export const conversationVisibilityUpdateSchema = z
  .object({
    key: z.string().uuid(),
    target: conversationVisibilityTargetSchema,
    expectedRevision: z.number().int().nonnegative(),
    archived: z.boolean(),
  })
  .strict();
export type ConversationVisibilityUpdate = z.infer<typeof conversationVisibilityUpdateSchema>;
export const conversationVisibilityQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    archived: z.enum(['true', 'false']).optional(),
  })
  .strict();
export const conversationVisibilityPageSchema = z
  .object({
    records: z.array(conversationVisibilitySchema).max(100),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const conversationListQuerySchema = z
  .object({
    includeArchived: z.enum(['true', 'false']).default('false'),
  })
  .strict();
