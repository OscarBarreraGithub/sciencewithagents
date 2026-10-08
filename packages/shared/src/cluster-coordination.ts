import { z } from 'zod';
/** Fixed actions for the saved connection, never a command or remote execution path. */
export const clusterWorkspaceControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect') }).strict(),
  z.object({ action: z.literal('renew'), hours: z.number().int().min(1).max(72) }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
]);
