import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const groupGitHostCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list') }),
  ...(['status', 'observe', 'snapshot', 'warnings', 'reconcile'] as const).map((kind) =>
    z.strictObject({ kind: z.literal(kind), repositoryId: id }),
  ),
  z.strictObject({
    kind: z.literal('policy'),
    repositoryId: id,
    key: z.uuid(),
    visibility: z.enum(['private', 'metadata', 'content']),
    paths: z.array(id).max(10000),
  }),
  z.strictObject({
    kind: z.literal('intent'),
    repositoryId: id,
    key: z.uuid(),
    paths: z.array(id).max(10000),
  }),
  z.strictObject({ kind: z.literal('propose'), repositoryId: id, key: z.uuid(), reviewId: id }),
  z.strictObject({
    kind: z.literal('view'),
    repositoryId: id,
    key: z.uuid(),
    view: z.enum(['main', 'task']),
  }),
]);
export const groupGitHostRequestSchema = z.strictObject({
  handle: z.uuid(),
  command: groupGitHostCommandSchema,
});
export const groupGitHostViewSchema = z.strictObject({
  message: z.string().max(2000),
  receipt: z
    .strictObject({
      key: z.uuid(),
      state: z.enum(['completed', 'refused']),
      message: z.string().max(2000),
    })
    .optional(),
  repositories: z
    .array(
      z.strictObject({
        id,
        label: z.string().max(160),
        branch: z.string().max(255),
        visibility: z.enum(['private', 'metadata', 'content']),
        paths: z
          .array(
            z.strictObject({
              id,
              name: z.string().max(4096),
              visibility: z.enum(['private', 'metadata', 'content']),
            }),
          )
          .max(10000),
        reviews: z.array(z.strictObject({ id, sourceOid: oid })).max(128),
      }),
    )
    .max(64),
  selected: z
    .strictObject({
      id,
      branch: z.string().max(255),
      observedOid: oid.nullable(),
      nextAttemptAt: z.number().nullable(),
      pending: z.boolean(),
      snapshot: z
        .strictObject({
          copyId: id,
          revision: z.number().int().nonnegative(),
          headOid: oid,
          baseOid: oid,
          dirty: z.boolean(),
          untracked: z.boolean(),
          conflicts: z.boolean(),
          complete: z.boolean(),
          writerGeneration: z.number().int().nonnegative(),
          paths: z.array(z.string()).max(10000),
          renames: z.array(z.tuple([z.string(), z.string()])).max(10000),
          unsavedAwareness: z.literal('unavailable'),
        })
        .nullable(),
      warnings: z
        .array(
          z.strictObject({ message: z.string().max(2000), paths: z.array(z.string()).max(10000) }),
        )
        .max(128),
    })
    .nullable(),
});
export type GroupGitHostCommand = z.infer<typeof groupGitHostCommandSchema>;
export type GroupGitHostView = z.infer<typeof groupGitHostViewSchema>;
