import { z } from 'zod';

/** The execution product, not the model name or a copied account credential. */
export const providerIdSchema = z.enum(['codex', 'claude']);
export type ProviderId = z.infer<typeof providerIdSchema>;
/** Host selection meaning "omit the optional native effort override", not a CLI value. */
export const providerDefaultEffort = 'provider-default';
export const effortLabel = (effort: string) =>
  effort === providerDefaultEffort ? 'Provider default' : effort;
// Provider catalogs own the available values. Validate an identifier here, not a
// release-specific list that makes saved/native choices fail after an update.
export const effortSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
export const difficultySchema = z.enum(['unspecified', 'low', 'medium', 'high']);

export const modelTierSchema = z.enum(['uncle', 'undergrad', 'grad', 'postdoc']);
export const taskClassSchema = z.enum([
  'manager',
  'routine',
  'reasoning',
  'calculation',
  'orchestration',
  'bulk',
]);

/** Intent for a NEW worker; provider/model overrides stay explicit. */
export const executionRequestSchema = z
  .object({
    taskClass: taskClassSchema.exclude(['manager']).optional(),
    tier: modelTierSchema.optional(),
    mode: z.enum(['manual', 'automatic']).default('manual'),
    provider: providerIdSchema.optional(),
    model: z.string().trim().min(1).max(100).nullable().optional(),
    effort: effortSchema.optional(),
    difficulty: difficultySchema.default('unspecified'),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export const assignmentSchema = z
  .object({
    provider: providerIdSchema,
    model: z.string().nullable(),
    effort: effortSchema,
    difficulty: difficultySchema,
    source: z.enum(['manager_selection', 'manager_inheritance', 'model_policy']),
    reason: z.string().max(1000),
    policyRevision: z.string().nullable(),
    tier: modelTierSchema.optional(),
    taskClass: taskClassSchema.optional(),
  })
  .strict();
export type Assignment = z.infer<typeof assignmentSchema>;

export const providerCatalogSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: providerIdSchema,
          label: z.string(),
          enabled: z.boolean(),
          message: z.string(),
          capabilities: z.array(
            z.enum(['managed_chat', 'native_terminal', 'coordination_tools', 'reported_usage']),
          ),
        })
        .strict(),
    ),
    automaticRouting: z
      .object({ enabled: z.boolean(), policyRevision: z.string().nullable(), message: z.string() })
      .strict(),
  })
  .strict();
