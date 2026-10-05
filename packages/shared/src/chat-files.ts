import { z } from 'zod';
import { chatImageIds, chatImageReference, withoutChatImages } from './chat-images.js';

export const chatFileByteLimit = 8 * 1024 * 1024;
export const chatAttachmentLimit = 4;
export const chatFileUploadSchema = z
  .object({
    key: z.uuid(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .regex(/^[^/\\\x00-\x1f\x7f]+$/),
    data: z.string().min(1).max(11_184_812),
  })
  .strict();
export const chatFileSchema = z
  .object({
    id: z.uuid(),
    name: chatFileUploadSchema.shape.name,
    size: z.number().int().min(1).max(chatFileByteLimit),
    mimeType: z.enum(['image/png', 'application/pdf', 'text/plain', 'application/octet-stream']),
    image: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .optional(),
  })
  .strict();
export type ChatFile = z.infer<typeof chatFileSchema>;
const fileId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const chatFileReference = (id: string) => `[File](swa-file:${id})`;
export function chatFileId(url: string) {
  return new RegExp(`^swa-file:(${fileId})$`).exec(url)?.[1] ?? null;
}
export function chatFileIds(text: string) {
  return [
    ...new Set(
      [...text.matchAll(new RegExp(`\\[File\\]\\(swa-file:(${fileId})\\)`, 'g'))].map((m) => m[1]!),
    ),
  ];
}
export function chatAttachmentCount(text: string) {
  return chatImageIds(text).length + chatFileIds(text).length;
}
export function withoutChatAttachments(text: string) {
  return withoutChatImages(text).replace(
    new RegExp(`(?:\\n\\n)?\\[File\\]\\(swa-file:${fileId}\\)`, 'g'),
    '',
  );
}
/** References remain in the existing shared draft and durable send receipt. */
export function withChatAttachmentText(previous: string, text: string) {
  const refs = [
    ...chatImageIds(previous).map(chatImageReference),
    ...chatFileIds(previous).map(chatFileReference),
  ];
  return refs.length ? [text, ...refs].filter(Boolean).join('\n\n') : text;
}
