import { z } from 'zod';
import { groupEvidenceFactsSchema } from './group-evidence.js';
import { groupEventSchema } from './groups.js';

export const GROUP_CATCHUP_LIMITS = {
  pageSize: 8,
  pages: 8192,
  snapshots: 512,
  members: 128,
  bytes: 64 * 1024 * 1024,
} as const;
const position = z.number().int().nonnegative().safe();
export const groupCatchupSelectSchema = z.strictObject({ handle: z.uuid() });
export const groupCatchupPageRequestSchema = groupCatchupSelectSchema.extend({
  snapshotId: z.uuid(),
  continuation: z.uuid(),
});
export const groupCatchupAckRequestSchema = groupCatchupSelectSchema.extend({
  snapshotId: z.uuid(),
  pageId: z.uuid(),
  acknowledgementId: z.uuid(),
});
export const groupCatchupPageSchema = z
  .strictObject({
    snapshotId: z.uuid(),
    pageId: z.uuid(),
    acknowledgementId: z.uuid(),
    after: position,
    through: position,
    watermark: position,
    entries: z.array(groupEventSchema).max(GROUP_CATCHUP_LIMITS.pageSize),
    continuation: z.uuid().nullable(),
    acknowledged: z.boolean(),
    sourceFacts: z
      .array(z.strictObject({ eventId: z.uuid(), facts: groupEvidenceFactsSchema.nullable() }))
      .max(GROUP_CATCHUP_LIMITS.pageSize)
      .optional(),
  })
  .refine(
    (p) =>
      p.after <= p.through &&
      p.through <= p.watermark &&
      p.entries.every((e, i) => e.sequence === p.after + i + 1) &&
      p.through === p.after + p.entries.length &&
      (p.continuation !== null) === p.through < p.watermark &&
      (!p.sourceFacts ||
        (new Set(p.sourceFacts.map((f) => f.eventId)).size === p.sourceFacts.length &&
          p.sourceFacts.every((f) => p.entries.some((e) => e.eventId === f.eventId)))),
    'Discontinuous catch-up page',
  );
export const groupCatchupAckSchema = z.strictObject({
  snapshotId: z.uuid(),
  pageId: z.uuid(),
  acknowledgementId: z.uuid(),
  through: position,
  watermark: position,
});
export type GroupCatchupPage = z.infer<typeof groupCatchupPageSchema>;
export type GroupCatchupAck = z.infer<typeof groupCatchupAckSchema>;
