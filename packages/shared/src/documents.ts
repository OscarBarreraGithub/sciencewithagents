import { z } from 'zod';

export const documentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    folder: z.string(),
    kind: z.enum(['tex', 'pdf']),
    state: z.enum(['source', 'queued', 'building', 'ready', 'failed']),
    hasPdf: z.boolean(),
    builtAt: z.string().nullable(),
    openedAt: z.string().nullable(),
    error: z.string().nullable(),
    href: z.string(),
  })
  .strict();
export type SavedDocument = z.infer<typeof documentSchema>;
export const documentReadingSchema = z
  .object({
    available: z.boolean(),
    html: z.string(),
    warnings: z.array(z.string()),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type DocumentReading = z.infer<typeof documentReadingSchema>;
export const savedDocumentLinkSchema = z
  .object({
    agentId: z.string().uuid(),
    entryId: z.string().min(1).max(512),
    index: z.number().int().min(0).max(999),
  })
  .strict();
/** Only saved Markdown document links can be resolved; clients send an ordinal, never a path. */
export function savedDocumentLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)\s*\)/g)]
    .map((match) => match[1]!.replace(/^<|>$/g, ''))
    .filter((href) => /^(?:\/|file:\/\/)/.test(href) && /\.(?:pdf|tex)$/i.test(href));
}
export const documentBrowseQuerySchema = z
  .object({
    folderId: z.string().uuid().optional(),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();
export const documentBrowseSchema = z
  .object({
    current: z.object({ id: z.string().uuid(), name: z.string(), canSelect: z.boolean() }),
    parentId: z.string().uuid().nullable(),
    folders: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    nextOffset: z.number().nullable(),
    files: z.array(documentSchema),
    nextFileOffset: z.number().nullable(),
  })
  .strict();
export type DocumentBrowse = z.infer<typeof documentBrowseSchema>;
export const documentActionSchema = z.object({ key: z.string().uuid() }).strict();
/** Provider tool only: the browser selects host-issued IDs, never paths. */
export const documentRegisterSchema = z
  .object({
    path: z.string().min(1).max(4096),
  })
  .strict();
