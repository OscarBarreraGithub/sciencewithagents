import { z } from 'zod';

/** Invalidation only. A connection or hint never grants read/effect authority. */
export const groupUpdateSchema = z.strictObject({
  version: z.literal(1),
  groupId: z.uuid(),
  kind: z.enum(['connected', 'changed']),
});
export type GroupUpdate = z.infer<typeof groupUpdateSchema>;
/** Ephemeral metadata on the existing authenticated app event stream. */
export const groupHostUpdateSchema = z.strictObject({
  groupId: z.uuid(),
  memberId: z.uuid(),
  installationId: z.uuid(),
  connected: z.boolean(),
  changed: z.boolean(),
});
export type GroupHostUpdate = z.infer<typeof groupHostUpdateSchema>;
export type GroupUpdateIdentity = Pick<GroupHostUpdate, 'groupId' | 'memberId' | 'installationId'>;
export const GROUP_UPDATE_LIMITS = {
  frameBytes: 1024,
  connections: 128,
  perEnrollment: 2,
} as const;
