import { z } from 'zod';
export const groupConversationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const groupConversationSelectionSchema = z.strictObject({
  handle: z.uuid(),
  key: z.uuid(),
  sessionId: groupConversationIdSchema,
});
export const groupConversationStopSchema = z.strictObject({
  handle: z.uuid(),
  key: z.uuid(),
  generation: z.number().int().positive().optional(),
  recoverOnly: z.literal(true).optional(),
});
export const groupConversationStopReceiptSchema = z.object({
  outcome: z.enum(['stopped', 'superseded', 'unresolved']),
});
export const groupConversationStatusSchema = z.strictObject({ handle: z.uuid() });
export const groupConversationSummarySchema = z.strictObject({
  share: z.boolean(),
  summary: z.string().max(1200),
});
export const groupConversationSharingStatusSchema = z.object({
  selection: z
    .object({
      enabled: z.boolean(),
      sessionId: groupConversationIdSchema,
      generation: z.number().int().positive(),
    })
    .nullable(),
  pending: z.number().int().nonnegative(),
  model: z.string().nullable(),
  blocked: z.number().int().nonnegative().default(0),
  warning: z.string().nullable().default(null),
  latest: z.object({ state: z.string(), message: z.string(), key: z.uuid().optional() }).nullable(),
});
