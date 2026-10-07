import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { GroupEventRepository } from './group-events.js';
import { GroupNativeBridge, GroupNativeJournal } from './group-native.js';
import { GroupNativeAuth } from './group-native-auth.js';
import { GroupNativeExecution } from './group-native-execution.js';
import { GroupDockerEngine, GroupNamespaceStopUnverified } from './group-container.js';
import { randomUUID } from 'node:crypto';
import type { CodexRpc } from './codex.js';

let root: string,
  store: Store,
  runtime: Runtime,
  journal: GroupNativeJournal,
  repository: GroupEventRepository;
let agent: string;
const factory = vi.fn(async () => new DemoProvider());
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = realpathSync.native(mkdtempSync('data/tests/group-auth-runtime-'));
  mkdirSync(join(root, 'workspace'));
  store = new Store(join(root, 'host.sqlite'));
  modelFixture(store);
  agent = store.register(join(root, 'workspace'), 'Auth fixture', '').managerId;
  store.updateAgent(agent, { model: 'demo', effort: 'high', toolPolicy: 'native' });
  store.setSetting('pulsar:policy', { enabled: false });
  repository = new GroupEventRepository(join(root, 'events.sqlite'));
  journal = new GroupNativeJournal(join(root, 'native.sqlite'), repository);
  runtime = new Runtime(store, root, 'UNUSED_NATIVE_BINARY', factory, undefined, {
    workspace: join(root, 'workspace'),
  });
  factory.mockClear();
});
afterEach(async () => {
  await runtime.close();
  journal.close();
  repository.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function request() {
  const group = repository.createGroup('Fixture');
  const handle = journal.issue(
    {
      groupId: group.groupId,
      memberId: group.memberId,
      installationId: group.installationId,
      visibility: 'shared',
    },
    agent,
    'codex',
  );
  const bridge = new GroupNativeBridge(journal, store, runtime.modelPolicy, runtime.quark);
  return {
    handle,
    bridge,
    resources: {
      revision: 1,
      expiresAt: Date.now() + 60_000,
      workspace: join(root, 'workspace'),
      readResources: [],
      executables: ['/usr/bin/false'],
      runtimeFiles: [],
      stateBase: join(root, 'state'),
      forbiddenPaths: [join(root, 'host.sqlite')],
      requireNestedSandbox: false,
    },
  };
}
it('scheduler unit keeps the fake auth probe queued behind actual pause, then retains QUARK admission until owned close without ordinary-provider launch', async () => {
  const { bridge, handle, resources } = request();
  const fakeProvider = new EventEmitter() as CodexRpc;
  const release = vi.fn(async () => {});
  let auth: GroupNativeAuth | undefined;
  const probe = vi.spyOn(bridge, 'probeAuthentication').mockImplementation(async (runId) => {
    expect(store.run(runId).status).toBe('running');
    expect(runtime.quark.executing().has(agent)).toBe(true);
    expect(runtime.pulsar.hasReservation(runId)).toBe(true);
    expect(runtime.quark.runs().find((run) => run.runId === runId)?.finishedAt).toBeNull();
    auth = new GroupNativeAuth(fakeProvider, () => {}, release);
    return auth;
  });
  store.setSetting('scheduler:settings', { maxConcurrent: 1, paused: true });
  await runtime.initialize();
  const queued = runtime.queueGroupAuthentication(bridge, handle, resources);
  await new Promise<void>((done) => setTimeout(done, 30));
  expect(store.run(queued.runId).status).toBe('queued');
  expect(probe).not.toHaveBeenCalled();
  store.setSetting('scheduler:settings', { maxConcurrent: 1, paused: false });
  runtime.kick();
  expect(await queued.admitted).toBe(auth);
  expect(factory).not.toHaveBeenCalled();
  await expect(runtime.client(store.agent(agent))).rejects.toThrow(
    /dedicated group authentication/,
  );
  await runtime.interrupt(agent);
  await expect.poll(() => runtime.quark.executing().has(agent)).toBe(false);
  expect(store.run(queued.runId).status).toBe('interrupted');
  expect(release).toHaveBeenCalledOnce();
});
it('lost durable auth lane fails closed on restart and never becomes an ordinary turn', async () => {
  store.setSetting(`group:native-auth-agent:${agent}`, { contextId: 'lost-fixture-context' });
  const run = store.enqueue(agent, 'owned-auth-fixture', 'No provider turn');
  await runtime.initialize();
  await expect.poll(() => store.run(run.id).status).toBe('failed');
  expect(factory).not.toHaveBeenCalled();
  expect(store.agent(agent).threadId).toBeNull();
});

it('cancels an admission-held auth probe without starting a provider or permitting reuse', async () => {
  const { bridge, handle, resources } = request();
  store.setSetting('scheduler:settings', { maxConcurrent: 1, paused: true });
  await runtime.initialize();
  const queued = runtime.queueGroupAuthentication(bridge, handle, resources);
  const rejected = expect(queued.admitted).rejects.toThrow(/cancelled/);
  await runtime.interrupt(agent);
  await rejected;
  expect(store.run(queued.runId).status).toBe('cancelled');
  expect(factory).not.toHaveBeenCalled();
  expect(() => runtime.queueGroupAuthentication(bridge, handle, resources)).toThrow(
    /new dedicated/,
  );
});

it('full-execution unit lane uses the same real admission and never starts the ordinary provider', async () => {
  const { bridge, handle } = request();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const capability = {
    closed,
    close: vi.fn(async () => {
      finish();
    }),
  };
  const probe = vi.spyOn(bridge, 'probeExecution').mockImplementation(async (runId) => {
    expect(store.run(runId).status).toBe('running');
    expect(runtime.pulsar.hasReservation(runId)).toBe(true);
    expect(runtime.quark.executing().has(agent)).toBe(true);
    return capability as unknown as import('./group-native-execution.js').GroupNativeExecution;
  });
  await runtime.initialize();
  const queued = runtime.queueGroupExecutionProbe(bridge, handle, {
    image: 'sha256:' + 'a'.repeat(64),
    workspace: join(root, 'workspace'),
    readResources: [],
    stateBase: root,
    forbiddenPaths: [join(root, 'host.sqlite')],
    expiresAt: Date.now() + 60000,
    outbound: [],
  });
  expect(await queued.admitted).toBe(capability);
  expect(probe).toHaveBeenCalledOnce();
  expect(factory).not.toHaveBeenCalled();
  await runtime.interrupt(agent);
  expect(capability.close).toHaveBeenCalledOnce();
  await expect.poll(() => runtime.quark.executing().has(agent)).toBe(false);
});

it('failed full-route namespace stop retains actual admission and a durable hold instead of acknowledging stop', async () => {
  const { bridge, handle } = request();
  const { GroupNamespaceStopUnverified } = await import('./group-container.js');
  vi.spyOn(bridge, 'probeExecution').mockRejectedValue(new GroupNamespaceStopUnverified());
  await runtime.initialize();
  const queued = runtime.queueGroupExecutionProbe(bridge, handle, {
    image: 'sha256:' + 'a'.repeat(64),
    workspace: join(root, 'workspace'),
    readResources: [],
    stateBase: root,
    forbiddenPaths: [join(root, 'host.sqlite')],
    expiresAt: Date.now() + 60000,
    outbound: [],
  });
  await expect(queued.admitted).rejects.toThrow();
  await expect
    .poll(() => store.getSetting(`group:native-stop-unverified:${queued.runId}`))
    .toBe(true);
  expect(runtime.pulsar.hasReservation(queued.runId)).toBe(true);
  expect(runtime.quark.executing().has(agent)).toBe(true);
  expect(store.run(queued.runId).status).toBe('running');
  expect(factory).not.toHaveBeenCalled();
});

it('unit production requests retain per-execution QUARK admission and exact dedicated context across turns', async () => {
  const { bridge, handle } = request();
  const observed: string[] = [];
  vi.spyOn(bridge, 'prepareExecution').mockImplementation(async (runId) => {
    observed.push(runId);
    expect(runtime.pulsar.hasReservation(runId)).toBe(true);
    expect(runtime.quark.executing().has(agent)).toBe(true);
    let finish!: () => void;
    return {
      closed: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      close: async () => finish(),
    } as unknown as import('./group-native-execution.js').GroupNativeExecution;
  });
  await runtime.initialize();
  const resources = {
    image: 'sha256:' + 'a'.repeat(64),
    workspace: join(root, 'workspace'),
    readResources: [],
    stateBase: root,
    forbiddenPaths: [join(root, 'host.sqlite')],
    expiresAt: Date.now() + 60000,
    outbound: [],
  };
  const first = runtime.queueGroupNativeRequest(bridge, handle, resources);
  const firstCap = await first.admitted;
  const second = runtime.queueGroupNativeRequest(bridge, handle, resources);
  expect(store.run(second.runId).status).toBe('queued');
  await firstCap.close();
  const secondCap = await second.admitted;
  expect(observed).toEqual([first.runId, second.runId]);
  expect(factory).not.toHaveBeenCalled();
  await secondCap.close();
});

it('admitted close failure retains unfinished QUARK/Pulsar and blocks replacement through sync, shutdown and restart', async () => {
  const { bridge, handle } = request();
  const capability = {
    closed: new Promise<void>(() => {}),
    close: vi.fn(async () => {
      throw new GroupNamespaceStopUnverified();
    }),
  };
  vi.spyOn(bridge, 'probeExecution').mockResolvedValue(
    capability as unknown as GroupNativeExecution,
  );
  store.setSetting('scheduler:settings', { maxConcurrent: 1, paused: false });
  await runtime.initialize();
  const queued = runtime.queueGroupExecutionProbe(bridge, handle, {
    image: 'sha256:' + 'a'.repeat(64),
    workspace: null,
    readResources: [],
    stateBase: root,
    forbiddenPaths: [store.path],
    expiresAt: Date.now() + 60000,
    outbound: [],
  });
  expect(await queued.admitted).toBe(capability);
  await expect(runtime.interrupt(agent)).rejects.toThrow(GroupNamespaceStopUnverified);
  const retained = (host: Runtime) => {
    host.quark.sync();
    host.pulsar.reconcile();
    expect(store.run(queued.runId).status).toBe('running');
    expect(store.getSetting(`group:native-stop-intent:${queued.runId}`)).toBeTruthy();
    expect(store.getSetting(`group:native-stop-unverified:${queued.runId}`)).toBe(true);
    expect(host.quark.runs().find((run) => run.runId === queued.runId)?.finishedAt).toBeNull();
    expect(host.quark.executing().has(agent)).toBe(true);
    expect(host.pulsar.admittedResources(queued.runId)).toMatchObject({ cpuCores: 0.25 });
    const lease = store.db
      .prepare('SELECT body FROM pulsar_leases WHERE run_id=?')
      .get(queued.runId);
    expect(JSON.parse(String(lease!.body))).toMatchObject({
      finishedAt: null,
      tokenBasis: 'reserved',
    });
    expect(
      host.quark.holds().find((hold) => hold.runId === queued.runId)?.stopAcknowledgedAt,
    ).toBeFalsy();
  };
  retained(runtime);
  expect(() => runtime.queueGroupNativeRequest(bridge, handle, {} as never)).toThrow(
    /stopped production context/,
  );
  const replacement = store.addAgent({
    projectId: store.agent(agent).projectId,
    parentId: null,
    taskId: null,
    role: 'implementer',
    name: 'Replacement unit',
    cwd: join(root, 'workspace'),
    provider: 'codex',
  });
  const next = store.enqueue(replacement.id, randomUUID(), 'Must stay queued');
  runtime.kick();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(store.run(next.id).status).toBe('queued');
  await runtime.close();
  retained(runtime);
  const restarted = new Runtime(store, root, 'UNUSED_NATIVE_BINARY', factory, undefined, {
    workspace: join(root, 'workspace'),
  });
  try {
    await restarted.initialize();
    retained(restarted);
    restarted.kick();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(store.run(next.id).status).toBe('queued');
    expect(factory).not.toHaveBeenCalled();
  } finally {
    await restarted.close();
  }
});

it('real bridge authorization survives admission-only pause, keeps next request queued, and rejects actual revocations', async () => {
  const { bridge, handle } = request();
  // Protocol/lifecycle unit: no Engine, image, native provider or account is used.
  vi.spyOn(GroupDockerEngine.prototype, 'availability').mockResolvedValue({
    state: 'ready',
    runtimeSignature: 'b'.repeat(64),
    cpuCores: 1,
    memoryMb: 2048,
    nativeDesktop: 'Linux guest only; macOS native app control is unavailable',
  });
  vi.spyOn(GroupNativeExecution.prototype, 'initialize').mockResolvedValue();
  const nextPrepare = vi.spyOn(bridge, 'prepareExecution').mockImplementation(async () => {
    let finish!: () => void;
    return {
      closed: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      close: async () => finish(),
    } as unknown as GroupNativeExecution;
  });
  await runtime.initialize();
  const resources = {
    image: 'sha256:' + 'a'.repeat(64),
    workspace: null,
    readResources: [],
    stateBase: root,
    forbiddenPaths: [store.path],
    expiresAt: Date.now() + 60000,
    outbound: [],
  };
  const first = runtime.queueGroupExecutionProbe(bridge, handle, resources);
  const current = await first.admitted;
  store.setSetting('scheduler:settings', { maxConcurrent: 1, paused: true });
  const next = runtime.queueGroupNativeRequest(bridge, handle, resources);
  // reconcile unknown receipt does no provider I/O, but uses the exact live
  // authorization closure used by native tools and the container watchdog.
  await expect(current.reconcile(randomUUID())).resolves.toBeUndefined();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(store.run(first.runId).status).toBe('running');
  expect(store.run(next.runId).status).toBe('queued');
  expect(nextPrepare).not.toHaveBeenCalled();
  expect(runtime.pulsar.admittedResources(first.runId)).toBeTruthy();
  store.setSetting(`quark:project:${store.agent(agent).projectId}`, { paused: true });
  await expect(current.reconcile(randomUUID())).rejects.toThrow(/project is paused/);
  store.setSetting(`quark:project:${store.agent(agent).projectId}`, { paused: false });
  runtime.quark.hold(store.run(first.runId), 'Actual manual revocation');
  await expect(current.reconcile(randomUUID())).rejects.toThrow(/Actual manual revocation/);
  // Remove only this fabricated manual hold in the unit fixture.
  store.db.prepare('DELETE FROM settings WHERE key=?').run(`quark:hold:${first.runId}`);
  store.setSetting(`group:native-stop-intent:${first.runId}`, {
    requestedAt: new Date().toISOString(),
  });
  await expect(current.reconcile(randomUUID())).rejects.toThrow(/QUARK execution/);
  store.setSetting(`group:native-stop-intent:${first.runId}`, null);
  store.setSetting(`group:native-stop-unverified:${first.runId}`, true);
  await expect(current.reconcile(randomUUID())).rejects.toThrow(/QUARK execution/);
  store.setSetting(`group:native-stop-unverified:${first.runId}`, null);
  await current.close();
  await expect.poll(() => runtime.quark.executing().has(agent)).toBe(false);
  runtime.kick();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(store.run(next.runId).status).toBe('queued');
  expect(nextPrepare).not.toHaveBeenCalled();
  store.setSetting('scheduler:settings', { maxConcurrent: 1, paused: false });
  runtime.kick();
  const nextCapability = await next.admitted;
  expect(nextPrepare).toHaveBeenCalledOnce();
  await nextCapability.close();
  expect(factory).not.toHaveBeenCalled();
});
