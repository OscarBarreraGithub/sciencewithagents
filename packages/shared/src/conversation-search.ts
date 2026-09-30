import { z } from 'zod';
import { effortSchema, providerIdSchema } from './providers.js';

/** Explicit owner action; ordinary catalog reads and typing never call this. */
export const conversationSearchRequestSchema = z
  .object({
    key: z.uuid(),
    query: z.string().trim().min(1).max(500),
    provider: providerIdSchema,
    model: z.string().trim().min(1).max(100).optional(),
    effort: effortSchema.optional(),
  })
  .strict();

export const conversationSearchCandidateSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['managed', 'editor']),
    provider: providerIdSchema,
    title: z.string().max(240),
    project: z.string().max(240).nullable(),
    // Constructed by the host from a saved agent or connected provider thread.
    href: z
      .string()
      .max(1000)
      .regex(/^#\/(?:chat|chats\/vscode)\//),
    excerpt: z.string().max(1000),
    evidence: z.enum(['saved-excerpts', 'title-only']),
  })
  .strict();

export const conversationSearchCoverageSchema = z
  .object({
    projectsConsidered: z.number().int().nonnegative(),
    projectsAvailable: z.number().int().nonnegative(),
    managedCandidates: z.number().int().nonnegative(),
    editorCandidates: z.number().int().nonnegative(),
    bounded: z.literal(true),
    editorTranscripts: z.literal(false),
    notice: z.string().max(2000),
  })
  .strict();

export const conversationSearchResultSchema = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    runId: z.uuid(),
    query: z.string().max(500),
    provider: providerIdSchema,
    model: z.string(),
    effort: effortSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
    createdAt: z.string(),
    coverage: conversationSearchCoverageSchema,
    candidates: z.array(conversationSearchCandidateSchema).max(40),
    // Ranked prose from the helper; candidates above are the host-verified source links.
    report: z.string().max(12000).nullable(),
    reportTruncated: z.boolean(),
    message: z.string().max(2000),
  })
  .strict();

export type ConversationSearchRequest = z.infer<typeof conversationSearchRequestSchema>;
export type ConversationSearchCandidate = z.infer<typeof conversationSearchCandidateSchema>;
export type ConversationSearchCoverage = z.infer<typeof conversationSearchCoverageSchema>;
export type ConversationSearchResult = z.infer<typeof conversationSearchResultSchema>;
