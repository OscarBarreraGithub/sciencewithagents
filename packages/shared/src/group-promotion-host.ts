import { z } from 'zod';
import {
  groupIdSchema,
  groupInstallationIdSchema,
  groupFeedOriginSchema,
  groupEventIdSchema,
  GROUP_LIMITS,
} from './groups.js';
import {
  groupPromotionCommandSchema,
  groupPromotionIdentitySchema,
  groupPromotionReplySchema,
  groupPromotionSourceSchema,
  groupPromotionKeySchema,
} from './group-promotion.js';

export const GROUP_PROMOTION_HOST_LIMITS = {
  bodyBytes: 6 * GROUP_LIMITS.payloadBytes + 65_536,
} as const;

/** Protected host/service protocol. Browser input cannot attest a producer source. */
export const groupPromotionAttributionSchema = z.strictObject({
  eventId: groupEventIdSchema,
  origin: groupFeedOriginSchema,
});
export const groupPromotionHostCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('register'), source: groupPromotionSourceSchema }),
  z.strictObject({ kind: z.literal('adopt'), source: groupPromotionSourceSchema }),
  z.strictObject({ kind: z.literal('pending'), after: z.number().int().nonnegative().safe() }),
  z.strictObject({ kind: z.literal('renew') }),
  z.strictObject({ kind: z.literal('state'), key: groupPromotionKeySchema }),
  z.strictObject({ kind: z.literal('attribution'), eventIds: z.array(groupEventIdSchema).max(8) }),
  z.strictObject({ kind: z.literal('designate'), writerId: groupInstallationIdSchema }),
  z.strictObject({ kind: z.literal('command'), command: groupPromotionCommandSchema }),
]);
export type GroupPromotionHostCommand = z.infer<typeof groupPromotionHostCommandSchema>;
export const groupPromotionHostEnvelopeSchema = z.strictObject({
  groupId: groupIdSchema,
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  command: groupPromotionHostCommandSchema,
});
export const groupPromotionHostResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    value: z.union([
      z.strictObject({ kind: z.literal('registered'), identity: groupPromotionIdentitySchema }),
      z.strictObject({ kind: z.literal('retained'), key: groupPromotionKeySchema }),
      z.strictObject({
        kind: z.literal('pending'),
        source: groupPromotionSourceSchema.nullable(),
        displayName: z.string().max(80).nullable(),
        position: z.number().int().nonnegative().safe(),
        retained: z.number().int().nonnegative().safe(),
        pending: z.number().int().nonnegative().safe(),
        capacity: z.union([z.literal(512), z.literal(0)]),
      }),
      z.strictObject({ kind: z.literal('designated'), writerId: groupInstallationIdSchema }),
      z.strictObject({
        kind: z.literal('status'),
        state: z.enum(['pending', 'complete', 'suppressed']),
      }),
      z.strictObject({
        kind: z.literal('attribution'),
        entries: z.array(groupPromotionAttributionSchema).max(8),
      }),
      groupPromotionReplySchema,
    ]),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['invalid', 'denied', 'conflict', 'limit', 'unavailable']),
  }),
]);
export type GroupPromotionHostResult = z.infer<typeof groupPromotionHostResultSchema>;
