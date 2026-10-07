import { z } from 'zod';
import { groupContextSchema, groupSourceSchema, groupUtf8Bytes, GROUP_LIMITS } from '@dock/shared';
import { groupHostSendSchema, groupHostNativeStatusSchema } from '@dock/shared/dist/group-host.js';
import type { GroupEventRepository } from './group-events.js';
import type { GroupNativeOwnerPort } from './group-native-owner.js';

export const groupNativeRequestSchema = groupHostSendSchema.omit({ handle: true }).extend({
  requestId: z.uuid(),
  context: groupContextSchema.refine((v) => v.provider === 'owner'),
  enrollmentHandle: z.uuid(),
  intent: z.enum(['ask', 'work']).default('ask'),
});
export const groupNativeResultSchema = z.strictObject({
  context: groupContextSchema.refine((v) => v.provider !== 'owner'),
  text: z
    .string()
    .min(1)
    .max(GROUP_LIMITS.payloadBytes)
    .refine(
      (v) =>
        groupUtf8Bytes(v) <= GROUP_LIMITS.payloadBytes &&
        !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(v),
    ),
  nativeToolItems: z.number().int().nonnegative().max(1000000),
  source: groupSourceSchema.optional(),
});
export const groupNativeStateSchema = z.enum([
  'queued',
  'pending-consent',
  'running',
  'completed',
  'unknown',
  'blocked',
]);
export const groupNativeSnapshotSchema = z
  .strictObject({
    requestId: z.uuid(),
    state: groupNativeStateSchema,
    message: z.string().max(1000),
    result: groupNativeResultSchema.optional(),
  })
  .refine((v) => (v.state === 'completed') === Boolean(v.result));
export type GroupNativeRequest = z.infer<typeof groupNativeRequestSchema>;
export type GroupNativeSnapshot = z.infer<typeof groupNativeSnapshotSchema>;
/** Host-only seam. Native owns model policy/QUARK, protected resources, fresh
 * native contexts, result journal, tools and whole-descendant stopping.
 * Existing/uncertain requests are inspected, never resubmitted as tools.
 * Shared sources must be exact native journal aliases in this events repository. */
export interface GroupNativeConnector {
  owner?: GroupNativeOwnerPort;
  availability():
    | z.input<typeof groupHostNativeStatusSchema>
    | Promise<z.input<typeof groupHostNativeStatusSchema>>;
  submit(input: GroupNativeRequest): Promise<GroupNativeSnapshot>;
  inspect(input: { requestId: string }): Promise<GroupNativeSnapshot>;
  close?(): void | Promise<void>;
}
export type GroupNativeConnectorFactory = (host: {
  directory: string;
  events: GroupEventRepository;
}) => GroupNativeConnector;
const missing =
  'Group agents need a verified isolated native adapter connected to model policy and QUARK. Human messages and private notes remain available when the group service is configured.';
export const unavailableGroupNative: GroupNativeConnector = {
  availability: () => ({
    available: false,
    productionReady: false,
    authState: 'unavailable',
    message: missing,
  }),
  async submit(input) {
    return { requestId: input.requestId, state: 'blocked', message: missing };
  },
  async inspect(input) {
    return {
      requestId: input.requestId,
      state: 'unknown',
      message:
        'Native execution receipt unavailable. Recover this exact request through the owning native adapter; tools are not resubmitted.',
    };
  },
};
