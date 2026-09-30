import { providerCatalogSchema, type ProviderId } from '@dock/shared';
import { Conflict } from './store.js';

/** Adapter availability is not account authentication or a promise of model access. */
export function providerCatalog() {
  return providerCatalogSchema.parse({
    providers: [
      {
        id: 'codex',
        label: 'Codex',
        enabled: true,
        message: 'Uses this computer’s existing Codex sign-in and installed model catalog.',
        capabilities: ['managed_chat', 'native_terminal', 'coordination_tools', 'reported_usage'],
      },
      {
        id: 'claude',
        label: 'Claude Code',
        enabled: true,
        message:
          'Uses this computer’s signed-in Claude Code subscription. Restricted managed chat and workers; native terminal, external MCPs and plugins remain in Claude Code/VS Code.',
        capabilities: ['managed_chat', 'coordination_tools', 'reported_usage'],
      },
    ],
    automaticRouting: {
      enabled: true,
      policyRevision: null,
      message:
        'Central model policy selects task tiers and provider presets. Inspect host policy or Model settings for current choices; QUARK controls admission, without silent fallbacks.',
    },
  });
}

/** Never send an unsupported provider choice through the Codex process or test factory. */
export function requireEnabledProvider(provider: ProviderId) {
  const selected = providerCatalog().providers.find((value) => value.id === provider);
  if (!selected?.enabled)
    throw new Conflict(selected?.message ?? 'This agent provider is not supported.');
}
