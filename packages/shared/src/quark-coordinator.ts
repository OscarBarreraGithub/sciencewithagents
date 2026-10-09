import { z } from 'zod';
import { providerIdSchema, effortSchema } from './providers.js';
import { pulsarStatusSchema } from './pulsar.js';
import { quarkStatusSchema, windowPacingSchema } from './quark.js';
import { localJobSchema } from './local-jobs.js';
import { providerCapacitySchema } from './capacity.js';

export const quarkDefaultFamilies = { claude: 'opus', codex: 'sol' } as const;
// One centrally owned default. Resolve the latest native Opus catalog entry, not a guessed ID.
export const quarkModelChoiceSchema = z
  .object({
    provider: providerIdSchema.default('claude'),
    family: z.string().trim().min(1).max(60).default(quarkDefaultFamilies.claude),
    model: z.string().trim().min(1).max(100).nullable().default(null),
    effort: effortSchema.nullable().default(null),
  })
  .strict();
export const quarkCoordinatorSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    automatic: z.boolean().default(false),
    model: quarkModelChoiceSchema.default(() => quarkModelChoiceSchema.parse({})),
  })
  .strict();
export const quarkCoordinatorSaveSchema = z
  .object({
    key: z.string().uuid(),
    settings: quarkCoordinatorSettingsSchema,
  })
  .strict();
export const quarkCoordinatorInspectSchema = z
  .object({
    view: z
      .enum([
        'overview',
        'projects',
        'jobs',
        'budgets',
        'decisions',
        'timing',
        'cluster',
        'conversation',
      ])
      .default('overview'),
    projectId: z.uuid().optional(),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(20).default(10),
    entryId: z.string().min(1).max(400).optional(),
    textOffset: z.number().int().min(0).max(1_000_000).default(0),
    textLimit: z.number().int().min(1).max(8000).default(4000),
  })
  .strict()
  .refine(
    (value) =>
      (!value.entryId || value.view === 'conversation') &&
      (value.view !== 'conversation' || !value.projectId),
    {
      message: 'Conversation reads use this coordinator’s own entryId, without projectId.',
    },
  );
export const quarkProjectPrioritySchema = z.enum(['high', 'normal', 'background']).nullable();
export const quarkProjectPolicySchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    priority: quarkProjectPrioritySchema.default(null),
    weight: z.number().int().min(1).max(10).default(1),
    paused: z.boolean().default(false),
    instruction: z.string().trim().max(2000).default(''),
  })
  .strict();
export const quarkProjectPriorityRequestSchema = z
  .object({
    key: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    priority: quarkProjectPrioritySchema,
  })
  .strict();
const projectControl = z
  .object({
    action: z.literal('project'),
    projectId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    priority: quarkProjectPrioritySchema.optional(),
    weight: z.number().int().min(1).max(10).optional(),
    paused: z.boolean().optional(),
    instruction: z.string().trim().max(2000).optional(),
    reason: z.string().trim().min(1).max(1500),
  })
  .strict();
export const quarkControlSchema = z.discriminatedUnion('action', [
  projectControl,
  z
    .object({
      action: z.literal('budget'),
      projectId: z.string().uuid(),
      provider: providerIdSchema,
      windowId: z.string().min(1).max(160),
      period: z.enum(['window', 'hour']).default('window'),
      enabled: z.boolean().default(true),
      limitPercent: z.number().min(0).max(100),
      expectedRevision: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(1500),
    })
    .strict()
    .refine(
      (value) => value.period === 'hour' || value.limitPercent > 0,
      'Only hourly rates can be zero.',
    ),
  z
    .object({
      action: z.literal('reserve'),
      reservePercent: z.number().min(0).max(100),
      provider: providerIdSchema.optional(),
      releaseEnabled: z.boolean().optional(),
      releaseBeforeResetMinutes: z.number().int().min(1).max(10080).optional(),
      reason: z.string().trim().min(1).max(1500),
    })
    .strict(),
  z
    .object({
      action: z.literal('notify'),
      projectId: z.string().uuid(),
      reason: z.string().trim().min(1).max(1500),
    })
    .strict(),
]);
export const quarkCoordinatorStatusSchema = z.object({
  modelLabel: z.string().nullable().default(null),
  agentId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  settings: quarkCoordinatorSettingsSchema,
  projects: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      managerId: z.string().uuid(),
      policy: quarkProjectPolicySchema,
    }),
  ),
  queue: pulsarStatusSchema,
  accounting: quarkStatusSchema,
  capacity: z.array(providerCapacitySchema),
  utilization: z.array(windowPacingSchema).default([]),
  localJobs: z.array(localJobSchema).default([]),
  decisions: z.array(
    z.object({
      key: z.string(),
      at: z.string(),
      source: z.enum(['owner', 'automatic']),
      instruction: z.string(),
      action: quarkControlSchema,
    }),
  ),
  notice: z.string(),
});
export type QuarkCoordinatorStatus = z.infer<typeof quarkCoordinatorStatusSchema>;
