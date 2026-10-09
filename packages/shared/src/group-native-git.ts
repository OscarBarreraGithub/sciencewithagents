import { z } from 'zod';
import { integrationPreviewSchema } from './integration.js';

const selected = { handle: z.uuid() };
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
export const groupNativeCommitPreviewSchema = z.strictObject({
  id: z.uuid(),
  requestId: z.uuid(),
  base: commit,
  head: commit,
  tree: commit,
  branch: z.string().max(255),
  repository: z.string().max(300),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.string().max(512)).max(1000),
  patch: z.string().max(131072),
});
export type GroupNativeCommitPreview = z.infer<typeof groupNativeCommitPreviewSchema>;
export const groupNativeGitRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...selected, action: z.literal('status') }),
  z.strictObject({ ...selected, action: z.literal('sync'), key: z.uuid() }),
  z.strictObject({ ...selected, action: z.literal('connect'), key: z.uuid() }),
  z.strictObject({
    ...selected,
    action: z.literal('configure'),
    key: z.uuid(),
    githubUsername: z
      .string()
      .trim()
      .max(39)
      .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)?$/),
    autoSync: z.boolean(),
  }),
  z.strictObject({ ...selected, action: z.literal('preview'), taskId: z.uuid() }),
  z.strictObject({ ...selected, action: z.literal('preview-native') }),
  z.strictObject({
    ...selected,
    action: z.literal('approve-native'),
    key: z.uuid(),
    previewId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    ...selected,
    action: z.literal('apply'),
    key: z.uuid(),
    taskId: z.uuid(),
    source: commit,
    target: commit,
  }),
]);
export const groupNativeGitViewSchema = z.strictObject({
  available: z.boolean(),
  repository: z.string().max(300).nullable(),
  workspacePath: z.string().max(4096).nullable(),
  branch: z.string().max(255).nullable(),
  githubUsername: z.string().max(39),
  autoSync: z.boolean(),
  connected: z.boolean().optional(),
  dirty: z.boolean(),
  busy: z.boolean(),
  message: z.string().max(1000),
  localEdits: z
    .array(
      z.strictObject({
        taskId: z.uuid().nullable(),
        label: z.string().max(200),
        state: z.enum(['clean', 'changed', 'unavailable']),
        changed: z.number().int().nonnegative(),
        withheld: z.number().int().nonnegative(),
        truncated: z.boolean(),
        files: z
          .array(z.strictObject({ path: z.string().max(512), status: z.string().max(2) }))
          .max(16),
      }),
    )
    .max(51)
    .default([]),
  tasks: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: z.string(),
        status: z.string(),
        reviewed: z.boolean(),
      }),
    )
    .max(100),
  preview: integrationPreviewSchema.nullable(),
  nativeReviewAvailable: z.boolean().optional(),
  nativePreview: groupNativeCommitPreviewSchema.nullable().optional(),
});
export type GroupNativeGitRequest = z.infer<typeof groupNativeGitRequestSchema>;
export type GroupNativeGitView = z.infer<typeof groupNativeGitViewSchema>;
