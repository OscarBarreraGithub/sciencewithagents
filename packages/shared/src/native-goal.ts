import { z } from 'zod';

const threadId = z.string().min(1).max(128);
const token = z.string().regex(/^[a-f0-9]{64}$/);
/** The native Codex goal, including its own measured progress and limits. */
export const nativeGoalSchema = z.object({
  threadId,
  objective: z.string().max(32000),
  status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  tokenBudget: z.number().int().nonnegative().nullable().default(null),
});
export const nativeGoalViewSchema = z.object({
  threadId: threadId.nullable(),
  supported: z.boolean(),
  goal: nativeGoalSchema.nullable(),
  token: token.nullable(),
  message: z.string().max(1000),
});
const action = { key: z.uuid(), threadId, provider: z.enum(['codex', 'claude']).optional() };
export const nativeGoalActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...action,
      action: z.literal('create'),
      objective: z.string().trim().min(1).max(32000),
      expectedToken: z.null(),
    })
    .strict(),
  z.object({ ...action, action: z.literal('pause'), expectedToken: token }).strict(),
  z.object({ ...action, action: z.literal('resume'), expectedToken: token }).strict(),
  z.object({ ...action, action: z.literal('clear'), expectedToken: token }).strict(),
]);
export type NativeGoal = z.infer<typeof nativeGoalSchema>;
export type NativeGoalView = z.infer<typeof nativeGoalViewSchema>;
export type NativeGoalAction = z.infer<typeof nativeGoalActionSchema>;

/** Progress changes do not invalidate a displayed lifecycle action. */
export function nativeGoalVersion(goal: NativeGoal): string {
  return JSON.stringify([
    goal.threadId,
    goal.objective,
    goal.createdAt,
    goal.status,
    goal.tokenBudget,
  ]);
}
export function nativeGoalActionProblem(
  input: NativeGoalAction,
  current: NativeGoalView,
): string | null {
  if (
    (input.provider ?? 'codex') !== 'codex' ||
    !current.supported ||
    current.threadId !== input.threadId
  )
    return 'Native goals are unavailable for this conversation. Nothing was changed.';
  if (input.expectedToken !== current.token)
    return 'The native goal changed. Refresh its status before choosing an action.';
  if (input.action === 'create')
    return current.goal
      ? 'This conversation already has a native goal. Nothing was replaced.'
      : null;
  if (!current.goal) return 'This conversation no longer has that goal. Nothing was changed.';
  if (input.action === 'clear' && current.goal.status === 'active')
    return 'Pause the active goal before clearing it. Nothing was changed.';
  if (input.action === 'pause' && current.goal.status !== 'active')
    return 'That goal is no longer active. Nothing was changed.';
  if (
    input.action === 'resume' &&
    !['paused', 'blocked', 'usageLimited'].includes(current.goal.status)
  )
    return 'This native goal cannot be resumed in its current state. Its budget was not changed.';
  return null;
}
/** Omitted native settings preserve the existing model, permissions and goal budget. */
export function nativeGoalParams(input: NativeGoalAction) {
  return {
    threadId: input.threadId,
    ...(input.action === 'create' ? { objective: input.objective } : {}),
    status: input.action === 'pause' ? ('paused' as const) : ('active' as const),
  };
}
