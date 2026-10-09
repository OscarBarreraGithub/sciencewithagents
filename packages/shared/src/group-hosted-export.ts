import { z } from 'zod';
export const GROUP_EXPORT_LIMITS = {
  pageBytes: 512 * 1024,
  pageRows: 128,
  pages: 4096,
  totalBytes: 1024 ** 3,
  rows: 1_000_000,
  timeoutMs: 180_000,
  pageMs: 5000,
  tables: 128,
  schemaBytes: 128 * 1024,
} as const;
const rowid = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,100}$/);
export const groupExportSnapshotSchema = z.strictObject({
  kind: z.enum(['bookmark', 'digest']),
  value: z.string().min(1).max(128),
  expiresAt: z.number().int().positive().safe(),
});
export const groupExportCursorSchema = z.strictObject({
  table: z
    .number()
    .int()
    .min(0)
    .max(GROUP_EXPORT_LIMITS.tables - 1),
  after: rowid.nullable(),
});
export const groupExportRequestSchema = z
  .strictObject({
    snapshot: groupExportSnapshotSchema.nullable(),
    cursor: groupExportCursorSchema.nullable(),
  })
  .refine((v) => (v.snapshot === null) === (v.cursor === null));
export const groupExportEnvelopeSchema = z.strictObject({
  groupId: z.uuid(),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  setupCapability: z.string().regex(/^[a-f0-9]{64}$/),
  betaAdmission: z.string().max(1024).optional(),
  request: groupExportRequestSchema,
});
export const groupExportCellSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('null') }),
  z.strictObject({
    type: z.enum(['text', 'integer', 'real', 'blob']),
    value: z.string().max(GROUP_EXPORT_LIMITS.pageBytes),
  }),
]);
export const groupExportTableSchema = z.strictObject({
  name: identifier,
  columns: z.array(identifier).min(1).max(128),
  rows: z.number().int().nonnegative().max(GROUP_EXPORT_LIMITS.rows),
});
export const groupExportPageSchema = z.strictObject({
  version: z.literal(1),
  groupId: z.uuid(),
  snapshot: groupExportSnapshotSchema,
  table: z.number().int().nonnegative(),
  columns: z.array(identifier).min(1).max(128),
  rows: z
    .array(z.strictObject({ rowid, cells: z.array(groupExportCellSchema).max(128) }))
    .max(GROUP_EXPORT_LIMITS.pageRows),
  next: groupExportCursorSchema.nullable(),
  schema: z
    .array(
      z.strictObject({
        type: z.enum(['table', 'index', 'trigger', 'view']),
        name: identifier,
        table: identifier,
        sql: z.string().max(GROUP_EXPORT_LIMITS.schemaBytes).nullable(),
      }),
    )
    .max(1024)
    .nullable(),
  tables: z.array(groupExportTableSchema).max(GROUP_EXPORT_LIMITS.tables).nullable(),
});
export const groupExportResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: groupExportPageSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(['denied', 'invalid', 'changed', 'limit', 'unsupported', 'unavailable']),
  }),
]);
export const groupExportArchiveRequestSchema = z.strictObject({ handle: z.uuid(), key: z.uuid() });
export const groupExportArchiveSchema = z.strictObject({
  archiveId: z.uuid(),
  groupId: z.uuid(),
  pages: z.number().int().positive().max(GROUP_EXPORT_LIMITS.pages),
  rows: z.number().int().nonnegative().max(GROUP_EXPORT_LIMITS.rows),
  bytes: z.number().int().nonnegative().max(GROUP_EXPORT_LIMITS.totalBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});
export type GroupExportRequest = z.infer<typeof groupExportRequestSchema>;
export type GroupExportPage = z.infer<typeof groupExportPageSchema>;
export type GroupExportCell = z.infer<typeof groupExportCellSchema>;
export type GroupExportResult = z.infer<typeof groupExportResultSchema>;
