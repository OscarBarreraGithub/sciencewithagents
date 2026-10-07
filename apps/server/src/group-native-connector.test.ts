import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { groupSessionIdSchema } from '@dock/shared';
import { nativeGitExportRequestSchema } from './group-native-git-export.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { GroupEventRepository } from './group-events.js';
import { createGroupNativeConnector, configureGroupNativeRoute } from './group-native-connector.js';
import * as gitExportModule from './group-native-git-export.js';
import { GroupNativeJournal } from './group-native.js';
import { GroupDockerEngine } from './group-container.js';

it('unit normal factory validates persisted owner scope but rejects unchecked ready Engine/image', async () => {
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/native-connector-'));
  mkdirSync(join(root, 'workspace'));
  const store = new Store(join(root, 'host.sqlite'));
  modelFixture(store);
  store.setSetting('pulsar:policy', { enabled: false });
  const factory = vi.fn(async () => new DemoProvider());
  const runtime = new Runtime(store, root, 'UNUSED', factory, undefined, {
    workspace: join(root, 'workspace'),
  });
  const events = new GroupEventRepository(join(root, 'events.sqlite'));
  const connector = createGroupNativeConnector(runtime, {
    directory: join(root, 'native'),
    events,
  });
  try {
    expect(await connector.availability()).toMatchObject({
      available: false,
      productionReady: false,
      authState: 'unavailable',
    });
    const project = store.register(join(root, 'workspace'), 'Unit', '');
    configureGroupNativeRoute(runtime, {
      projectId: project.id,
      provider: 'codex',
      image: 'sha256:' + 'a'.repeat(64),
      resources: {
        workspace: join(root, 'workspace'),
        stateBase: join(root, 'state'),
        readResources: [],
        forbiddenPaths: [store.path],
        outbound: [],
      },
    });
    vi.spyOn(GroupDockerEngine.prototype, 'availability').mockResolvedValue({
      state: 'ready',
      runtimeSignature: 'b'.repeat(64),
      cpuCores: 1,
      memoryMb: 2048,
      nativeDesktop: 'Linux guest only; macOS native app control is unavailable',
    });
    const group = events.createGroup('Unit'),
      context = events.createContext({
        groupId: group.groupId,
        memberId: group.memberId,
        installationId: group.installationId,
        visibility: 'shared',
        provider: 'owner',
        nativeSessionId: randomUUID(),
      });
    const input = {
      requestId: randomUUID(),
      key: randomUUID(),
      enrollmentHandle: randomUUID(),
      context,
      text: 'unit',
    };
    expect(await connector.availability()).toMatchObject({
      available: false,
      productionReady: false,
      authState: 'unavailable',
    });
    expect(await connector.submit(input)).toMatchObject({ state: 'blocked' });
    const exports = connector.gitExports(async () => ({
      contextId: randomUUID(),
      guestRepository: '/workspace',
      revalidate: () => {},
    }));
    await expect(
      exports.acquire(
        nativeGitExportRequestSchema.parse({
          exportId: randomUUID(),
          operationId: 'unit',
          repositoryId: 'unit',
          resourceId: 'unit',
          scope: {
            groupId: context.groupId,
            memberId: context.memberId,
            installationId: context.installationId,
            visibility: 'shared',
            source: {
              sessionId: context.sessionId,
              nativeSessionId: context.nativeSessionId,
              provider: context.provider,
              messageId: randomUUID(),
            },
            causalRefs: [],
          },
          grantRevision: 'unit',
          reviewId: 'unit',
          sourceOid: 'a'.repeat(40),
          historyRevision: 'unit',
          contentPaths: ['public.txt'],
          maxObjects: 10,
          maxBytes: 1024,
          maxFileBytes: 512,
        }),
      ),
    ).rejects.toThrow(/Unknown local group context/);
    await expect(
      connector.submit({
        ...input,
        context: { ...context, sessionId: groupSessionIdSchema.parse(randomUUID()) },
      }),
    ).rejects.toThrow(/Persisted context/);
    expect(store.runs()).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await connector.close();
    await runtime.close();
    events.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('retained exact Git export admission proof survives the recent window and host restart', async () => {
  // Transport/Engine are deliberately absent: exercise the ACTUAL connector's
  // proof verifier against durable host journal/QUARK/Pulsar fixture records.
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/native-git-old-proof-'));
  mkdirSync(join(root, 'workspace'));
  let store = new Store(join(root, 'host.sqlite'));
  modelFixture(store);
  store.setSetting('pulsar:policy', { enabled: false });
  const factory = vi.fn(async () => new DemoProvider());
  const makeRuntime = () =>
    new Runtime(store, root, 'UNUSED', factory, undefined, {
      workspace: join(root, 'workspace'),
    });
  let runtime = makeRuntime();
  const events = new GroupEventRepository(join(root, 'events.sqlite')),
    directory = join(root, 'native');
  let verify: Parameters<typeof gitExportModule.createGroupNativeGitExports>[0]['verifyAdmission'];
  vi.spyOn(gitExportModule, 'createGroupNativeGitExports').mockImplementation((options) => {
    verify = options.verifyAdmission;
    return { acquire: vi.fn(), inspect: vi.fn(), close: () => {} };
  });
  let connector = createGroupNativeConnector(runtime, { directory, events });
  const journal = new GroupNativeJournal(join(directory, 'native-identities.sqlite'), events);
  try {
    const project = store.register(join(root, 'workspace'), 'Retained Git proof', ''),
      group = events.createGroup('Proof'),
      handle = journal.issue(
        {
          groupId: group.groupId,
          memberId: group.memberId,
          installationId: group.installationId,
          visibility: 'shared',
        },
        project.managerId,
        'codex',
      ),
      context = journal.resolve(handle).context,
      run = store.enqueue(project.managerId, randomUUID(), 'Synthetic retained export proof'),
      containerId = 'a'.repeat(64),
      proof = { contextId: context.sessionId, runId: run.id, containerId };
    expect(runtime.pulsar.reserve(store.run(run.id), new Set())).toBe(true);
    runtime.quark.begin(store.run(run.id));
    store.updateRun(run.id, { status: 'running' });
    journal.runtimeEvent(handle, 'container-created', { container: containerId });
    journal.runtimeEvent(handle, 'container-stopped', { container: containerId });
    store.updateRun(run.id, { status: 'completed' });
    runtime.pulsar.settle(run.id);
    runtime.quark.sync();
    const authorize = vi.fn(async () => ({
      contextId: context.sessionId,
      guestRepository: '/workspace',
      revalidate: () => {},
    }));
    connector.gitExports(authorize);
    expect(() => verify(proof)).not.toThrow();
    // Age the durable fixture ledger beyond the actual recent SQL window;
    // no mock replaces either ledger read or the connector proof verifier.
    const ledger = runtime.quark.runLedger(run.id)!;
    store.db
      .prepare('UPDATE quark_runs SET body=? WHERE run_id=?')
      .run(
        JSON.stringify({ ...ledger, finishedAt: new Date(Date.now() - 121_000).toISOString() }),
        run.id,
      );
    expect(runtime.quark.runs(true).some((row) => row.runId === run.id)).toBe(false);
    expect(() => verify(proof)).not.toThrow();
    await connector.close();
    await runtime.close();
    store.close();
    store = new Store(join(root, 'host.sqlite'));
    runtime = makeRuntime();
    connector = createGroupNativeConnector(runtime, { directory, events });
    connector.gitExports(authorize);
    expect(runtime.quark.runLedger(run.id)?.runId).toBe(run.id);
    expect(runtime.quark.runs(true).some((row) => row.runId === run.id)).toBe(false);
    expect(() => verify(proof)).not.toThrow();
    expect(() => verify({ ...proof, containerId: 'b'.repeat(64) })).toThrow(/invalid or stopping/);
    store.setSetting(`group:native-stop-unverified:${run.id}`, true);
    expect(() => verify(proof)).toThrow(/invalid or stopping/);
    store.setSetting(`group:native-stop-unverified:${run.id}`, null);
    store.db.prepare('DELETE FROM pulsar_leases WHERE run_id=?').run(run.id);
    expect(() => verify(proof)).toThrow(/invalid or stopping/);
    expect(factory).not.toHaveBeenCalled();
  } finally {
    await connector.close();
    await runtime.close();
    journal.close();
    events.close();
    store.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
