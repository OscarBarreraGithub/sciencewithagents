import { z } from 'zod';
import {
  groupCategorySchema,
  groupEventIdSchema,
  groupIdSchema,
  groupInstallationIdSchema,
  groupPayloadSchema,
  groupScopeSchema,
  groupUtf8Bytes,
} from './groups.js';

export const GROUP_PROMOTION_LIMITS = {
  receipts: 512,
  summaryBytes: 768,
  synthesisBytes: 32_768,
  leaseMs: 60_000,
} as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sentenceSegments = new Intl.Segmenter('en', { granularity: 'sentence' });
const refs = z
  .array(groupEventIdSchema)
  .max(16)
  .refine((v) => new Set(v).size === v.length);
const sentence = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine(
    (v) =>
      groupUtf8Bytes(v) <= GROUP_PROMOTION_LIMITS.summaryBytes &&
      !v.includes('\n') &&
      [...sentenceSegments.segment(v)].filter((s) => s.segment.trim()).length === 1 &&
      !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(v),
  );
/** Structured sentences, never a prefix of a larger original. Finding covers results;
 * Action covers status, preserving the established feed category contract. */
export const groupPromotionDecisionSchema = z
  .strictObject({
    category: groupCategorySchema,
    sentences: z.array(sentence).min(1).max(2),
    evidenceRefs: refs,
  })
  .refine((v) => groupUtf8Bytes(v.sentences.join(' ')) <= GROUP_PROMOTION_LIMITS.summaryBytes);
export type GroupPromotionDecision = z.infer<typeof groupPromotionDecisionSchema>;
export const groupPromotionKeySchema = z.strictObject({
  groupId: groupIdSchema,
  sourceId: z.uuid(),
  version: z.string().min(1).max(128),
});
export type GroupPromotionKey = z.infer<typeof groupPromotionKeySchema>;
export const groupPromotionIdentitySchema = z.strictObject({
  key: groupPromotionKeySchema,
  sourceHash: digest,
});
export type GroupPromotionIdentity = z.infer<typeof groupPromotionIdentitySchema>;
export const groupPromotionDispositionSchema = z.strictObject({
  reason: z.enum(['stale-correction', 'verified-not-launched', 'not-substantive']),
  operationId: z.uuid(),
});
export const groupPromotionReceiptSchema = z.strictObject({
  identity: groupPromotionIdentitySchema,
  writerId: groupInstallationIdSchema,
  operationId: z.uuid(),
  entityId: z.uuid(),
  synthesisId: z.uuid(),
  synthesisStarted: z.boolean(),
  decision: groupPromotionDecisionSchema.nullable(),
  eventId: groupEventIdSchema.nullable(),
  publicationOperationId: z.uuid().nullable(),
  disposition: groupPromotionDispositionSchema.nullable(),
});
export type GroupPromotionReceipt = z.infer<typeof groupPromotionReceiptSchema>;
export const groupPromotionCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dispose'),
    identity: groupPromotionIdentitySchema,
    disposition: groupPromotionDispositionSchema,
  }),
  z.strictObject({ kind: z.literal('reserve'), identity: groupPromotionIdentitySchema }),
  z.strictObject({ kind: z.literal('startSynthesis'), identity: groupPromotionIdentitySchema }),
  z.strictObject({
    kind: z.literal('decide'),
    identity: groupPromotionIdentitySchema,
    decision: groupPromotionDecisionSchema,
  }),
  z.strictObject({
    kind: z.literal('bindEvent'),
    identity: groupPromotionIdentitySchema,
    eventId: groupEventIdSchema,
  }),
  z.strictObject({
    kind: z.literal('published'),
    identity: groupPromotionIdentitySchema,
    eventId: groupEventIdSchema,
    publicationOperationId: z.uuid(),
  }),
]);
export type GroupPromotionCommand = z.infer<typeof groupPromotionCommandSchema>;
export const groupPromotionReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('receipt'),
    receipt: groupPromotionReceiptSchema,
    acquired: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum(['writer_unavailable', 'not_writer', 'denied', 'collision', 'limit']),
  }),
]);
export type GroupPromotionReply = z.infer<typeof groupPromotionReplySchema>;
/** This is verified by a host source adapter, never accepted by a browser route. */
export const groupPromotionSourceSchema = z.strictObject({
  key: groupPromotionKeySchema,
  /** Remote writer enrollment and stable local projection alias, distinct from
   * original attribution. A writer cannot impersonate another source author. */
  writerId: groupInstallationIdSchema,
  scope: groupScopeSchema,
  projectionScope: groupScopeSchema,
  kind: z.enum(['human', 'native', 'manager', 'worker', 'quark', 'file', 'job']),
  activity: z.enum(['substantive', 'tool-line', 'heartbeat', 'progress', 'metadata']),
  contentMode: z.enum(['shared-content', 'metadata-only', 'private']),
  original: groupPayloadSchema,
  evidenceRefs: refs,
  correction: z
    .strictObject({
      eventId: groupEventIdSchema,
      entityId: z.uuid(),
      revision: z.number().int().positive().safe(),
    })
    .nullable(),
  decision: groupPromotionDecisionSchema.nullable(),
  synthesisAuthorized: z.boolean(),
});
export type GroupPromotionSource = z.infer<typeof groupPromotionSourceSchema>;
/** Only these explicitly verified records are offered to the private catch-up index. */
export const groupPromotionEvidenceSchema = z.strictObject({
  identity: groupPromotionIdentitySchema,
  eventId: groupEventIdSchema,
  scope: groupScopeSchema,
  kind: groupPromotionSourceSchema.shape.kind,
  causalRefs: refs,
  evidenceRefs: refs,
  corrects: groupEventIdSchema.nullable(),
});
export type GroupPromotionEvidence = z.infer<typeof groupPromotionEvidenceSchema>;
