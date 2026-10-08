import {
  arxivImportSchema,
  arxivPaperSchema,
  documentLibrarySchema,
  documentSchema,
} from '@dock/shared';

// The web bundle and selected computer may update separately. Keep server-only
// contracts strict while accepting additional response metadata in the client.
export const documentResponseSchema = documentSchema.strip().extend({
  arxiv: arxivPaperSchema.strip().optional(),
});
export const documentLibraryResponseSchema = documentLibrarySchema.strip().extend({
  documents: documentResponseSchema.array(),
});
export const arxivImportResponseSchema = arxivImportSchema.strip().extend({
  document: documentResponseSchema.nullable(),
});
