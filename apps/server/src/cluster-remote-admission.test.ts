import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteRuntimeIdentity } from '@dock/shared';
import { Store } from './store.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { projectSchedulerKey } from './quark-project.js';
import { ClusterNativeAccounts } from './cluster-native-accounts.js';
import { remoteRequestHash } from './cluster-admission-request.js';
import {
  ClusterRemoteAdmission,
  clusterInternalPath,
  type RemoteAdmissionRuntime,
} from './cluster-remote-admission.js';

let root: string,
  store: Store,
  identity: RemoteRuntimeIdentity,
  runtime: RemoteAdmissionRuntime,
  remote: ClusterRemoteAdmission,
  managerId: string;
let nativeId: string, ordinaryAllowed: boolean;
let accounts: ClusterNativeAccounts;
let prepared: Set<string>;
let codexRead: ReturnType<typeof vi.fn>;
let usageRead: ReturnType<typeof vi.fn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-remote-admission-'));
  store = new Store(join(root, 'dock.sqlite'));
  const project = store.register(root, 'Remote science', '', 'codex');
  managerId = project.managerId;
  identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: randomUUID(),
    remoteProjectId: project.id,
    jobId: '41234',
    leaseToken: randomUUID(),
  };
  const pulsar = new Pulsar(store, () => null);
  prepared = new Set();
  runtime = {
    store,
    pulsar,
    quark: new Quark(store, pulsar),
    clusterCodexAccountLimits: async () => {
      throw new Error('Only injected metadata readers may run');
    },
    isInternalProject: () => false,
    preparedForRemoteAdmission: (id) => prepared.has(id),
    nativeAdmissionReason: () => null,
    nativeAdmissionConsume: () => true,
    nativeAdmissionVerify: async () => {},
    clusterBackgroundMetadataAllowed: () => true,
    settleClusterBackgroundMetadata: async () => {},
  };
  nativeId = 'private-native-account';
  ordinaryAllowed = true;
  codexRead = vi.fn(async () => ({
    accountId: nativeId,
    ordinaryUsageAllowed: ordinaryAllowed,
    rateLimits: { primary: { usedPercent: 1 } },
  }));
  usageRead = vi.fn(async (_signal: AbortSignal): Promise<unknown> => {
    throw new Error('No native usage request is authorized');
  });
  accounts = new ClusterNativeAccounts(codexRead, Date.now, {
    claudeIdentity: async () => ({
      affinity: 'b'.repeat(64),
      authMethod: 'claude.ai',
      provider: 'firstParty',
    }),
    claudeUsage: (signal) => usageRead(signal),
  });
  remote = new ClusterRemoteAdmission(runtime, identity, Date.now, accounts);
});
afterEach(() => {
  remote.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const worker = () =>
  store.addAgent({
    id: randomUUID(),
    projectId: identity.remoteProjectId,
    parentId: managerId,
    taskId: null,
    name: 'Worker',
    role: 'implementer',
    cwd: root,
    provider: 'codex',
  });

it('keeps owner FIFO ahead of coordination, holds edited owner input, and excludes stopped managers without native reads', async () => {
  await accounts.discover('codex');
  const source = worker();
  const report = store.enqueue(managerId, randomUUID(), 'Worker evidence', 'report', source.id);
  const owner = store.enqueue(managerId, randomUUID(), 'Private owner instruction');
  prepared.add(report.id);
  prepared.add(owner.id);
  expect(remote.snapshot().candidates.map((candidate) => candidate.runId)).toEqual([owner.id]);
  expect(JSON.stringify(remote.snapshot())).not.toContain('Private owner instruction');
  expect(codexRead).toHaveBeenCalledTimes(1);
  store.updateRun(owner.id, {
    queueEdit: { clientId: randomUUID(), text: owner.text, state: 'editing' },
  });
  expect(remote.snapshot().candidates).toEqual([]);
  store.updateRun(owner.id, { queueEdit: null });
  store.updateAgent(managerId, { status: 'interrupted' });
  expect(remote.snapshot().candidates).toEqual([]);
  expect(store.run(owner.id).status).toBe('queued');
});

it('bounds metadata scans and rotates past128 unprepared heads without reading their prompts or starving later prepared work', async () => {
  await accounts.discover('codex');
  let readyId = '';
  for (let index = 0; index < 129; index++) {
    const agent = worker();
    const run = store.enqueue(agent.id, randomUUID(), 'Saved private worker input');
    if (index === 128) {
      readyId = run.id;
      prepared.add(run.id);
    }
  }
  const runRead = vi.spyOn(store, 'run');
  const unboundedRead = vi.spyOn(store, 'runs');
  expect(remote.snapshot().candidates).toEqual([]);
  expect(runRead).not.toHaveBeenCalled();
  expect(remote.snapshot().candidates.map((candidate) => candidate.runId)).toEqual([readyId]);
  expect(runRead).toHaveBeenCalledTimes(1);
  expect(unboundedRead).not.toHaveBeenCalled();
});

it('binds project Off to exact permission, rolls back consumption, and rechecks policy/account before any native input', async () => {
  await accounts.discover('codex');
  store.setSetting(projectSchedulerKey(identity.remoteProjectId), {
    projectId: identity.remoteProjectId,
    enabled: false,
  });
  const run = store.enqueue(managerId, randomUUID(), 'A saved request');
  prepared.add(run.id);
  const snapshot = remote.snapshot(),
    candidate = snapshot.candidates[0]!;
  expect(snapshot.followQuark).toBe(false);
  expect(candidate.followQuark).toBe(false);
  const grant = {
    id: randomUUID(),
    ...identity,
    runId: run.id,
    provider: 'codex',
    accountAffinity: candidate.accountAffinity,
    requestHash: remoteRequestHash(candidate),
    policyRevision: '0',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    decision: 'allow',
    reason: 'Exact fixture permission',
  };
  const { remoteProjectId: _remoteProjectId, ...input } = grant;
  remote.inbox.push({ key: randomUUID(), grant: input });
  expect(runtime.nativeAdmissionReason(store.run(run.id))).toBeNull();
  expect(() =>
    store.transaction(() => {
      expect(runtime.nativeAdmissionConsume(store.run(run.id))).toBe(true);
      throw new Error('Local stop before dispatch');
    }),
  ).toThrow('Local stop');
  expect(runtime.nativeAdmissionReason(store.run(run.id))).toBeNull();
  await runtime.nativeAdmissionVerify(store.run(run.id));
  store.setSetting(projectSchedulerKey(identity.remoteProjectId), {
    projectId: identity.remoteProjectId,
    enabled: true,
  });
  await expect(runtime.nativeAdmissionVerify(store.run(run.id))).rejects.toThrow('before dispatch');
  store.setSetting(projectSchedulerKey(identity.remoteProjectId), {
    projectId: identity.remoteProjectId,
    enabled: false,
  });
  nativeId = 'another-native-account';
  await expect(runtime.nativeAdmissionVerify(store.run(run.id))).rejects.toThrow('before dispatch');
  expect(store.run(run.id).status).toBe('queued');
});

it('retains native ordinary-usage denial when project scheduling is off', async () => {
  ordinaryAllowed = false;
  await accounts.discover('codex');
  store.setSetting(projectSchedulerKey(identity.remoteProjectId), {
    projectId: identity.remoteProjectId,
    enabled: false,
  });
  const run = store.enqueue(managerId, randomUUID(), 'A saved request');
  prepared.add(run.id);
  expect(runtime.nativeAdmissionReason(store.run(run.id))).toContain(
    'ordinary included usage is blocked',
  );
  expect(runtime.nativeAdmissionConsume(store.run(run.id))).toBe(false);
  expect(store.run(run.id).status).toBe('queued');
});

it('accepts only exact private gateway admission methods and rejects reader selection after close', async () => {
  expect(clusterInternalPath('GET', '/api/cluster/runtime/admission')).toBe(true);
  expect(clusterInternalPath('POST', '/api/cluster/runtime/admission/revoke')).toBe(true);
  expect(clusterInternalPath('GET', '/api/cluster/runtime/admission/revoke')).toBe(false);
  expect(clusterInternalPath('POST', '/api/cluster/runtime/admission/revoke?extra=1')).toBe(false);
  remote.close();
  expect(() => remote.selectReader({})).toThrow('stopping');
});

it('refuses another account reader and cannot publish an in-flight usage sample after close', async () => {
  await accounts.discover('claude');
  let finish!: (value: unknown) => void;
  usageRead.mockImplementationOnce(
    () =>
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
  );
  const lease = {
    key: randomUUID(),
    controllerHostId: identity.controllerHostId,
    provider: 'claude',
    accountAffinity: 'b'.repeat(64),
    generation: randomUUID(),
    reader: true,
    expiresAt: new Date(Date.now() + 45000).toISOString(),
    cached: null,
  };
  expect(() => remote.selectReader({ ...lease, accountAffinity: 'a'.repeat(64) })).toThrow(
    'identity or lifetime',
  );
  expect(usageRead).not.toHaveBeenCalled();
  remote.selectReader(lease);
  await vi.waitFor(() => expect(usageRead).toHaveBeenCalledOnce());
  remote.close();
  const writes = vi.spyOn(store, 'setSetting');
  finish([
    {
      provider: 'claude',
      source: 'claude-native-oauth',
      usage: {
        accountAffinity: 'b'.repeat(64),
        updatedAt: new Date().toISOString(),
        primary: { usedPercent: 1, windowMinutes: 300, resetsAt: null },
      },
    },
  ]);
  await vi.waitFor(() =>
    expect((remote as unknown as { pending: Set<string> }).pending.size).toBe(0),
  );
  expect(writes).not.toHaveBeenCalled();
});

function admissionClock(now: () => number) {
  remote.close();
  accounts = new ClusterNativeAccounts(codexRead, now, {
    claudeIdentity: async () => ({
      affinity: 'b'.repeat(64),
      authMethod: 'claude.ai',
      provider: 'firstParty',
    }),
    claudeUsage: (signal) => usageRead(signal),
  });
  remote = new ClusterRemoteAdmission(runtime, identity, now, accounts);
}

it('exposes pending identity without blocking bootstrap and recovers a failed read once after its TTL', async () => {
  let now = Date.now();
  admissionClock(() => now);
  let finish!: (value: unknown) => void;
  codexRead.mockRejectedValueOnce(new Error('Native history is still starting'));
  await remote.initialize();
  await vi.waitFor(() => expect(accounts.get('codex')?.state).toBe('setup-required'));
  expect(codexRead).toHaveBeenCalledTimes(1);
  now += 59_000;
  remote.snapshot();
  await vi.waitFor(() =>
    expect((remote as unknown as { pending: Set<string> }).pending.has('codex')).toBe(false),
  );
  expect(codexRead).toHaveBeenCalledTimes(1);
  codexRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  now += 1_001;
  for (let index = 0; index < 8; index++) remote.snapshot();
  expect(codexRead).toHaveBeenCalledTimes(2);
  expect(remote.snapshot().accounts.find((value) => value.provider === 'codex')).toMatchObject({
    state: 'unavailable',
    affinity: null,
    message: expect.stringContaining('Checking'),
  });
  expect(remote.snapshot().candidates).toEqual([]);
  finish({ accountId: nativeId, rateLimits: { primary: { usedPercent: 76 } } });
  await vi.waitFor(() => expect(accounts.get('codex')?.state).toBe('ready'));
  expect(
    remote.snapshot().accounts.find((value) => value.provider === 'codex')?.affinity,
  ).toBeTruthy();
  expect(codexRead).toHaveBeenCalledTimes(2);
  expect(usageRead).not.toHaveBeenCalled();
  expect(store.runs()).toEqual([]);
  vi.restoreAllMocks();
});

it('drops the old reader, allowance and grant authority when rediscovery observes another native account', async () => {
  let now = Date.now();
  admissionClock(() => now);
  const initial = await accounts.discover('codex');
  const reader = () => ({
    key: randomUUID(),
    controllerHostId: identity.controllerHostId,
    provider: 'codex',
    accountAffinity: initial.account.affinity,
    generation: randomUUID(),
    reader: true,
    expiresAt: new Date(now + 45000).toISOString(),
    cached: null,
  });
  remote.selectReader(reader());
  await vi.waitFor(() => expect(remote.snapshot().capacities).toHaveLength(1));
  const run = store.enqueue(managerId, randomUUID(), 'Owned saved input');
  prepared.add(run.id);
  const candidate = remote.snapshot().candidates[0]!;
  const { remoteProjectId: _remoteProjectId, ...runtimeIdentity } = identity;
  remote.inbox.push({
    key: randomUUID(),
    grant: {
      id: randomUUID(),
      ...runtimeIdentity,
      runId: run.id,
      provider: 'codex',
      accountAffinity: initial.account.affinity,
      requestHash: remoteRequestHash(candidate),
      policyRevision: '0',
      expiresAt: new Date(now + 59000).toISOString(),
      decision: 'allow',
      reason: 'Exact fixture',
    },
  });
  expect(runtime.nativeAdmissionReason(store.run(run.id))).toBeNull();
  nativeId = 'different-private-native-account';
  now += 61_000;
  remote.selectReader(reader());
  await vi.waitFor(() =>
    expect(accounts.get('codex')?.affinity).not.toBe(initial.account.affinity),
  );
  await vi.waitFor(() => expect(remote.snapshot().capacities).toEqual([]));
  expect(store.getSetting('capacity:v1:codex')).toBeNull();
  expect((remote as unknown as { readers: Map<string, unknown> }).readers.has('codex')).toBe(false);
  expect(runtime.nativeAdmissionReason(store.run(run.id))).toContain('controller QUARK admission');
  expect(runtime.nativeAdmissionConsume(store.run(run.id))).toBe(false);
  vi.restoreAllMocks();
});
