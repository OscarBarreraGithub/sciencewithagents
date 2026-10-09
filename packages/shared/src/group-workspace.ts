import { z } from 'zod';

export const groupWorkspaceInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status'), handle: z.uuid() }),
  z.strictObject({
    action: z.literal('select'),
    handle: z.uuid(),
    key: z.uuid(),
    revision: z.number().int().nonnegative().safe(),
    selectionKey: z.uuid(),
  }),
]);
export const groupWorkspaceViewSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  selectionKey: z.uuid().nullable(),
  workspacePath: z.string().max(4096).nullable(),
  available: z.boolean(),
  message: z.string().max(500),
});
export type GroupWorkspaceInput = z.infer<typeof groupWorkspaceInputSchema>;
export type GroupWorkspaceView = z.infer<typeof groupWorkspaceViewSchema>;
