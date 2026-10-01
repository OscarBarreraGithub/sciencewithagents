import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentSchema, delegateSchema, type Agent } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { git } from './workspaces.js';
import { repoRoot } from './paths.js';
import { usageSummary } from './usage.js';

class CatalogProvider extends DemoProvider {
  calls: string[] = [];
  failUsage = false;
  override async request(method: string, params?: unknown) {
    this.calls.push(method);
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'manager-model',
            model: 'manager-model',
            displayName: 'Manager fixture',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
          },
          {
            id: 'worker-model',
            model: 'worker-model',
            displayName: 'Worker fixture',
            isDefault: false,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
        ],
      };
    if (method === 'account/rateLimits/read') {
      if (this.failUsage) throw new Error('private provider diagnostics never shown');
      return {
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 17,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 600,
          },
        },
      };
    }
    return super.request(method, params);
  }
}

let root: string, store: Store, runtime: Runtime, managerId: string, projectId: string;
let provider: CatalogProvider;
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/providers-'));
  const project = join(root, 'project');
  mkdirSync(project);
  await git(project, ['init', '-b', 'main']);
  await git(project, ['config', 'user.name', 'Fixture']);
  await git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await git(project, ['commit', '--allow-empty', '-m', 'Fixture']);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store, 'manager-model');
  const value = store.register(project, 'Fixture', '');
  managerId = value.managerId;
  projectId = value.id;
  provider = new CatalogProvider();
  runtime = new Runtime(store, root, 'never-start-a-real-provider', async () => provider);
});
afterEach(async () => {
  await runtime.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function task() {
  return store.addTask(projectId, {
    title: 'One result',
    goal: 'Read one thing',
    acceptance: 'Report evidence',
    parentId: null,
  });
}
function delegation(taskId: string) {
  return {
    taskId,
    role: 'researcher',
    name: 'Worker',
    instruction: 'Inspect this atomic question.',
  };
}

describe('provider-aware assignments through shared policy', () => {
  it('keeps old records Codex by projection, without rewriting their saved body', () => {
    store.db
      .prepare("UPDATE agents SET body=json_remove(body, '$.provider', '$.assignment') WHERE id=?")
      .run(managerId);
    const before = store.db.prepare('SELECT body FROM agents WHERE id=?').get(managerId);
    expect(store.agent(managerId)).toMatchObject({ provider: 'codex', assignment: null });
    expect(agentSchema.parse(store.agent(managerId)).provider).toBe('codex');
    expect(store.db.prepare('SELECT body FROM agents WHERE id=?').get(managerId)).toEqual(before);
    expect(
      delegateSchema.safeParse({ ...delegation(randomUUID()), execution: { command: 'bash' } })
        .success,
    ).toBe(false);
  });

  it('lets the manager pick a different worker model and retains the exact assignment across retry/restart', async () => {
    store.updateAgent(managerId, { model: 'manager-model', effort: 'high' });
    const input = {
      ...delegation(task().id),
      execution: {
        provider: 'codex',
        model: 'worker-model',
        effort: 'low',
        difficulty: 'high',
        reason: 'Owner requested this model for the bounded inspection.',
      },
    };
    const key = randomUUID();
    const worker = (await managerTool(runtime, managerId, key, 'dock_delegate', input)) as Agent;
    expect(worker).toMatchObject({
      provider: 'codex',
      model: 'worker-model',
      effort: 'low',
      assignment: {
        source: 'manager_selection',
        difficulty: 'high',
        policyRevision: '0:0',
      },
    });
    expect(store.agent(managerId)).toMatchObject({ model: 'manager-model', effort: 'high' });
    expect(store.events().filter((event) => event.type === 'agent.assigned')).toHaveLength(1);
    expect(provider.calls).toEqual(['model/list']);
    const head = store.head;
    expect(await managerTool(runtime, managerId, key, 'dock_delegate', input)).toEqual(worker);
    expect(store.head).toBe(head);
    expect(store.runs().filter((r) => r.agentId !== managerId)).toHaveLength(1);
    await expect(
      managerTool(runtime, managerId, key, 'dock_delegate', {
        ...input,
        execution: { model: 'manager-model' },
      }),
    ).rejects.toThrow('replayed');
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store, 'manager-model');
    const factory = vi.fn(async () => new CatalogProvider());
    runtime = new Runtime(store, root, 'never-start', factory);
    expect(await managerTool(runtime, managerId, key, 'dock_delegate', input)).toEqual(worker);
    expect(factory).not.toHaveBeenCalled();
    expect(store.agent(worker.id).assignment).toEqual(worker.assignment);
  });

  it('uses shared defaults and can inspect actual installed model IDs without a turn', async () => {
    store.updateAgent(managerId, { model: 'manager-model', effort: 'high' });
    const worker = (await managerTool(
      runtime,
      managerId,
      randomUUID(),
      'dock_delegate',
      delegation(task().id),
    )) as Agent;
    expect(worker).toMatchObject({
      model: 'manager-model',
      effort: 'high',
      assignment: {
        source: 'model_policy',
        difficulty: 'unspecified',
        policyRevision: '0:0',
      },
    });
    expect(provider.calls).toEqual(['model/list']);
    const catalog = await managerTool(runtime, managerId, randomUUID(), 'dock_inspect', {
      models: true,
    });
    expect(catalog).toMatchObject({
      provider: 'codex',
      automaticRouting: { enabled: true },
      models: [{ id: 'manager-model' }, { id: 'worker-model' }],
    });
    expect(provider.calls).toEqual(['model/list', 'model/list']);
  });

  it('returns one accepted assignment for overlapping identical implementer requests', async () => {
    const input = { ...delegation(task().id), role: 'implementer' };
    const key = randomUUID();
    const [first, second] = await Promise.all([
      managerTool(runtime, managerId, key, 'dock_delegate', input),
      managerTool(runtime, managerId, key, 'dock_delegate', input),
    ]);
    expect(second).toEqual(first);
    expect(store.runs().filter((r) => r.agentId !== managerId)).toHaveLength(1);
    expect(store.agents()).toHaveLength(2);
    expect(store.events().filter((event) => event.type === 'agent.assigned')).toHaveLength(1);
  });

  it('rejects weaker tiers for serious work before a provider or worktree starts', async () => {
    for (const execution of [
      { taskClass: 'calculation', tier: 'undergrad' },
      { taskClass: 'reasoning', tier: 'uncle' },
    ]) {
      const target = task();
      await expect(
        managerTool(runtime, managerId, randomUUID(), 'dock_delegate', {
          ...delegation(target.id),
          execution,
        }),
      ).rejects.toThrow('requires');
      expect(store.task(target.id).worktree).toBeNull();
    }
    expect(provider.calls).toEqual([]);
    expect(store.runs().filter((r) => r.agentId !== managerId)).toEqual([]);
  });

  it('rejects an unknown model or unsupported reasoning level without dispatch', async () => {
    for (const execution of [{ model: 'invented' }, { model: 'worker-model', effort: 'high' }]) {
      const target = task();
      await expect(
        managerTool(runtime, managerId, randomUUID(), 'dock_delegate', {
          ...delegation(target.id),
          execution,
        }),
      ).rejects.toThrow(/available|unavailable/);
      expect(store.task(target.id).worktree).toBeNull();
    }
    expect(store.runs().filter((r) => r.agentId !== managerId)).toEqual([]);
    expect(store.agents()).toHaveLength(1);
  });

  it('namespaces identical provider IDs and observed history, without using a Codex factory for Claude', async () => {
    const claude = store.addAgent({
      projectId,
      parentId: managerId,
      taskId: null,
      name: 'Future Claude metadata',
      role: 'researcher',
      cwd: root,
      provider: 'claude',
    });
    store.updateAgent(managerId, { threadId: 'same-id' });
    store.updateAgent(claude.id, { threadId: 'same-id' });
    store.observeContext('same-id', 'codex');
    expect(store.contextOwner('same-id', 'codex')).toBe(managerId);
    expect(store.contextOwner('same-id', 'claude')).toBe(claude.id);
    expect(store.observedContext('same-id', 'claude')).toBe(false);
    expect(store.observedContext('same-id')).toBe(true);
    await expect(runtime.client(store.agent(claude.id))).rejects.toThrow('belongs to Codex');
    expect(runtime.clients.size).toBe(0);
    expect(() => store.updateAgent(managerId, { provider: 'claude' })).toThrow(
      'keeps its provider',
    );
    store.updateAgent(managerId, { threadId: null });
    expect(() => store.updateAgent(managerId, { provider: 'claude' })).toThrow(
      'keeps its provider',
    );
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store, 'manager-model');
    runtime = new Runtime(store, root, 'never-start');
    expect(store.contextOwner('same-id', 'codex')).toBe(managerId);
    expect(store.contextOwner('same-id', 'claude')).toBe(claude.id);
    expect(store.observedContext('same-id', 'claude')).toBe(false);
  });

  it('exposes honest capability/usage states and refreshes quota once without a thread or model turn', async () => {
    const app = await createServer(store, runtime, { port: 4999, ownsRuntime: false });
    try {
      const catalog = (await app.inject({ url: '/api/providers', headers })).json();
      expect(catalog.providers).toMatchObject([
        { id: 'codex', enabled: true },
        {
          id: 'claude',
          enabled: true,
          capabilities: ['managed_chat', 'coordination_tools', 'reported_usage'],
        },
      ]);
      const url = `/api/agents/${managerId}/usage`;
      expect((await app.inject({ url, headers })).json()).toMatchObject({
        tokenSnapshots: [],
        quotaSnapshots: [],
        unknownTokenAgentIds: [managerId],
      });
      expect(runtime.clients.size).toBe(0);
      const payload = { key: randomUUID() };
      const first = await app.inject({ method: 'POST', url: `${url}/refresh`, headers, payload });
      expect(first.statusCode).toBe(200);
      expect(first.json().quotaSnapshots[0]).toMatchObject({
        provider: 'codex',
        accountAffinity: 'unknown',
        buckets: [{ primary: { usedPercent: 17 } }],
      });
      expect(
        (await app.inject({ method: 'POST', url: `${url}/refresh`, headers, payload })).json()
          .quotaSnapshots,
      ).toEqual(first.json().quotaSnapshots);
      expect(provider.calls).toEqual(['account/rateLimits/read']);
      expect(store.agent(managerId).threadId).toBeNull();
      expect(store.runs().filter((r) => r.agentId !== managerId)).toEqual([]);
      provider.failUsage = true;
      const failure = await app.inject({
        method: 'POST',
        url: `${url}/refresh`,
        headers,
        payload: { key: randomUUID() },
      });
      expect(failure.statusCode).toBe(409);
      expect(failure.body).not.toContain('private provider diagnostics');
      expect((await app.inject({ url, headers })).json().quotaSnapshots).toEqual(
        first.json().quotaSnapshots,
      );
      const refused = await app.inject({
        method: 'POST',
        url: `/api/agents/${managerId}/settings`,
        headers,
        payload: { provider: 'claude', model: 'opus', effort: 'high', permission: 'read-only' },
      });
      expect(refused.statusCode).toBe(409);
      expect(store.agent(managerId).provider).toBe('codex');
    } finally {
      await app.close();
    }
  });

  it('normalizes actual runtime notification delivery and exposes it to manager inspection', async () => {
    const { threadId } = await runtime.attach(managerId);
    const run = store.enqueue(managerId, randomUUID(), 'Fixture turn', 'user');
    store.updateRun(run.id, { status: 'running', turnId: 'fixture-turn' });
    store.updateAgent(managerId, { turnId: 'fixture-turn', status: 'running' });
    const counts = {
      totalTokens: 100,
      inputTokens: 70,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    };
    const notification = {
      threadId,
      turnId: 'fixture-turn',
      tokenUsage: { total: counts, last: counts, modelContextWindow: 1000 },
    };
    provider.emit('notification', 'thread/tokenUsage/updated', notification);
    provider.emit('notification', 'thread/tokenUsage/updated', notification);
    provider.emit('notification', 'account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 25 } },
    });
    await vi.waitFor(() =>
      expect(usageSummary(store, projectId, managerId).tokenSnapshots).toHaveLength(1),
    );
    const inspected = await managerTool(runtime, managerId, randomUUID(), 'dock_inspect', {
      agentId: managerId,
    });
    expect(inspected).toMatchObject({
      usage: {
        tokenSnapshots: [{ runId: run.id, total: { totalTokens: 100 } }],
        quotaSnapshots: [{ buckets: [{ primary: { usedPercent: 25 } }] }],
      },
    });
    expect(store.events().filter((event) => event.type === 'usage.observed')).toHaveLength(2);
    expect(runtime.context(store.agent(managerId))).toContain('context-only-not-billing');
    provider.emit('notification', 'thread/tokenUsage/updated', {
      ...notification,
      tokenUsage: { total: { totalTokens: -1 } },
    });
    expect(provider.ready).toBe(true);
    expect(usageSummary(store, projectId, managerId).tokenSnapshots[0].total.totalTokens).toBe(100);
  });

  it('recomputes staleness on an old refresh receipt without rereading the provider', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    const app = await createServer(store, runtime, { port: 4999, ownsRuntime: false });
    try {
      const url = `/api/agents/${managerId}/usage/refresh`,
        payload = { key: randomUUID() };
      const first = await app.inject({ method: 'POST', url, headers, payload });
      expect(first.json().quotaSnapshots[0]).toMatchObject({
        stale: false,
        buckets: [{ primaryStale: false }],
      });
      const observedAt = first.json().quotaSnapshots[0].observedAt;
      vi.setSystemTime(new Date('2026-09-13T12:11:00.000Z'));
      const replay = await app.inject({ method: 'POST', url, headers, payload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().quotaSnapshots[0]).toMatchObject({
        observedAt,
        stale: true,
        buckets: [{ primaryStale: true }],
      });
      expect(replay.json().asOf).not.toBe(first.json().asOf);
      expect(provider.calls).toEqual(['account/rateLimits/read']);
    } finally {
      await app.close();
    }
  });
});
