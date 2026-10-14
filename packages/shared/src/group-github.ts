import { z } from 'zod';
export const githubUsernameSchema = z
  .string()
  .trim()
  .max(39)
  .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)?$/)
  .refine((v) => !v.includes('--'), 'Use a GitHub username');
export const githubRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/)
  .max(200)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!), 'Use an owner/repository name');
export const groupGitHubMetadataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('swa-github-profile-v1'), username: githubUsernameSchema }),
  z.strictObject({
    kind: z.literal('swa-github-repository-v1'),
    repository: githubRepositorySchema,
  }),
]);
export const groupGitHubRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status'), handle: z.uuid(), key: z.uuid().optional() }),
  z.strictObject({ action: z.literal('check'), handle: z.uuid() }),
  z.strictObject({
    action: z.literal('profile'),
    handle: z.uuid(),
    key: z.uuid(),
    username: githubUsernameSchema,
  }),
  z.strictObject({ action: z.literal('repository'), handle: z.uuid(), key: z.uuid() }),
  z.strictObject({ action: z.literal('retry'), handle: z.uuid(), key: z.uuid() }),
]);
export const githubAccessStateSchema = z.enum([
  'Access confirmed',
  'Invitation pending',
  'No access',
  'Not checked',
]);
export const groupGitHubViewSchema = z.object({
  receipt: z.object({ key: z.uuid(), committed: z.boolean() }).optional(),
  repository: githubRepositorySchema.nullable(),
  creator: z.boolean(),
  ownMemberId: z.uuid(),
  pending: z.array(z.object({ key: z.uuid(), kind: z.string(), message: z.string() })).max(64),
  members: z
    .array(
      z.object({
        memberId: z.uuid(),
        displayName: z.string(),
        username: githubUsernameSchema.nullable(),
        status: githubAccessStateSchema,
      }),
    )
    .max(64),
  checkedAt: z.string().nullable(),
  viewer: z.string().nullable(),
  message: z.string(),
  complete: z.boolean(),
});
export type GroupGitHubView = z.infer<typeof groupGitHubViewSchema>;
