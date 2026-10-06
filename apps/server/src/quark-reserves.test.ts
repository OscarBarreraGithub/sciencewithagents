import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveProviderReserve, providerReservePolicy } from '@dock/shared';
import { Store } from './store.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { parseCapacity, readCapacity } from './capacity.js';

let root: string, store: Store, pulsar: Pulsar, quark: Quark;
const start = Date.parse('2026-10-05T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  root = mkdtempSync(join(tmpdir(), 'quark-reserves-'));
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => ({
    observedAt: new Date().toISOString(),
    cpuCount: 8,
    cpuUsedPercent: 10,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryAvailableBytes: 16 * 1024 ** 3,
    diskAvailableBytes: 100 * 1024 ** 3,
    loadPerCore: 0.2,
  }));
  quark = new Quark(store, pulsar);
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function usage(provider: 'codex' | 'claude', used: number, reset: number) {
  store.setSetting(
    `capacity:v1:${provider}`,
    parseCapacity(
      provider,
      [
        {
          provider,
          source: 'oauth',
          usage: {
            updatedAt: new Date().toISOString(),
            primary: {
              usedPercent: used,
              windowMinutes: provider === 'codex' ? 10080 : 300,
              resetsAt: new Date(reset).toISOString(),
            },
          },
        },
      ],
      Date.now(),
    ),
  );
}
function run(provider: 'codex' | 'claude') {
  const p = store.register(join(root, randomUUID()), 'Reserve fixture', '');
  const a = store.addAgent({
    projectId: p.id,
    parentId: p.managerId,
    taskId: null,
    provider,
    role: 'researcher',
    name: 'Worker',
    cwd: root,
  });
  return store.enqueue(a.id, randomUUID(), 'Retain progress');
}
function effective(provider: 'codex' | 'claude') {
  const capacity = readCapacity(store, provider, Date.now());
  return effectiveProviderReserve(pulsar.policy(), capacity, capacity.windows[0]!, Date.now());
}
it('preserves legacy saved reserves for both providers and defaults only new settings to20', () => {
  expect(providerReservePolicy(pulsar.policy(), 'codex')).toMatchObject({
    reservePercent: 20,
    releaseEnabled: false,
    releaseBeforeResetMinutes: 720,
  });
  expect(providerReservePolicy(pulsar.policy(), 'claude').releaseBeforeResetMinutes).toBe(45);
  store.setSetting('pulsar:policy', { enabled: true, reservePercent: 25 });
  expect(pulsar.policy().providerReserves.codex.reservePercent).toBe(25);
  expect(pulsar.policy().providerReserves.claude.reservePercent).toBe(25);
  expect(pulsar.policy().providerReserves.claude.releaseEnabled).toBe(false);
});
it('saves independent zero reserves idempotently and rejects concurrent stale settings', () => {
  const before = pulsar.policy();
  const request = {
    key: randomUUID(),
    policy: {
      ...before,
      providerReserves: {
        ...before.providerReserves,
        codex: { ...before.providerReserves.codex, reservePercent: 0 },
      },
    },
  };
  const saved = pulsar.savePolicy(request);
  expect(pulsar.savePolicy(request)).toEqual(saved);
  expect(pulsar.policy().providerReserves).toMatchObject({
    codex: { reservePercent: 0 },
    claude: { reservePercent: 20 },
  });
  expect(() => pulsar.savePolicy({ key: randomUUID(), policy: before })).toThrow('changed');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => ({
    observedAt: new Date().toISOString(),
    cpuCount: 8,
    cpuUsedPercent: 10,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryAvailableBytes: 16 * 1024 ** 3,
    diskAvailableBytes: 100 * 1024 ** 3,
    loadPerCore: 0.2,
  }));
  expect(pulsar.policy().providerReserves.codex.reservePercent).toBe(0);
});
it('uses separate effective reserves in admission and running guards while retaining native exhaustion', () => {
  const policy = pulsar.policy();
  pulsar.savePolicy({
    key: randomUUID(),
    policy: {
      ...policy,
      enabled: true,
      providerReserves: {
        codex: { ...policy.providerReserves.codex, reservePercent: 0 },
        claude: { ...policy.providerReserves.claude, reservePercent: 25 },
      },
    },
  });
  usage('codex', 90, start + 86400_000);
  usage('claude', 90, start + 300 * 60_000);
  const c = run('codex'),
    a = run('claude');
  expect(quark.block(c, true)).toBeNull();
  expect(quark.block(a, true)?.cause).toBe('headroom');
  expect(pulsar.decision(c, new Set()).eligible).toBe(true);
  expect(pulsar.decision(a, new Set()).eligible).toBe(false);
  usage('codex', 100, start + 86400_000);
  expect(quark.block(c)?.cause).toBe('headroom');
  expect(pulsar.decision(c, new Set()).eligible).toBe(false);
});
it('releases only opted-in fresh reported windows, restores baseline on reset and keeps stale holds', () => {
  const policy = pulsar.policy();
  pulsar.savePolicy({
    key: randomUUID(),
    policy: {
      ...policy,
      enabled: true,
      providerReserves: {
        ...policy.providerReserves,
        claude: { ...policy.providerReserves.claude, releaseEnabled: true },
      },
    },
  });
  usage('claude', 90, start + 46 * 60_000);
  expect(effective('claude')).toMatchObject({ effectivePercent: 20, released: false });
  vi.setSystemTime(start + 60_000);
  usage('claude', 90, start + 46 * 60_000);
  expect(effective('claude')).toMatchObject({
    reservePercent: 20,
    effectivePercent: 0,
    released: true,
  });
  expect(quark.block(run('claude'), true)).toBeNull();
  vi.setSystemTime(start + 10 * 60_000); // no fresh observation
  expect(effective('claude')).toMatchObject({ effectivePercent: 20, released: false });
  expect(quark.block(run('claude'), true)?.cause).toBe('monitoring');
  vi.setSystemTime(start + 46 * 60_000);
  usage('claude', 90, start + 46 * 60_000);
  expect(effective('claude').released).toBe(false);
  expect(quark.block(run('claude'), true)?.cause).toBe('reset');
  usage('claude', 0, Date.now() + 300 * 60_000);
  expect(effective('claude')).toMatchObject({ effectivePercent: 20, released: false });
});

it('preserves independent reserves during an unrelated legacy edit but applies an explicit global change', () => {
  const before = pulsar.policy();
  pulsar.savePolicy({
    key: randomUUID(),
    policy: {
      ...before,
      providerReserves: {
        ...before.providerReserves,
        codex: { ...before.providerReserves.codex, reservePercent: 7 },
      },
    },
  });
  const { providerReserves: _reserves, ...legacy } = pulsar.policy();
  pulsar.savePolicy({ key: randomUUID(), policy: { ...legacy, backgroundGapSeconds: 180 } });
  expect(pulsar.policy().providerReserves.codex.reservePercent).toBe(7);
  expect(pulsar.policy().providerReserves.claude.reservePercent).toBe(20);
  const { providerReserves: _next, ...changed } = pulsar.policy();
  pulsar.savePolicy({ key: randomUUID(), policy: { ...changed, reservePercent: 0 } });
  expect(pulsar.policy().providerReserves.codex.reservePercent).toBe(0);
  expect(pulsar.policy().providerReserves.claude.reservePercent).toBe(0);
});

it('resumes retained headroom-held progress once, only after a genuine reported reset', () => {
  store.setSetting('pulsar:policy', { enabled: true, reservePercent: 5 });
  const reset = start + 60 * 60_000;
  usage('claude', 97, reset);
  const r = run('claude');
  const agentId = r.agentId;
  store.updateRun(r.id, { status: 'running' });
  quark.hold(store.run(r.id), 'Session reached the shared headroom limit.', false, 'headroom');
  store.updateRun(r.id, { status: 'interrupted' });
  store.updateAgent(agentId, { status: 'interrupted', turnId: null });
  quark.acknowledgeStop(r.id);
  const resumes = () =>
    store.runs(['queued']).filter((x) => x.agentId === agentId && x.kind === 'resume');
  // A fresh but still exhausted pre-reset report is not capacity.
  vi.setSystemTime(start + 60_000);
  usage('claude', 97, reset);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
  // Elapsed reset time without a new report never assumes a refill.
  vi.setSystemTime(reset + 60_000);
  quark.recoverTransient(new Set());
  usage('claude', 97, reset);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
  expect(resumes()).toHaveLength(0);
  // A genuine report of the new window resumes retained progress exactly once.
  usage('claude', 2, Date.now() + 300 * 60_000);
  quark.recoverTransient(new Set());
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
  expect(resumes()).toHaveLength(1);
  expect(resumes()[0]!.text).toContain('Inspect retained progress');
  expect(store.events().filter((e) => e.type === 'quark.resumed')).toHaveLength(1);
});
