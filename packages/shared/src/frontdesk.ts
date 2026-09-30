import { z } from 'zod';
import { providerIdSchema } from './providers.js';
import { catalogQuerySchema, historyQuerySchema, historyReadSchema } from './history.js';

const identity = z.string().uuid();
const visibleProjects = z
  .array(identity)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Choose each project once.');
export const frontdeskSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    visibleProjectIds: visibleProjects,
    preferences: z.string().trim().max(4000),
    priorities: z.string().trim().max(4000),
    commitments: z.string().trim().max(4000),
  })
  .strict();
export const frontdeskSaveSchema = frontdeskSettingsSchema
  .omit({ revision: true })
  .extend({
    key: identity,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const frontdeskStartSchema = z
  .object({ key: identity, provider: providerIdSchema.optional() })
  .strict();
export const frontdeskStatusSchema = z
  .object({
    agentId: identity.nullable(),
    projectId: identity.nullable(),
    settings: frontdeskSettingsSchema,
    notice: z.string(),
  })
  .strict();
export const frontdeskInspectSchema = z
  .object({
    projectId: identity.optional(),
    agentId: identity.optional(),
    taskId: identity.optional(),
    history: historyQuerySchema.optional(),
    read: historyReadSchema.optional(),
    catalog: catalogQuerySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const targets = [value.agentId, value.taskId, value.history, value.read, value.catalog].filter(
      (item) => item !== undefined,
    );
    if (targets.length > 1)
      ctx.addIssue({ code: 'custom', message: 'Inspect one source at a time.' });
    if (targets.length && !value.projectId)
      ctx.addIssue({ code: 'custom', message: 'Choose the source project.' });
  });
export const frontdeskRouteSchema = z
  .object({ managerId: identity, message: z.string().trim().min(1).max(24_000) })
  .strict();
export const frontdeskDeliverySchema = z
  .object({
    id: identity,
    agentId: identity,
    sourceRunId: identity,
    projectId: identity,
    managerId: identity,
    managerRunId: identity,
    reportRunId: identity.nullable(),
    state: z.enum(['waiting', 'reported', 'withheld']),
    outcome: z.enum(['completed', 'failed', 'interrupted', 'cancelled']).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type FrontdeskSettings = z.infer<typeof frontdeskSettingsSchema>;
export type FrontdeskStatus = z.infer<typeof frontdeskStatusSchema>;
export type FrontdeskSave = z.infer<typeof frontdeskSaveSchema>;
export type FrontdeskDelivery = z.infer<typeof frontdeskDeliverySchema>;
