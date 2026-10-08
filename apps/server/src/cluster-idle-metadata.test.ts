import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from './codex.js';
import type { Terminals } from './terminal.js';
import type { OwnerTerminals } from './owner-terminal.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { ClusterNativeAccounts } from './cluster-native-accounts.js';
import { ClusterRemoteAdmission } from './cluster-remote-admission.js';
import { ClusterRuntimeIdle } from './cluster-runtime-idle.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swa-idle-metadata-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const project = store.register(root, 'Retained cluster history', '', 'codex');
  let now = 0;
  let nativeProcesses = 0;
  let closeMetadata!: () => void;
  const closing = new Promise<void>((resolve) => {
    closeMetadata = resolve;
  });
  const raw = () => ({
    accountId: 'owned-native-fixture-account',
    ordinaryUsageAllowed: true,
    rateLimits: { primary: { usedPercent: 1 } },
  });
  const providerFactory = vi.fn(async () => {
    nativeProcesses++;
    let closed = false;
    return Object.assign(new EventEmitter(), {
      ready: true,
      request: vi.fn(async (method: string) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'account/rateLimits/read') return raw();
        throw new Error('Only fixed metadata requests are authorized in this fixture.');
      }),
      respond() {},
      async close() {
        await closing;
        if (!closed) {
          closed = true;
          nativeProcesses--;
        }
      },
    }) as Provider;
  });
  const runtime = new Runtime(store, root, '/unused-native-fixture', providerFactory);
  vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  const metadata = vi.fn(() => runtime.clusterCodexAccountLimits());
  metadata.mockResolvedValueOnce(raw());
  const accounts = new ClusterNativeAccounts(metadata, () => now, {
    claudeIdentity: async () => ({
      affinity: 'b'.repeat(64),
      authMethod: 'claude.ai',
      provider: 'firstParty',
    }),
    claudeUsage: async () => {
      throw new Error('No live usage request is authorized.');
    },
  });
  const identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: randomUUID(),
    remoteProjectId: project.id,
    jobId: '41234',
    leaseToken: randomUUID(),
  };
  const remote = new ClusterRemoteAdmission(runtime, identity, () => now, accounts);
  const owner = { activeCount: () => 0, beforeOpen: () => {} };
  const nativeProof = vi.fn(() => {
    if (nativeProcesses) throw new Error('Native metadata process is still alive.');
  });
  const closeProviders = vi.spyOn(runtime, 'closeClusterIdleProviders');
  const idle = new ClusterRuntimeIdle(
    identity,
    runtime,
    { activeCount: () => 0 } as Terminals,
    owner as OwnerTerminals,
    join(root, 'runtime-bootstrap.json'),
    20,
    () => now,
    nativeProof,
  );
  cleanups.push(async () => {
    closeMetadata();
    remote.close();
    idle.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const selectReader = () =>
    remote.selectReader({
      key: randomUUID(),
      controllerHostId: identity.controllerHostId,
      provider: 'codex',
      accountAffinity: accounts.get('codex')!.affinity!,
      generation: randomUUID(),
      reader: true,
      expiresAt: new Date(now + 45000).toISOString(),
      cached: null,
    });
  return {
    store,
    runtime,
    remote,
    accounts,
    idle,
    identity,
    owner,
    metadata,
    providerFactory,
    closeMetadata,
    nativeProof,
    closeProviders,
    selectReader,
    advance: () => {
      now += 1200001;
    },
  };
}

it('settles an owned account refresh before idle proof without resetting elapsed material idle', async () => {
  const f = fixture();
  await Promise.resolve(); // Deliver initial registration events before advancing the idle clock.
  f.advance();
  await f.accounts.discover('codex');
  const ready = f.accounts.get('codex');
  f.selectReader();
  await vi.waitFor(() => expect(f.providerFactory).toHaveBeenCalledOnce());
  expect(Object.values(f.runtime.clusterIdleCounts())).toEqual([0, 0, 0, 0, 0]);
  const draining = f.idle.drain({ key: randomUUID() });
  expect(f.nativeProof).not.toHaveBeenCalled();
  expect(() => f.runtime.clusterMutationGuard()).toThrow(/draining/);
  expect(() => f.owner.beforeOpen()).toThrow(/draining/);
  f.closeMetadata();
  expect(await draining).toMatchObject({ idleSince: 0, observedAt: 1200001 });
  expect(f.nativeProof).toHaveBeenCalledTimes(2);
  expect(f.closeProviders).toHaveBeenCalledOnce();
  expect(f.accounts.get('codex')).toEqual(ready);
  const calls = f.metadata.mock.calls.length;
  f.advance();
  f.selectReader();
  f.remote.snapshot();
  await Promise.resolve();
  expect(f.metadata).toHaveBeenCalledTimes(calls);
  f.idle.reopen({ jobId: f.identity.jobId, leaseToken: f.identity.leaseToken });
  f.selectReader();
  await vi.waitFor(() => expect(f.metadata.mock.calls.length).toBeGreaterThan(calls));
});

it('rechecks saved owner work after metadata settles before closing providers or proving idle', async () => {
  const f = fixture();
  await Promise.resolve();
  f.advance();
  await f.accounts.discover('codex');
  f.selectReader();
  await vi.waitFor(() => expect(f.providerFactory).toHaveBeenCalledOnce());
  const draining = f.idle.drain({ key: randomUUID() });
  expect(() => f.owner.beforeOpen()).toThrow(/draining/);
  const owner = f.store.enqueue(
    f.store.project(f.identity.remoteProjectId).managerId,
    randomUUID(),
    'Retain this already-authorized input across the metadata await.',
  );
  f.closeMetadata();
  expect(await draining).toBeNull();
  expect(f.nativeProof).not.toHaveBeenCalled();
  expect(f.closeProviders).not.toHaveBeenCalled();
  expect(f.store.run(owner.id)).toMatchObject({ status: 'queued', text: owner.text });
  expect(() => f.runtime.clusterMutationGuard()).not.toThrow();
});

it('bounds a slow metadata close and retries without changing readiness or material idle', async () => {
  const f = fixture();
  await Promise.resolve();
  f.advance();
  await f.accounts.discover('codex');
  const ready = f.accounts.get('codex');
  f.selectReader();
  await vi.waitFor(() => expect(f.providerFactory).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  const draining = f.idle.drain({ key: randomUUID() });
  await vi.advanceTimersByTimeAsync(15000);
  expect(await draining).toBeNull();
  expect(f.nativeProof).not.toHaveBeenCalled();
  expect(f.accounts.get('codex')).toEqual(ready);
  expect(() => f.runtime.clusterMutationGuard()).not.toThrow();
  f.closeMetadata();
  await f.runtime.settleClusterBackgroundMetadata();
  expect(await f.idle.drain({ key: randomUUID() })).toMatchObject({ idleSince: 0 });
  expect(f.nativeProof).toHaveBeenCalledTimes(2);
});
