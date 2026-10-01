import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultModelPolicy,
  recommendedModelPolicy,
  newProjectWorkflow,
  resourceSampleSchema,
  type Model,
  type ModelPolicy as Policy,
} from '@dock/shared';
import { ModelPolicy, latestFamily } from './model-policy.js';
import { projectWorkflow } from './project-workflow.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { ResourceWatch } from './resource-watch.js';
import { nativeChildConfig } from './native-children.js';
import { proxyPath } from './hosts.js';
const model = (id: string, label = id): Model => ({
  id,
  label,
  efforts: ['low', 'medium', 'high'],
  isDefault: false,
});
const catalogs = {
  codex: [
    model('gpt-6-astra'),
    model('gpt-6-sol'),
    model('gpt-5.6-sol'),
    model('gpt-5.6-terra'),
    model('gpt-6-luna'),
    model('gpt-5.5'),
  ],
  claude: [
    model('opus', 'Opus 5'),
    model('claude-opus-4-8'),
    model('sonnet', 'Sonnet 5'),
    model('claude-fable-5-1', 'Fable 5.1'),
    model('claude-fable-5', 'Fable 5'),
  ],
};
let root: string, store: Store, policy: ModelPolicy, now: number;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-models-'));
  store = new Store(join(root, 'dock.sqlite'));
  store.setSetting('model-policy', structuredClone(defaultModelPolicy));
  now = Date.now();
  policy = new ModelPolicy(
    store,
    async (provider) => catalogs[provider],
    () => now,
  );
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const save = (edit: (p: Policy) => void) => {
  const p = policy.policy();
  edit(p);
  return policy.save({ key: randomUUID(), expectedRevision: p.revision, policy: p });
};
it('copies general preferences into projects, preserves older choices after reset and restart, and resolves live versions', async () => {
  await policy.refresh();
  save((p) => {
    p.projectDefaults = {
      providerMix: 'codex-only',
      spending: 'light',
      overrides: {
        research: { provider: 'codex', family: 'sol', model: 'gpt-5.5', effort: 'medium' },
      },
    };
  });
  const first = store.register(join(root, 'first'), 'First', '');
  expect(projectWorkflow(store, first.id)).toEqual(newProjectWorkflow(policy.policy()));
  expect(await policy.resolveWorker(first.id, 'implementer')).toMatchObject({
    model: 'gpt-5.5',
    effort: 'medium',
  });
  expect(await policy.resolveWorker(first.id, 'reviewer')).toMatchObject({ model: 'gpt-6-sol' });
  save((p) => {
    p.models.codex.grad.model = 'gpt-5.6-sol';
  });
  const second = store.register(join(root, 'second'), 'Second', '');
  expect(await policy.resolveWorker(second.id, 'reviewer')).toMatchObject({ model: 'gpt-5.6-sol' });
  expect(await policy.resolveWorker(first.id, 'reviewer')).toMatchObject({ model: 'gpt-6-sol' });
  const recommended = recommendedModelPolicy(policy.policy());
  const request = {
    key: randomUUID(),
    expectedRevision: recommended.revision,
    policy: recommended,
  };
  const saved = policy.save(request);
  expect(policy.save(request)).toEqual(saved);
  const third = store.register(join(root, 'third'), 'Third', '');
  expect(await policy.resolveWorker(third.id, 'implementer')).toMatchObject({
    model: 'gpt-6-astra',
  });
  expect(await policy.resolveWorker(third.id, 'reviewer')).toMatchObject({
    model: 'claude-fable-5-1',
  });
  const retained = projectWorkflow(store, first.id);
  expect(store.register(join(root, 'first'), 'Reconnected', '').id).toBe(first.id);
  expect(projectWorkflow(store, first.id)).toEqual(retained);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  policy = new ModelPolicy(store, async (provider) => catalogs[provider]);
  expect(projectWorkflow(store, first.id)).toEqual(retained);
  expect(await policy.resolveWorker(first.id, 'implementer')).toMatchObject({ model: 'gpt-5.5' });
  expect(store.runs()).toHaveLength(0);
});
it('uses central family remapping for new project previews and dispatch without rewriting existing or legacy projects', async () => {
  save((p) => {
    p.projectDefaults = { providerMix: 'codex-only', spending: 'default', overrides: {} };
  });
  const before = store.register(join(root, 'before'), 'Before', '');
  save((p) => {
    p.models.codex.grad.family = 'quasar';
  });
  policy = new ModelPolicy(store, async () => [
    ...catalogs.codex,
    model('quasar-7'),
    model('quasar-8'),
  ]);
  const after = store.register(join(root, 'after'), 'After', '');
  expect(projectWorkflow(store, after.id).familyDefaults?.sol?.family).toBe('quasar');
  expect(await policy.resolveWorker(after.id, 'implementer')).toMatchObject({
    model: 'quasar-8',
  });
  expect(await policy.resolveWorker(before.id, 'implementer')).toMatchObject({
    model: 'gpt-6-sol',
  });
  store.setSetting(`project-workflow:${before.id}`, {
    providerMix: 'codex-only',
    spending: 'light',
  });
  expect(await policy.resolveWorker(before.id, 'implementer')).toMatchObject({
    model: 'gpt-5.6-terra',
  });
});
it('keeps routine checks and calculations within project provider preferences while enforcing stronger calculation models', async () => {
  save((p) => {
    p.projectDefaults = { providerMix: 'claude-only', spending: 'light', overrides: {} };
    p.providers.calculation = 'codex';
  });
  const claude = store.register(join(root, 'claude'), 'Claude workers', '');
  expect(
    await policy.resolveWorker(claude.id, 'implementer', {
      taskClass: 'calculation',
      mode: 'automatic',
      difficulty: 'high',
    }),
  ).toMatchObject({ provider: 'claude', model: 'opus' });
  expect(
    await policy.resolveWorker(claude.id, 'researcher', {
      taskClass: 'routine',
      mode: 'automatic',
      difficulty: 'low',
    }),
  ).toMatchObject({ provider: 'claude', model: 'sonnet' });
  save((p) => {
    p.projectDefaults.providerMix = 'codex-only';
  });
  const codex = store.register(join(root, 'codex'), 'Light workers', '');
  expect(await policy.resolveWorker(codex.id, 'implementer')).toMatchObject({
    model: 'gpt-5.6-terra',
  });
  expect(
    await policy.resolveWorker(codex.id, 'implementer', {
      taskClass: 'calculation',
      mode: 'automatic',
      difficulty: 'high',
    }),
  ).toMatchObject({ model: 'gpt-6-sol' });
  expect(
    await policy.resolveWorker(codex.id, 'researcher', {
      taskClass: 'orchestration',
      mode: 'automatic',
      difficulty: 'high',
    }),
  ).toMatchObject({ model: 'gpt-6-sol' });
});
it('restores recommendations without enabling another provider and validates user-wide worker pins', async () => {
  save((p) => {
    p.enabledProviders = ['codex'];
    p.scheduledProvider = 'codex';
  });
  const recommended = recommendedModelPolicy(policy.policy());
  expect(recommended.enabledProviders).toEqual(['codex']);
  expect(recommended.projectDefaults).toMatchObject({
    providerMix: 'codex-only',
    spending: 'tokenmax',
  });
  await policy.refresh();
  expect(() =>
    save((p) => {
      p.projectDefaults.overrides.review = {
        provider: 'codex',
        family: 'sol',
        model: 'missing-model',
        effort: null,
      };
    }),
  ).toThrow('available model');
  expect(() =>
    save((p) => {
      p.projectDefaults.overrides.review = {
        provider: 'codex',
        family: 'sol',
        model: 'gpt-6-sol',
        effort: 'ultra',
      };
    }),
  ).toThrow('thinking level');
  const existing = store.register(root, 'Keep manager', '');
  const first = await policy.prepare(store.agent(existing.managerId));
  await policy.catalog('codex');
  save((p) => {
    p.models.codex.postdoc.model = 'gpt-5.5';
  });
  expect((await policy.prepare(store.agent(existing.managerId), 'next-manager-turn')).model).toBe(
    first.model,
  );
});
it('keeps general manager pins independent of worker slots and preserves each project manager snapshot', async () => {
  await policy.refresh();
  save((p) => {
    p.managerModels.codex = { ...p.models.codex.postdoc, model: 'gpt-5.5', effort: 'medium' };
  });
  const project = store.register(root, 'Independent manager', '');
  expect(await policy.prepare(store.agent(project.managerId))).toMatchObject({
    model: 'gpt-5.5',
    effort: 'medium',
  });
  expect(await policy.resolveWorker(project.id, 'implementer')).toMatchObject({
    model: 'gpt-6-astra',
  });
  expect(policy.policy().models.codex.postdoc.model).toBeNull();
  save((p) => {
    p.managerModels.codex = { ...p.models.codex.postdoc };
  });
  const next = store.register(join(root, 'next'), 'Next manager', '');
  expect(await policy.prepare(store.agent(next.managerId))).toMatchObject({ model: 'gpt-6-astra' });
  expect(await policy.prepare(store.agent(project.managerId), 'later-turn')).toMatchObject({
    model: 'gpt-5.5',
  });
  expect(() =>
    save((p) => {
      p.managerModels.codex = { ...p.models.codex.postdoc, model: 'missing' };
    }),
  ).toThrow('available model');
});
it('uses xhigh for new managers when available, preserves explicit effort, and respects native catalogs', async () => {
  const supported = ['low', 'medium', 'high', 'xhigh'];
  policy = new ModelPolicy(store, async () => [{ ...model('gpt-6-astra'), efforts: supported }]);
  expect((await policy.resolve('manager')).effort).toBe('xhigh');
  await save((p) => {
    p.models.codex.postdoc.effort = 'high';
  });
  expect((await policy.resolve('manager')).effort).toBe('high');
  await save((p) => {
    p.models.codex.postdoc.effort = null;
  });
  policy = new ModelPolicy(store, async () => [
    { ...model('gpt-6-astra'), efforts: ['provider-default'] },
  ]);
  expect((await policy.resolve('manager')).effort).toBe('provider-default');
});
it('resolves an available bulk model with native default effort through the central policy', async () => {
  policy = new ModelPolicy(store, async () => [
    { ...model('luna-future'), efforts: ['provider-default'] },
  ]);
  expect(await policy.resolve('bulk')).toMatchObject({
    provider: 'codex',
    model: 'luna-future',
    effort: 'provider-default',
    tier: 'uncle',
  });
});
it('resolves all default tiers from actual catalogs, including rolling aliases and numeric generations', async () => {
  expect((await policy.resolve('manager')).model).toBe('gpt-6-astra');
  expect((await policy.resolve('routine')).model).toBe('sonnet');
  expect((await policy.resolve('calculation')).model).toBe('gpt-6-sol');
  expect((await policy.resolve('reasoning')).model).toBe('gpt-6-sol');
  expect((await policy.resolve('orchestration')).model).toBe('gpt-6-sol');
  expect(
    (
      await policy.resolve('manager', {
        provider: 'claude',
        mode: 'automatic',
        difficulty: 'unspecified',
      })
    ).model,
  ).toBe('claude-fable-5-1');
  expect(latestFamily([model('gpt-5.9-sol'), model('gpt-5.10-sol')], 'sol')?.id).toBe(
    'gpt-5.10-sol',
  );
  expect(
    latestFamily([model('opus[1m]', 'Opus 5 (1M context)'), model('opus', 'Opus 5')], 'opus')?.id,
  ).toBe('opus');
  expect(latestFamily([model('solitude'), model('gpt-6-sol-mini')], 'terra')).toBeUndefined();
  expect((await policy.resolve('bulk')).model).toBe('gpt-6-luna');
  expect(
    (await policy.resolve('bulk', { provider: 'codex', mode: 'automatic', difficulty: 'low' }))
      .tier,
  ).toBe('uncle');
});
it('uses Sonnet for Claude-only bulk defaults and preserves saved explicit legacy families and pins', async () => {
  save((p) => {
    p.enabledProviders = ['claude'];
  });
  expect(await policy.resolve('bulk')).toMatchObject({
    provider: 'claude',
    model: 'sonnet',
    tier: 'undergrad',
  });
  expect(defaultModelPolicy.models.claude.uncle.family).toBe('sonnet');
  const saved = policy.policy();
  saved.providers.bulk = 'claude';
  saved.models.claude.uncle = {
    family: 'haiku',
    model: 'haiku-owner-pin',
    effort: 'medium',
    requiresModelAllowance: false,
  };
  store.setSetting('model-policy', saved);
  policy = new ModelPolicy(store, async () => [model('haiku-owner-pin')]);
  expect(policy.policy()).toEqual(saved);
  expect(store.getSetting('model-policy')).toEqual(saved);
  expect(await policy.resolve('bulk')).toMatchObject({
    provider: 'claude',
    model: 'haiku-owner-pin',
    effort: 'medium',
  });
});
it('refreshes new generations centrally without changing an exact pin or using stale catalogs after failure', async () => {
  let fail = false,
    models = [model('gpt-6-sol'), model('gpt-5.5')];
  const discover = vi.fn(async () => {
    if (fail) throw new Error('private token');
    return models;
  });
  policy = new ModelPolicy(store, discover, () => now);
  save((p) => {
    p.providers.reasoning = 'codex';
  });
  const results = await Promise.all([policy.resolve('reasoning'), policy.resolve('reasoning')]);
  expect(results[0]?.model).toBe('gpt-6-sol');
  expect(discover).toHaveBeenCalledOnce();
  models = [...models, model('gpt-7-sol')];
  now += 300_001;
  expect((await policy.resolve('reasoning')).model).toBe('gpt-7-sol');
  save((p) => {
    p.models.codex.grad.model = 'gpt-5.5';
  });
  expect((await policy.resolve('reasoning')).model).toBe('gpt-5.5');
  fail = true;
  now += 300_001;
  await expect(policy.resolve('reasoning')).rejects.toThrow('discovery failed');
  expect(JSON.stringify(policy.status())).not.toContain('private token');
});
it('presets, task overrides and pick-as-I-go have deterministic provider rules', async () => {
  for (const task of ['manager', 'reasoning', 'calculation', 'orchestration', 'bulk'] as const)
    expect(policy.provider(task)).toBe('codex');
  save((p) => {
    p.preset = 'claude-heavy';
  });
  expect(policy.provider('manager')).toBe('claude');
  expect(policy.provider('routine')).toBe('codex');
  expect(policy.provider('reasoning')).toBe('claude');
  expect(policy.provider('bulk')).toBe('claude');
  save((p) => {
    p.preset = 'pick';
    p.scheduledProvider = 'codex';
  });
  expect(() => policy.provider('manager')).toThrow(/choose/i);
  expect(() => policy.provider('reasoning')).toThrow(/choose/i);
  expect(policy.provider('routine', undefined, true)).toBe('codex');
  save((p) => {
    p.providers.calculation = 'claude';
  });
  expect(policy.provider('calculation')).toBe('claude');
  expect(policy.provider('calculation', 'codex')).toBe('codex');
});
it('checks actual known model tiers for new assignments while preserving unknown exact models and native histories', async () => {
  const request = {
    provider: 'codex' as const,
    model: 'gpt-6-luna',
    tier: 'postdoc' as const,
    mode: 'manual' as const,
    difficulty: 'unspecified' as const,
  };
  for (const task of ['manager', 'routine', 'reasoning', 'calculation', 'orchestration'] as const)
    await expect(policy.resolve(task, request)).rejects.toThrow('requested tier cannot promote');
  await expect(
    policy.resolve('calculation', { ...request, model: 'gpt-5.6-terra' }),
  ).rejects.toThrow('requested tier cannot promote');
  await expect(policy.resolve('bulk', { ...request, difficulty: 'high' })).rejects.toThrow(
    'requested tier cannot promote',
  );
  expect(await policy.resolve('bulk', request)).toMatchObject({
    model: 'gpt-6-luna',
    tier: 'uncle',
  });
  expect(await policy.resolve('reasoning', { ...request, model: 'gpt-5.5' })).toMatchObject({
    model: 'gpt-5.5',
    tier: 'postdoc',
  });
  const saved = policy.policy();
  saved.models.codex.grad.model = 'gpt-6-luna';
  store.setSetting('model-policy', saved);
  await expect(policy.resolve('reasoning')).rejects.toThrow('requested tier cannot promote');
  expect(policy.policy()).toEqual(saved);
  const project = store.register(root, 'Existing native manager', '', 'codex');
  const existing = store.updateAgent(project.managerId, {
    threadId: 'native-owner-history',
    model: 'gpt-6-luna',
    modelSelection: 'exact',
  });
  expect(await policy.prepare(existing, randomUUID())).toEqual(existing);
});
it('requires appropriate tiers before discovery, and persists versioned settings with lost-response retries', async () => {
  const discover = vi.fn(async () => catalogs.codex);
  policy = new ModelPolicy(store, discover);
  for (const task of ['manager', 'calculation', 'orchestration', 'reasoning'] as const)
    await expect(
      policy.resolve(task, { mode: 'automatic', tier: 'uncle', difficulty: 'unspecified' }),
    ).rejects.toThrow('requires');
  expect(discover).not.toHaveBeenCalled();
  const input = {
    key: randomUUID(),
    expectedRevision: 0,
    policy: { ...policy.policy(), preset: 'pick' },
  };
  expect(policy.save(input).policy.revision).toBe(1);
  expect(policy.save(input).policy.revision).toBe(1);
  expect(() => policy.save({ ...input, key: randomUUID() })).toThrow('another device');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  policy = new ModelPolicy(store, discover);
  expect(policy.policy().preset).toBe('pick');
});
it('fresh managers follow postdoc defaults between runs while queued assignments, pins and imported histories stay intact', async () => {
  const managerModels = [...catalogs.codex];
  vi.spyOn(policy, 'catalog').mockImplementation(async (provider) =>
    provider === 'codex' ? managerModels : catalogs[provider],
  );
  const project = store.register(root, 'Project', '');
  const id = project.managerId;
  const initial = await policy.prepare(store.agent(id), 'first-run');
  expect(initial.model).toBe('gpt-6-astra');
  managerModels.push(model('gpt-7-astra'));
  expect((await policy.prepare(store.agent(id), 'first-run')).model).toBe('gpt-6-astra');
  store.updateAgent(id, { threadId: 'retained-history' });
  expect((await policy.prepare(store.agent(id), 'next-run')).model).toBe('gpt-7-astra');
  expect(store.agent(id).threadId).toBe('retained-history');
  store.setSetting(`model-policy:follow:${id}`, false);
  expect((await policy.prepare(store.agent(id), 'pin-run')).model).toBe('gpt-7-astra');
  save((p) => {
    p.preset = 'claude-heavy';
  });
  expect(store.agent(store.register(join(root, 'new'), 'New', '').managerId).provider).toBe(
    'claude',
  );
  expect(store.agent(id).provider).toBe('codex');
  const imported = store.addAgent({
    projectId: project.id,
    parentId: null,
    taskId: null,
    role: 'researcher',
    name: 'Imported',
    cwd: root,
    provider: 'codex',
  });
  store.updateAgent(imported.id, { threadId: 'external', model: 'explicit-old-model' });
  expect((await policy.prepare(store.agent(imported.id))).model).toBe('explicit-old-model');
});
it('validates pins and efforts at save without requiring an unavailable unused provider', async () => {
  await policy.catalog('codex');
  expect(() =>
    save((p) => {
      p.models.codex.grad.model = 'invented';
    }),
  ).toThrow('available model');
  expect(() =>
    save((p) => {
      p.models.codex.grad.effort = 'ultra';
    }),
  ).toThrow('thinking level');
  expect(() =>
    save((p) => {
      p.models.claude.uncle.family = 'new-family';
    }),
  ).not.toThrow();
  expect(() =>
    save((p) => {
      p.models.codex.grad.model = 'gpt-5.5';
    }),
  ).not.toThrow();
});
it('exposes protected policy APIs to local and authenticated host clients without starting a turn', async () => {
  const runtime = new Runtime(store, root, 'never-real', async () => new DemoProvider(), {
    inspect: async () => {
      throw new Error('not signed in');
    },
  });
  const app = await createServer(store, runtime, { port: 4999 });
  cleanups.push(() => app.close());
  const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
  expect((await app.inject({ url: '/api/model-policy', headers })).statusCode).toBe(200);
  const refreshed = (
    await app.inject({ method: 'POST', url: '/api/model-policy/catalogs', headers, payload: {} })
  ).json();
  expect(refreshed.catalogs[0].models[0].id).toBe('demo');
  expect(refreshed.catalogs[1].error).toContain('discovery failed');
  expect(store.runs()).toHaveLength(0);
  const payload = { key: randomUUID(), expectedRevision: 0, policy: runtime.modelPolicy.policy() };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/model-policy',
        headers: { ...headers, origin: 'https://evil.invalid' },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: 'POST', url: '/api/model-policy', headers, payload })).statusCode,
  ).toBe(200);
  expect(proxyPath('GET', '/model-policy')).toBe('/api/model-policy');
  expect(proxyPath('POST', '/model-policy/catalogs')).toBe('/api/model-policy/catalogs');
});
it('queues exactly one resource escalation, persists its receipt and prevents cascading or extra daily spend', async () => {
  const runtime = new Runtime(store, root, 'never-real', async () => new DemoProvider());
  cleanups.push(() => runtime.close());
  vi.spyOn(runtime.modelPolicy, 'catalog').mockImplementation(
    async (provider) => catalogs[provider],
  );
  const sample = resourceSampleSchema.parse({
    observedAt: new Date().toISOString(),
    machine: {
      observedAt: new Date().toISOString(),
      cpuCount: 8,
      cpuUsedPercent: 10,
      memoryTotalBytes: 16e9,
      memoryAvailableBytes: 8e9,
      diskAvailableBytes: 100e9,
      loadPerCore: 0.2,
    },
    hottestCorePercent: 30,
    memoryPressure: 'normal',
    compressedBytes: null,
    swapUsedBytes: 0,
    swapOutBytesPerSecond: 0,
    diskTotalBytes: 200e9,
    groups: [],
    processCount: 100,
    unavailable: [],
  });
  store.setSetting('resources:latest', sample);
  const first = (await runtime.resources.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(first.runId, { status: 'running' });
  store.updateAgent(first.agentId, { status: 'running' });
  const key = randomUUID(),
    question = {
      question: 'Does this trend support a memory leak?',
      evidence: 'One busy core, normal pressure, no sustained swap.',
    };
  const result = (await runtime.tool(first.agentId, key, 'dock_escalate', question)) as {
    agentId: string;
  };
  expect(store.agent(result.agentId).assignment).toMatchObject({
    tier: 'grad',
    model: 'opus',
    provider: 'claude',
  });
  expect(store.agent(result.agentId)).toMatchObject({
    resourceAssistant: { mode: 'snapshot', reason: 'asked' },
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  expect(() => runtime.requireDirectControl(result.agentId)).toThrow('bounded snapshot');
  expect(runtime.resources.status().checks[0]).toMatchObject({
    escalatedFrom: first.id,
    tier: 'grad',
  });
  expect(await runtime.tool(first.agentId, key, 'dock_escalate', question)).toEqual(result);
  await expect(
    runtime.tool(first.agentId, randomUUID(), 'dock_escalate', question),
  ).rejects.toThrow('already requested');
  await expect(
    runtime.tool(result.agentId, randomUUID(), 'dock_escalate', question),
  ).rejects.toThrow('Only an undergrad');
  expect(store.runs()).toHaveLength(2);
  const restored = new Runtime(store, root, 'never-real', async () => new DemoProvider());
  cleanups.push(() => restored.close());
  expect(await restored.tool(first.agentId, key, 'dock_escalate', question)).toEqual(result);
  const initial = store.agent(first.agentId);
  store.updateAgent(initial.id, {
    resourceAssistant: { mode: 'snapshot', reason: 'checkpoint' },
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  store.setSetting(`model-policy:escalated:${initial.id}`, null);
  store.setSetting(
    'resources:checks',
    runtime.resources.status().checks.map(({ summary: _a, state: _b, waitReason: _c, ...c }) => ({
      ...c,
      reason: 'checkpoint',
    })),
  );
  store.setSetting('resources:settings', { automatic: true, checkpointHours: 6 });
  store.setSetting('resources:attempts', Array(6).fill(Date.now()));
  const before = store.runs().length;
  await expect(runtime.tool(initial.id, randomUUID(), 'dock_escalate', question)).rejects.toThrow(
    'daily limit',
  );
  expect(store.runs()).toHaveLength(before);
});
it('sets native helper defaults from the resolved assignment while preserving explicit native custom roles', async () => {
  const client = new DemoProvider();
  const config = await nativeChildConfig(client, false, { model: 'future-sol', effort: 'high' });
  expect(config.agents).toMatchObject({
    default_subagent_model: 'future-sol',
    default_subagent_reasoning_effort: 'high',
    max_concurrent_threads_per_session: 2,
  });
  await client.close();
});
it('uses independent project spending/provider presets and preserves explicit live model pins', async () => {
  const project = store.register(root, 'Project presets', '');
  store.setSetting(`project-workflow:${project.id}`, {
    providerMix: 'balanced',
    spending: 'light',
  });
  expect(await policy.resolveWorker(project.id, 'implementer')).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-terra',
    tier: 'undergrad',
  });
  expect(await policy.resolveWorker(project.id, 'reviewer')).toMatchObject({
    provider: 'claude',
    model: 'opus',
    tier: 'grad',
  });
  expect(
    await policy.resolveWorker(project.id, 'researcher', {
      taskClass: 'bulk',
      mode: 'automatic',
      difficulty: 'low',
    }),
  ).toMatchObject({ provider: 'codex', model: 'gpt-6-luna' });
  store.setSetting(`project-workflow:${project.id}`, {
    providerMix: 'balanced',
    spending: 'tokenmax',
  });
  expect(await policy.resolveWorker(project.id, 'implementer')).toMatchObject({
    provider: 'codex',
    model: 'gpt-6-astra',
  });
  expect(await policy.resolveWorker(project.id, 'reviewer')).toMatchObject({
    provider: 'claude',
    model: 'claude-fable-5-1',
  });
  expect(
    await policy.resolveWorker(project.id, 'implementer', {
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      mode: 'manual',
      difficulty: 'unspecified',
    }),
  ).toMatchObject({ model: 'gpt-5.5', effort: 'medium' });
  await expect(
    policy.resolveWorker(project.id, 'reviewer', {
      provider: 'codex',
      model: 'gpt-6-luna',
      tier: 'postdoc',
      mode: 'manual',
      difficulty: 'unspecified',
    }),
  ).rejects.toThrow('below the requested Postdoc tier');
});
it('honors a stronger requested tier over a Light project default and rejects weaker exact pins', async () => {
  await policy.refresh();
  save((settings) => {
    settings.projectDefaults = {
      providerMix: 'codex-only',
      spending: 'light',
      overrides: {},
    };
    settings.models.codex.grad.model = 'gpt-5.6-sol';
  });
  const project = store.register(root, 'Light project', '');
  save((settings) => {
    settings.models.codex.grad.model = 'gpt-6-sol';
  });
  expect(await policy.resolveWorker(project.id, 'researcher')).toMatchObject({
    model: 'gpt-5.6-terra',
    tier: 'undergrad',
  });
  expect(await policy.resolveWorker(project.id, 'researcher', { tier: 'grad' })).toMatchObject({
    model: 'gpt-5.6-sol',
    tier: 'grad',
    source: 'model_policy',
  });
  expect(await policy.resolveWorker(project.id, 'researcher', { tier: 'postdoc' })).toMatchObject({
    model: 'gpt-6-astra',
    tier: 'postdoc',
  });
  await expect(
    policy.resolveWorker(project.id, 'researcher', {
      tier: 'postdoc',
      model: 'gpt-6-sol',
    }),
  ).rejects.toThrow('below the requested Postdoc tier');
  await expect(policy.resolveWorker(project.id, 'reviewer', { tier: 'undergrad' })).rejects.toThrow(
    'reasoning work requires Grad student',
  );
});
