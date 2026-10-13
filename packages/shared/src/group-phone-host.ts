import { z } from 'zod';

// Portable app contracts. Hosted enrollment, routing proofs and credentials are
// constructed by the host; the browser supplies only retained handles.
export const groupPhoneHostRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status'), handle: z.uuid() }),
  z.strictObject({
    action: z.literal('pair'),
    handle: z.uuid(),
    key: z.uuid(),
    label: z.string().trim().min(1).max(80),
    allowPost: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('revoke'),
    handle: z.uuid(),
    key: z.uuid(),
    deviceId: z.uuid(),
  }),
]);
export const groupPhoneDevicesSchema = z.strictObject({
  devices: z
    .array(
      z.strictObject({
        id: z.uuid(),
        label: z.string().max(80),
        allowPost: z.boolean(),
        state: z.enum(['active', 'revoked']),
      }),
    )
    .max(64),
});
export const groupPhoneHostViewSchema = groupPhoneDevicesSchema.extend({
  link: z.string().url().max(4096).nullable(),
  expiresAt: z.number().int().safe().nullable(),
});
export type GroupPhoneHostRequest = z.infer<typeof groupPhoneHostRequestSchema>;
export type GroupPhoneHostView = z.infer<typeof groupPhoneHostViewSchema>;
