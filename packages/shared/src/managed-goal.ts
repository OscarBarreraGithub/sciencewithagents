import { z } from 'zod';

const id = z.uuid();
const revision = z.number().int().positive();
const objective = z.string().trim().min(1).max(24000);
export const managedGoalSchema = z
  .object({
    id,
    agentId: id,
    revision,
    objective,
    status: z.enum(['active', 'paused', 'waiting', 'blocked', 'completed', 'stopped']),
    progress: z
      .object({ summary: z.string().max(8000), nextAction: z.string().max(2000).nullable() })
      .strict(),
    lastRunId: id.nullable(),
    continuationRunId: id.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const managedGoalViewSchema = z
  .object({
    supported: z.boolean(),
    goal: managedGoalSchema.nullable(),
    continuation: z
      .object({ runId: id, status: z.string(), reason: z.string().nullable() })
      .strict()
      .nullable(),
    message: z.string().max(2000),
  })
  .strict();
const action = { key: id, expectedRevision: revision };
export const managedGoalActionSchema = z.discriminatedUnion('action', [
  z
    .object({ key: id, action: z.literal('create'), expectedRevision: z.null(), objective })
    .strict(),
  z.object({ ...action, action: z.literal('replace'), objective }).strict(),
  z.object({ ...action, action: z.literal('pause') }).strict(),
  z.object({ ...action, action: z.literal('resume') }).strict(),
  z.object({ ...action, action: z.literal('stop') }).strict(),
]);
/** A checkpoint of useful work in the manager's current admitted turn; cannot enroll or replace a goal. */
export const managedGoalUpdateSchema = z
  .object({
    goalId: id,
    expectedRevision: revision,
    action: z.enum(['continue', 'wait', 'blocked', 'complete']),
    summary: z.string().trim().min(1).max(8000),
    nextAction: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((value) => value.action !== 'continue' || !!value.nextAction, {
    message: 'Useful continuation needs a saved next action.',
  });
export type ManagedGoal = z.infer<typeof managedGoalSchema>;
export type ManagedGoalView = z.infer<typeof managedGoalViewSchema>;
export type ManagedGoalAction = z.infer<typeof managedGoalActionSchema>;
export type ManagedGoalUpdate = z.infer<typeof managedGoalUpdateSchema>;
/** Saved local-client receipt, bound to the original admitted manager turn. */
export const agentManagedGoalUpdateRequestSchema = managedGoalUpdateSchema.safeExtend({
  key: id,
  managerId: id,
  runId: id,
});
