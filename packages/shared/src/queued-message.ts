import { z } from 'zod';
import { draftTextSchema } from './prompt-text.js';

export const queuedMessageActionSchema = z
  .object({
    key: z.uuid(),
    clientId: z.uuid(),
    revision: z.number().int().nonnegative(),
    action: z.enum(['edit', 'takeover', 'save', 'queue', 'discard', 'steer', 'remove']),
    text: draftTextSchema.optional(),
  })
  .strict();
export type QueuedMessageAction = z.infer<typeof queuedMessageActionSchema>;
