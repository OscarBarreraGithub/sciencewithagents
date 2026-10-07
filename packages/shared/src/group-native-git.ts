import { z } from 'zod';
import { integrationPreviewSchema } from './integration.js';

const selected = { handle: z.uuid() };
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
export const groupNativeGitRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...selected, action: z.literal('status') }),
  z.strictObject({ ...selected, action: z.literal('sync'), key: z.uuid() }),
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
  dirty: z.boolean(),
  busy: z.boolean(),
  message: z.string().max(1000),
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
});
export type GroupNativeGitRequest = z.infer<typeof groupNativeGitRequestSchema>;
export type GroupNativeGitView = z.infer<typeof groupNativeGitViewSchema>;
