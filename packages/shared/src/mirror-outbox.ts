import { z } from 'zod';
import { draftTextSchema } from './prompt-text.js';
import { queuedMessageActionSchema } from './queued-message.js';

export const mirrorQueueQuerySchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    threadId: z.string().min(1).max(128),
  })
  .strict();
export const mirrorQueuedMessageSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(['codex', 'claude']),
    threadId: z.string().min(1).max(128),
    text: draftTextSchema,
    createdAt: z.string().datetime(),
    status: z.enum(['queued', 'running', 'completed', 'uncertain', 'cancelled']),
    queueRevision: z.number().int().nonnegative(),
    queueEdit: z
      .object({
        clientId: z.uuid(),
        text: draftTextSchema,
        state: z.enum(['editing', 'steering']),
        operationKey: z.uuid().optional(),
      })
      .nullable(),
    deliveryKey: z.uuid().nullable(),
    message: z.string().max(1000),
  })
  .strict();
export const mirrorQueuedMessagesSchema = z
  .object({
    items: z.array(mirrorQueuedMessageSchema).max(100),
  })
  .strict();
export const mirrorQueuedActionSchema = queuedMessageActionSchema.extend({
  text: draftTextSchema.optional(),
});
export const mirrorQueuedReceiptSchema = z
  .object({
    status: z.enum(['applied', 'uncertain', 'not_found']),
    item: mirrorQueuedMessageSchema,
  })
  .strict();
export type MirrorQueueQuery = z.infer<typeof mirrorQueueQuerySchema>;
export type MirrorQueuedMessage = z.infer<typeof mirrorQueuedMessageSchema>;
export type MirrorQueuedAction = z.infer<typeof mirrorQueuedActionSchema>;
export type MirrorQueuedReceipt = z.infer<typeof mirrorQueuedReceiptSchema>;
