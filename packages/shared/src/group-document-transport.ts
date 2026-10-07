import { z } from 'zod';
import { groupContextSchema } from './groups.js';
import { groupDocumentNameSchema } from './group-documents.js';
import {
  publicationBindingSchema,
  publicationCanonical,
  publicationHash,
} from './group-delivery.js';
export const DOCUMENT_TRANSPORT_LIMITS = {
  chunkBytes: 49152,
  bodyBytes: 100000,
  files: 101,
  bundleBytes: 58 * 1024 ** 2,
  logicalBytes: 32 * 1024 ** 2,
  databaseBytes: 64 * 1024 ** 2,
  pending: 8,
  page: 4,
  dailyBytes: 64 * 1024 ** 2,
} as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sharedDocumentManifestSchema = z
  .strictObject({
    publicationId: z.uuid(),
    grantId: z.uuid(),
    version: hash,
    owner: groupContextSchema.extend({ visibility: z.literal('shared') }),
    title: z.string().min(1).max(240),
    entryId: z.uuid(),
    files: z
      .array(
        z.strictObject({
          id: z.uuid(),
          name: groupDocumentNameSchema,
          kind: z.enum(['source', 'asset', 'pdf']),
          bytes: z
            .number()
            .int()
            .nonnegative()
            .max(50 * 1024 ** 2),
          sha256: hash,
        }),
      )
      .min(1)
      .max(DOCUMENT_TRANSPORT_LIMITS.files),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.files.map((f) => f.id)).size !== v.files.length ||
      new Set(v.files.map((f) => f.name)).size !== v.files.length ||
      !v.files.some((f) => f.id === v.entryId && f.kind === 'source') ||
      v.files.filter((f) => f.kind === 'pdf').length > 1 ||
      v.files.filter((f) => f.kind !== 'pdf').reduce((n, f) => n + f.bytes, 0) > 8 * 1024 ** 2 ||
      v.files.reduce((n, f) => n + f.bytes, 0) > DOCUMENT_TRANSPORT_LIMITS.bundleBytes
    )
      c.addIssue({ code: 'custom', message: 'Invalid shared artifact manifest' });
  });
export const documentPublicationKeySchema = z.strictObject({
  publicationId: z.uuid(),
  manifestHash: hash,
});
const ref = { key: documentPublicationKeySchema };
export const documentTransportCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('begin'),
    binding: publicationBindingSchema,
    manifest: sharedDocumentManifestSchema,
    ...ref,
  }),
  z.strictObject({
    kind: z.literal('chunk'),
    ...ref,
    fileId: z.uuid(),
    index: z.number().int().nonnegative().max(1100),
    base64: z
      .string()
      .max(65536)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.strictObject({ kind: z.literal('commit'), ...ref }),
  z.strictObject({ kind: z.literal('receipt'), ...ref }),
  z.strictObject({ kind: z.literal('manifest'), ...ref }),
  z.strictObject({
    kind: z.literal('read'),
    ...ref,
    fileId: z.uuid(),
    index: z.number().int().nonnegative().max(1100),
  }),
  z.strictObject({
    kind: z.literal('list'),
    after: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(DOCUMENT_TRANSPORT_LIMITS.page),
  }),
  z.strictObject({ kind: z.literal('revoke'), ...ref }),
]);
export const documentTransportEnvelopeSchema = z.strictObject({
  groupId: z.uuid(),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  command: documentTransportCommandSchema,
});
export const documentTransportReceiptSchema = z.strictObject({
  key: documentPublicationKeySchema,
  state: z.enum(['absent', 'staged', 'committed', 'revoked']),
  next: z
    .array(z.strictObject({ fileId: z.uuid(), index: z.number().int().nonnegative() }))
    .max(DOCUMENT_TRANSPORT_LIMITS.files),
});
export const documentTransportReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('receipt'), receipt: documentTransportReceiptSchema }),
  z.strictObject({
    kind: z.literal('manifest'),
    key: documentPublicationKeySchema,
    manifest: sharedDocumentManifestSchema,
  }),
  z.strictObject({
    kind: z.literal('chunk'),
    key: documentPublicationKeySchema,
    fileId: z.uuid(),
    index: z.number().int().nonnegative(),
    base64: z.string().max(65536),
    sha256: hash,
  }),
  z.strictObject({
    kind: z.literal('list'),
    entries: z
      .array(
        z.strictObject({
          sequence: z.number().int().positive(),
          key: documentPublicationKeySchema,
          manifest: sharedDocumentManifestSchema,
        }),
      )
      .max(DOCUMENT_TRANSPORT_LIMITS.page),
    next: z.number().int().nonnegative().nullable(),
  }),
]);
export const documentTransportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: documentTransportReplySchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['denied', 'invalid', 'conflict', 'limit', 'unavailable', 'hosting_disabled']),
  }),
]);
export type SharedDocumentManifest = z.infer<typeof sharedDocumentManifestSchema>;
export type DocumentPublicationKey = z.infer<typeof documentPublicationKeySchema>;
export type DocumentTransportCommand = z.infer<typeof documentTransportCommandSchema>;
export type DocumentTransportReply = z.infer<typeof documentTransportReplySchema>;
export type DocumentTransportResult = z.infer<typeof documentTransportResultSchema>;
export const documentPublicationKey = (
  manifest: SharedDocumentManifest,
): DocumentPublicationKey => ({
  publicationId: manifest.publicationId,
  manifestHash: publicationHash(publicationCanonical(sharedDocumentManifestSchema.parse(manifest))),
});
