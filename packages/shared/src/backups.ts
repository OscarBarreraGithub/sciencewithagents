import { z } from 'zod';
export const backupStatusSchema = z
  .object({
    projectId: z.string().uuid(),
    configured: z.boolean(),
    state: z.enum(['not_configured', 'waiting', 'saving', 'saved', 'needs_attention']),
    commit: z.string().nullable(),
    checkedAt: z.string().nullable(),
    message: z.string(),
  })
  .strict();
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const backupRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!));
export const backupPreviewRequestSchema = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('create') }).strict(),
  z.object({ choice: z.literal('existing'), repository: backupRepositorySchema }).strict(),
]);
export const backupConnectRequestSchema = z
  .object({
    key: z.uuid(),
    previewId: z.uuid(),
    confirm: z.literal(true),
  })
  .strict();
export const backupPreviewSchema = z.object({
  id: z.uuid(),
  repository: backupRepositorySchema,
  branch: z.string(),
  choice: z.enum(['create', 'existing']),
  expiresAt: z.string().datetime(),
  attempted: z.boolean(),
});
export const backupSetupSchema = z.object({
  canSignIn: z.boolean().default(false),
  status: backupStatusSchema,
  destination: z.object({ repository: backupRepositorySchema, branch: z.string() }).nullable(),
  preview: backupPreviewSchema.nullable(),
});
export type BackupSetup = z.infer<typeof backupSetupSchema>;
