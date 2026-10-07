import { z } from 'zod';
import { groupBetaAdmissionSchema } from './group-beta-admission.js';
import {
  groupIdSchema,
  groupDisplayNameSchema,
  groupMemberIdSchema,
  groupInstallationIdSchema,
  groupOperationIdSchema,
} from './groups.js';

export const MEMBERSHIP_LIMITS = {
  bodyBytes: 4096,
  pageSize: 50,
  members: 64,
  enrollments: 512,
  openInvites: 32,
  pending: 32,
  inviteSeconds: 900,
  // Internal membership-history guard; leave storage room for future group events.
  historyOperations: 2_048,
  dailyMutations: 500,
  databaseBytes: 16_777_216,
} as const;
// Canonical, exactly 256-bit client-generated capabilities; never use names as IDs.
export const membershipCapabilitySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const membershipHashSchema = membershipCapabilitySchema;
const mutation = { operationId: groupOperationIdSchema };
const init = z.strictObject({
  kind: z.literal('initialize'),
  ...mutation,
  groupName: groupDisplayNameSchema,
  displayName: groupDisplayNameSchema,
});
const invite = z.strictObject({
  kind: z.literal('invite'),
  ...mutation,
  inviteSecret: membershipCapabilitySchema,
  ttlSeconds: z.number().int().min(1).max(MEMBERSHIP_LIMITS.inviteSeconds),
});
const join = z.strictObject({
  kind: z.literal('join'),
  ...mutation,
  inviteSecret: membershipCapabilitySchema,
  confirmation: membershipCapabilitySchema,
  displayName: groupDisplayNameSchema,
});
const approve = z.strictObject({
  kind: z.literal('approve'),
  ...mutation,
  installationId: groupInstallationIdSchema,
  confirmation: membershipCapabilitySchema,
});
const revoke = z.strictObject({
  kind: z.literal('revoke'),
  ...mutation,
  installationId: groupInstallationIdSchema,
});
const revokeInvite = z.strictObject({
  kind: z.literal('revokeInvite'),
  ...mutation,
  inviteId: z.uuid(),
});
const page = {
  after: z.number().int().nonnegative().safe(),
  limit: z.number().int().min(1).max(MEMBERSHIP_LIMITS.pageSize),
};
export const membershipCommandSchema = z.discriminatedUnion('kind', [
  init,
  invite,
  join,
  approve,
  revoke,
  revokeInvite,
  z.strictObject({ kind: z.literal('roster'), ...page }),
  z.strictObject({ kind: z.literal('pending'), ...page }),
  z.strictObject({ kind: z.literal('audit'), ...page }),
  z.strictObject({ kind: z.literal('status') }),
]);
export const membershipEnvelopeSchema = z.strictObject({
  groupId: groupIdSchema,
  credential: membershipCapabilitySchema,
  setupCapability: membershipCapabilitySchema.optional(),
  betaAdmission: groupBetaAdmissionSchema.optional(),
  command: membershipCommandSchema,
});
export const membershipIdentitySchema = z.strictObject({
  groupId: groupIdSchema,
  memberId: groupMemberIdSchema,
  installationId: groupInstallationIdSchema,
  displayName: groupDisplayNameSchema,
  state: z.enum(['pending', 'active', 'revoked']),
});
export const membershipReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('identity'), identity: membershipIdentitySchema }),
  z.strictObject({
    kind: z.literal('invitation'),
    inviteId: z.uuid(),
    expiresAt: z.number().int().safe(),
  }),
  z.strictObject({ kind: z.literal('revokedInvite'), inviteId: z.uuid() }),
  z.strictObject({
    kind: z.literal('members'),
    entries: z
      .array(
        z.strictObject({
          position: z.number().int().positive(),
          identity: membershipIdentitySchema,
        }),
      )
      .max(MEMBERSHIP_LIMITS.pageSize),
    next: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    kind: z.literal('audit'),
    entries: z
      .array(
        z.strictObject({
          sequence: z.number().int().positive(),
          kind: z.enum(['initialize', 'invite', 'join', 'approve', 'revoke', 'revokeInvite']),
          actorInstallationId: groupInstallationIdSchema,
          targetId: z.uuid(),
          recordedAt: z.number().int().safe(),
        }),
      )
      .max(MEMBERSHIP_LIMITS.pageSize),
    next: z.number().int().positive().nullable(),
  }),
]);
export const membershipFailureSchema = z.enum([
  'denied',
  'invalid',
  'conflict',
  'limit',
  'unavailable',
  'hosting_disabled',
  'creation_expired',
]);
export type MembershipCommand = z.infer<typeof membershipCommandSchema>;
export type MembershipEnvelope = z.infer<typeof membershipEnvelopeSchema>;
export type MembershipIdentity = z.infer<typeof membershipIdentitySchema>;
export type MembershipReply = z.infer<typeof membershipReplySchema>;
export type MembershipFailure = z.infer<typeof membershipFailureSchema>;
export type MembershipResult =
  | { ok: true; value: MembershipReply }
  | { ok: false; error: MembershipFailure };
