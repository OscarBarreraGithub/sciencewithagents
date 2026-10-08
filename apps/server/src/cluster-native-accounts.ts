import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  providerCapacitySchema,
  remoteAccountIdentitySchema,
  type ProviderId,
  type ProviderCapacity,
  type RemoteAccountIdentity,
} from '@dock/shared';
import { ClaudePreflightError, readClaudeIdentity } from './claude-session.js';
import { nativeClaudeFetcher } from './claude-capacity.js';
import { parseCapacity } from './capacity.js';

const window = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().positive().nullish(),
  resetsAt: z.number().int().nonnegative().nullish(),
});
const bucket = z.object({ primary: window.nullish(), secondary: window.nullish() });
const codexSnapshot = z.object({
  accountId: z.string().min(1).max(300).nullable(),
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimits: bucket,
});
/** Native backend accountId, not email/plan inference. Raw identifiers never leave this function. */
export function projectNativeCodexAccount(raw: unknown, now: number) {
  const reply = codexSnapshot.parse(raw),
    stamp = new Date(now).toISOString();
  if (!reply.accountId)
    throw new Error(
      'This Codex CLI did not report a native account identity. Upgrade/setup is required before cluster dispatch.',
    );
  const affinity = createHash('sha256')
    .update(JSON.stringify(['codex', 'chatgpt-native-account', reply.accountId]))
    .digest('hex');
  const windows: ProviderCapacity['windows'] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const w = reply.rateLimits[key];
    if (w)
      windows.push({
        id: key,
        label: key === 'primary' ? 'Native primary allowance' : 'Native secondary allowance',
        scope: 'general',
        model: null,
        usedPercent: w.usedPercent,
        windowMinutes: w.windowDurationMins ?? null,
        resetsAt: w.resetsAt == null ? null : new Date(w.resetsAt * 1000).toISOString(),
      });
  }
  const blocked = reply.ordinaryUsageAllowed === false;
  return {
    account: remoteAccountIdentitySchema.parse({
      provider: 'codex',
      affinity,
      identityBasis: 'native',
      state: 'ready',
      observedAt: stamp,
      message:
        'Cluster Codex native account verified. It remains independent from this controller’s local account.',
    }),
    ordinaryUsageAllowed: reply.ordinaryUsageAllowed ?? null,
    capacity: providerCapacitySchema.parse({
      provider: 'codex',
      account: 'local-sign-in',
      label: 'Cluster Codex',
      plan: null,
      source: 'codex-native',
      observedAt: stamp,
      attemptedAt: stamp,
      nextRefreshAt: new Date(now + 60000).toISOString(),
      state: blocked || !windows.length ? 'error' : 'ready',
      stale: false,
      message: blocked
        ? 'Native Codex reports that ordinary included usage is blocked.'
        : windows.length
          ? 'Verified native cluster allowance; no account credentials are copied.'
          : 'Native Codex returned no allowance windows.',
      windows,
      weeklyPolicy: windows.some((w) => (w.windowMinutes ?? 0) >= 10080)
        ? 'reported'
        : 'not-reported',
    }),
  };
}
export type NativeClusterAccountReading = {
  account: RemoteAccountIdentity;
  capacity: ProviderCapacity | null;
  ordinaryUsageAllowed: boolean | null;
};
export class ClusterNativeAccounts {
  private readonly values = new Map<ProviderId, NativeClusterAccountReading>();
  private readonly pending = new Map<ProviderId, Promise<NativeClusterAccountReading>>();
  private readonly claudeUsage: ReturnType<typeof nativeClaudeFetcher>;
  private readonly claudeIdentity: () => ReturnType<typeof readClaudeIdentity>;
  constructor(
    private readonly codexRead: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
    dependencies: {
      claudeIdentity?: () => ReturnType<typeof readClaudeIdentity>;
      claudeUsage?: ReturnType<typeof nativeClaudeFetcher>;
    } = {},
  ) {
    this.claudeIdentity =
      dependencies.claudeIdentity ??
      (() => readClaudeIdentity(process.env.DOCK_CLAUDE_BIN ?? 'claude'));
    this.claudeUsage = dependencies.claudeUsage ?? nativeClaudeFetcher();
  }
  get(provider: ProviderId): RemoteAccountIdentity | null {
    return this.values.get(provider)?.account ?? null;
  }
  reading(provider: ProviderId) {
    return this.values.get(provider) ?? null;
  }
  all() {
    return (['codex', 'claude'] as const).map((provider) => {
      const current = this.get(provider);
      if (current?.state === 'ready' || !this.pending.has(provider))
        return (
          current ??
          remoteAccountIdentitySchema.parse({
            provider,
            affinity: null,
            identityBasis: 'native',
            state: 'setup-required',
            observedAt: new Date(this.now()).toISOString(),
            message: `Cluster ${provider === 'codex' ? 'Codex' : 'Claude'} native account has not been verified.`,
          })
        );
      return remoteAccountIdentitySchema.parse({
        provider,
        affinity: null,
        identityBasis: 'native',
        state: 'unavailable',
        observedAt: new Date(this.now()).toISOString(),
        message: `Checking the native cluster ${provider === 'codex' ? 'Codex' : 'Claude'} account. No model turn has started.`,
      });
    });
  }
  async discover(provider: ProviderId, force = false): Promise<NativeClusterAccountReading> {
    const pending = this.pending.get(provider);
    if (pending) return pending;
    const current = this.values.get(provider);
    if (!force && current && this.now() - Date.parse(current.account.observedAt) < 60000)
      return current;
    const work = (async () => {
      let reading: NativeClusterAccountReading;
      try {
        if (provider === 'codex')
          reading = projectNativeCodexAccount(await this.codexRead(), this.now());
        else {
          const identity = await this.claudeIdentity();
          reading = {
            account: remoteAccountIdentitySchema.parse({
              provider,
              affinity: identity.affinity,
              identityBasis: 'native',
              state: 'ready',
              observedAt: new Date(this.now()).toISOString(),
              message:
                'Cluster Claude native subscription account verified; independent from the controller account.',
            }),
            capacity: current?.account.affinity === identity.affinity ? current.capacity : null,
            ordinaryUsageAllowed: null,
          };
        }
      } catch (error) {
        const unavailable =
          error instanceof ClaudePreflightError && ['timeout', 'unavailable'].includes(error.code);
        reading = {
          account: remoteAccountIdentitySchema.parse({
            provider,
            affinity: null,
            identityBasis: 'native',
            state: unavailable ? 'unavailable' : 'setup-required',
            observedAt: new Date(this.now()).toISOString(),
            message: unavailable
              ? 'Cluster Claude account metadata is temporarily unavailable. Retry the account check; no sign-out or native turn was inferred.'
              : `Cluster ${provider === 'codex' ? 'Codex account identity/history storage' : 'Claude installation or native subscription sign-in'} needs setup. The selected provider was retained; no fallback or native turn started.`,
          }),
          capacity: null,
          ordinaryUsageAllowed: null,
        };
      }
      this.values.set(provider, reading);
      return reading;
    })().finally(() => this.pending.delete(provider));
    this.pending.set(provider, work);
    return work;
  }
  async capacity(provider: ProviderId) {
    const identity = await this.discover(provider);
    if (identity.account.state !== 'ready') return identity;
    if (provider === 'codex') return this.discover(provider, true);
    try {
      const raw = await this.claudeUsage(AbortSignal.timeout(20000));
      const capacity = parseCapacity('claude', raw, this.now());
      const affinity = z
        .array(z.object({ usage: z.object({ accountAffinity: z.string() }) }))
        .parse(raw)[0]?.usage.accountAffinity;
      if (affinity !== identity.account.affinity) throw new Error('Native account changed.');
      const latest = this.values.get(provider);
      if (
        latest?.account.state !== 'ready' ||
        latest.account.affinity !== identity.account.affinity
      )
        return latest ?? { ...identity, capacity: null };
      const reading = { ...identity, capacity };
      this.values.set(provider, reading);
      return reading;
    } catch {
      const latest = this.values.get(provider);
      if (
        latest?.account.state !== 'ready' ||
        latest.account.affinity !== identity.account.affinity
      )
        return latest ?? { ...identity, capacity: null };
      const reading = { ...identity, capacity: null };
      this.values.set(provider, reading);
      return reading;
    }
  }
}
