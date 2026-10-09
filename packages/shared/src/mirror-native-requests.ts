import { z } from 'zod';

const nativeId = z.string().min(1).max(1024);
export const mirrorNativeRequestIdSchema = z.union([nativeId, z.number().int().safe()]);
export const mirrorNativeQuestionSchema = z
  .object({
    id: nativeId,
    header: z.string().max(200),
    question: z.string().max(8000),
    isOther: z.boolean(),
    isSecret: z.boolean(),
    options: z
      .array(
        z
          .object({ label: z.string().min(1).max(1000), description: z.string().max(2000) })
          .strict(),
      )
      .max(16)
      .nullable(),
  })
  .strict();
export const mirrorNativeRequestSchema = z
  .object({
    token: z.uuid(),
    requestId: mirrorNativeRequestIdSchema,
    threadId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128).nullable(),
    itemId: nativeId.nullable(),
    kind: z.enum(['question', 'approval', 'unsupported']),
    title: z.string().max(240),
    message: z.string().max(2000),
    questions: z.array(mirrorNativeQuestionSchema).max(8),
    observation: z.enum(['pending', 'unconfirmed']),
    response: z.enum(['answer', 'editor_only']),
  })
  .strict();
export const mirrorQuestionAnswerSchema = z
  .object({
    key: z.uuid(),
    provider: z.literal('codex'),
    token: z.uuid(),
    threadId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    answers: z
      .record(nativeId, z.array(z.string().min(1).max(8000)).min(1).max(16))
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 8),
  })
  .strict();
export const mirrorQuestionReceiptSchema = mirrorQuestionAnswerSchema
  .pick({ key: true, token: true, threadId: true, turnId: true })
  .strict();
export type MirrorNativeQuestion = z.infer<typeof mirrorNativeQuestionSchema>;
export type MirrorNativeRequest = z.infer<typeof mirrorNativeRequestSchema>;
export type MirrorQuestionAnswer = z.infer<typeof mirrorQuestionAnswerSchema>;
export type MirrorQuestionReceipt = z.infer<typeof mirrorQuestionReceiptSchema>;
