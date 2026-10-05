import { z } from 'zod';

export const chatImageBodyLimit = 12 * 1024 * 1024;
export const chatImageUploadSchema = z
  .object({
    key: z.uuid(),
    png: z.string().min(1).max(11_184_812),
  })
  .strict();
export const chatImageSchema = z
  .object({
    id: z.uuid(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const imageId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const chatImageUrl = (id: string) => `swa-image:${id}`;
export const chatImageReference = (id: string) => `![Screenshot](${chatImageUrl(id)})`;
export function chatImageId(url: string) {
  return new RegExp(`^swa-image:(${imageId})$`).exec(url)?.[1] ?? null;
}
export function chatImageIds(text: string) {
  return [
    ...new Set(
      [...text.matchAll(new RegExp(`!\\[Screenshot\\]\\(swa-image:(${imageId})\\)`, 'g'))].map(
        (m) => m[1]!,
      ),
    ),
  ];
}
export function withoutChatImages(text: string) {
  return text.replace(
    new RegExp(`(?:\\n\\n)?!\\[Screenshot\\]\\(swa-image:${imageId}\\)`, 'g'),
    '',
  );
}
/** Keep image references in the same saved draft/receipt as the user's text. */
export function withChatImageText(previous: string, text: string) {
  const refs = chatImageIds(previous).map(chatImageReference);
  return refs.length ? [text, ...refs].filter(Boolean).join('\n\n') : text;
}
