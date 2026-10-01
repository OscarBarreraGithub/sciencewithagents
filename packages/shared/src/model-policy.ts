import { z } from 'zod';
import { effortSchema, providerIdSchema, modelTierSchema, taskClassSchema } from './providers.js';

export const tierLabels = {
  uncle: 'Uncle',
  undergrad: 'Undergrad',
  grad: 'Grad student',
  postdoc: 'Postdoc',
} as const;
export const taskTiers = {
  manager: 'postdoc',
  routine: 'undergrad',
  reasoning: 'grad',
  calculation: 'grad',
  orchestration: 'grad',
  bulk: 'uncle',
} as const;
export const taskLabels = {
  manager: 'Managers & personal agent',
  routine: 'Routine checks & monitoring',
  reasoning: 'Research, implementation & review',
  calculation: 'Calculations & difficult questions',
  orchestration: 'Delegated orchestration',
  bulk: 'Simple bulk text & image work',
} as const;
/** Concrete default shared by the launch policy and setup controls. Catalogs own support. */
export function policyDefaultEffort(efforts: readonly string[], tier: keyof typeof tierLabels) {
  const preferred =
    tier === 'postdoc'
      ? ['xhigh', 'max', 'high', 'medium']
      : [tier === 'uncle' || tier === 'undergrad' ? 'low' : 'high', 'medium'];
  return (
    preferred.find((effort) => efforts.includes(effort)) ??
    efforts.find((effort) => effortSchema.safeParse(effort).success)
  );
}

export function workerDefaultEffort(efforts: readonly string[], tier: keyof typeof tierLabels) {
  const preferred = tier === 'uncle' || tier === 'undergrad' ? 'medium' : 'high';
  return efforts.includes(preferred) ? preferred : efforts[0];
}

const choice = z
  .object({
    family: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/),
    model: z.string().trim().min(1).max(100).nullable(),
    effort: effortSchema.nullable(),
    requiresModelAllowance: z.boolean().default(false),
  })
  .strict();
const tiers = z
  .object({ uncle: choice, undergrad: choice, grad: choice, postdoc: choice })
  .strict();
export const modelPolicySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    preset: z.enum(['codex-heavy', 'claude-heavy', 'pick']),
    // Older saved policies used both providers. Absence must preserve that behavior.
    enabledProviders: z
      .array(providerIdSchema)
      .min(1)
      .max(2)
      .refine(
        (providers) => new Set(providers).size === providers.length,
        'Choose each provider once.',
      )
      .default(['codex', 'claude']),
    models: z.object({ codex: tiers, claude: tiers }).strict(),
    providers: z
      .object({
        manager: z.enum(['preset', 'codex', 'claude']),
        routine: z.enum(['preset', 'codex', 'claude']),
        reasoning: z.enum(['preset', 'codex', 'claude']),
        calculation: z.enum(['preset', 'codex', 'claude']),
        orchestration: z.enum(['preset', 'codex', 'claude']),
        bulk: z.enum(['preset', 'codex', 'claude']),
      })
      .strict(),
    // Unattended work needs an explicit choice even under Pick as I go.
    scheduledProvider: providerIdSchema,
    escalation: z.boolean(),
  })
  .strict();
export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
export type TaskClass = z.infer<typeof taskClassSchema>;
export const defaultModelPolicy: ModelPolicy = {
  revision: 0,
  preset: 'codex-heavy',
  enabledProviders: ['codex', 'claude'],
  models: {
    codex: {
      uncle: { family: 'luna', model: null, effort: null, requiresModelAllowance: false },
      undergrad: { family: 'terra', model: null, effort: null, requiresModelAllowance: false },
      grad: { family: 'sol', model: null, effort: null, requiresModelAllowance: false },
      postdoc: { family: 'astra', model: null, effort: null, requiresModelAllowance: false },
    },
    claude: {
      uncle: { family: 'sonnet', model: null, effort: null, requiresModelAllowance: false },
      undergrad: { family: 'sonnet', model: null, effort: null, requiresModelAllowance: false },
      grad: { family: 'opus', model: null, effort: null, requiresModelAllowance: false },
      postdoc: { family: 'fable', model: null, effort: null, requiresModelAllowance: true },
    },
  },
  providers: {
    manager: 'preset',
    routine: 'preset',
    reasoning: 'preset',
    calculation: 'preset',
    orchestration: 'preset',
    bulk: 'preset',
  },
  scheduledProvider: 'claude',
  escalation: true,
};
export const modelPolicySaveSchema = z
  .object({
    key: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    policy: modelPolicySchema,
  })
  .strict();
export const escalationSchema = z
  .object({
    question: z.string().trim().min(10).max(2000),
    evidence: z.string().trim().min(1).max(6000),
  })
  .strict();
export const policyCatalogSchema = z.object({
  provider: providerIdSchema,
  observedAt: z.string().nullable(),
  error: z.string().nullable(),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      isDefault: z.boolean(),
      efforts: z.array(z.string()),
    }),
  ),
});
export const modelPolicyStatusSchema = z.object({
  policy: modelPolicySchema,
  catalogs: z.array(policyCatalogSchema),
});
export type ModelPolicyStatus = z.infer<typeof modelPolicyStatusSchema>;

export function policyProvider(
  policy: ModelPolicy,
  task: TaskClass,
  explicit?: 'codex' | 'claude',
  scheduled = false,
) {
  if (explicit) return explicit;
  const choice = policy.providers[task];
  if (choice !== 'preset') return policy.enabledProviders.includes(choice) ? choice : undefined;
  if (policy.preset === 'pick')
    return scheduled && policy.enabledProviders.includes(policy.scheduledProvider)
      ? policy.scheduledProvider
      : undefined;
  if (policy.enabledProviders.length === 1) return policy.enabledProviders[0];
  const heavy = policy.preset === 'codex-heavy' ? 'codex' : 'claude';
  // Presets route research/coding and inexpensive bulk work to the preferred provider.
  // Routine monitoring remains the small complementary-provider assignment.
  return task === 'routine' ? (heavy === 'codex' ? 'claude' : 'codex') : heavy;
}

type CatalogModel = { id: string; label: string; isDefault: boolean };
/** Family words, not versioned IDs, are the only shipping defaults. No guessed aliases. */
function familyMatches(model: CatalogModel, family: string) {
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const wanted = tokens(family);
  return [model.id, model.label].some((s) => {
    const parts = tokens(s);
    return parts.some((_, i) => wanted.every((token, j) => parts[i + j] === token));
  });
}
function version(model: CatalogModel): number[] {
  // Ignore context-size/variant labels: [1m] is not a newer generation.
  const clean = (text: string) => text.replace(/\([^)]*\)|\[[^\]]*\]/g, '');
  const label = clean(model.label),
    id = clean(model.id);
  const text = /\d/.test(label) ? label : id;
  const version = text.match(/\d+(?:[.-]\d+)*/)?.[0];
  return (version?.split(/[.-]/).map(Number) ?? []).filter((n) => n < 1000);
}
export function latestFamily<T extends CatalogModel>(catalog: T[], family: string) {
  return catalog
    .filter((m) => familyMatches(m, family))
    .sort((a, b) => {
      const av = version(a),
        bv = version(b);
      const rolling = (model: CatalogModel, v: number[]) =>
        !v.length && model.id.toLowerCase().replace(/\[[^\]]*\]/g, '') === family.toLowerCase();
      const alias = Number(rolling(b, bv)) - Number(rolling(a, av));
      if (alias) return alias;
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const difference = (bv[i] ?? 0) - (av[i] ?? 0);
        if (difference) return difference;
      }
      return (
        Number(b.id === family) - Number(a.id === family) ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.id.length - b.id.length ||
        a.id.localeCompare(b.id)
      );
    })[0];
}
