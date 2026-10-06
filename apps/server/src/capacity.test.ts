import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.js';
import { CapacityMonitor, parseCapacity, readCapacity } from './capacity.js';
import { ClaudeCapacityError, nativeClaudeFetcher } from './claude-capacity.js';

const dirs: string[] = [];
const monitors: CapacityMonitor[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map((m) => m.close()));
  stores.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swa-capacity-'));
  dirs.push(root);
  const store = new Store(join(root, 'dock.sqlite'));
  stores.push(store);
  return { root, store };
}
const stamp = Date.parse('2026-09-24T06:00:00Z');
function report(now = stamp) {
  return [
    {
      provider: 'claude',
      source: 'oauth',
      usage: {
        updatedAt: new Date(now).toISOString(),
        accountEmail: 'must-not-persist@example.com',
        secret: 'never-copy',
        loginMethod: 'Claude Enterprise',
        primary: { usedPercent: 8, windowMinutes: 300, resetsAt: '2026-09-24T09:20:00Z' },
        secondary: null,
        extraRateWindows: [
          {
            id: 'fable-five-hour',
            title: 'Fable',
            window: { usedPercent: 41, windowMinutes: 300 },
          },
          {
            id: 'fable-weekly',
            title: 'Fable weekly',
            window: { usedPercent: 12, windowMinutes: 10080 },
          },
        ],
      },
    },
  ];
}
it('preserves independent model windows, absent weekly and source freshness without copying secrets', () => {
  const parsed = parseCapacity('claude', report(), stamp);
  expect(parsed.weeklyPolicy).toBe('not-reported');
  expect(parsed.windows.map((w) => [w.scope, w.model, w.usedPercent])).toEqual([
    ['general', null, 8],
    ['model', 'fable', 41],
    ['model', 'fable', 12],
  ]);
  expect(JSON.stringify(parsed)).not.toMatch(/must-not-persist|never-copy/);
  expect(() => parseCapacity('codex', report(), stamp)).toThrow();
  expect(() => parseCapacity('claude', report(), stamp + 240_000)).toThrow();
  expect(() => parseCapacity('claude', report(stamp + 60_000), stamp)).toThrow();
});
it('coalesces callers, retains last good reading on failure, backs off and survives reopening', async () => {
  const { root, store } = fixture();
  let clock = stamp,
    calls = 0,
    fail = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const monitor = new CapacityMonitor(
    store,
    root,
    async () => {
      calls++;
      await gate;
      if (fail) throw new Error('private error');
      return report(clock);
    },
    () => clock,
  );
  monitors.push(monitor);
  const a = monitor.refresh('claude'),
    b = monitor.refresh('claude');
  expect(calls).toBe(1);
  release();
  await Promise.all([a, b]);
  expect(readCapacity(store, 'claude', clock).state).toBe('ready');
  await monitor.refresh('claude');
  expect(calls).toBe(1);
  clock += 60_000;
  await monitor.refresh('claude');
  expect(calls).toBe(1);
  clock += 240_000;
  fail = true;
  await monitor.refresh('claude');
  expect(readCapacity(store, 'claude', clock)).toMatchObject({
    state: 'error',
    stale: true,
    observedAt: new Date(stamp).toISOString(),
  });
  expect(readCapacity(store, 'claude', clock).message).not.toContain('private error');
  clock += 60_000;
  await monitor.refresh('claude');
  expect(calls).toBe(2);
  await monitor.close();
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(join(root, 'dock.sqlite'));
  stores.push(reopened);
  expect(readCapacity(reopened, 'claude', clock).windows).toHaveLength(3);
  clock += 60_000;
  fail = false;
  const recovered = new CapacityMonitor(
    reopened,
    root,
    async () => report(clock),
    () => clock,
  );
  monitors.push(recovered);
  await recovered.refresh('claude');
  expect(readCapacity(reopened, 'claude', clock)).toMatchObject({ state: 'ready', stale: false });
});
it('shutdown aborts an owned collector and prevents late writes', async () => {
  const { root, store } = fixture();
  let aborted = false;
  const monitor = new CapacityMonitor(
    store,
    root,
    async (_p, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    () => stamp,
  );
  monitors.push(monitor);
  const pending = monitor.refresh('claude');
  await monitor.close();
  await pending;
  expect(aborted).toBe(true);
  expect(readCapacity(store, 'claude', stamp).state).toBe('unknown');
});
it('shares a provider retry delay across refresh callers and restart, then clears the failure on recovery', async () => {
  const { root, store } = fixture();
  let clock = stamp,
    calls = 0;
  const retryAt = stamp + 660_000;
  const monitor = new CapacityMonitor(
    store,
    root,
    async () => {
      calls++;
      if (calls > 1) throw new ClaudeCapacityError('rate-limit', retryAt);
      return report(clock);
    },
    () => clock,
  );
  monitors.push(monitor);
  await monitor.refresh('claude');
  clock += 300_000;
  await Promise.all([monitor.refresh('claude'), monitor.refresh('claude')]);
  const failed = readCapacity(store, 'claude', clock);
  expect(calls).toBe(2);
  expect(failed.message).toContain('does not mean your model allowance is exhausted');
  expect(failed).toMatchObject({
    stale: true,
    observedAt: new Date(stamp).toISOString(),
    nextRefreshAt: new Date(retryAt).toISOString(),
  });
  expect(failed.windows).toHaveLength(3);
  await monitor.close();
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(join(root, 'dock.sqlite'));
  stores.push(reopened);
  const recovered = new CapacityMonitor(
    reopened,
    root,
    async () => {
      calls++;
      return report(clock);
    },
    () => clock,
  );
  monitors.push(recovered);
  clock = retryAt - 1;
  await recovered.refresh('claude');
  expect(calls).toBe(2);
  clock = retryAt;
  await recovered.refresh('claude');
  expect(calls).toBe(3);
  expect(readCapacity(reopened, 'claude', clock)).toMatchObject({
    state: 'ready',
    stale: false,
    nextRefreshAt: new Date(clock + 300_000).toISOString(),
  });
  expect(readCapacity(reopened, 'claude', clock).message).not.toContain('limiting');
});
it('recovers native Claude sign-in after repeated local failures without extending its shared minute retry', async () => {
  const { root, store } = fixture();
  let clock = stamp,
    attempts = 0,
    usageRequests = 0,
    signedIn = true;
  const reader = nativeClaudeFetcher({
    affinity: async () => {
      if (!signedIn) throw new Error('Native sign-in unavailable');
      return 'fixture-account';
    },
    credential: async () => 'fixture-token',
    clock: () => clock,
    fetch: async () => {
      usageRequests++;
      return new Response(
        JSON.stringify({ five_hour: { utilization: 8, resets_at: null }, seven_day: null }),
      );
    },
  });
  const monitor = new CapacityMonitor(
    store,
    root,
    async (_provider, signal) => {
      attempts++;
      return reader(signal);
    },
    () => clock,
  );
  monitors.push(monitor);
  await monitor.refresh('claude');
  const good = readCapacity(store, 'claude', clock);
  clock = Date.parse(good.nextRefreshAt!);
  signedIn = false;
  for (let failures = 0; failures < 6; failures++) {
    const before = attempts;
    await Promise.all(Array.from({ length: 20 }, () => monitor.refresh('claude')));
    const failed = readCapacity(store, 'claude', clock);
    expect(attempts).toBe(before + 1);
    expect(usageRequests).toBe(1);
    expect(failed).toMatchObject({ state: 'error', stale: true, observedAt: good.observedAt });
    expect(failed.windows).toEqual(good.windows);
    expect(Date.parse(failed.nextRefreshAt!) - clock).toBe(60_000);
    clock = Date.parse(failed.nextRefreshAt!) - 1;
    await Promise.all(Array.from({ length: 20 }, () => monitor.refresh('claude')));
    expect(attempts).toBe(before + 1);
    clock++;
  }
  signedIn = true;
  await Promise.all(Array.from({ length: 20 }, () => monitor.refresh('claude')));
  expect(usageRequests).toBe(2);
  expect(readCapacity(store, 'claude', clock)).toMatchObject({
    state: 'ready',
    stale: false,
    observedAt: new Date(clock).toISOString(),
    nextRefreshAt: new Date(clock + 300_000).toISOString(),
  });
});
it('binds the owner’s no-weekly statement to one verified account, without inferring it for another', async () => {
  const { root, store } = fixture();
  let clock = stamp;
  let affinity = 'a'.repeat(64);
  store.setSetting(`capacity:owner-no-weekly:${affinity}`, true);
  const monitor = new CapacityMonitor(
    store,
    root,
    async () => {
      const row = report(clock)[0]!;
      return [
        {
          ...row,
          source: 'claude-native-oauth',
          usage: { ...row.usage, accountAffinity: affinity },
        },
      ];
    },
    () => clock,
  );
  monitors.push(monitor);
  await monitor.refresh('claude');
  expect(readCapacity(store, 'claude', clock).weeklyPolicy).toBe('owner-reported-none');
  clock += 300000;
  affinity = 'b'.repeat(64);
  await monitor.refresh('claude');
  expect(readCapacity(store, 'claude', clock).weeklyPolicy).toBe('not-reported');
});

it.each(['codex', 'claude'] as const)(
  'keeps %s failures distinct from exhaustion and bounds retry backoff, clearing it after recovery',
  async (provider) => {
    const { root, store } = fixture();
    let clock = stamp,
      calls = 0,
      fail = false;
    const monitor = new CapacityMonitor(
      store,
      root,
      async () => {
        calls++;
        if (fail) throw new Error('unavailable');
        const row = report(clock)[0]!;
        return [
          {
            ...row,
            provider,
            usage: { ...row.usage, primary: { ...row.usage.primary, usedPercent: 100 } },
          },
        ];
      },
      () => clock,
    );
    monitors.push(monitor);
    await Promise.all(Array.from({ length: 20 }, () => monitor.refresh(provider)));
    expect(calls).toBe(1);
    const good = readCapacity(store, provider, clock);
    clock = Date.parse(good.nextRefreshAt!);
    fail = true;
    for (const delay of [120, 240, 480, 900, 900]) {
      const before = calls;
      await Promise.all(Array.from({ length: 20 }, () => monitor.refresh(provider)));
      expect(calls).toBe(before + 1);
      const saved = readCapacity(store, provider, clock);
      expect(saved).toMatchObject({ state: 'error', stale: true, observedAt: good.observedAt });
      expect(saved.windows[0].usedPercent).toBe(100);
      expect(Date.parse(saved.nextRefreshAt!) - clock).toBe(delay * 1000);
      clock = Date.parse(saved.nextRefreshAt!) - 1;
      await monitor.refresh(provider);
      expect(calls).toBe(before + 1);
      clock++;
    }
    fail = false;
    await monitor.refresh(provider);
    expect(readCapacity(store, provider, clock)).toMatchObject({ state: 'ready', stale: false });
    expect(Date.parse(readCapacity(store, provider, clock).nextRefreshAt!) - clock).toBe(
      provider === 'claude' ? 300000 : 60000,
    );
  },
);
