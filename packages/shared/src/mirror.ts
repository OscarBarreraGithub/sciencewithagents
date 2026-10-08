import { z } from 'zod';
import { draftTextSchema, promptTextSchema, promptTextLimit } from './prompt-text.js';
import { nativeGoalActionSchema } from './native-goal.js';

export const mirrorSendSchema = z
  .object({
    key: z.uuid(),
    threadId: z.string().min(1).max(128),
    provider: z.enum(['codex', 'claude']).optional(),
    // Present only for native steering of this observed turn; never fall back to start.
    expectedTurnId: z.string().min(1).max(128).optional(),
    // Native input queue; does not steer or interrupt the current reply.
    mode: z.literal('queue').optional(),
    text: promptTextSchema,
  })
  .strict()
  .refine((input) => !(input.expectedTurnId && input.mode === 'queue'), {
    message: 'Choose either native steering or a queued follow-up.',
  });
export const mirrorControlSchema = z
  .object({
    key: z.uuid(),
    threadId: z.string().min(1).max(128),
    provider: z.enum(['codex', 'claude']).optional(),
    action: z.literal('interrupt'),
    // An observed native turn, never "whatever happens to be running later".
    token: z.string().min(1).max(128),
  })
  .strict();
export const mirrorEntrySchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'activity']),
  text: z.string(),
  textOffset: z.number().int().nonnegative().optional(),
  textLength: z.number().int().nonnegative().optional(),
  activityGroup: z.object({ count: z.number().int().positive() }).strict().optional(),
});
export const mirrorPageQuerySchema = z
  .object({
    before: z.string().min(1).max(2048).optional(),
    after: z.string().min(1).max(2048).optional(),
    entry: z.string().min(1).max(2048).optional(),
    activity: z.string().min(1).max(2048).optional(),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(32 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .refine(
    (q) =>
      Number(!!q.before) + Number(!!q.after) + Number(!!q.entry) <= 1 &&
      !(q.activity && q.entry) &&
      (q.offset === undefined || !!q.entry),
  );
export type MirrorPageQuery = z.infer<typeof mirrorPageQuerySchema>;
export const mirrorStateSchema = z.object({
  windowId: z.uuid(),
  // Omitted by editor companions; daemon sessions keep their native ownership.
  source: z.enum(['vscode', 'codex-daemon']).optional(),
  // Omitted by the original Codex-only companion; retain wire compatibility.
  provider: z.enum(['codex', 'claude']).optional(),
  label: z.string().max(200),
  threadId: z.string().max(128).nullable(),
  title: z.string().max(500),
  status: z.enum(['idle', 'busy', 'attention', 'offline']),
  message: z.string().max(1000),
  // Native history may not be readable before the first turn; never imply an empty archive.
  historyUnavailable: z.boolean().optional(),
  entries: z.array(mirrorEntrySchema).max(100_000),
  stopToken: z.string().min(1).max(128).optional(),
  // Capability omission means an older companion, or a provider without steering.
  canSteer: z.boolean().optional(),
  canQueue: z.boolean().optional(),
  // New companions support explicit native goal reads/actions; omission is unsupported.
  canManageGoal: z.boolean().optional(),
  // Remote sockets cannot read screenshot files stored on the app computer.
  // Omission preserves local behavior for older companions.
  canAttachImages: z.boolean().optional(),
  queuedMessages: z
    .array(z.object({ id: z.string().min(1).max(128), text: draftTextSchema }).strict())
    .max(100)
    .optional(),
  queueHasMore: z.boolean().optional(),
  queueReadError: z.enum(['unsupported', 'unavailable']).optional(),
  steerToken: z.string().min(1).max(128).optional(),
  paged: z.boolean().optional(),
  groupedActivity: z.boolean().optional(),
  page: z
    .object({
      total: z.number().int().nonnegative(),
      before: z.string().optional(),
      after: z.string().optional(),
      reset: z.boolean().optional(),
    })
    .optional(),
});
export const mirrorWindowSchema = mirrorStateSchema.omit({
  entries: true,
  page: true,
  queuedMessages: true,
  queueHasMore: true,
  queueReadError: true,
});
export const mirrorResultSchema = z.object({
  state: z.enum(['sent', 'not_sent', 'uncertain']),
  message: z.string().max(1000),
});
export const mirrorCommandSchema = z.discriminatedUnion('type', [
  z
    .object({ id: z.uuid(), type: z.literal('read'), page: mirrorPageQuerySchema.optional() })
    .strict(),
  z.object({ id: z.uuid(), type: z.literal('send'), input: mirrorSendSchema }).strict(),
  z.object({ id: z.uuid(), type: z.literal('control'), input: mirrorControlSchema }).strict(),
  z.object({ id: z.uuid(), type: z.literal('goal_read') }).strict(),
  z
    .object({ id: z.uuid(), type: z.literal('goal_action'), input: nativeGoalActionSchema })
    .strict(),
]);
// A bridge never raises the global 32 KiB WebSocket input limit. Large transcripts
// travel in small, bounded frames and are only assembled for an outstanding read.
export const mirrorFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), window: mirrorWindowSchema }).strict(),
  z
    .object({
      type: z.literal('chunk'),
      id: z.uuid(),
      text: z.string().max(4096),
      last: z.boolean(),
    })
    .strict(),
]);
export type MirrorState = z.infer<typeof mirrorStateSchema>;
export type MirrorSend = z.infer<typeof mirrorSendSchema>;
export type MirrorControl = z.infer<typeof mirrorControlSchema>;
export type MirrorResult = z.infer<typeof mirrorResultSchema>;
export type MirrorCommand = z.infer<typeof mirrorCommandSchema>;

/** Only explicit native method rejection establishes that queue reads are unsupported. */
export function codexQueueUnsupported(error: { code?: number; message: string }): boolean {
  return (
    error.code === -32601 ||
    /^(method not found|unknown method|thread\/queue\/list is not supported)/i.test(
      error.message,
    ) ||
    (error.code === -32600 &&
      /^Invalid request: unknown variant `thread\/queue\/list`, expected one of\b/i.test(
        error.message,
      ))
  );
}

// Validate a native queue read before advertising queue capability. Preserve order.
export function codexQueue(value: unknown): Pick<MirrorState, 'queuedMessages' | 'queueHasMore'> {
  const response = z
    .object({
      data: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            input: z.array(
              z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
            ),
          }),
        )
        .max(100),
      nextCursor: z.string().nullable(),
    })
    .parse(value);
  return {
    queuedMessages: response.data.map((item) => ({
      id: item.id,
      text:
        item.input
          .filter((input) => input.type === 'text')
          .map((input) => input.text ?? '')
          .join('\n')
          .slice(0, promptTextLimit) || '[Native attachment]',
    })),
    queueHasMore: !!response.nextCursor,
  };
}
