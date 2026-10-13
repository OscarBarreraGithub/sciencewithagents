import { z } from 'zod';
import { membershipCapabilitySchema } from './group-membership.js';
import { publicationBindingSchema } from './group-delivery.js';
import { groupMemberIdSchema, groupUtf8Bytes } from './groups.js';
export const GROUP_PHONE_LIMITS = {
  pairMs: 600_000,
  devicePage: 64,
  activeDevices: 8,
  textBytes: 16_384,
  page: 20,
} as const;
export const groupPhoneManageCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pair'),
    operationId: z.uuid(),
    pairSecret: membershipCapabilitySchema,
    expiresAt: z.number().int().safe(),
    label: z.string().trim().min(1).max(80),
    allowPost: z.boolean(),
    binding: publicationBindingSchema,
    memberId: groupMemberIdSchema,
  }),
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('revoke'), operationId: z.uuid(), deviceId: z.uuid() }),
]);
export const groupPhoneCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('claim'),
    pairId: z.uuid(),
    pairSecret: membershipCapabilitySchema,
    pairProof: membershipCapabilitySchema,
    expiresAt: z.number().int().safe(),
    key: z.uuid(),
    deviceId: z.uuid(),
    deviceCredential: membershipCapabilitySchema,
  }),
  z.strictObject({
    kind: z.literal('feed'),
    before: z.number().int().positive().safe().nullable(),
    since: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    kind: z.literal('original'),
    eventId: z.uuid(),
    start: z.number().int().nonnegative().max(63),
  }),
  z.strictObject({
    kind: z.literal('post'),
    key: z.uuid(),
    text: z
      .string()
      .min(1)
      .max(GROUP_PHONE_LIMITS.textBytes)
      .refine((t) => t.trim().length > 0 && groupUtf8Bytes(t) <= GROUP_PHONE_LIMITS.textBytes),
  }),
]);
export { groupPhoneDevicesSchema } from './group-phone-host.js';
export type GroupPhoneManageCommand = z.infer<typeof groupPhoneManageCommandSchema>;
export type GroupPhoneCommand = z.infer<typeof groupPhoneCommandSchema>;
export type GroupPhoneResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: 'denied' | 'invalid' | 'conflict' | 'limit' | 'unavailable' | 'hosting_disabled';
    };
