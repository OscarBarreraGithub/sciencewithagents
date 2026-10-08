import { z } from 'zod';
import { folderBreadcrumbSchema, folderLocationSchema } from './folder-navigation.js';

/** Public arXiv provenance for an imported document. Paths and URLs other than arXiv's stay private. */
export const arxivPaperSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    authors: z.array(z.string()),
    abstract: z.string(),
    absUrl: z.string(),
    hasSource: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();
export type ArxivPaper = z.infer<typeof arxivPaperSchema>;

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
    arxiv: arxivPaperSchema.optional(),
  })
  .strict();
export type SavedDocument = z.infer<typeof documentSchema>;
export const documentLibrarySchema = z
  .object({ compiler: z.string().nullable(), documents: documentSchema.array() })
  .strict();
/**
 * What the deterministic Reading rules did to a source. Later slices (bibliography, KaTeX
 * checks, the light fixer) add optional fields here; names are relative, never absolute paths.
 */
export const readingMacrosSchema = z
  .record(z.string().regex(/^\\[A-Za-z]{1,40}$/), z.string().max(1024))
  .refine((value) => Object.keys(value).length <= 64 && JSON.stringify(value).length <= 32768);
export const readingHealthSchema = z
  .object({
    /** complete: every passage converted; partial: some passages are only in the PDF. */
    conversion: z.enum(['complete', 'partial', 'unavailable']).default('complete'),
    plainTex: z.boolean().default(false),
    /** Included files named by the source but absent from its folder. */
    missingIncludes: z.array(z.string()).default([]),
    /** Passages replaced by a visible “only in the Original PDF” note. */
    dropped: z
      .array(
        z
          .object({
            part: z.enum(['preamble', 'body']),
            reason: z.string(),
            excerpt: z.string(),
          })
          .strict(),
      )
      .default([]),
    /** Deterministic source rules applied, by name, with how often each applied. */
    rules: z.record(z.string(), z.number().int().nonnegative()).default({}),
    notes: z.array(z.string()).default([]),
    localMacros: z
      .array(
        z
          .object({
            name: z.string().max(41),
            file: z.string(),
            status: z.enum(['restored', 'declined']),
            reason: z
              .enum(['conflicting-definition', 'scoped-or-conditional', 'unsupported-definition'])
              .nullable(),
            occurrences: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();
export type ReadingHealth = z.infer<typeof readingHealthSchema>;
export const documentReadingSchema = z
  .object({
    available: z.boolean(),
    html: z.string(),
    warnings: z.array(z.string()),
    labels: z.record(z.string(), z.string()).default({}),
    health: readingHealthSchema.optional(),
    macros: readingMacrosSchema.optional(),
  })
  .strict();
export type DocumentReading = z.infer<typeof documentReadingSchema>;
/**
 * Clients accept any server version: unknown keys are dropped and newer fields are optional,
 * because the phone runs the web build on disk while the server keeps its own build until it
 * restarts.
 */
export const documentReadingResponseSchema = documentReadingSchema.strip().extend({
  macros: readingMacrosSchema.catch({}).optional(),
  warnings: z.array(z.string()).default([]),
  health: z
    .object({
      conversion: z.string().default('complete'),
      plainTex: z.boolean().default(false),
      missingIncludes: z.array(z.string()).default([]),
      dropped: z
        .array(z.object({ part: z.string(), reason: z.string(), excerpt: z.string() }).strip())
        .default([]),
      rules: z.record(z.string(), z.number()).default({}),
      notes: z.array(z.string()).default([]),
      localMacros: readingHealthSchema.shape.localMacros,
    })
    .strip()
    .optional(),
});
export type DocumentReadingResponse = z.infer<typeof documentReadingResponseSchema>;
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
/** Server contract; the documents route has no folder search, so it never sends `search`. */
export const documentBrowseSchema = z
  .object({
    current: z.object({ id: z.string().uuid(), name: z.string(), canSelect: z.boolean() }),
    parentId: z.string().uuid().nullable(),
    folders: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    nextOffset: z.number().nullable(),
    breadcrumbs: z.array(folderBreadcrumbSchema),
    locations: z.array(folderLocationSchema),
    files: z.array(documentSchema),
    nextFileOffset: z.number().nullable(),
  })
  .strict();
/**
 * Clients accept any server version: unknown keys are dropped, older servers may omit
 * navigation and newer servers may add location kinds. The phone runs whatever web build
 * is on disk while the server keeps running its own build until restarted.
 */
export const documentBrowseResponseSchema = documentBrowseSchema.strip().extend({
  breadcrumbs: z.array(folderBreadcrumbSchema.strip()).default([]),
  locations: z.array(folderLocationSchema.strip().extend({ kind: z.string() })).default([]),
  files: z.array(documentSchema.strip()),
});
export type DocumentBrowse = z.infer<typeof documentBrowseResponseSchema>;
export const documentActionSchema = z.object({ key: z.string().uuid() }).strict();
/** Provider tool only: the browser selects host-issued IDs, never paths. */
export const documentRegisterSchema = z
  .object({
    path: z.string().min(1).max(4096),
  })
  .strict();

export const documentFormatRequestSchema = z
  .object({
    key: z.string().uuid(),
    provider: z.enum(['codex', 'claude']).optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(40).optional(),
  })
  .strict();
export const documentFormatStatusSchema = z
  .object({
    id: z.string().uuid(),
    documentId: z.string().uuid(),
    agentId: z.string().uuid(),
    model: z.string(),
    state: z.enum(['queued', 'running', 'ready', 'failed', 'interrupted', 'stale']),
    message: z.string(),
  })
  .strict();
export type DocumentFormatStatus = z.infer<typeof documentFormatStatusSchema>;

/** The client sends only an arXiv link or ID; the server chooses every URL and path. */
export const arxivImportRequestSchema = z
  .object({ key: z.string().uuid(), link: z.string().trim().min(1).max(2048) })
  .strict();
export const arxivImportSchema = z
  .object({
    id: z.string().uuid(),
    arxivId: z.string(),
    version: z.number().int().positive().nullable(),
    state: z.enum(['queued', 'fetching', 'ready', 'failed']),
    message: z.string(),
    document: documentSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ArxivImport = z.infer<typeof arxivImportSchema>;
