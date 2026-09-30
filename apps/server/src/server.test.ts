import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';
import { parseCapacity } from './capacity.js';

let root: string, store: Store, runtime: Runtime, app: FastifyInstance, manager: string;
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/http-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Fixture', '').managerId;
  store.updateAgent(manager, { toolPolicy: 'restricted' }); // Retained legacy settings fixture.
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  app = await createServer(store, runtime, { port: 4999 });
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
describe('local application boundary', () => {
  it('migrates an idle saved Codex context only explicitly, preserving identity and old-client tool saves', async () => {
    const { threadId } = await runtime.attach(manager);
    const settings = { model: 'demo', effort: 'medium', permission: 'read-only' };
    const save = (extra = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${manager}/settings`,
        headers,
        payload: { ...settings, ...extra },
      });
    expect((await save()).json().toolPolicy).toBe('restricted');
    expect((await save({ toolPolicy: 'native' })).json().toolPolicy).toBe('native');
    expect((await save()).json().toolPolicy).toBe('native');
    expect(store.agent(manager).threadId).toBe(threadId);
    expect(store.runs()).toEqual([]);
    // An older client's explicit off setting is a restriction, not a no-op.
    expect((await save({ webSearch: 'disabled' })).json().toolPolicy).toBe('restricted');
    expect(store.agent(manager).threadId).toBe(threadId);
  });
  it('saves project worker allowances atomically, rejects stale edits and discovers names without starting a turn', async () => {
    const projectId = store.agent(manager).projectId;
    const url = `/api/projects/${projectId}/worker-tools`;
    const first = await app.inject({ url, headers });
    expect(first.json()).toMatchObject({
      revision: 0,
      toolPolicy: 'native',
      codex: { mcpServers: [], webSearch: 'disabled' },
    });
    expect(runtime.clients.size).toBe(0);
    const factory = vi.spyOn(runtime, 'projectMcpCatalog');
    const payload = {
      key: randomUUID(),
      revision: 0,
      codex: { mcpServers: ['demo_docs'], webSearch: 'indexed' },
    };
    const saved = await app.inject({ method: 'POST', url, headers, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      revision: 1,
      toolPolicy: 'restricted',
      codex: { mcpServers: ['demo_docs'], webSearch: 'indexed' },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.clients.size).toBe(0);
    expect(store.agent(manager).webSearch).toBe('disabled');
    const head = store.head;
    expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toEqual(
      saved.json(),
    );
    expect(store.head).toBe(head);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, key: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, codex: { webSearch: 'live' } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { key: randomUUID(), revision: 1, codex: { mcpServers: ['unconfigured'] } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            key: randomUUID(),
            revision: 1,
            codex: { command: 'execute arbitrary command' },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, origin: 'https://elsewhere.invalid' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: `${url}/catalog`, headers })).json()).toEqual([
      { name: 'demo_docs' },
    ]);
    expect(store.getSetting(`worker-tools:${projectId}`)).toEqual(saved.json());
    expect(store.runs()).toEqual([]);
  });
  it('restores native project defaults without catalog discovery, retaining old receipts and restricted ceilings', async () => {
    const projectId = store.agent(manager).projectId;
    const url = `/api/projects/${projectId}/worker-tools`;
    const legacy = { key: randomUUID(), revision: 0, codex: { webSearch: 'indexed' } };
    const saved = await app.inject({ method: 'POST', url, headers, payload: legacy });
    const catalog = vi.spyOn(runtime, 'projectMcpCatalog').mockRejectedValue(new Error('offline'));
    const restore = {
      key: randomUUID(),
      revision: 1,
      toolPolicy: 'native',
      // Dormant values in a native save cannot silently extend the old allowance.
      codex: { mcpServers: ['not-granted'], webSearch: 'live' },
    };
    const result = await app.inject({ method: 'POST', url, headers, payload: restore });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      revision: 2,
      toolPolicy: 'native',
      codex: { webSearch: 'indexed', mcpServers: [] },
    });
    const head = store.head;
    expect((await app.inject({ method: 'POST', url, headers, payload: restore })).json()).toEqual(
      result.json(),
    );
    // Checking an older uncertain save returns its own receipt without undoing restoration.
    expect((await app.inject({ method: 'POST', url, headers, payload: legacy })).json()).toEqual(
      saved.json(),
    );
    expect(store.head).toBe(head);
    expect((await app.inject({ url, headers })).json().toolPolicy).toBe('native');
    expect(store.agent(manager).toolPolicy).toBe('restricted');
    expect(catalog).not.toHaveBeenCalled();
    expect(runtime.clients.size).toBe(0);
    expect(store.runs()).toEqual([]);
  });
  it('offers allowance budgets and cache controls through protected, retry-safe app actions', async () => {
    const before = store.head;
    const first = await app.inject({ url: '/api/quark', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().budgets).toEqual([]);
    expect(store.head).toBe(before);
    expect(runtime.clients.size).toBe(0);
    const at = Date.now();
    store.setSetting(
      'capacity:v1:codex',
      parseCapacity(
        'codex',
        [
          {
            provider: 'codex',
            source: 'oauth',
            usage: {
              updatedAt: new Date(at).toISOString(),
              secondary: {
                usedPercent: 6,
                windowMinutes: 10080,
                resetsAt: new Date(at + 7 * 86400_000).toISOString(),
              },
            },
          },
        ],
        at,
      ),
    );
    const payload = {
      key: randomUUID(),
      projectId: store.agent(manager).projectId,
      provider: 'codex',
      windowId: 'secondary',
      limitPercent: 10,
    };
    const saved = await app.inject({ method: 'POST', url: '/api/quark/budgets', headers, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().budgets[0].limitPercent).toBe(10);
    const retry = await app.inject({ method: 'POST', url: '/api/quark/budgets', headers, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().budgets).toEqual(saved.json().budgets);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/quark/budgets',
          headers: { ...headers, origin: 'https://evil.test' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/quark/budgets',
          headers,
          payload: { ...payload, key: randomUUID(), limitPercent: 101 },
        })
      ).statusCode,
    ).toBe(400);
    const settings = { ...first.json().settings, cacheEnabled: false };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/quark/settings',
          headers,
          payload: { key: randomUUID(), settings },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/quark/settings',
          headers,
          payload: { key: randomUUID(), settings },
        })
      ).statusCode,
    ).toBe(409);
    expect(runtime.clients.size).toBe(0);
  });
  it('validates idempotent queue settings without starting or cancelling unrelated work', async () => {
    const value = { key: randomUUID(), settings: { paused: true, maxConcurrent: 2 } };
    const update = await app.inject({
      method: 'POST',
      url: '/api/scheduler/settings',
      headers,
      payload: value,
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toEqual(value.settings);
    const head = store.head;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/scheduler/settings',
          headers,
          payload: value,
        })
      ).statusCode,
    ).toBe(200);
    expect(store.head).toBe(head);
    expect(store.runs()).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/scheduler/settings',
          headers: { ...headers, origin: 'https://evil.test' },
          payload: value,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/scheduler/settings',
          headers,
          payload: { key: randomUUID(), settings: { paused: false, maxConcurrent: 99 } },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/api/scheduler', headers })).json().settings).toEqual(
      value.settings,
    );
  });
  it('reads cross-project attention without starting work and reconstructs it from retained state', async () => {
    store.updateAgent(manager, { status: 'interrupted' });
    const head = store.head;
    const first = await app.inject({ url: '/api/attention', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().items[0]).toMatchObject({ agentId: manager, kind: 'interrupted' });
    expect(store.head).toBe(head);
    expect(runtime.clients.size).toBe(0);
    await app.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
    app = await createServer(store, runtime, { port: 4999 });
    expect((await app.inject({ url: '/api/attention', headers })).json()).toEqual(first.json());
    store.updateAgent(manager, { status: 'idle' });
    expect((await app.inject({ url: '/api/attention', headers })).json().items).toEqual([]);
  });
  it('serves retained images by agent-owned IDs with no filesystem or cross-origin access', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
      'base64',
    );
    store.imageEntry(
      {
        id: 'image-item',
        agentId: manager,
        runId: null,
        kind: 'tool',
        title: 'Generated image',
        text: 'Test image',
        status: 'complete',
        createdAt: new Date().toISOString(),
      },
      bytes,
    );
    const image = store.entries(manager)[0].image!;
    const url = `/api/agents/${manager}/images/${image.id}`;
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers).toMatchObject({
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(response.headers['content-disposition']).toContain(`generated-${image.id}.png`);
    expect(
      (await app.inject({ url, headers: { ...headers, origin: 'https://example.invalid' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/api/agents/${manager}/images/not-a-file.png`, headers }))
        .statusCode,
    ).toBe(400);
    const other = store.addManager(store.agent(manager).projectId, 'Other', 'Separate identity');
    expect(
      (await app.inject({ url: `/api/agents/${other.id}/images/${image.id}`, headers })).statusCode,
    ).toBe(404);
    const detail = await app.inject({ url: `/api/agents/${manager}`, headers });
    expect(detail.body).not.toContain(bytes.toString('base64'));
    expect(detail.json().entries[0].image).toEqual(image);
  });

  it('persists idle worker web-search modes without granting manager tools or starting work', async () => {
    const worker = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: null,
      taskId: null,
      name: 'Web researcher',
      role: 'researcher',
      cwd: root,
    });
    expect(worker.webSearch).toBe('cached');
    const { client, threadId } = await runtime.attach(worker.id);
    const originalEntries = store.entries(worker.id);
    const settings = { model: 'demo', effort: 'medium', permission: 'read-only' };
    const post = (webSearch: unknown, target = worker.id) =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${target}/settings`,
        headers,
        payload: { ...settings, webSearch },
      });
    for (const mode of ['indexed', 'live', 'disabled', 'cached']) {
      const saved = await post(mode);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().webSearch).toBe(mode);
      expect(store.agent(worker.id)).toMatchObject({
        threadId,
        permission: 'read-only',
        webSearch: mode,
      });
      expect(store.entries(worker.id).slice(0, originalEntries.length)).toEqual(originalEntries);
      expect(store.runs()).toHaveLength(0);
    }
    expect(client.ready).toBe(false);
    const { client: imageClient } = await runtime.attach(worker.id);
    for (const imageGeneration of [true, false]) {
      const changed = await app.inject({
        method: 'POST',
        url: `/api/agents/${worker.id}/settings`,
        headers,
        payload: { ...settings, imageGeneration },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().imageGeneration).toBe(imageGeneration);
      expect(store.runs()).toHaveLength(0);
      expect(store.agent(worker.id).threadId).toBe(threadId);
    }
    expect(imageClient.ready).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${manager}/settings`,
          headers,
          payload: { ...settings, imageGeneration: true },
        })
      ).statusCode,
    ).toBe(409);
    expect((await post('unsupported')).statusCode).toBe(400);
    expect((await post('live', manager)).statusCode).toBe(409);
    expect(store.agent(manager).webSearch).toBe('disabled');
    store.updateAgent(worker.id, { status: 'running' });
    expect((await post('live')).statusCode).toBe(409);
    store.updateAgent(worker.id, { status: 'idle' });
    const snapshot = (await app.inject({ method: 'GET', url: '/api/snapshot', headers })).json();
    expect(snapshot.agents.find((a: { id: string }) => a.id === worker.id).webSearch).toBe(
      'cached',
    );
  });

  it('keeps original URL permission separate from page completion, with private retained links and no replay', async () => {
    const worker = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'URL fixture',
      cwd: root,
    });
    store.updateAgent(worker.id, { toolPolicy: 'restricted', mcpServers: ['demo_docs'] });
    const { client, threadId } = await runtime.attach(worker.id);
    const respond = vi.spyOn(client, 'respond');
    const params = {
      threadId,
      turnId: null,
      serverName: 'demo_docs',
      mode: 'url',
      _meta: null,
      message: 'Continue the local fixture',
      elicitationId: 'fixture-url',
      url: 'https://example.invalid/continue?state=private-fixture-token',
    };
    const emit = async (id: number, changes = {}) => {
      client.emit('request', id, 'mcpServer/elicitation/request', { ...params, ...changes });
      await runtime.withLock(`provider:${worker.id}`, async () => {});
    };
    await emit(920);
    const approval = store.approvals()[0];
    expect(approval).toMatchObject({
      kind: 'mcp_url',
      requestId: 920,
      status: 'pending',
      urlRequest: { serverName: 'demo_docs', url: params.url },
    });
    const snapshot = (await app.inject({ method: 'GET', url: '/api/snapshot', headers })).json();
    expect(snapshot.approvals[0].urlRequest).toEqual(approval.urlRequest);
    expect(snapshot.approvals[0]).not.toHaveProperty('params');
    expect(respond).not.toHaveBeenCalled();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: `/api/approvals/${approval.id}`, headers, payload });
    expect((await post({ decision: 'accept', url: 'https://forged.invalid' })).statusCode).toBe(
      400,
    );
    expect(respond).not.toHaveBeenCalled();
    expect((await post({ decision: 'accept' })).statusCode).toBe(200);
    expect((await post({ decision: 'accept' })).statusCode).toBe(200);
    expect(respond).toHaveBeenCalledExactlyOnceWith(920, { action: 'accept', content: null });
    const allowed = store
      .entries(worker.id)
      .filter((entry) => entry.title === 'URL request allowed');
    expect(allowed).toHaveLength(1);
    expect(allowed[0].urlRequest).toEqual(approval.urlRequest);
    expect(allowed[0].text).toContain('not successful sign-in or completion');
    expect(runtime.context(store.agent(worker.id))).not.toContain('private-fixture-token');
    const inspected = await runtime.tool(manager, 'inspect-url', 'dock_inspect', {
      agentId: worker.id,
    });
    expect(JSON.stringify(inspected)).toContain('URL request allowed');
    expect(JSON.stringify(inspected)).not.toContain('private-fixture-token');
    await emit(921);
    const declined = store.approvals().at(-1)!;
    await runtime.approve(declined.id, 'decline');
    expect(respond).toHaveBeenLastCalledWith(921, { action: 'decline', content: null });
    expect(
      store.entries(worker.id).find((entry) => entry.title === 'URL request declined'),
    ).not.toHaveProperty('urlRequest');
    await emit(922);
    const resolved = store.approvals().at(-1)!;
    client.emit('notification', 'serverRequest/resolved', { threadId, requestId: 922 });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    await expect(runtime.approve(resolved.id, 'accept')).rejects.toThrow('no longer pending');
    await emit(923);
    const abandoned = store.approvals().at(-1)!,
      archive = store.entries(worker.id);
    await runtime.close();
    store.recover();
    expect(store.approval(abandoned.id).status).toBe('expired');
    expect(store.entries(worker.id).slice(0, archive.length)).toEqual(archive);
    await expect(runtime.approve(abandoned.id, 'accept')).rejects.toThrow('no longer pending');
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it('declines unsafe, foreign, unselected and malformed-consent URL requests', async () => {
    const worker = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'URL boundary fixture',
      cwd: root,
    });
    store.updateAgent(worker.id, { toolPolicy: 'restricted', mcpServers: ['demo_docs'] });
    const { client, threadId } = await runtime.attach(worker.id);
    const respond = vi.spyOn(client, 'respond');
    const params = {
      threadId,
      turnId: null,
      serverName: 'demo_docs',
      mode: 'url',
      _meta: null,
      message: 'Fixture link',
      elicitationId: 'fixture-url',
      url: 'https://example.invalid',
    };
    let requestId = 930;
    for (const changes of [
      { serverName: 'not-selected' },
      { elicitationId: undefined },
      { message: null },
      { url: 'javascript:alert(1)' },
      { url: 'http://elsewhere.invalid' },
      { _meta: { codex_approval_kind: 'mcp_tool_call' } },
    ]) {
      const current = requestId++;
      client.emit('request', current, 'mcpServer/elicitation/request', { ...params, ...changes });
      await runtime.withLock(`provider:${worker.id}`, async () => {});
      expect(respond.mock.calls.at(-1)?.[0]).toBe(current);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'decline', content: null });
      expect(store.approvals()).toHaveLength(0);
    }
    const foreign = requestId++;
    client.emit('request', foreign, 'mcpServer/elicitation/request', {
      ...params,
      threadId: 'foreign',
    });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    expect(store.approvals()).toHaveLength(0);
    const connection = await runtime.attach(manager),
      managerRespond = vi.spyOn(connection.client, 'respond');
    connection.client.emit('request', requestId, 'mcpServer/elicitation/request', {
      ...params,
      threadId: connection.threadId,
    });
    await expect.poll(() => managerRespond.mock.calls.length).toBe(1);
    expect(managerRespond.mock.calls[0][1]).toMatchObject({ action: 'decline', content: null });
    expect(store.approvals()).toHaveLength(0);
  });

  it('validates original MCP form replies, archives accepted values once, and expires abandoned requests', async () => {
    const worker = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'Form fixture',
      cwd: root,
    });
    store.updateAgent(worker.id, { toolPolicy: 'restricted', mcpServers: ['demo_docs'] });
    const { client, threadId } = await runtime.attach(worker.id);
    const respond = vi.spyOn(client, 'respond');
    const params = {
      threadId,
      turnId: null,
      serverName: 'demo_docs',
      mode: 'form',
      _meta: null,
      message: 'Choose fixture preferences',
      requestedSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 0, maximum: 3 },
          enabled: { type: 'boolean' },
        },
        required: ['count', 'enabled'],
      },
    };
    const emit = async (id: number, changes = {}) => {
      client.emit('request', id, 'mcpServer/elicitation/request', { ...params, ...changes });
      await runtime.withLock(`provider:${worker.id}`, async () => {});
    };
    await emit(900);
    const approval = store.approvals()[0];
    expect(approval).toMatchObject({
      kind: 'mcp_form',
      requestId: 900,
      status: 'pending',
      form: { serverName: 'demo_docs' },
    });
    const snapshot = (await app.inject({ method: 'GET', url: '/api/snapshot', headers })).json();
    expect(snapshot.approvals[0].form.requestedSchema).toEqual(params.requestedSchema);
    expect(snapshot.approvals[0]).not.toHaveProperty('params');
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}`,
        headers,
        payload: payload as object,
      });
    for (const formValues of [
      { count: '0', enabled: false },
      { count: 4, enabled: false },
      { count: 0 },
      { count: 0, enabled: false, extra: true },
    ]) {
      expect((await post({ decision: 'accept', formValues })).statusCode).toBe(409);
      expect(store.approval(approval.id).status).toBe('pending');
      expect(respond).not.toHaveBeenCalled();
    }
    expect(
      (await post({ decision: 'accept', formValues: { count: 0, enabled: false } })).statusCode,
    ).toBe(200);
    expect(
      (await post({ decision: 'accept', formValues: { count: 2, enabled: true } })).statusCode,
    ).toBe(200);
    expect(respond).toHaveBeenCalledExactlyOnceWith(900, {
      action: 'accept',
      content: { count: 0, enabled: false },
    });
    const submitted = store
      .entries(worker.id)
      .filter((entry) => entry.title === 'Form submitted to demo_docs');
    expect(submitted).toHaveLength(1);
    expect(JSON.parse(submitted[0].text)).toEqual({ count: 0, enabled: false });
    await emit(901);
    await runtime.approve(store.approvals()[1].id, 'decline');
    expect(respond).toHaveBeenLastCalledWith(901, { action: 'decline', content: null });
    await emit(902, { serverName: 'not-selected' });
    expect(respond).toHaveBeenLastCalledWith(902, { action: 'decline', content: null });
    await emit(903, { mode: 'url', url: 'javascript:alert(1)', elicitationId: 'fixture' });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'decline', content: null });
    await emit(904, {
      requestedSchema: { type: 'object', properties: { unsafe: { type: 'object' } } },
    });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'decline', content: null });
    await emit(905);
    client.emit('notification', 'serverRequest/resolved', { threadId, requestId: 905 });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    await expect(
      runtime.approve(store.approvals()[2].id, 'accept', undefined, { count: 0, enabled: false }),
    ).rejects.toThrow('no longer pending');
    await emit(908, { mode: 'openai/form' });
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'decline', content: null });
    const managerConnection = await runtime.attach(manager);
    const managerRespond = vi.spyOn(managerConnection.client, 'respond');
    managerConnection.client.emit('request', 909, 'mcpServer/elicitation/request', {
      ...params,
      threadId: managerConnection.threadId,
    });
    await expect.poll(() => managerRespond.mock.calls.length).toBe(1);
    expect(managerRespond).toHaveBeenCalledExactlyOnceWith(909, {
      action: 'decline',
      content: null,
    });
    await emit(906);
    const abandoned = store.approvals()[3];
    const archive = store.entries(worker.id);
    await runtime.close();
    store.recover();
    expect(store.approval(abandoned.id).status).toBe('expired');
    expect(store.entries(worker.id).slice(0, archive.length)).toEqual(archive);
    expect(store.entries(worker.id).at(-1)?.title).toBe('Interrupted');
    await expect(
      runtime.approve(abandoned.id, 'accept', undefined, { count: 0, enabled: false }),
    ).rejects.toThrow('no longer pending');
    expect(respond).toHaveBeenCalledTimes(6);
  });
  it('exposes reviewed-code evidence without paths and refuses integration for transcript-only results', async () => {
    const project = store.agent(manager).projectId;
    const result = store.addTask(project, {
      title: 'Research result',
      goal: 'One answer',
      acceptance: 'Evidence retained',
      parentId: null,
    });
    const code = store.addTask(project, {
      title: 'Code result',
      goal: 'One implementation',
      acceptance: 'Reviewed code',
      parentId: null,
    });
    const unchanged = store.addTask(project, {
      title: 'Read-only result with a review worktree',
      goal: 'One inspected answer',
      acceptance: 'Evidence retained',
      parentId: null,
    });
    store.updateTask(unchanged.id, {
      status: 'done',
      review: 'approve',
      worktree: '/private/unchanged-worktree',
      baseCommit: 'unchanged-base',
      reviewedCommit: 'unchanged-base',
    });
    store.updateTask(result.id, { status: 'done', review: 'approve' });
    store.updateTask(code.id, {
      status: 'done',
      review: 'approve',
      worktree: '/private/fixture-worktree',
      baseCommit: 'private-base-commit',
      reviewedCommit: 'private-reviewed-commit',
    });
    const response = await app.inject({ method: 'GET', url: '/api/snapshot', headers });
    expect(response.statusCode).toBe(200);
    const tasks = response.json().tasks;
    expect(tasks.find((t: { id: string }) => t.id === result.id).hasReviewedChanges).toBe(false);
    expect(tasks.find((t: { id: string }) => t.id === unchanged.id).hasReviewedChanges).toBe(false);
    expect(tasks.find((t: { id: string }) => t.id === code.id).hasReviewedChanges).toBe(true);
    expect(response.body).not.toContain('/private/fixture-worktree');
    expect(response.body).not.toContain('private-reviewed-commit');
    expect(response.body).not.toContain('private-base-commit');
    expect(response.body).not.toContain('/private/unchanged-worktree');
    expect(response.body).not.toContain('unchanged-base');
    const inspection = await runtime.tool(manager, randomUUID(), 'dock_inspect', {
      taskId: code.id,
    });
    expect(inspection).toMatchObject({ task: { hasReviewedChanges: true } });
    const denied = await app.inject({
      method: 'GET',
      url: `/api/tasks/${result.id}/integration`,
      headers,
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.body).toContain('Finish and review the task');
    expect(store.task(result.id).status).toBe('done');
  });
  it('retains native child records but refuses queued direct input and independent settings or contexts', async () => {
    const parent = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: manager,
      taskId: null,
      role: 'researcher',
      name: 'Native parent',
      cwd: root,
    });
    const child = store.addAgent({
      projectId: parent.projectId,
      parentId: parent.id,
      taskId: null,
      role: 'researcher',
      name: 'Native child',
      cwd: root,
    });
    store.updateAgent(child.id, {
      nativeRootId: parent.id,
      nativePath: '/root/helper',
      threadId: randomUUID(),
    });
    for (const [path, payload] of [
      ['messages', { key: randomUUID(), text: 'Do not queue an impossible independent turn' }],
      ['messages', { key: randomUUID(), text: 'Do not steer independently', steer: true }],
      ['commands', { key: randomUUID(), command: 'resume' }],
      ['commands', { key: randomUUID(), command: 'new' }],
      ['commands', { key: randomUUID(), command: 'compact' }],
      ['settings', { model: 'demo', effort: 'medium', permission: 'read-only' }],
    ] as const) {
      const result = await app.inject({
        method: 'POST',
        url: `/api/agents/${child.id}/${path}`,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(409);
      expect(result.body).toContain('controlled by its parent');
    }
    expect(store.runs()).toHaveLength(0);
    expect(runtime.clients.size).toBe(0);
    const detail = await app.inject({ method: 'GET', url: `/api/agents/${child.id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('/root/helper');
    expect(detail.body).not.toContain(root);
  });
  it('persists explicit worker plugin opt-in, refuses managers and reconnects without starting a turn', async () => {
    const worker = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: null,
      taskId: null,
      name: 'Plugin reader',
      role: 'researcher',
      cwd: root,
    });
    await runtime.attach(worker.id);
    const previous = runtime.clients.get(worker.id),
      threadId = store.agent(worker.id).threadId;
    const settings = {
      model: 'demo',
      effort: 'medium',
      permission: 'read-only',
      pluginsEnabled: true,
    };
    const saved = await app.inject({
      method: 'POST',
      url: `/api/agents/${worker.id}/settings`,
      headers,
      payload: settings,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().pluginsEnabled).toBe(true);
    expect(previous?.ready).toBe(false);
    expect(store.agent(worker.id).threadId).toBe(threadId);
    expect(store.runs()).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${manager}/settings`,
          headers,
          payload: settings,
        })
      ).statusCode,
    ).toBe(409);
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/agents/${worker.id}/settings`,
      headers,
      payload: { ...settings, pluginsEnabled: false },
    });
    expect(disabled.json().pluginsEnabled).toBe(false);
  });
  it('lets idle workers select configured MCP names without exposing transports or enabling manager execution', async () => {
    const worker = store.addAgent({
      projectId: store.agent(manager).projectId,
      parentId: manager,
      taskId: null,
      name: 'MCP reader',
      role: 'researcher',
      cwd: root,
    });
    const catalog = await app.inject({
      method: 'GET',
      url: `/api/agents/${worker.id}/mcp`,
      headers,
    });
    expect(catalog.json()).toEqual([{ name: 'demo_docs' }]);
    const settings = {
      model: 'demo',
      effort: 'medium',
      permission: 'read-only',
      mcpServers: ['demo_docs'],
    };
    const save = () =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${worker.id}/settings`,
        headers,
        payload: settings,
      });
    expect((await save()).statusCode).toBe(200);
    expect(store.agent(worker.id).mcpServers).toEqual(['demo_docs']);
    expect(store.runs()).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${manager}/settings`,
          headers,
          payload: settings,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${worker.id}/settings`,
          headers,
          payload: { ...settings, mcpServers: ['unconfigured'] },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${worker.id}/settings`,
          headers,
          payload: { ...settings, command: '/bin/sh' },
        })
      ).statusCode,
    ).toBe(400);
    store.updateAgent(worker.id, { status: 'running' });
    expect((await save()).statusCode).toBe(409);
  });
  it('creates module managers idempotently and routes owner tasks to the selected manager', async () => {
    const projectId = store.agent(manager).projectId;
    const request = {
      method: 'POST' as const,
      url: `/api/projects/${projectId}/managers`,
      headers,
      payload: { key: randomUUID(), name: 'Interface manager', scope: 'Web interface' },
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    const module = first.json();
    expect(module).toMatchObject({
      role: 'manager',
      scope: 'Web interface',
      permission: 'read-only',
    });
    expect(first.body).not.toContain(root);
    expect((await app.inject(request)).json().id).toBe(module.id);
    expect(store.agents()).toHaveLength(2);
    expect(
      (await app.inject({ ...request, payload: { ...request.payload, scope: 'Changed' } }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          ...request,
          payload: { ...request.payload, key: randomUUID(), cwd: '/arbitrary' },
        })
      ).statusCode,
    ).toBe(400);
    const taskRequest = {
      method: 'POST' as const,
      url: `/api/projects/${projectId}/tasks`,
      headers,
      payload: {
        key: randomUUID(),
        managerId: module.id,
        task: { title: 'Module task', goal: 'One change', acceptance: 'One check' },
      },
    };
    const task = await app.inject(taskRequest);
    expect(task.statusCode).toBe(201);
    expect(task.json().managerId).toBe(module.id);
    expect((await app.inject(taskRequest)).json().id).toBe(task.json().id);
    expect(store.runs()).toHaveLength(1);
    expect(store.runs()[0].agentId).toBe(module.id);
    const other = store.register(join(root, 'other'), 'Other', '');
    expect(
      (
        await app.inject({
          ...taskRequest,
          payload: { ...taskRequest.payload, key: randomUUID(), managerId: other.managerId },
        })
      ).statusCode,
    ).toBe(409);
    const worker = store.addAgent({
      projectId,
      parentId: module.id,
      taskId: null,
      role: 'researcher',
      name: 'Worker',
      cwd: root,
    });
    expect(
      (
        await app.inject({
          ...taskRequest,
          payload: { ...taskRequest.payload, key: randomUUID(), managerId: worker.id },
        })
      ).statusCode,
    ).toBe(409);
    expect(store.tasks()).toHaveLength(1);
    const legacyKey = randomUUID();
    const legacyTask = {
      title: 'Before modules',
      goal: 'Keep the receipt',
      acceptance: 'Same task on retry',
    };
    const saved = store.addTask(projectId, { ...legacyTask, parentId: null });
    const { managerId: _oldManager, ...legacyResult } = saved;
    store.operation(legacyKey, { projectId, task: legacyTask }, () => legacyResult);
    const replay = await app.inject({
      ...taskRequest,
      payload: { key: legacyKey, task: legacyTask },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ id: saved.id, managerId: manager });
  });
  it('replays command receipts exactly and rejects changed retry input', async () => {
    const key = randomUUID();
    const request = {
      method: 'POST' as const,
      url: `/api/agents/${manager}/commands`,
      headers,
      payload: { key, command: 'new' },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    const count = store.entries(manager).length;
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(store.entries(manager)).toHaveLength(count);
    expect(
      (await app.inject({ ...request, payload: { key, command: 'interrupt' } })).statusCode,
    ).toBe(409);
  });
  it('replays SSE by Last-Event-ID, streams live invalidations, and releases listeners', async () => {
    await app.listen({ host: '127.0.0.1', port: 4999 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const baseline = store.listenerCount('event');
    const cursor = store.head;
    const replay = store.event('test.replay', store.agent(manager).projectId, manager, {
      private: 'not-in-stream',
    });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
      headers: { host: headers.host, 'Last-Event-ID': String(cursor) },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = '';
    async function until(expected: string) {
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        while (!text.includes(expected)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream ended');
          text += new TextDecoder().decode(chunk.value);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    try {
      await until(`id: ${replay.id}\n`);
      const live = store.event('test.live', null, null, {});
      await until(`id: ${live.id}\n`);
      expect(text).not.toContain('not-in-stream');
      expect(text).not.toContain(`id: ${cursor}\n`);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    await expect.poll(() => store.listenerCount('event')).toBe(baseline);
  });
  it('shuts down with a browser event stream still open and retains its archive', async () => {
    await runtime.tool(manager, randomUUID(), 'dock_checkpoint', { summary: 'Before shutdown' });
    const entries = store.entries(manager);
    await app.listen({ host: '127.0.0.1', port: 4999 });
    const controller = new AbortController();
    const response = await fetch('http://127.0.0.1:4999/api/events', { signal: controller.signal });
    expect(response.status).toBe(200);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        app.close(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('An open event stream blocked shutdown.')),
            2000,
          );
        }),
      ]);
      expect(store.db.isOpen).toBe(false);
      expect(store.listenerCount('event')).toBe(0);
      const reopened = new Store(join(root, 'dock.sqlite'));
      modelFixture(reopened);
      try {
        expect(reopened.agent(manager).checkpoint).toBe('Before shutdown');
        expect(reopened.entries(manager)).toEqual(entries);
      } finally {
        reopened.close();
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response.body?.cancel().catch(() => {});
    }
  });
  it('rejects foreign hosts, origins and unguarded writes', async () => {
    for (const value of [
      { host: 'evil.example' },
      { host: headers.host, origin: 'https://evil.example' },
      { host: headers.host, 'sec-fetch-site': 'cross-site' },
    ])
      expect((await app.inject({ url: '/api/snapshot', headers: value })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${manager}/messages`,
          headers: { host: headers.host },
          payload: { key: randomUUID(), text: 'No origin' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('returns typed project/agent projections without execution handles or filesystem roots', async () => {
    store.updateAgent(manager, { threadId: 'private-provider-id' });
    const response = await app.inject({ url: '/api/snapshot', headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain('private-provider-id');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('persists literal messages once while rejecting execution fields and arbitrary RPC', async () => {
    const key = randomUUID();
    const url = `/api/agents/${manager}/messages`;
    const first = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { key, text: 'A durable goal' },
    });
    const second = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { key, text: 'A durable goal' },
    });
    expect(first.statusCode).toBe(202);
    expect(second.json().id).toBe(first.json().id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { key: randomUUID(), text: 'Hello', path: '/etc' },
        })
      ).statusCode,
    ).toBe(400);
    for (const text of ['/Users/example/project Please inspect this.', '/shell anything']) {
      const literal = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { key: randomUUID(), text },
      });
      expect(literal.statusCode).toBe(202);
      expect(store.run(literal.json().id).text).toBe(text);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/rpc',
          headers,
          payload: { method: 'command/exec' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('does not allow a manager to select workspace writes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${manager}/settings`,
      headers,
      payload: { model: 'demo', effort: 'medium', permission: 'workspace-write' },
    });
    expect(response.statusCode).toBe(409);
    expect(store.agent(manager).permission).toBe('read-only');
  });
});
