import { z } from 'zod';
import { promptTextSchema } from './prompt-text.js';

export const nativeConnectionKindSchema = z.enum(['tmux', 'herdr']);
export const nativeConnectionSourceSchema = z
  .object({
    id: z.uuid(),
    label: z.string().min(1).max(200),
    kind: nativeConnectionKindSchema,
    location: z.enum(['local', 'ssh']),
    state: z.enum(['available', 'unavailable', 'unsupported']),
    message: z.string().max(1000),
  })
  .strict();
export const nativeConnectionTargetSchema = z
  .object({
    id: z.uuid(),
    sourceId: z.uuid(),
    label: z.string().min(1).max(500),
    kind: nativeConnectionKindSchema,
    nativeStatus: z.enum(['idle', 'working', 'blocked', 'unknown']),
    canObserve: z.boolean(),
    canControl: z.boolean(),
    /** tmux permits concurrent native clients; Herdr has an exclusive controller. */
    controlPolicy: z.enum(['shared', 'exclusive']),
    controller: z.enum(['free', 'occupied', 'unknown']),
    controllerLabel: z.string().max(200).optional(),
  })
  .strict();
export const nativeConnectionAttachSchema = z
  .object({
    key: z.uuid(),
    targetId: z.uuid(),
    mode: z.enum(['observe', 'control']),
    takeover: z.literal(true).optional(),
  })
  .strict();
export const nativeConnectionAttachmentSchema = z
  .object({
    id: z.uuid(),
    targetId: z.uuid(),
    mode: z.enum(['observe', 'control']),
    status: z.enum(['connecting', 'connected', 'detached', 'unavailable']),
    message: z.string().max(1000),
    inputToken: z.uuid().optional(),
  })
  .strict();
export const nativeConnectionsViewSchema = z
  .object({
    sources: z.array(nativeConnectionSourceSchema).max(34),
    targets: z.array(nativeConnectionTargetSchema).max(512),
    attachments: z.array(nativeConnectionAttachmentSchema).max(64),
    observedAt: z.string().datetime(),
  })
  .strict();
export const nativeConnectionDetachSchema = z.object({ key: z.uuid() }).strict();
/** Explicit saved prompt only. Raw terminal keys/passwords use the unrecorded socket. */
export const nativeConnectionSendSchema = z
  .object({
    key: z.uuid(),
    inputToken: z.uuid(),
    text: promptTextSchema,
  })
  .strict();
export const nativeConnectionSendReceiptSchema = nativeConnectionSendSchema
  .extend({
    attachmentId: z.uuid(),
    targetId: z.uuid(),
    /** delivered proves native pane submission, never agent acceptance or a turn. */
    state: z.enum(['not_sent', 'delivered', 'uncertain']),
    message: z.string().max(1000),
    createdAt: z.string().datetime(),
  })
  .strict();
export const nativeConnectionPromptListSchema = z
  .object({
    items: z
      .array(
        nativeConnectionSendReceiptSchema
          .omit({ text: true, inputToken: true })
          .extend({
            textPreview: z.string().max(1200),
            textLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(20),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export const nativeConnectionPromptQuerySchema = z.object({ before: z.uuid().optional() }).strict();
export type NativeConnectionSource = z.infer<typeof nativeConnectionSourceSchema>;
export type NativeConnectionTarget = z.infer<typeof nativeConnectionTargetSchema>;
export type NativeConnectionAttach = z.infer<typeof nativeConnectionAttachSchema>;
export type NativeConnectionAttachment = z.infer<typeof nativeConnectionAttachmentSchema>;
export type NativeConnectionsView = z.infer<typeof nativeConnectionsViewSchema>;
export type NativeConnectionSend = z.infer<typeof nativeConnectionSendSchema>;
export type NativeConnectionSendReceipt = z.infer<typeof nativeConnectionSendReceiptSchema>;
export type NativeConnectionPromptList = z.infer<typeof nativeConnectionPromptListSchema>;
