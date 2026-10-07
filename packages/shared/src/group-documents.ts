import { z } from 'zod';
import { groupContextSchema, groupSourceSchema } from './groups.js';

export const GROUP_DOCUMENT_LIMITS = Object.freeze({
  files: 100,
  bytes: 8 * 1024 ** 2,
  pdfBytes: 50 * 1024 ** 2,
  buildMs: 120_000,
  readingMs: 30_000,
  outputBytes: 16 * 1024 ** 2,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Native-owned relative archive names, never browser or host paths. */
export const groupDocumentNameSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/)
  .refine((v) =>
    v.split('/').every((p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('.')),
  );
export const groupDocumentFileSchema = z.strictObject({
  artifactId: z.uuid(),
  name: groupDocumentNameSchema,
  sha256: digest,
  bytes: z.number().int().nonnegative().max(GROUP_DOCUMENT_LIMITS.bytes),
});
export const groupDocumentManifestSchema = z
  .strictObject({
    receiptId: z.uuid(),
    requestId: z.uuid(),
    resultId: z.uuid(),
    context: groupContextSchema,
    nativeContext: groupContextSchema,
    source: groupSourceSchema,
    files: z.array(groupDocumentFileSchema).min(1).max(GROUP_DOCUMENT_LIMITS.files),
  })
  .refine(
    (v) =>
      v.source.sessionId === v.nativeContext.sessionId &&
      v.source.provider === v.nativeContext.provider &&
      v.source.nativeSessionId === v.nativeContext.nativeSessionId &&
      new Set(v.files.map((f) => f.artifactId)).size === v.files.length &&
      new Set(v.files.map((f) => f.name.toLowerCase())).size === v.files.length &&
      !v.files.some((f) =>
        v.files.some((other) => other.name.toLowerCase().startsWith(f.name.toLowerCase() + '/')),
      ) &&
      v.nativeContext.provider !== 'owner' &&
      v.context.groupId === v.nativeContext.groupId &&
      v.context.memberId === v.nativeContext.memberId &&
      v.context.installationId === v.nativeContext.installationId &&
      v.context.visibility === v.nativeContext.visibility &&
      v.files.reduce((n, f) => n + f.bytes, 0) <= GROUP_DOCUMENT_LIMITS.bytes,
  );
export const groupDocumentOfferSchema = z.strictObject({
  handle: z.uuid(),
  resultId: z.uuid(),
  version: digest,
  files: z
    .array(
      z.strictObject({
        handle: z.uuid(),
        name: groupDocumentNameSchema,
        bytes: z.number().int().nonnegative(),
        kind: z.enum(['tex', 'pdf', 'dependency']),
      }),
    )
    .max(GROUP_DOCUMENT_LIMITS.files),
});
export const groupDocumentGrantRequestSchema = z
  .strictObject({
    key: z.uuid(),
    offer: z.uuid(),
    entry: z.uuid(),
    dependencies: z.array(z.uuid()).max(GROUP_DOCUMENT_LIMITS.files - 1),
  })
  .refine(
    (v) =>
      !v.dependencies.includes(v.entry) && new Set(v.dependencies).size === v.dependencies.length,
  );
export const groupDocumentActionSchema = z.strictObject({ key: z.uuid() });
export const groupDocumentShareSchema = z.strictObject({ key: z.uuid(), sharedHandle: z.uuid() });
/** Browser projection only; protected artifact proof/hash validation stays server-side. */
export const groupReportListSchema = z.object({
  kind: z.literal('list'),
  entries: z
    .array(
      z.object({
        key: z.strictObject({ publicationId: z.uuid(), manifestHash: digest }),
        manifest: z.object({
          title: z.string().min(1).max(240),
          files: z
            .array(
              z.object({
                bytes: z
                  .number()
                  .int()
                  .nonnegative()
                  .max(50 * 1024 ** 2),
              }),
            )
            .max(101),
        }),
      }),
    )
    .max(4),
  next: z.number().int().nonnegative().nullable(),
});
export const groupDocumentLinkSchema = z.strictObject({
  grantId: z.uuid(),
  version: digest,
  href: z.string(),
  visibility: z.enum(['private', 'shared']),
});
export const groupDocumentBuildPolicy = Object.freeze({
  network: 'none',
  shellEscape: false,
  inputs: 'exact-grant',
  systemAssets: 'compiler-only',
  timeoutMs: GROUP_DOCUMENT_LIMITS.buildMs,
  maxPdfBytes: GROUP_DOCUMENT_LIMITS.pdfBytes,
  maxOutputBytes: GROUP_DOCUMENT_LIMITS.outputBytes,
} as const);
export type GroupDocumentManifest = z.infer<typeof groupDocumentManifestSchema>;
export type GroupDocumentFile = z.infer<typeof groupDocumentFileSchema>;
export type GroupDocumentLink = z.infer<typeof groupDocumentLinkSchema>;
export type GroupDocumentOffer = z.infer<typeof groupDocumentOfferSchema>;
/** Only the scoped renderer recognizes these; ordinary local document links confer no access. */
export function groupDocumentHref(grantId: string, version: string) {
  return `#/groups/document/${z.uuid().parse(grantId)}/${digest.parse(version)}`;
}
export function groupDocumentReference(href: string) {
  const m = /^#\/groups\/(document|report)\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(href);
  if (!m || !z.uuid().safeParse(m[2]).success) return null;
  return {
    grantId: m[2]!,
    version: m[3]!,
    ...(m[1] === 'report' ? { shared: true as const } : {}),
  };
}
