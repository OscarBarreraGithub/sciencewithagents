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
    automatic: z.boolean().default(true),
    model: quarkModelChoiceSchema.default(() => quarkModelChoiceSchema.parse({})),
  })
  .strict();
export const quarkCoordinatorSaveSchema = z
  .object({
    key: z.string().uuid(),
    settings: quarkCoordinatorSettingsSchema,
  })
  .strict();
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
      limitPercent: z.number().positive().max(100),
      expectedRevision: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(1500),
    })
    .strict(),
  z
    .object({
      action: z.literal('reserve'),
      reservePercent: z.number().min(5).max(80),
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
