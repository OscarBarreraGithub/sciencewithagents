import { z } from 'zod';
import { effortSchema, providerIdSchema } from './providers.js';

export const providerMixSchema = z.enum([
  'codex-only',
  'codex-heavy',
  'balanced',
  'claude-heavy',
  'claude-only',
]);
export const spendingLevelSchema = z.enum(['light', 'default', 'tokenmax']);
export const workerPurposeSchema = z.enum(['research', 'review', 'bulk']);
export const workerChoiceSchema = z
  .object({
    provider: providerIdSchema,
    family: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(100).nullable().default(null),
    effort: effortSchema.nullable().default(null),
  })
  .strict();
export const workerPreferencesSchema = z
  .object({
    providerMix: providerMixSchema,
    spending: spendingLevelSchema,
    overrides: z
      .object({
        research: workerChoiceSchema.optional(),
        review: workerChoiceSchema.optional(),
        bulk: workerChoiceSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
const projectWorkflowFieldsSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    providerMix: providerMixSchema.default('codex-only'),
    spending: spendingLevelSchema.default('default'),
    applyChanges: z.enum(['manager', 'human']).default('manager'),
    reviewLimit: z.enum(['manager-decides', 'ask-human']).default('manager-decides'),
    reviewPlan: z.boolean().default(true),
    ambiguity: z.enum(['continue', 'ask-human']).default('continue'),
    overrides: z
      .object({
        research: workerChoiceSchema.optional(),
        review: workerChoiceSchema.optional(),
        bulk: workerChoiceSchema.optional(),
      })
      .strict()
      .default({}),
    // Snapshot the user's mappings when a project is created. Absence preserves legacy projects.
    familyDefaults: z.record(z.string().min(1).max(60), workerChoiceSchema).optional(),
    managerDefaults: z
      .object({ codex: workerChoiceSchema, claude: workerChoiceSchema })
      .strict()
      .optional(),
  })
  .strict();
export const projectWorkflowSchema = projectWorkflowFieldsSchema.transform((workflow) => {
  // One decision policy. Keep the legacy wire fields aligned for saved projects and
  // older clients; an existing request for human input must never be weakened.
  return workflow.reviewLimit === 'ask-human' || workflow.ambiguity === 'ask-human'
    ? { ...workflow, reviewLimit: 'ask-human' as const, ambiguity: 'ask-human' as const }
    : workflow;
});
export type ProjectWorkflow = z.infer<typeof projectWorkflowSchema>;
export function withProjectDecisionPolicy(
  workflow: ProjectWorkflow,
  policy: ProjectWorkflow['reviewLimit'],
): ProjectWorkflow {
  return {
    ...workflow,
    reviewLimit: policy,
    ambiguity: policy === 'ask-human' ? 'ask-human' : 'continue',
  };
}
export const projectEditorOpenSchema = z.object({ key: z.string().uuid() }).strict();
export const projectWorkflowSaveSchema = z
  .object({
    key: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    // Keep exact legacy request receipts stable; normalize when reading/saving the workflow.
    workflow: projectWorkflowFieldsSchema,
  })
  .strict();
export const managerApplySchema = z
  .object({
    taskId: z.string().uuid(),
    action: z.enum(['preview', 'apply', 'reconcile']).default('preview'),
    source: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    target: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  })
  .strict();

// Family names are configuration; exact versions come only from live native catalogs.
export const workerDefaults = {
  light: {
    'codex-only': ['terra', 'sol', 'luna'],
    'codex-heavy': ['terra', 'opus', 'luna'],
    balanced: ['terra', 'opus', 'luna'],
    'claude-heavy': ['opus', 'sol', 'sonnet'],
    'claude-only': ['opus', 'opus', 'sonnet'],
  },
  default: {
    'codex-only': ['sol', 'astra', 'luna'],
    'codex-heavy': ['sol', 'opus', 'luna'],
    balanced: ['sol', 'opus', 'sonnet'],
    'claude-heavy': ['opus', 'sol', 'sonnet'],
    'claude-only': ['opus', 'fable', 'sonnet'],
  },
  tokenmax: {
    'codex-only': ['astra', 'astra', 'terra'],
    'codex-heavy': ['astra', 'fable', 'terra'],
    balanced: ['astra', 'fable', 'sonnet'],
    'claude-heavy': ['fable', 'astra', 'sonnet'],
    'claude-only': ['fable', 'fable', 'sonnet'],
  },
} as const;
export const modelFamilies: Record<
  string,
  { provider: 'codex' | 'claude'; tier: 'uncle' | 'undergrad' | 'grad' | 'postdoc' }
> = {
  luna: { provider: 'codex', tier: 'uncle' },
  terra: { provider: 'codex', tier: 'undergrad' },
  sol: { provider: 'codex', tier: 'grad' },
  astra: { provider: 'codex', tier: 'postdoc' },
  sonnet: { provider: 'claude', tier: 'undergrad' },
  opus: { provider: 'claude', tier: 'grad' },
  fable: { provider: 'claude', tier: 'postdoc' },
};
export function projectFamilyDefault(
  workflow: ProjectWorkflow,
  provider: 'codex' | 'claude',
  tier: 'uncle' | 'undergrad' | 'grad' | 'postdoc',
) {
  const family = Object.keys(modelFamilies).find(
    (key) => modelFamilies[key]!.provider === provider && modelFamilies[key]!.tier === tier,
  );
  return family ? workflow.familyDefaults?.[family] : undefined;
}
export function projectManagerDefault(workflow: ProjectWorkflow, provider: 'codex' | 'claude') {
  return (
    workflow.managerDefaults?.[provider] ?? projectFamilyDefault(workflow, provider, 'postdoc')
  );
}
export function workerDefault(
  workflow: ProjectWorkflow,
  purpose: z.infer<typeof workerPurposeSchema>,
) {
  const saved = workflow.overrides[purpose];
  if (saved) return saved;
  const family =
    workerDefaults[workflow.spending][workflow.providerMix][
      ['research', 'review', 'bulk'].indexOf(purpose)
    ]!;
  if (workflow.familyDefaults?.[family]) return workflow.familyDefaults[family];
  return { provider: modelFamilies[family]!.provider, family, model: null, effort: null };
}
