import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModelPolicy, quarkCoordinatorSettingsSchema } from '@dock/shared';
import { Store } from './store.js';
import { initializeScheduling, Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { ModelPolicy } from './model-policy.js';
import { QuarkCoordinator } from './quark-coordinator.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import type { Provider } from './codex.js';

let root: string, store: Store;
const policies: ModelPolicy[] = [];
const discover = vi.fn(async (provider: string) =>
  (provider === 'claude' ? ['opus', 'retained-opus-exact', 'other-opus-exact'] : ['sol']).map(
    (id) => ({ id, label: id, isDefault: false, efforts: ['high'] }),
  ),
);

async function reconnectRouteFixture() {
  const factory = vi.fn(async () => {
    throw new Error('No provider process may start');
  });
  const runtime = new Runtime(store, root, 'unused', factory);
  const catalog = vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue(
    ['sol-original', 'sol-edited'].map((id) => ({
      id,
      label: id,
      isDefault: false,
      efforts: ['high'],
    })),
  );
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  const saved = {
    revision: 4,
    automatic: false,
    model: { provider: 'codex', family: 'sol', model: 'sol-original', effort: 'high' },
  };
  store.setSetting('quark:coordinator:settings', saved);
  const project = store.register(join(root, 'retained'), 'QUARK', '');
  store.updateAgent(project.managerId, {
    model: 'sol-original',
    modelSelection: 'native',
    effort: 'high',
    threadId: randomUUID(),
    status: 'idle',
  });
  store.setSetting('quark:coordinator:identity', {
    projectId: project.id,
    agentId: project.managerId,
  });
  const close = vi.fn(async () => {});
  runtime.clients.set(project.managerId, { close } as unknown as Provider);
  const app = await createServer(store, runtime, { port: 4997, ownsRuntime: false });
  const payload = {
    key: randomUUID(),
    settings: { ...saved, model: { ...saved.model, model: 'sol-edited' } },
  };
  const post = (target = app) =>
    target.inject({
      method: 'POST',
      url: '/api/quark/coordinator/settings',
      headers: { host: '127.0.0.1:4997', origin: 'http://127.0.0.1:4997' },
      payload,
    });
  const block = () => {
    const child = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: null,
      role: 'researcher',
      name: 'Native child',
      cwd: root,
      provider: 'codex',
    });
    store.updateAgent(child.id, { nativeRootId: project.managerId, status: 'running' });
    return child;
  };
  return { runtime, factory, catalog, project, close, app, payload, post, block };
}

it('never repeats a settled settings reconnect against a later running native client', async () => {
  const f = await reconnectRouteFixture();
  try {
    const first = await f.post();
    expect(first.statusCode, first.body).toBe(200);
    expect(f.close).toHaveBeenCalledTimes(1);
    const catalogReads = f.catalog.mock.calls.length;
    const run = store.enqueue(f.project.managerId, randomUUID(), 'Later authorized work');
    store.updateRun(run.id, { status: 'running' });
    store.updateAgent(f.project.managerId, { status: 'running', turnId: run.id });
    const laterClose = vi.fn(async () => {});
    const laterClient = { close: laterClose } as unknown as Provider;
    f.runtime.clients.set(f.project.managerId, laterClient);
    const before = store.agent(f.project.managerId);
    const replay = await f.post();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(laterClose).not.toHaveBeenCalled();
    expect(f.runtime.clients.get(f.project.managerId)).toBe(laterClient);
    expect(store.agent(f.project.managerId)).toEqual(before);
    expect(store.run(run.id).status).toBe('running');
    expect(f.catalog).toHaveBeenCalledTimes(catalogReads);
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
    await f.runtime.close();
  }
});

it('recovers a settings reconnect that failed before its effect while the exact native proof remains', async () => {
  const f = await reconnectRouteFixture();
  try {
    const child = f.block();
    const failed = await f.post();
    expect(failed.statusCode, failed.body).toBe(409);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.runtime.coordinator.settings().revision).toBe(5);
    expect(store.getSetting(`quark:coordinator:reconnect:${f.payload.key}`)).toBeNull();
    const catalogReads = f.catalog.mock.calls.length;
    store.updateAgent(child.id, { status: 'idle' });
    const recovered = await f.post();
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(store.getSetting(`quark:coordinator:reconnect:${f.payload.key}`)).toEqual({
      state: 'complete',
    });
    expect((await f.post()).statusCode).toBe(200);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(catalogReads);
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
    await f.runtime.close();
  }
});

it.each(['client', 'configuration', 'later completed run', 'restart'] as const)(
  'does not guess a pending settings reconnect target after changed %s',
  async (change) => {
    const f = await reconnectRouteFixture();
    let restarted: Runtime | undefined;
    let restartedApp: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const child = f.block();
      expect((await f.post()).statusCode).toBe(409);
      const catalogReads = f.catalog.mock.calls.length;
      store.updateAgent(child.id, { status: 'idle' });
      const replacementClose = vi.fn(async () => {});
      if (change === 'client')
        f.runtime.clients.set(f.project.managerId, {
          close: replacementClose,
        } as unknown as Provider);
      if (change === 'configuration')
        store.updateAgent(f.project.managerId, { threadId: randomUUID() });
      if (change === 'later completed run') {
        const later = store.enqueue(f.project.managerId, randomUUID(), 'Later work completed');
        store.updateRun(later.id, { status: 'completed' });
      }
      if (change === 'restart') {
        await f.app.close();
        await f.runtime.close();
        f.close.mockClear();
        restarted = new Runtime(store, root, 'unused', f.factory);
        restarted.clients.set(f.project.managerId, {
          close: replacementClose,
        } as unknown as Provider);
        restartedApp = await createServer(store, restarted, { port: 4997, ownsRuntime: false });
      }
      const replay = await f.post(restartedApp);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(f.close).not.toHaveBeenCalled();
      expect(replacementClose).not.toHaveBeenCalled();
      expect(store.getSetting(`quark:coordinator:reconnect:${f.payload.key}`)).toEqual({
        state: 'superseded',
      });
      expect(f.catalog).toHaveBeenCalledTimes(catalogReads);
      expect(f.factory).not.toHaveBeenCalled();
    } finally {
      if (restartedApp) await restartedApp.close();
      if (restarted) await restarted.close();
      await f.app.close();
      await f.runtime.close();
    }
  },
);

it('preserves a replacement client installed while the original settings close is awaiting acknowledgement', async () => {
  const f = await reconnectRouteFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closing!: () => void;
  const started = new Promise<void>((resolve) => {
    closing = resolve;
  });
  f.close.mockImplementationOnce(async () => {
    closing();
    await gate;
  });
  try {
    const saving = f.post();
    await started;
    const replacementClose = vi.fn(async () => {});
    const replacement = { close: replacementClose } as unknown as Provider;
    f.runtime.clients.set(f.project.managerId, replacement);
    release();
    const result = await saving;
    expect(result.statusCode, result.body).toBe(200);
    expect(f.runtime.clients.get(f.project.managerId)).toBe(replacement);
    expect(replacementClose).not.toHaveBeenCalled();
    expect((await f.post()).statusCode).toBe(200);
    expect(replacementClose).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    release();
    await f.app.close();
    await f.runtime.close();
  }
});

it('retains an uncertain native close across restart without repeating it after a lost acknowledgement', async () => {
  const f = await reconnectRouteFixture();
  let restarted: Runtime | undefined;
  let restartedApp: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    f.close.mockImplementationOnce(async () => {
      throw new Error('Lost acknowledgement after close');
    });
    const first = await f.post();
    expect(first.statusCode, first.body).toBe(500);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(store.getSetting(`quark:coordinator:reconnect:${f.payload.key}`)).toEqual({
      state: 'started',
    });
    const laterClose = vi.fn(async () => {});
    f.runtime.clients.set(f.project.managerId, { close: laterClose } as unknown as Provider);
    const retry = await f.post();
    expect(retry.statusCode, retry.body).toBe(409);
    expect(laterClose).not.toHaveBeenCalled();
    await f.app.close();
    await f.runtime.close();
    laterClose.mockClear();
    restarted = new Runtime(store, root, 'unused', f.factory);
    restarted.clients.set(f.project.managerId, { close: laterClose } as unknown as Provider);
    restartedApp = await createServer(store, restarted, { port: 4997, ownsRuntime: false });
    expect((await f.post(restartedApp)).statusCode).toBe(409);
    expect(laterClose).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    if (restartedApp) await restartedApp.close();
    if (restarted) await restarted.close();
    await f.app.close();
    await f.runtime.close();
  }
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'public-quark-defaults-'));
  store = new Store(join(root, 'dock.sqlite'));
  initializeScheduling(store);
  discover.mockClear();
});
afterEach(async () => {
  await Promise.all(policies.splice(0).map((policy) => policy.close()));
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function desk(target = store) {
  const models = new ModelPolicy(target, discover),
    pulsar = new Pulsar(target, () => null);
  policies.push(models);
  return {
    models,
    coordinator: new QuarkCoordinator(target, root, new Quark(target, pulsar), pulsar, models),
  };
}
it('defaults missing QUARK automatic settings to Off without creating native work', () => {
  store.db.prepare('DELETE FROM settings WHERE key=?').run('quark:coordinator:settings');
  const { coordinator } = desk();
  expect(quarkCoordinatorSettingsSchema.parse({}).automatic).toBe(false);
  expect(coordinator.settings()).toMatchObject({ automatic: false, model: { provider: 'codex' } });
  expect(coordinator.identity()).toBeNull();
  expect(discover).not.toHaveBeenCalled();
  expect(store.projects()).toEqual([]);
  expect(store.runs()).toEqual([]);
});
it('preserves an explicit saved On and can switch it Off and On without changing native work', async () => {
  const { coordinator } = desk();
  const saved = {
    revision: 4,
    automatic: true,
    model: { provider: 'claude', family: 'opus', model: 'retained-opus-exact', effort: 'high' },
  };
  store.setSetting('quark:coordinator:settings', saved);
  const project = store.register(join(root, 'retained-on'), 'QUARK', '', 'claude');
  store.updateAgent(project.managerId, {
    model: 'retained-opus-exact',
    modelSelection: 'native',
    effort: 'high',
    threadId: randomUUID(),
    status: 'interrupted',
  });
  store.setSetting('quark:coordinator:identity', {
    projectId: project.id,
    agentId: project.managerId,
  });
  const run = store.enqueue(project.managerId, randomUUID(), 'Retained owner work');
  const beforeAgent = store.agent(project.managerId),
    beforeRun = store.run(run.id);
  expect(coordinator.settings()).toEqual(saved);
  expect(quarkCoordinatorSettingsSchema.parse(saved)).toEqual(saved);
  for (const automatic of [false, true]) {
    await coordinator.save({
      key: randomUUID(),
      settings: { ...coordinator.settings(), automatic },
    });
    expect(coordinator.settings().automatic).toBe(automatic);
  }
  expect(coordinator.settings()).toEqual({ ...saved, revision: 6 });
  expect(discover).not.toHaveBeenCalled();
  expect(store.agent(project.managerId)).toEqual(beforeAgent);
  expect(store.runs()).toEqual([beforeRun]);
});
it.each(['codex', 'claude'] as const)(
  'fresh QUARK uses only enabled %s and retains its provider after restart',
  async (provider) => {
    if (provider === 'claude') {
      const selected = structuredClone(defaultModelPolicy);
      selected.enabledProviders = ['claude'];
      selected.scheduledProvider = 'claude';
      store.setSetting('model-policy', selected);
    }
    const { models, coordinator } = desk();
    expect(coordinator.settings()).toMatchObject({ automatic: false, model: { provider } });
    expect(discover).not.toHaveBeenCalled();
    const input = { key: randomUUID() },
      first = await coordinator.start(input);
    expect((await coordinator.start(input)).agentId).toBe(first.agentId);
    expect(store.agent(first.agentId!).provider).toBe(provider);
    expect(discover.mock.calls).toEqual([[provider]]);
    expect(store.runs()).toEqual([]);
    const retained = store.agent(first.agentId!),
      policy = models.policy();
    policy.enabledProviders = [provider === 'codex' ? 'claude' : 'codex'];
    policy.scheduledProvider = policy.enabledProviders[0];
    store.setSetting('model-policy', policy);
    const reopened = new Store(join(root, 'dock.sqlite'));
    try {
      const next = desk(reopened).coordinator;
      expect(next.settings()).toMatchObject({ automatic: false, model: { provider } });
      expect((await next.start({ key: randomUUID() })).agentId).toBe(first.agentId);
      expect(reopened.agent(first.agentId!)).toEqual(retained);
      expect(discover.mock.calls).toEqual([[provider]]);
    } finally {
      reopened.close();
    }
  },
);
it('does not create a stale default coordinator when provider preferences change during discovery', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  discover.mockImplementationOnce(async () => {
    await gate;
    return [{ id: 'sol', label: 'Sol', isDefault: false, efforts: ['high'] }];
  });
  const { models, coordinator } = desk();
  const pending = coordinator.start({ key: randomUUID() });
  const policy = models.policy();
  policy.enabledProviders = ['claude'];
  policy.scheduledProvider = 'claude';
  store.setSetting('model-policy', policy);
  release();
  await expect(pending).rejects.toThrow(/changed during model discovery/);
  expect(coordinator.identity()).toBeNull();
  expect(store.projects()).toEqual([]);
  expect(store.runs()).toEqual([]);
  expect(coordinator.settings().model.provider).toBe('claude');
});
it('preserves an explicit Claude model on a Codex-only installation', async () => {
  const { models, coordinator } = desk();
  expect(models.policy().enabledProviders).toEqual(['codex']);
  const saved = {
    revision: 3,
    automatic: false,
    model: { provider: 'claude', family: 'opus', model: 'retained-opus-exact', effort: 'high' },
  };
  store.setSetting('quark:coordinator:settings', saved);
  const first = await coordinator.start({ key: randomUUID() });
  expect(store.agent(first.agentId!)).toMatchObject({
    provider: 'claude',
    model: 'retained-opus-exact',
    effort: 'high',
  });
  expect(coordinator.settings()).toEqual(saved);
  expect(discover.mock.calls).toEqual([['claude']]);
  expect(store.runs()).toEqual([]);
});
it('can disable automatic checks before creation without discovery or a new identity', async () => {
  const { coordinator } = desk();
  store.setSetting('quark:coordinator:settings', { automatic: true });
  await coordinator.save({
    key: randomUUID(),
    settings: { ...coordinator.settings(), automatic: false },
  });
  expect(coordinator.settings().automatic).toBe(false);
  expect(coordinator.identity()).toBeNull();
  expect(discover).not.toHaveBeenCalled();
  expect(store.projects()).toEqual([]);
  expect(store.runs()).toEqual([]);
});
it.each(['queued', 'running'] as const)(
  'disables automatic checks around retained %s work without discovery or native changes',
  async (status) => {
    const { coordinator } = desk();
    const saved = {
      revision: 7,
      automatic: true,
      model: { provider: 'claude', family: 'opus', model: 'retained-opus-exact', effort: 'high' },
    };
    store.setSetting('quark:coordinator:settings', saved);
    const project = store.register(
      join(root, 'quark-coordinator', 'retained'),
      'QUARK',
      '',
      'claude',
    );
    store.updateAgent(project.managerId, {
      model: 'retained-opus-exact',
      modelSelection: 'native',
      effort: 'high',
      threadId: randomUUID(),
      status: status === 'queued' ? 'interrupted' : 'running',
    });
    const identity = { projectId: project.id, agentId: project.managerId };
    store.setSetting('quark:coordinator:identity', identity);
    const run = store.enqueue(
      project.managerId,
      randomUUID(),
      'Retained coordinator work',
      'report',
    );
    if (status === 'running') store.updateRun(run.id, { status });
    const agentBefore = store.agent(project.managerId),
      runBefore = store.run(run.id);
    const input = { key: randomUUID(), settings: { ...saved, automatic: false } };
    await coordinator.save(input);
    await coordinator.save(input);
    expect(coordinator.settings()).toEqual({ ...saved, automatic: false, revision: 8 });
    expect(discover).not.toHaveBeenCalled();
    expect(coordinator.identity()).toEqual(identity);
    expect(store.agent(project.managerId)).toEqual(agentBefore);
    expect(store.runs()).toEqual([runBefore]);
    await expect(
      coordinator.save({
        key: randomUUID(),
        settings: {
          ...coordinator.settings(),
          model: { ...saved.model, model: 'other-opus-exact' },
        },
      }),
    ).rejects.toThrow(/finish its reply/);
    expect(store.agent(project.managerId)).toEqual(agentBefore);
    expect(store.runs()).toEqual([runBefore]);
  },
);
it.each(['queued', 'running'] as const)(
  'the protected automatic-off route preserves %s work and reconnects only real model edits',
  async (status) => {
    const factory = vi.fn(async () => {
      throw new Error('No provider process may start');
    });
    const runtime = new Runtime(store, root, 'unused', factory);
    const catalog = vi.spyOn(runtime.modelPolicy, 'catalog').mockImplementation(discover);
    const close = vi.fn(async () => {});
    const saved = {
      revision: 4,
      automatic: true,
      model: { provider: 'claude', family: 'opus', model: 'retained-opus-exact', effort: 'high' },
    };
    store.setSetting('quark:coordinator:settings', saved);
    const project = store.register(join(root, 'quark-coordinator', 'route'), 'QUARK', '', 'claude');
    store.updateAgent(project.managerId, {
      model: 'retained-opus-exact',
      modelSelection: 'native',
      effort: 'high',
      threadId: randomUUID(),
      status: status === 'queued' ? 'interrupted' : 'running',
    });
    const child = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: null,
      role: 'researcher',
      name: 'Retained native child',
      cwd: root,
      provider: 'claude',
    });
    store.updateAgent(child.id, { status: 'running', nativeRootId: project.managerId });
    store.setSetting('quark:coordinator:identity', {
      projectId: project.id,
      agentId: project.managerId,
    });
    runtime.clients.set(project.managerId, { close } as unknown as Provider);
    const run = store.enqueue(project.managerId, randomUUID(), 'Saved native work', 'report');
    if (status === 'running') store.updateRun(run.id, { status });
    const beforeAgent = store.agent(project.managerId),
      beforeChild = store.agent(child.id),
      beforeRun = store.run(run.id);
    const app = await createServer(store, runtime, { port: 4997 });
    const headers = { host: '127.0.0.1:4997', origin: 'http://127.0.0.1:4997' };
    const payload = { key: randomUUID(), settings: { ...saved, automatic: false } };
    try {
      const refused = await app.inject({
        method: 'POST',
        url: '/api/quark/coordinator/settings',
        headers: { ...headers, origin: 'https://wrong.invalid' },
        payload,
      });
      expect(refused.statusCode).toBe(403);
      for (let i = 0; i < 2; i++) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/quark/coordinator/settings',
          headers,
          payload,
        });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json().settings.automatic).toBe(false);
      }
      expect(close).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(store.agent(project.managerId)).toEqual(beforeAgent);
      expect(store.agent(child.id)).toEqual(beforeChild);
      expect(store.runs()).toEqual([beforeRun]);
      const edit = {
        key: randomUUID(),
        settings: {
          ...runtime.coordinator.settings(),
          model: { ...saved.model, model: 'other-opus-exact' },
        },
      };
      const busy = await app.inject({
        method: 'POST',
        url: '/api/quark/coordinator/settings',
        headers,
        payload: edit,
      });
      expect(busy.statusCode, busy.body).toBe(409);
      expect(close).not.toHaveBeenCalled();
      store.updateRun(run.id, { status: 'completed' });
      store.updateAgent(project.managerId, { status: 'idle' });
      store.updateAgent(child.id, { status: 'idle' });
      const changed = await app.inject({
        method: 'POST',
        url: '/api/quark/coordinator/settings',
        headers,
        payload: edit,
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(close).toHaveBeenCalledTimes(1);
      expect(store.agent(project.managerId).model).toBe('other-opus-exact');
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
