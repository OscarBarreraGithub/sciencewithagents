import { z } from 'zod';

/** Navigation shared by the project folder picker and the LaTeX file browser. */
export const folderBreadcrumbSchema = z
  .object({ id: z.string().uuid(), name: z.string() })
  .strict();
export const folderLocationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(['home', 'desktop', 'documents', 'downloads', 'developer', 'computer', 'volumes']),
  })
  .strict();
