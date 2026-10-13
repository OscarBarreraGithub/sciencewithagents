import { z } from 'zod';
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const handle = { handle: z.uuid() };
export const groupExternalFileProposeSchema = z.strictObject({
  ...handle,
  key: z.uuid(),
  head: commit,
});
export const groupExternalFilesRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...handle, action: z.literal('status') }),
  groupExternalFileProposeSchema.extend({ action: z.literal('propose') }),
  z.strictObject({ ...handle, action: z.literal('preview'), id: z.uuid() }),
  z.strictObject({
    ...handle,
    action: z.literal('approve'),
    id: z.uuid(),
    key: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ ...handle, action: z.literal('reject'), id: z.uuid(), key: z.uuid() }),
  z.strictObject({ ...handle, action: z.literal('retry'), id: z.uuid(), key: z.uuid() }),
]);
export const groupExternalFilePreviewSchema = z.strictObject({
  id: z.uuid(),
  repository: z.string().max(300),
  branch: z.string().max(255),
  sessionId: z.string().max(128),
  base: commit,
  head: commit,
  tree: commit,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.string().max(512)).max(1000),
  patch: z.string().max(131072),
});
export type GroupExternalFilePreview = z.infer<typeof groupExternalFilePreviewSchema>;
export const groupExternalFilesViewSchema = z.strictObject({
  proposals: z
    .array(
      z.strictObject({
        id: z.uuid(),
        head: commit,
        repository: z.string().max(300),
        state: z.enum(['review', 'approved', 'rejected', 'shared', 'branch-shared', 'stale']),
        message: z.string().max(1000),
        retryable: z.boolean().default(false),
      }),
    )
    .max(20),
  preview: groupExternalFilePreviewSchema.nullable(),
});
export type GroupExternalFilesView = z.infer<typeof groupExternalFilesViewSchema>;
