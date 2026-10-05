import { z } from 'zod';
import { providerIdSchema } from './providers.js';
import { mirrorWindowSchema } from './mirror.js';

const selection = {
  source: z.enum(['managed', 'editor']),
  windowId: z.string().uuid().optional(),
  threadId: z.string().min(1).max(128).optional(),
  provider: providerIdSchema.optional(),
};
const editorIdentity = (value: {
  source: string;
  windowId?: string;
  threadId?: string;
  provider?: string;
}) =>
  value.source === 'editor'
    ? !!(value.windowId && value.threadId && value.provider)
    : !(value.windowId || value.threadId || value.provider);
export const archiveQuerySchema = z
  .object({
    ...selection,
    query: z.string().trim().max(200).default(''),
    cursor: z.string().min(1).max(16384).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine(editorIdentity, 'Select an exact editor window, provider and thread.');
export const archiveReadSchema = z
  .object({
    ...selection,
    recordType: z.enum(['entry', 'decision']).default('entry'),
    id: z.string().min(1).max(2048),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024)
      .default(0),
    limit: z.number().int().min(1).max(24000).default(8000),
  })
  .strict()
  .refine(editorIdentity, 'Select an exact editor window, provider and thread.');
export const archiveItemSchema = z
  .object({
    source: z.enum(['managed', 'editor']),
    recordType: z.enum(['entry', 'decision']),
    id: z.string(),
    agentId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    windowId: z.string().uuid().nullable(),
    threadId: z.string().nullable(),
    provider: providerIdSchema,
    role: z.string(),
    title: z.string().max(500),
    text: z.string().max(24000),
    offset: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    href: z
      .string()
      .max(1000)
      .regex(/^#\/(?:chat|chats\/vscode)\//),
  })
  .strict();
export const archivePageSchema = z
  .object({
    items: z.array(archiveItemSchema).max(50),
    nextCursor: z.string().nullable(),
    complete: z.boolean(),
    scannedEntries: z.number().int().nonnegative(),
    notice: z.string().max(2000),
  })
  .strict();
export const archiveEditorsSchema = z
  .object({
    windows: z.array(mirrorWindowSchema),
    notice: z.string().max(2000),
  })
  .strict();
export type ArchiveQuery = z.infer<typeof archiveQuerySchema>;
export type ArchiveRead = z.infer<typeof archiveReadSchema>;
export type ArchiveItem = z.infer<typeof archiveItemSchema>;
export type ArchivePage = z.infer<typeof archivePageSchema>;
