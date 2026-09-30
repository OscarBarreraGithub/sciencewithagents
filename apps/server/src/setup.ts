import {
  setupStatusSchema,
  type ProviderAccountState,
  type ProviderId,
  type SetupStatus,
} from '@dock/shared';
import type { ModelPolicy } from './model-policy.js';
import { Conflict } from './store.js';

/** Explicit, metadata-only readiness. No model turns, account copying or inferred routing. */
export class Setup {
  private closed = false;
  private pending: Promise<SetupStatus> | null = null;
  private pendingProviders: ProviderId[] = [];
  private accounts = new Map<ProviderId, { state: ProviderAccountState; checkedAt: string }>();
  constructor(
    private policy: ModelPolicy,
    private account: (provider: ProviderId) => Promise<ProviderAccountState>,
    private clock = Date.now,
  ) {}
  status(): SetupStatus {
    return setupStatusSchema.parse({
      policy: this.policy.status(),
      accounts: (['codex', 'claude'] as const).map((provider) => ({
        provider,
        ...(this.accounts.get(provider) ?? { state: 'unchecked', checkedAt: null }),
      })),
      checking: this.pending !== null,
    });
  }
  async refresh(selected?: ProviderId): Promise<SetupStatus> {
    if (this.closed) throw new Conflict('Setup checks are stopping. Reconnect to try again.');
    const providers = selected ? [selected] : this.policy.policy().enabledProviders;
    if (this.pending) {
      if (providers.every((p) => this.pendingProviders.includes(p))) return this.pending;
      await this.pending;
      return this.refresh(selected);
    }
    this.pendingProviders = providers;
    const request = (async () => {
      await Promise.allSettled(
        providers.map(async (provider) => {
          let state: ProviderAccountState;
          try {
            state = await this.account(provider);
          } catch {
            state = 'unavailable';
          }
          if (this.closed) return;
          this.accounts.set(provider, { state, checkedAt: new Date(this.clock()).toISOString() });
          // A catalog alone is not proof of authentication. Don't launch discovery
          // behind a missing or unavailable account just to display a green check.
          if (state === 'signed-in' || state === 'custom')
            await this.policy.catalog(provider, true);
        }),
      );
      return { ...this.status(), checking: false };
    })();
    this.pending = request;
    try {
      return await request;
    } finally {
      if (this.pending === request) this.pending = null;
    }
  }
  async close() {
    this.closed = true;
    await this.pending;
  }
}
