import { z } from 'zod';
import { groupDocumentCaptureStateSchema } from './group-documents.js';
import { agentSchema, detailSchema } from './index.js';
import {
  groupContextSchema,
  groupDisplayNameSchema,
  groupIdSchema,
  groupMemberSchema,
  groupFeedQuerySchema,
  groupEventIdSchema,
  groupUtf8Bytes,
  groupSourceSchema,
} from './groups.js';

export const groupHostSelectSchema = z.strictObject({ handle: z.uuid() });
export const groupHostLocalStateSchema = z.strictObject({
  hidden: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
  mode: z.enum(['read-only', 'contribute']).default('contribute'),
  modeRevision: z.number().int().nonnegative().safe().default(0),
});
export const groupHostLocalVisibilitySchema = groupHostSelectSchema.extend({
  key: z.uuid(),
  revision: z.number().int().nonnegative().safe(),
  hidden: z.boolean(),
});
export const groupHostLocalModeSchema = groupHostSelectSchema.extend({
  key: z.uuid(),
  revision: z.number().int().nonnegative().safe(),
  mode: z.enum(['read-only', 'contribute']),
});
const text = z
  .string()
  .max(16384)
  .refine(
    (v) =>
      groupUtf8Bytes(v) <= 16384 &&
      !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(v),
  );
export const groupHostCreateSchema = z.strictObject({
  key: z.uuid(),
  projectName: groupDisplayNameSchema,
  displayName: groupDisplayNameSchema,
  setupCode: z.string().min(1).max(4096).optional(),
});
export const groupHostJoinSchema = z.strictObject({
  key: z.uuid(),
  invitation: z.string().min(1).max(4096),
  displayName: groupDisplayNameSchema,
});
export const groupHostSummarySchema = z.strictObject({
  id: groupIdSchema,
  handle: z.uuid(),
  name: groupDisplayNameSchema,
  members: z.number().int().nonnegative().max(64),
  sync: z.string().max(200),
  state: z.enum(['pending', 'active', 'revoked', 'setup']),
  local: groupHostLocalStateSchema.optional(),
});
export const groupHostSlotSchema = z.strictObject({
  handle: z.uuid(),
  context: groupContextSchema,
  agent: agentSchema,
});
export const groupHostNativeStatusSchema = z.strictObject({
  executionMode: z.enum(['host', 'isolated']).optional(),
  available: z.boolean(),
  productionReady: z.boolean().default(false),
  authState: z
    .enum(['unavailable', 'signed-out', 'per-context', 'ready', 'inherited'])
    .default('unavailable'),
  message: z.string().max(1000),
});
export const groupHostOpenSchema = z.strictObject({
  group: groupHostSummarySchema,
  member: groupMemberSchema,
  members: z.array(groupMemberSchema).max(64),
  shared: groupHostSlotSchema,
  private: groupHostSlotSchema,
  native: groupHostNativeStatusSchema,
  feedWriter: z
    .strictObject({ canSelect: z.boolean(), enabled: z.boolean(), message: z.string().max(240) })
    .optional(),
});
export const groupHostListSchema = z.strictObject({
  groups: z.array(groupHostSummarySchema).max(32),
  removed: z.array(groupHostSummarySchema).max(32).optional(),
  service: z.strictObject({
    configured: z.boolean(),
    message: z.string().max(1000),
    setupCodeRequired: z.boolean().optional(),
    localReceiptStorage: z
      .strictObject({
        bytes: z.number().int().nonnegative().safe(),
        limitBytes: z.number().int().positive().safe(),
        full: z.boolean(),
      })
      .optional(),
  }),
  native: groupHostNativeStatusSchema,
});
export const groupHostSendSchema = groupHostSelectSchema.extend({
  key: z.uuid(),
  text: text.refine((v) => v.trim().length > 0),
});
export const groupHostAgentRequestSchema = groupHostSendSchema.extend({
  intent: z.enum(['ask', 'work']).default('ask'),
});
export const groupHostDraftSchema = groupHostSelectSchema.extend({
  key: z.uuid(),
  revision: z.number().int().nonnegative().safe(),
  text,
});
export const groupHostDraftStateSchema = z.strictObject({
  text,
  revision: z.number().int().nonnegative().safe(),
});
export const groupHostNativeReceiptSchema = z.strictObject({
  key: z.uuid(),
  text,
  intent: z.enum(['ask', 'work']).default('ask'),
  requestId: z.uuid(),
  resultId: z.uuid().nullable(),
  documentAvailable: z.boolean().optional(),
  documentCaptureState: groupDocumentCaptureStateSchema.optional(),
  state: z.enum(['queued', 'pending-consent', 'running', 'completed', 'unknown', 'blocked']),
  message: z.string().max(1000),
  delivery: z.string().max(100),
  source: groupSourceSchema.optional(),
});
export const groupHostChatSchema = z.strictObject({
  detail: detailSchema,
  draft: groupHostDraftStateSchema,
  deliveries: z
    .array(z.strictObject({ key: z.uuid(), runId: z.uuid(), state: z.string().max(100) }))
    .max(200)
    .optional(),
  nativeRequests: z.array(groupHostNativeReceiptSchema).max(64).optional(),
});
export const groupHostReceiptSchema = z.strictObject({
  key: z.uuid(),
  runId: z.uuid(),
  status: z.literal('accepted'),
  delivery: z.string().max(200),
});
export const groupHostFeedSchema = groupHostSelectSchema.extend({
  query: groupFeedQuerySchema.refine((v) => v.visibility === 'shared' && v.limit <= 20),
});
export const groupHostOriginalSchema = groupHostSelectSchema.extend({
  eventId: groupEventIdSchema,
});
export const groupHostOriginalResultSchema = z.strictObject({
  eventId: groupEventIdSchema,
  text: z.string().max(1048576),
});
export const groupHostCatchUpSchema = z.strictObject({ text: z.string().max(20000) });
export const groupHostApprovalSchema = groupHostSelectSchema.extend({
  key: z.uuid(),
  requestId: z.uuid(),
});
export const groupHostPendingSchema = z.strictObject({
  requests: z
    .array(z.strictObject({ requestId: z.uuid(), displayName: groupDisplayNameSchema }))
    .max(32),
});
export type GroupHostOpen = z.infer<typeof groupHostOpenSchema>;
export type GroupHostSlot = z.infer<typeof groupHostSlotSchema>;
export type GroupHostSummary = z.infer<typeof groupHostSummarySchema>;
export type GroupHostChat = z.infer<typeof groupHostChatSchema>;
export const groupHostErrorSchema = z.object({ error: z.string() });
export const groupHostJoinResultSchema = z.strictObject({
  group: groupHostSummarySchema,
  confirmation: z.string().regex(/^[a-f0-9]{64}$/),
});
export const groupHostInviteResultSchema = z.strictObject({
  fragment: z.string().max(4096),
  expiresAt: z.number().int().safe(),
});

export const groupHostResumeResultSchema = z.strictObject({
  group: groupHostSummarySchema,
  confirmation: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
