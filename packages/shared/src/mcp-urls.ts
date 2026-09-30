import { z } from 'zod';

/** User-clicked destinations only. This is never a server-side fetch or redirect endpoint. */
export const mcpUrlSchema = z
  .string()
  .min(1)
  .max(8000)
  .transform((raw, context) => {
    try {
      // Reject browser parser repairs that can hide the actual destination.
      if (/[\s\u0000-\u0020\u007f\u202a-\u202e\u2066-\u2069\\]/u.test(raw)) throw new Error();
      const authority = /^https?:\/\/([^/?#]+)/i.exec(raw)?.[1];
      if (!authority || authority.includes('@')) throw new Error();
      const url = new URL(raw);
      if (url.username || url.password) throw new Error();
      const localHttp =
        url.protocol === 'http:' &&
        /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(raw);
      if (url.protocol !== 'https:' && !localHttp) throw new Error();
      return url.href;
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'URL requests need HTTPS or an explicit loopback HTTP address, without credentials or ambiguous characters.',
      });
      return z.NEVER;
    }
  });

export const mcpUrlRequestSchema = z
  .object({
    serverName: z.string().min(1).max(200),
    url: mcpUrlSchema,
  })
  .strict();
export type McpUrlRequest = z.infer<typeof mcpUrlRequestSchema>;
