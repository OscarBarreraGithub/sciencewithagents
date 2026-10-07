import { z } from 'zod';
import { agentSchema, detailSchema } from './index.js';
import {
  groupContextSchema,
  groupDisplayNameSchema,
  groupIdSchema,
  groupMemberSchema,
  groupFeedQuerySchema,
  groupEventIdSchema,
  groupUtf8Bytes,
} from './groups.js';

// Local test workflow only. Handles select host-owned records; labels supply no authority.
export const groupFixtureHandleSchema = z.uuid();
export const groupFixtureSelectSchema = z.strictObject({ handle: groupFixtureHandleSchema });
const text = z
  .string()
  .max(16_384)
  .refine(
    (v) =>
      groupUtf8Bytes(v) <= 16_384 &&
      !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(v),
  );
export const groupFixtureCreateSchema = z.strictObject({
  key: z.uuid(),
  projectName: z.string().trim().min(1).max(120),
  displayName: groupDisplayNameSchema,
});
export const groupFixtureSummarySchema = z.strictObject({
  id: groupIdSchema,
  handle: groupFixtureHandleSchema,
  name: z.string().min(1).max(120),
  members: z.literal(1),
  sync: z.literal('Local test host · fake replies'),
});
export const groupFixtureSlotSchema = z.strictObject({
  handle: groupFixtureHandleSchema,
  context: groupContextSchema,
  agent: agentSchema,
});
export const groupFixtureOpenSchema = z.strictObject({
  group: groupFixtureSummarySchema,
  member: groupMemberSchema,
  shared: groupFixtureSlotSchema,
  private: groupFixtureSlotSchema,
});
export const groupFixtureSendSchema = groupFixtureSelectSchema.extend({
  key: z.uuid(),
  text: text.refine((v) => v.trim().length > 0),
});
export const groupFixtureDraftSchema = groupFixtureSelectSchema.extend({
  key: z.uuid(),
  revision: z.number().int().nonnegative().safe(),
  text,
});
export const groupFixtureDraftStateSchema = z.strictObject({
  text,
  revision: z.number().int().nonnegative().safe(),
});
export const groupFixtureChatSchema = z.strictObject({
  detail: detailSchema,
  draft: groupFixtureDraftStateSchema,
});
export const groupFixtureReceiptSchema = z.strictObject({
  key: z.uuid(),
  runId: z.uuid(),
  status: z.literal('accepted'),
});
export const groupFixtureFeedSchema = groupFixtureSelectSchema.extend({
  query: groupFeedQuerySchema.refine((v) => v.visibility === 'shared' && v.limit <= 20),
});
export const groupFixtureOriginalSchema = groupFixtureSelectSchema.extend({
  eventId: groupEventIdSchema,
});
export type GroupFixtureOpen = z.infer<typeof groupFixtureOpenSchema>;
export type GroupFixtureSlot = z.infer<typeof groupFixtureSlotSchema>;
export type GroupFixtureSummary = z.infer<typeof groupFixtureSummarySchema>;

export const groupFixtureListSchema = z.strictObject({
  groups: z.array(groupFixtureSummarySchema).max(32),
});
export const groupFixtureErrorSchema = z.object({ error: z.string() });
export const groupFixtureOriginalResultSchema = z.strictObject({
  eventId: groupEventIdSchema,
  text,
});
export const groupFixtureCatchUpSchema = z.strictObject({ text: z.string().max(20_000) });
export type GroupFixtureChat = z.infer<typeof groupFixtureChatSchema>;
