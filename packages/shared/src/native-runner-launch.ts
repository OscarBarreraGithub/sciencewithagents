import { z } from 'zod';
import { effortSchema, providerIdSchema } from './providers.js';

export const nativeRunnerModelChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('native') }).strict(),
  z.object({ mode: z.literal('policy') }).strict(),
  z
    .object({
      mode: z.literal('exact'),
      model: z.string().min(1).max(100),
      effort: effortSchema.optional(),
    })
    .strict(),
]);
export const nativeRunnerModelResolutionSchema = z
  .object({
    provider: providerIdSchema,
    mode: z.enum(['native', 'policy', 'exact']),
    model: z.string().max(100).nullable(),
    effort: effortSchema.nullable(),
    policyRevision: z.number().int().nonnegative(),
  })
  .strict();
export const nativeRunnerStartSchema = z
  .object({
    key: z.uuid(),
    folderId: z.uuid(),
    sourceId: z.uuid(),
    provider: providerIdSchema,
    choice: nativeRunnerModelChoiceSchema,
  })
  .strict();
export const nativeRunnerStartReceiptSchema = nativeRunnerStartSchema
  .extend({
    /** created proves native session creation, never sign-in, an agent turn, or a running outcome. */
    state: z.enum(['not_started', 'created', 'uncertain']),
    folderName: z.string().min(1).max(500),
    resolution: nativeRunnerModelResolutionSchema,
    targetId: z.uuid().optional(),
    message: z.string().max(1000),
    createdAt: z.string().datetime(),
  })
  .strict();
export const nativeRunnerLaunchOptionsSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            id: z.uuid(),
            label: z.string().min(1).max(200),
            available: z.boolean(),
            message: z.string().max(1000),
          })
          .strict(),
      )
      .max(34),
    providers: z
      .array(
        z
          .object({
            provider: providerIdSchema,
            installed: z.boolean(),
            version: z.string().max(200),
            message: z.string().max(1000),
          })
          .strict(),
      )
      .max(2),
    starts: z.array(nativeRunnerStartReceiptSchema).max(20),
  })
  .strict();
export type NativeRunnerModelChoice = z.infer<typeof nativeRunnerModelChoiceSchema>;
export type NativeRunnerModelResolution = z.infer<typeof nativeRunnerModelResolutionSchema>;
export type NativeRunnerStart = z.infer<typeof nativeRunnerStartSchema>;
export type NativeRunnerStartReceipt = z.infer<typeof nativeRunnerStartReceiptSchema>;
export type NativeRunnerLaunchOptions = z.infer<typeof nativeRunnerLaunchOptionsSchema>;
