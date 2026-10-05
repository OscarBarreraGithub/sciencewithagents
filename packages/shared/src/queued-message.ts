import { z } from 'zod';

export const queuedMessageActionSchema = z
  .object({
    key: z.uuid(),
    clientId: z.uuid(),
    revision: z.number().int().nonnegative(),
    action: z.enum(['edit', 'takeover', 'save', 'queue', 'discard', 'steer', 'remove']),
    text: z.string().max(24_000).optional(),
  })
  .strict();
export type QueuedMessageAction = z.infer<typeof queuedMessageActionSchema>;
