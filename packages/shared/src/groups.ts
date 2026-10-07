import { z } from 'zod';

// Browser-portable contracts: identity is never inferred from a display name.
export const groupIdSchema = z.uuid().brand<'GroupId'>();
export const groupMemberIdSchema = z.uuid().brand<'GroupMemberId'>();
export const groupInstallationIdSchema = z.uuid().brand<'GroupInstallationId'>();
export const groupSessionIdSchema = z.uuid().brand<'GroupSessionId'>();
export const groupEventIdSchema = z.uuid().brand<'GroupEventId'>();
export const groupEntityIdSchema = z.uuid().brand<'GroupEntityId'>();
export const groupOperationIdSchema = z.uuid().brand<'GroupOperationId'>();
export const groupDisplayNameSchema = z.string().trim().min(1).max(120).brand<'GroupDisplayName'>();
export const groupVisibilitySchema = z.enum(['shared', 'private']);
export const GROUP_LIMITS = {
  chunkBytes: 16_384,
  payloadBytes: 1_048_576,
  chunks: 64,
  condensedBytes: 4_096,
  references: 16,
  pageSize: 50,
} as const;
export const groupUtf8Bytes = (value: string): number => new TextEncoder().encode(value).length;
const boundedText = (bytes: number) =>
  z
    .string()
    .min(1)
    .max(bytes)
    .refine(
      (text) =>
        !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(text),
      'Malformed Unicode',
    )
    .refine((text) => groupUtf8Bytes(text) <= bytes, 'UTF-8 byte limit exceeded');
const exactKey = boundedText(256);
export const groupMemberSchema = z.strictObject({
  groupId: groupIdSchema,
  memberId: groupMemberIdSchema,
  installationId: groupInstallationIdSchema,
  displayName: groupDisplayNameSchema,
  active: z.boolean(),
});
export const groupSourceSchema = z.strictObject({
  sessionId: groupSessionIdSchema,
  provider: z.enum(['owner', 'codex', 'claude']),
  nativeSessionId: exactKey,
  messageId: exactKey,
});
export const groupContextSchema = z.strictObject({
  groupId: groupIdSchema,
  memberId: groupMemberIdSchema,
  installationId: groupInstallationIdSchema,
  sessionId: groupSessionIdSchema,
  visibility: groupVisibilitySchema,
  provider: groupSourceSchema.shape.provider,
  nativeSessionId: exactKey,
});
const references = z
  .array(groupEventIdSchema)
  .max(GROUP_LIMITS.references)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate evidence reference');
export const groupScopeSchema = z.strictObject({
  groupId: groupIdSchema,
  memberId: groupMemberIdSchema,
  installationId: groupInstallationIdSchema,
  visibility: groupVisibilitySchema,
  source: groupSourceSchema,
  causalRefs: references,
});
export const groupPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inline'), text: boundedText(GROUP_LIMITS.chunkBytes) }),
  z
    .strictObject({
      kind: z.literal('chunked'),
      chunks: z.array(boundedText(GROUP_LIMITS.chunkBytes)).min(2).max(GROUP_LIMITS.chunks),
    })
    .refine(
      (payload) =>
        payload.chunks.reduce((n, text) => n + groupUtf8Bytes(text), 0) > GROUP_LIMITS.chunkBytes,
      'Use inline payload for small originals',
    ),
]);
export const groupCategorySchema = z.enum([
  'Question',
  'Idea',
  'Decision',
  'Instruction',
  'Conflict',
  'Blocker',
  'Finding',
  'Action',
]);
export const groupAppendSchema = z.strictObject({
  operationId: groupOperationIdSchema,
  entityId: groupEntityIdSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
  category: groupCategorySchema,
  condensedText: boundedText(GROUP_LIMITS.condensedBytes).refine(
    (value) => value.trim().length > 0,
  ),
  original: groupPayloadSchema,
  evidenceRefs: references,
  corrects: groupEventIdSchema.nullable(),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const groupChunkManifestSchema = z
  .strictObject({
    bytes: z.number().int().positive().max(GROUP_LIMITS.payloadBytes),
    sha256: digest,
    chunks: z
      .array(
        z.strictObject({
          index: z
            .number()
            .int()
            .nonnegative()
            .max(GROUP_LIMITS.chunks - 1),
          bytes: z.number().int().positive().max(GROUP_LIMITS.chunkBytes),
          sha256: digest,
        }),
      )
      .min(1)
      .max(GROUP_LIMITS.chunks),
  })
  .refine(
    (manifest) =>
      manifest.chunks.every((chunk, index) => chunk.index === index) &&
      manifest.chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0) === manifest.bytes,
    'Manifest byte totals and indices must match',
  );
export const groupEventSchema = z.strictObject({
  eventId: groupEventIdSchema,
  // Public position counts only this shared group or exact private session.
  sequence: z.number().int().positive().safe(),
  scope: groupScopeSchema,
  operationId: groupOperationIdSchema,
  entityId: groupEntityIdSchema,
  revision: z.number().int().positive().safe(),
  category: groupCategorySchema,
  condensedText: boundedText(GROUP_LIMITS.condensedBytes),
  evidenceRefs: references,
  corrects: groupEventIdSchema.nullable(),
  manifest: groupChunkManifestSchema,
  recordedAt: z.string().datetime(),
});
export const groupFeedCursorSchema = z
  .strictObject({
    version: z.literal(2),
    scopeKey: digest,
    visibility: groupVisibilitySchema,
    after: z.number().int().nonnegative().safe(),
    watermark: z.number().int().nonnegative().safe(),
  })
  .refine((cursor) => cursor.after <= cursor.watermark);
export const groupFeedQuerySchema = z.strictObject({
  visibility: groupVisibilitySchema,
  limit: z.number().int().min(1).max(GROUP_LIMITS.pageSize),
  // Starting position when cursor is null; cursor.after takes precedence otherwise.
  after: z.number().int().nonnegative().safe(),
  cursor: groupFeedCursorSchema.nullable(),
});
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type GroupDisplayName = z.infer<typeof groupDisplayNameSchema>;
export type GroupId = z.infer<typeof groupIdSchema>;
export type GroupMemberId = z.infer<typeof groupMemberIdSchema>;
export type GroupInstallationId = z.infer<typeof groupInstallationIdSchema>;
export type GroupSessionId = z.infer<typeof groupSessionIdSchema>;
export type GroupContext = z.infer<typeof groupContextSchema>;
export type GroupScope = z.infer<typeof groupScopeSchema>;
export type GroupAppend = z.infer<typeof groupAppendSchema>;
export type GroupEvent = z.infer<typeof groupEventSchema>;
export type GroupFeedCursor = z.infer<typeof groupFeedCursorSchema>;
export type GroupFeedQuery = z.infer<typeof groupFeedQuerySchema>;
/** Presentation provenance from authenticated promotion receipts. The event's
 * immutable scope remains its writer; this annotation grants no action authority. */
export const groupFeedOriginSchema = z.strictObject({
  key: z.strictObject({
    groupId: groupIdSchema,
    sourceId: z.uuid(),
    version: z.string().min(1).max(128),
  }),
  scope: groupScopeSchema,
  kind: z.enum(['human', 'native', 'manager', 'worker', 'quark', 'file', 'job']),
  writerId: groupInstallationIdSchema,
  displayName: groupDisplayNameSchema,
});
export const groupFeedEntrySchema = groupEventSchema.extend({
  origin: groupFeedOriginSchema.optional(),
});
export type GroupFeedEntry = z.infer<typeof groupFeedEntrySchema>;
export const groupFeedPageSchema = z
  .strictObject({
    entries: z.array(groupFeedEntrySchema).max(GROUP_LIMITS.pageSize),
    watermark: z.number().int().nonnegative().safe(),
    continuation: groupFeedCursorSchema.nullable(),
  })
  .refine(
    (page) =>
      page.entries.every(
        (event, index) =>
          event.sequence <= page.watermark &&
          (index === 0 || event.sequence > page.entries[index - 1].sequence),
      ) &&
      (page.continuation === null ||
        (page.entries.length > 0 &&
          page.continuation.watermark === page.watermark &&
          page.continuation.after === page.entries[page.entries.length - 1].sequence)),
    'Invalid feed snapshot',
  );
export type GroupFeedPage = z.infer<typeof groupFeedPageSchema>;
