import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultModelPolicy,
  newProjectWorkflow,
  pulsarPolicySchema,
  remoteAdmissionSnapshotSchema,
  type RemoteAdmissionGrant,
} from '@dock/shared';
import { Store, Conflict } from './store.js';
import { ClusterProjects } from './cluster-projects.js';
import { ClusterDevelopmentAllocations } from './cluster-development.js';
import { ClusterProjectRuntimes } from './cluster-runtime.js';
import {
  ClusterAdmissionController,
  type RemoteAdmissionLedger,
} from './cluster-admission-controller.js';
import { remoteRequestHash } from './cluster-admission-request.js';
let root: string | undefined, store: Store | undefined;
afterEach(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('stops polling a released allocation, retains saved accounts and history, and resumes sync after reopen', async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-released-admission-'));
  store = new Store(join(root, 'dock.sqlite'));
  const data = store;
  const registered = data.register(root, 'Retained remote history', '', 'codex');
  const agentId = registered.managerId;
  const entry = {
    id: randomUUID(),
    agentId,
    runId: null,
    kind: 'assistant' as const,
    title: 'Agent',
    text: 'Retained native reply',
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  data.entry(entry);
  const projectId = randomUUID();
  const identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: projectId,
    remoteProjectId: randomUUID(),
    jobId: '42',
    leaseToken: randomUUID(),
  };
  const account = {
    provider: 'codex' as const,
    affinity: 'a'.repeat(64),
    identityBasis: 'native' as const,
    state: 'ready' as const,
    observedAt: new Date().toISOString(),
    message: 'Verified native identity',
  };
  const savedAccounts = { accounts: [account], observedAt: new Date().toISOString() };
  data.setSetting('cluster-admission:accounts:' + projectId, savedAccounts);
  const lease = {
    projectId,
    token: identity.leaseToken,
    username: 'owner',
    alias: 'cluster',
    configuration: 'a'.repeat(64),
    state: 'released',
    jobId: '42',
    node: 'compute1',
    createdAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    message: 'Released the owned idle development allocation.',
  };
  data.setSetting('cluster-development:' + projectId, lease);
  data.setSetting('cluster-admission:controller-status:' + projectId, {
    state: 'unavailable',
    observedAt: new Date().toISOString(),
    message: 'This computer could not authenticate its saved connection.',
  });
  const allocations = new ClusterDevelopmentAllocations(data);
  const ledger: RemoteAdmissionLedger = {
    observeCapacity: async () => {},
    status: () => [],
    policyFor: () => pulsarPolicySchema.parse({}),
    schedulingEnabled: () => false,
    saveBudget: () => {},
    savePolicy: () => {},
    decide: async () => {
      throw Error('No grant authorized');
    },
    settle: async () => {},
  };
  const controller = new ClusterAdmissionController(
    data,
    {
      list: () => [{ id: projectId, remoteProjectId: identity.remoteProjectId }],
      record: () => ({
        id: projectId,
        controllerHostId: identity.controllerHostId,
        remoteWorkspaceId: identity.remoteHostId,
        remoteProjectId: identity.remoteProjectId,
        manager: { provider: 'codex' },
      }),
      runtimes: { allocations },
    } as unknown as ClusterProjects,
    ledger,
    () => 1000,
  );
  const network = vi.fn(async (_id: string, method: string) =>
    method === 'GET'
      ? remoteAdmissionSnapshotSchema.parse({
          identity,
          followQuark: false,
          accounts: [account],
          candidates: [],
          receipts: [],
          capacities: [],
        })
      : { accepted: true },
  );
  (controller as unknown as { request: typeof network }).request = network;
  for (let i = 0; i < 3; i++) await controller.tick();
  expect(network).not.toHaveBeenCalled();
  expect(data.getSetting('cluster-admission:controller-status:' + projectId)).toMatchObject({
    state: 'idle',
    message: 'Allocation released. Open this project to reconnect.',
  });
  expect(data.getSetting('cluster-admission:accounts:' + projectId)).toEqual(savedAccounts);
  expect(data.getSetting('cluster-development:' + projectId)).toEqual(lease);
  expect(data.db.prepare('SELECT body FROM entries WHERE id=?').get(entry.id)?.body).toBe(
    JSON.stringify(entry),
  );
  data.setSetting('cluster-development:' + projectId, { ...lease, state: 'ready' });
  await controller.tick();
  expect(network).toHaveBeenCalledTimes(2);
  expect(data.getSetting('cluster-admission:controller-status:' + projectId)).toMatchObject({
    state: 'ready',
  });
  network.mockRejectedValueOnce(Error('Active allocation gateway failed'));
  await controller.tick();
  expect(data.getSetting('cluster-admission:controller-status:' + projectId)).toMatchObject({
    state: 'unavailable',
    message: 'Active allocation gateway failed',
  });
  network.mockImplementationOnce(async () => {
    data.setSetting('cluster-development:' + projectId, lease);
    throw Error('A read already in flight ended after release');
  });
  await controller.tick();
  expect(data.getSetting('cluster-admission:controller-status:' + projectId)).toMatchObject({
    state: 'idle',
    message: 'Allocation released. Open this project to reconnect.',
  });
  const afterRelease = network.mock.calls.length;
  await controller.tick();
  expect(network).toHaveBeenCalledTimes(afterRelease);
  await controller.close();
});
it.each([
  { followQuark: true, accountEnabled: true },
  { followQuark: false, accountEnabled: true },
  { followQuark: true, accountEnabled: false },
])(
  'retains exact delivery with project Follow QUARK $followQuark and account pacing $accountEnabled',
  async ({ followQuark, accountEnabled }) => {
    root = mkdtempSync(join(tmpdir(), 'swa-broker-'));
    store = new Store(join(root, 'dock.sqlite'));
    const data = store;
    const folder = {
      alias: 'cluster',
      rootId: randomUUID(),
      folderId: randomUUID(),
      path: '/home/owner/project',
      username: 'owner',
      account: 'owner_lab',
      development: {
        partition: 'test',
        qos: null,
        cpus: 2,
        memoryMb: 8192,
        timeMinutes: 120,
        idleMinutes: 20,
      },
      workflow: newProjectWorkflow(defaultModelPolicy),
      indexObservedAt: new Date().toISOString(),
      connectionId: randomUUID(),
    };
    const allocations = new ClusterDevelopmentAllocations(data),
      projects = new ClusterProjects(
        data,
        { resolveFolder: async () => folder },
        new ClusterProjectRuntimes(data, allocations, async () => {
          throw Error('No deployment');
        }),
        () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
      );
    const project = await projects.create({
        key: randomUUID(),
        folderId: folder.folderId,
        name: 'Remote',
        manager: { provider: 'codex', model: 'native-model', effort: 'high' },
      }),
      record = projects.record(project.id),
      remoteProjectId = randomUUID(),
      remoteHostId = randomUUID(),
      runId = randomUUID(),
      leaseToken = randomUUID();
    data.setSetting('cluster-project:' + project.id, {
      ...record,
      remoteProjectId,
      remoteManagerId: randomUUID(),
      remoteWorkspaceId: remoteHostId,
    });
    data.setSetting('cluster-development:' + project.id, {
      projectId: project.id,
      token: leaseToken,
      username: 'owner',
      alias: 'cluster',
      configuration: 'a'.repeat(64),
      state: 'ready',
      jobId: '42',
      node: 'compute1',
      createdAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      message: 'RUNNING',
    });
    let capacityObserved = 0;
    let calls = 0,
      lost = true;
    const deliveries: { key: string; grant: RemoteAdmissionGrant }[] = [],
      events: string[] = [];
    const snapshot = remoteAdmissionSnapshotSchema.parse({
      identity: {
        controllerHostId: record.controllerHostId,
        remoteHostId,
        clusterProjectId: project.id,
        remoteProjectId,
        jobId: '42',
        leaseToken,
      },
      followQuark,
      accounts: [
        {
          provider: 'codex',
          affinity: 'a'.repeat(64),
          identityBasis: 'native',
          state: 'ready',
          observedAt: new Date().toISOString(),
          message: 'Verified',
        },
      ],
      candidates: [
        {
          runId,
          agentId: randomUUID(),
          projectId: remoteProjectId,
          projectName: 'Remote',
          provider: 'codex',
          accountAffinity: 'a'.repeat(64),
          model: 'native-model',
          effort: 'high',
          taskClass: 'manager',
          followQuark,
          kind: 'user',
          estimate: {},
          createdAt: new Date().toISOString(),
        },
      ],
      receipts: [],
      capacities: [],
    });
    const ledger: RemoteAdmissionLedger = {
      observeCapacity: async () => {
        capacityObserved++;
      },
      status: () => [],
      policyFor: () => pulsarPolicySchema.parse({}),
      schedulingEnabled: () => accountEnabled,
      saveBudget: () => {},
      savePolicy: () => {
        events.push('saved');
        return pulsarPolicySchema.parse({ revision: 1 });
      },
      decide: async (identity, account, candidate) => {
        calls++;
        return {
          id: randomUUID(),
          controllerHostId: identity.controllerHostId,
          remoteHostId: identity.remoteHostId,
          clusterProjectId: identity.clusterProjectId,
          jobId: identity.jobId,
          leaseToken: identity.leaseToken,
          runId: candidate.runId,
          provider: account.provider,
          accountAffinity: account.affinity!,
          requestHash: remoteRequestHash(candidate),
          policyRevision: '0',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          decision: 'allow',
          reason: 'Fixture',
        };
      },
      settle: async (_identity, _account, receipt) => {
        if (!deliveries.some((delivery) => delivery.grant.id === receipt.grantId))
          throw new Conflict('Stale receipt');
        events.push('settled');
      },
    };
    const controller = new ClusterAdmissionController(data, projects, ledger);
    (
      controller as unknown as {
        request: (
          project: string,
          method: string,
          path: string,
          body?: unknown,
        ) => Promise<unknown>;
      }
    ).request = async (_project, method, path, body) => {
      if (method === 'GET') return snapshot;
      if (path.endsWith('/reader')) {
        const input = body as { generation: string };
        if (followQuark && accountEnabled)
          snapshot.capacities = [
            {
              provider: 'codex',
              accountAffinity: 'a'.repeat(64),
              readerHostId: remoteHostId,
              generation: input.generation,
              ordinaryUsageAllowed: true,
              capacity: {
                provider: 'codex',
                account: 'local-sign-in',
                label: 'Cluster',
                plan: null,
                source: 'codex-native',
                state: 'ready',
                stale: false,
                observedAt: new Date().toISOString(),
                attemptedAt: new Date().toISOString(),
                nextRefreshAt: null,
                message: 'Native',
                windows: [
                  {
                    id: 'primary',
                    label: 'Primary',
                    scope: 'general',
                    model: null,
                    usedPercent: 1,
                    windowMinutes: 300,
                    resetsAt: null,
                  },
                ],
                weeklyPolicy: 'not-reported',
              },
            },
          ];
        return { accepted: true };
      }
      if (path.endsWith('/grants')) {
        const input = body as { key: string; grant: RemoteAdmissionGrant };
        deliveries.push(input);
        if (lost) {
          lost = false;
          throw Error('Lost receipt');
        }
        return {
          key: input.key,
          accepted: true,
          grantId: input.grant.id,
          runId,
          decision: 'allow',
        };
      }
      if (path.endsWith('/revoke')) {
        events.push('revoked');
        const grant = (body as { grant: RemoteAdmissionGrant }).grant;
        return {
          state: 'unused',
          receipt: {
            grantId: grant.id,
            runId,
            provider: 'codex',
            accountAffinity: 'a'.repeat(64),
            state: 'unused',
            startedAt: null,
            finishedAt: new Date().toISOString(),
            basis: 'measured',
            usage: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
            },
          },
        };
      }
      return {};
    };
    for (let i = 0; i < 300; i++) data.setSetting(`cluster-admission:delivery:old-${i}`, null);
    await controller.tick();
    expect(calls).toBe(followQuark && accountEnabled ? 0 : 1);
    snapshot.receipts = [
      {
        grantId: randomUUID(),
        runId: randomUUID(),
        provider: 'codex',
        accountAffinity: 'a'.repeat(64),
        state: 'complete',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        basis: 'unknown',
        usage: {
          totalTokens: null,
          inputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
        },
      },
    ];
    await controller.tick();
    await controller.tick();
    expect(calls).toBe(1);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    if (followQuark && accountEnabled) {
      snapshot.followQuark = false;
      snapshot.candidates[0]!.followQuark = false;
      await controller.tick();
      expect(events).toEqual(['revoked', 'settled']);
      expect(calls).toBe(2);
      expect(deliveries.at(-1)!.grant.requestHash).toBe(remoteRequestHash(snapshot.candidates[0]!));
      expect(deliveries.at(-1)!.grant.id).not.toBe(deliveries[0]!.grant.id);
      events.length = 0;
    }
    snapshot.candidates = [];
    const before = capacityObserved;
    await controller.tick();
    expect(capacityObserved).toBe(before + Number(followQuark && accountEnabled));
    if (!followQuark || !accountEnabled)
      expect(data.getSetting(`cluster-admission:controller-status:${project.id}`)).toMatchObject({
        state: 'ready',
        message: expect.stringContaining('off'),
      });
    expect(
      controller.controls(project.id).accounts.find((value) => value.provider === 'codex')?.policy,
    ).toBeNull();
    await controller.savePolicy(project.id, {
      provider: 'codex',
      expectedAccountAffinity: 'a'.repeat(64),
      update: { key: randomUUID(), policy: pulsarPolicySchema.parse({}) },
    });
    expect(events).toEqual(['revoked', 'settled', 'saved']);
    await controller.close();
  },
);

function accountControlsFixture() {
  root = mkdtempSync(join(tmpdir(), 'swa-affinity-controls-'));
  store = new Store(join(root, 'dock.sqlite'));
  const data = store,
    projectId = randomUUID(),
    remoteProjectId = randomUUID(),
    affinity = 'a'.repeat(64),
    other = 'b'.repeat(64);
  const saved: { kind: string; account: unknown; input: unknown }[] = [];
  const ledger: RemoteAdmissionLedger = {
    observeCapacity: async () => {},
    status: () => [],
    policyFor: () => pulsarPolicySchema.parse({}),
    schedulingEnabled: () => true,
    decide: async () => {
      throw Error('No new grants');
    },
    settle: async () => {
      throw Error('Stale control must not settle');
    },
    savePolicy: (account, input) => {
      saved.push({ kind: 'policy', account, input });
      return data.operation('fixture-policy:' + (input as { key: string }).key, input, () =>
        pulsarPolicySchema.parse({ revision: 1 }),
      );
    },
    saveBudget: (account, input) => {
      saved.push({ kind: 'budget', account, input });
      return data.operation('fixture-budget:' + (input as { key: string }).key, input, () => ({
        saved: true,
      }));
    },
  };
  const controller = new ClusterAdmissionController(
    data,
    { record: () => ({ remoteProjectId }) } as unknown as ClusterProjects,
    ledger,
  );
  const setAccount = (value: string) =>
    data.setSetting('cluster-admission:accounts:' + projectId, {
      observedAt: new Date().toISOString(),
      accounts: [
        {
          provider: 'codex',
          affinity: value,
          identityBasis: 'native',
          state: 'ready',
          observedAt: new Date().toISOString(),
          message: 'Verified',
        },
      ],
    });
  setAccount(affinity);
  const policy = {
    provider: 'codex',
    expectedAccountAffinity: affinity,
    update: { key: randomUUID(), policy: pulsarPolicySchema.parse({}) },
  };
  const budget = {
    provider: 'codex',
    expectedAccountAffinity: affinity,
    budget: {
      key: randomUUID(),
      projectId: remoteProjectId,
      provider: 'codex',
      windowId: 'primary',
      limitPercent: 10,
    },
  };
  const mutable = controller as unknown as {
    request: (project: string, method: string, path: string, body?: unknown) => Promise<unknown>;
    active: Map<string, Promise<void>>;
    intents: () => { grant: RemoteAdmissionGrant; projectId: string; identity: unknown }[];
  };
  let requests = 0;
  mutable.request = async () => {
    requests++;
    throw Error('No stale-account revocation');
  };
  return {
    data,
    controller,
    ledger,
    mutable,
    projectId,
    affinity,
    other,
    setAccount,
    policy,
    budget,
    saved,
    requests: () => requests,
  };
}
it.each(['policy', 'budget'] as const)(
  'rejects stale account A %s controls after native account B is verified without revocation or save',
  async (kind) => {
    const f = accountControlsFixture();
    f.setAccount(f.other);
    const before = f.data.db.prepare('SELECT key,value FROM settings ORDER BY key').all();
    await expect(
      kind === 'policy'
        ? f.controller.savePolicy(f.projectId, f.policy)
        : f.controller.saveBudget(f.projectId, f.budget),
    ).rejects.toThrow(/account changed/);
    expect(f.requests()).toBe(0);
    expect(f.saved).toEqual([]);
    expect(f.data.db.prepare('SELECT key,value FROM settings ORDER BY key').all()).toEqual(before);
    await f.controller.close();
  },
);
it.each(['policy', 'budget'] as const)(
  'preserves the exact %s request and original account across an explicit same-key retry',
  async (kind) => {
    const f = accountControlsFixture();
    const save = () =>
      kind === 'policy'
        ? f.controller.savePolicy(f.projectId, f.policy)
        : f.controller.saveBudget(f.projectId, f.budget);
    const first = await save();
    const retried = await save();
    expect(retried).toEqual(first);
    expect(f.saved).toHaveLength(2);
    expect(f.saved[1]).toEqual(f.saved[0]);
    expect(f.saved[0]!.account).toEqual({ provider: 'codex', affinity: f.affinity });
    expect(f.requests()).toBe(0);
    await f.controller.close();
  },
);
it('rechecks account identity after awaiting an active controller sync before any revocation or save', async () => {
  const f = accountControlsFixture();
  let finish!: () => void;
  const active = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.mutable.active.set('other-project', active);
  const saving = f.controller.savePolicy(f.projectId, f.policy);
  f.setAccount(f.other);
  finish();
  await expect(saving).rejects.toThrow(/account changed/);
  expect(f.requests()).toBe(0);
  expect(f.saved).toEqual([]);
  await f.controller.close();
});
it('rechecks account identity after a revoke reply before settlement or committing controls', async () => {
  const f = accountControlsFixture(),
    grantId = randomUUID(),
    runId = randomUUID();
  f.data.setSetting('cluster-admission:delivery:' + runId, { retained: true });
  f.mutable.intents = () => [
    {
      projectId: f.projectId,
      identity: {},
      grant: {
        id: grantId,
        runId,
        provider: 'codex',
        accountAffinity: f.affinity,
      } as RemoteAdmissionGrant,
    },
  ];
  f.mutable.request = async () => {
    f.setAccount(f.other);
    return {
      state: 'unused',
      receipt: {
        grantId,
        runId,
        provider: 'codex',
        accountAffinity: f.affinity,
        state: 'unused',
        startedAt: null,
        finishedAt: new Date().toISOString(),
        basis: 'unknown',
        usage: {
          totalTokens: null,
          inputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
        },
      },
    };
  };
  await expect(f.controller.savePolicy(f.projectId, f.policy)).rejects.toThrow(/account changed/);
  expect(f.saved).toEqual([]);
  expect(f.data.getSetting('cluster-admission:delivery:' + runId)).toEqual({ retained: true });
  await f.controller.close();
});
