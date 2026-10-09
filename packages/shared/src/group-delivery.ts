// Wire snapshot of immutable server protocol180. Parity is checked by the Node integration tests.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GROUP_LIMITS, groupEventSchema, groupPayloadSchema, groupUtf8Bytes } from './groups.js';

/** Host-resolved aliases, never URLs, paths, tokens or browser-selected destinations. */
export const publicationBindingSchema = z.strictObject({
  groupId: z.uuid(),
  installationId: z.uuid(),
  epoch: z.uuid(),
  remoteGroupId: z.uuid(),
  endpointId: z.uuid(),
  credentialRevision: z.number().int().positive().max(2_147_483_647),
});
export type PublicationBinding = z.infer<typeof publicationBindingSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const publicationKeySchema = z.strictObject({
  version: z.literal(1),
  binding: publicationBindingSchema,
  operationId: z.uuid(),
  payloadHash: digest,
});
export type PublicationKey = z.infer<typeof publicationKeySchema>;
export const PUBLICATION_LIMITS = {
  headerBytes: 49_152,
  packetBytes: 100_000,
  receiptBytes: 4_096,
  partitions: 8,
  lifetimeOperations: 128,
  pendingOperations: 64,
  journalBytes: 1024 ** 3,
  attempts: 96,
  leaseMs: 30_000,
  timeoutMs: 5_000,
  progressMs: 250,
  backoffMs: 1_000,
  maxBackoffMs: 60_000,
} as const;
export const publicationCanonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(publicationCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${publicationCanonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
export const publicationHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
export const publicationHeaderSchema = publicationKeySchema
  .extend({ event: groupEventSchema })
  .refine(
    (header) =>
      header.event.scope.visibility === 'shared' &&
      header.event.scope.groupId === header.binding.groupId &&
      header.event.scope.installationId === header.binding.installationId &&
      groupUtf8Bytes(publicationCanonical(header)) <= PUBLICATION_LIMITS.headerBytes,
    'Invalid shared publication header',
  );
export type PublicationHeader = z.infer<typeof publicationHeaderSchema>;
const chunkSchema = z
  .strictObject({
    index: z
      .number()
      .int()
      .min(0)
      .max(GROUP_LIMITS.chunks - 1),
    text: z.string().min(1).max(GROUP_LIMITS.chunkBytes),
    bytes: z.number().int().positive().max(GROUP_LIMITS.chunkBytes),
    sha256: digest,
  })
  .refine(
    (chunk) =>
      groupPayloadSchema.safeParse({ kind: 'inline', text: chunk.text }).success &&
      groupUtf8Bytes(chunk.text) === chunk.bytes &&
      publicationHash(chunk.text) === chunk.sha256,
    'Invalid exact chunk',
  );
export type PublicationChunk = z.infer<typeof chunkSchema>;
export const publicationEnvelopeSchema = z
  .strictObject({
    header: publicationHeaderSchema,
    chunks: z.array(chunkSchema).min(1).max(GROUP_LIMITS.chunks),
  })
  .refine((envelope) => {
    const { header, chunks } = envelope;
    const original = chunks.map((chunk) => chunk.text).join('');
    const { payloadHash, ...intent } = header;
    return (
      chunks.length === header.event.manifest.chunks.length &&
      chunks.every((chunk, index) => {
        const manifest = header.event.manifest.chunks[index];
        return (
          chunk.index === index &&
          chunk.bytes === manifest.bytes &&
          chunk.sha256 === manifest.sha256 &&
          groupUtf8Bytes(chunk.text) === chunk.bytes &&
          publicationHash(chunk.text) === chunk.sha256
        );
      }) &&
      groupUtf8Bytes(original) === header.event.manifest.bytes &&
      publicationHash(original) === header.event.manifest.sha256 &&
      payloadHash === publicationHash(publicationCanonical({ ...intent, chunks }))
    );
  }, 'Publication integrity failure');
export type PublicationEnvelope = z.infer<typeof publicationEnvelopeSchema>;

/** Reconstruct the repository's exact byte boundaries, without normalizing Unicode. */
export function publicationEnvelope(
  binding: PublicationBinding,
  operationId: string,
  record: { event: z.infer<typeof groupEventSchema>; original: string },
): PublicationEnvelope {
  const bytes = Buffer.from(record.original, 'utf8');
  let offset = 0;
  const chunks = record.event.manifest.chunks.map((manifest) => {
    const text = bytes.subarray(offset, offset + manifest.bytes).toString('utf8');
    offset += manifest.bytes;
    return { ...manifest, text };
  });
  const intent = { version: 1 as const, binding, operationId, event: record.event };
  return publicationEnvelopeSchema.parse({
    header: {
      ...intent,
      payloadHash: publicationHash(publicationCanonical({ ...intent, chunks })),
    },
    chunks,
  });
}
export const publicationEffectSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('begin'), header: publicationHeaderSchema }),
    z.strictObject({ kind: z.literal('chunk'), key: publicationKeySchema, chunk: chunkSchema }),
    z.strictObject({ kind: z.literal('commit'), key: publicationKeySchema }),
  ])
  .refine(
    (packet) => groupUtf8Bytes(publicationCanonical(packet)) <= PUBLICATION_LIMITS.packetBytes,
  );
export type PublicationEffect = z.infer<typeof publicationEffectSchema>;
export const publicationReceiptSchema = z
  .discriminatedUnion('state', [
    publicationKeySchema.extend({ state: z.literal('absent') }),
    publicationKeySchema.extend({
      state: z.literal('staged'),
      missing: z
        .array(
          z
            .number()
            .int()
            .min(0)
            .max(GROUP_LIMITS.chunks - 1),
        )
        .max(GROUP_LIMITS.chunks)
        .refine((values) => values.every((value, i) => i === 0 || value > values[i - 1])),
    }),
    publicationKeySchema.extend({
      state: z.literal('committed'),
      eventId: z.uuid(),
      remoteSequence: z.number().int().positive().safe(),
    }),
    publicationKeySchema.extend({ state: z.literal('collision') }),
  ])
  .refine(
    (value) => groupUtf8Bytes(publicationCanonical(value)) <= PUBLICATION_LIMITS.receiptBytes,
  );
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

export const DELIVERY_LIMITS = {
  operations: 2048,
  staged: 64,
  sources: 4096,
  logicalBytes: 16 * 1_048_576,
  databaseBytes: 64 * 1_048_576,
  pageSize: 8,
  responseBytes: 512_000,
  bodyBytes: 100_128,
  timeoutMs: 5000,
} as const;
export const deliverySourceSchema = z.strictObject({
  sessionId: z.uuid(),
  provider: z.enum(['owner', 'codex', 'claude']),
  nativeSessionId: z.uuid(),
  messageId: z.uuid(),
});
export const deliveryAuthorSchema = z.strictObject({
  groupId: z.uuid(),
  memberId: z.uuid(),
  installationId: z.uuid(),
});
export type DeliveryAuthor = z.infer<typeof deliveryAuthorSchema>;
export const deliveryCursorSchema = z
  .strictObject({
    version: z.literal(1),
    groupId: z.uuid(),
    after: z.number().int().nonnegative().safe(),
    watermark: z.number().int().nonnegative().safe(),
  })
  .refine((c) => c.after <= c.watermark);
export const deliveryCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('registerSource'),
    operationId: z.uuid(),
    binding: publicationBindingSchema,
    memberId: z.uuid(),
    source: deliverySourceSchema,
  }),
  z.strictObject({ kind: z.literal('receipt'), key: publicationKeySchema }),
  z.strictObject({ kind: z.literal('effect'), packet: publicationEffectSchema }),
  z.strictObject({
    kind: z.literal('feed'),
    after: z.number().int().nonnegative().safe(),
    limit: z.number().int().min(1).max(DELIVERY_LIMITS.pageSize),
    cursor: deliveryCursorSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('expand'),
    eventId: z.uuid(),
    start: z.number().int().min(0).max(63),
    count: z.number().int().min(1).max(4),
  }),
]);
export type DeliveryCommand = z.infer<typeof deliveryCommandSchema>;
export const deliveryReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('registered'),
    sourceId: z.uuid(),
    source: deliverySourceSchema,
    author: deliveryAuthorSchema,
  }),
  z.strictObject({ kind: z.literal('receipt'), receipt: publicationReceiptSchema }),
  z.strictObject({
    kind: z.literal('feed'),
    entries: z
      .array(
        z.strictObject({
          header: publicationHeaderSchema,
          author: deliveryAuthorSchema,
          remoteSequence: z.number().int().positive().safe(),
        }),
      )
      .max(DELIVERY_LIMITS.pageSize),
    watermark: z.number().int().nonnegative().safe(),
    continuation: deliveryCursorSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('expansion'),
    header: publicationHeaderSchema,
    author: deliveryAuthorSchema,
    remoteSequence: z.number().int().positive().safe(),
    start: z.number().int().min(0).max(63),
    chunks: z.array(chunkSchema).max(4),
    next: z.number().int().min(0).max(63).nullable(),
  }),
]);
export type DeliveryReply = z.infer<typeof deliveryReplySchema>;
export const deliveryResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: deliveryReplySchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['denied', 'invalid', 'conflict', 'limit', 'unavailable', 'hosting_disabled']),
  }),
]);
export type DeliveryResult = z.infer<typeof deliveryResultSchema>;
export const deliveryEnvelopeSchema = z.strictObject({
  groupId: z.uuid(),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  command: deliveryCommandSchema,
});
export type DeliveryEnvelope = z.infer<typeof deliveryEnvelopeSchema>;
