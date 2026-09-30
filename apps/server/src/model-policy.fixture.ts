/** Explicit fake-catalog setup for maintained tests. Never called by the production runtime. */
import { defaultModelPolicy } from '@dock/shared';
import type { Store } from './store.js';
export function modelFixture(store: Store, codex = 'demo', claude = 'default') {
  if (store.getSetting('model-policy')) return;
  const policy = structuredClone(defaultModelPolicy);
  for (const task of Object.keys(policy.providers) as (keyof typeof policy.providers)[])
    policy.providers[task] = 'codex';
  for (const tier of Object.keys(policy.models.codex) as (keyof typeof policy.models.codex)[]) {
    policy.models.codex[tier].model = codex;
    policy.models.claude[tier].model = claude;
  }
  store.setSetting('model-policy', policy);
}
