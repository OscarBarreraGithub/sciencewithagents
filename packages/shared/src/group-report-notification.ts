import { z } from 'zod';
import { groupReportListSchema } from './group-documents.js';
const entry = groupReportListSchema.shape.entries.element;

/** Presentation only: opening still requires the current group's report authorization. */
export const groupReportNotificationSchema = z
  .strictObject({
    kind: z.literal('shared-report'),
    title: entry.shape.manifest.shape.title,
    publication: entry.shape.key,
    href: z.string().max(180),
  })
  .refine(
    (value) =>
      value.href ===
      `#/groups/report/${value.publication.publicationId}/${value.publication.manifestHash}`,
  );
export type GroupReportNotification = z.infer<typeof groupReportNotificationSchema>;

/** Keep malformed or unrelated originals unchanged; no URL or endpoint is inferred. */
export function groupReportNotification(text: string): GroupReportNotification | null {
  if (new TextEncoder().encode(text).length > 32 * 1024) return null;
  try {
    const parsed = groupReportNotificationSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
