import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { Sessions } from './sessions.js';
import { repoRoot } from './paths.js';
import { createServer } from './server.js';

let root: string,
  store: Store,
  runtime: Runtime,
  sessions: Sessions,
  projectId: string,
  managerId: string;
let thread: {
  id: string;
  cwd: string;
  preview: string;
  name: string;
  updatedAt: number;
  status: { type: string };
};
let calls: { method: string; params: Record<string, unknown> }[];
let handler: (method: string, params: Record<string, unknown>) => unknown;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/sessions-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Fixture', '');
  projectId = project.id;
  managerId = project.managerId;
  thread = {
    id: randomUUID(),
    cwd: root,
    preview: 'A saved conversation',
    name: 'Saved session',
    updatedAt: 100,
    status: { type: 'notLoaded' },
  };
  calls = [];
  handler = (method, params) => {
    if (method === 'thread/list')
      return {
        data: [thread, { ...thread, id: randomUUID(), cwd: '/outside-project' }],
        nextCursor: 'next-page',
      };
    if (method === 'thread/read') return { thread: { ...thread, path: '/private/provider/path' } };
    if (method === 'thread/turns/list')
      return params.cursor
        ? {
            data: [
              {
                id: 'turn-2',
                items: [
                  { id: 'answer', type: 'agentMessage', text: 'The retained answer' },
                  { id: 'hidden', type: 'reasoning', content: ['private'] },
                ],
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: 'turn-1',
                items: [
                  {
                    id: 'question',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'The retained question' }],
                  },
                ],
              },
            ],
            nextCursor: 'older',
          };
    throw new Error(`Unexpected provider operation: ${method}`);
  };
  const provider = new DemoProvider();
  provider.request = async (method, raw) => {
    const params = raw as Record<string, unknown>;
    calls.push({ method, params });
    return handler(method, params);
  };
  runtime = new Runtime(store, root, 'codex', async () => provider);
  sessions = new Sessions(runtime);
});
afterEach(async () => {
  if (store.db.isOpen) {
    await runtime.close();
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
});
const input = () => ({ key: randomUUID(), threadId: thread.id, managerId, confirmedStopped: true });

describe('saved session discovery and import', () => {
  it('uses and releases a separate Codex reader for a Claude-managed project without changing its manager', async () => {
    await runtime.close();
    const folder = join(root, 'claude-project');
    mkdirSync(folder);
    const claudeProject = store.register(folder, 'Claude project', '', 'claude');
    projectId = claudeProject.id;
    managerId = claudeProject.managerId;
    thread.cwd = folder;
    store.updateAgent(managerId, {
      model: 'claude-fixture',
      threadId: randomUUID(),
    });
    const original = store.agent(managerId);
    const readers: DemoProvider[] = [];
    runtime = new Runtime(store, root, 'never-launch-real-provider', async (agent) => {
      expect(agent.provider).toBe('codex');
      const reader = new DemoProvider();
      reader.request = async (method, params) => {
        calls.push({ method, params: params as Record<string, unknown> });
        return handler(method, params as Record<string, unknown>);
      };
      readers.push(reader);
      return reader;
    });
    sessions = new Sessions(runtime);
    expect((await sessions.list(projectId)).data[0]?.id).toBe(thread.id);
    const imported = (await sessions.import(projectId, input())) as {
      id: string;
      provider: string;
    };
    expect(imported.provider).toBe('codex');
    expect(store.agent(imported.id).parentId).toBe(managerId);
    expect(store.agent(managerId)).toEqual(original);
    expect(runtime.clients.has(managerId)).toBe(false);
    expect(readers).toHaveLength(2);
    expect(readers.every((reader) => !reader.ready)).toBe(true);
    expect(store.runs()).toHaveLength(0);
    expect(
      calls.every((call) =>
        ['thread/list', 'thread/read', 'thread/turns/list'].includes(call.method),
      ),
    ).toBe(true);
  });
  it('lists only the registered repository with pagination and no execution handles', async () => {
    const page = await sessions.list(projectId, 'cursor');
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).toBe('next-page');
    expect(JSON.stringify(page)).not.toContain(root);
    expect(JSON.stringify(page)).not.toContain('private/provider');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'thread/list',
      params: {
        cwd: root,
        cursor: 'cursor',
        sourceKinds: expect.arrayContaining(['appServer', 'cli', 'subAgentThreadSpawn']),
      },
    });
    expect(store.runs()).toHaveLength(0);
  });
  it('imports all visible pages atomically and idempotently without starting a provider turn', async () => {
    const request = input();
    const [a, b] = (await Promise.all([
      sessions.import(projectId, request),
      sessions.import(projectId, request),
    ])) as { id: string }[];
    expect(a.id).toBe(b.id);
    expect(store.agents()).toHaveLength(2);
    expect(store.agent(a.id)).toMatchObject({
      parentId: managerId,
      role: 'researcher',
      permission: 'read-only',
      threadId: thread.id,
      status: 'idle',
    });
    expect(
      store
        .entries(a.id)
        .map((e) => e.text)
        .slice(0, 2),
    ).toEqual(['The retained question', 'The retained answer']);
    expect(store.entries(a.id).some((e) => e.text === 'private')).toBe(false);
    expect(store.runs()).toHaveLength(0);
    expect(calls.every((c) => ['thread/read', 'thread/turns/list'].includes(c.method))).toBe(true);
    await expect(
      sessions.import(projectId, { ...request, threadId: randomUUID() }),
    ).rejects.toThrow('different input');
    const head = store.head;
    expect(((await sessions.import(projectId, input())) as { id: string }).id).toBe(a.id);
    expect(store.head).toBe(head);
    expect((await sessions.list(projectId)).data[0].agentId).toBe(a.id);
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    runtime = new Runtime(store, root, 'codex');
    expect(store.agent(a.id).threadId).toBe(thread.id);
    expect(store.entries(a.id)).toHaveLength(3);
  });
  it('rejects unknown authority, foreign repositories, active threads, and forged fields', async () => {
    await expect(
      sessions.import(projectId, { ...input(), confirmedStopped: false }),
    ).rejects.toThrow();
    await expect(sessions.import(projectId, { ...input(), path: '/arbitrary' })).rejects.toThrow();
    const other = store.register(join(root, 'other'), 'Other', '');
    await expect(
      sessions.import(projectId, { ...input(), managerId: other.managerId }),
    ).rejects.toThrow('this project');
    thread.cwd = '/outside-project';
    await expect(sessions.import(projectId, input())).rejects.toThrow('registered repository');
    thread.cwd = root;
    thread.status.type = 'active';
    await expect(sessions.import(projectId, input())).rejects.toThrow('Stop the original');
    expect(store.agents()).toHaveLength(2);
    expect(store.runs()).toHaveLength(0);
  });
  it('reuses the durable owner when an imported context is no longer its current context', async () => {
    const imported = (await sessions.import(projectId, input())) as { id: string };
    const entries = store.entries(imported.id);
    store.updateAgent(imported.id, { threadId: 'fresh-current-context' });
    const before = calls.length;
    expect((await sessions.list(projectId)).data[0].agentId).toBe(imported.id);
    expect(await sessions.import(projectId, input())).toMatchObject({ id: imported.id });
    expect(store.agents()).toHaveLength(2);
    expect(store.agent(imported.id).threadId).toBe('fresh-current-context');
    expect(store.entries(imported.id)).toEqual(entries);
    expect(calls.slice(before).some((c) => c.method === 'thread/turns/list')).toBe(false);
  });
  it('leaves no partial import when a page fails or the original changes during reading', async () => {
    const baseline = store.head;
    const original = handler;
    handler = (method, params) => {
      if (method === 'thread/turns/list' && params.cursor) throw new Error('Connection lost');
      return original(method, params);
    };
    const request = input();
    await expect(sessions.import(projectId, request)).rejects.toThrow('Connection lost');
    expect(store.head).toBe(baseline);
    expect(store.agents()).toHaveLength(1);
    handler = (method, params) => {
      if (method === 'thread/turns/list') thread.updatedAt++;
      return original(method, params);
    };
    await expect(sessions.import(projectId, request)).rejects.toThrow('changed while reading');
    expect(store.head).toBe(baseline);
    handler = original;
    await expect(sessions.import(projectId, request)).resolves.toMatchObject({
      role: 'researcher',
    });
  });
  it('rejects repeated provider cursors instead of looping forever', async () => {
    const original = handler;
    handler = (method, params) =>
      method === 'thread/turns/list'
        ? { data: [], nextCursor: 'repeated' }
        : original(method, params);
    await expect(sessions.import(projectId, input())).rejects.toThrow('repeated');
    expect(store.agents()).toHaveLength(1);
  });
  it('serves history through strict same-origin endpoints, not arbitrary RPC or paths', async () => {
    const app = await createServer(store, runtime, { port: 4999 });
    const headers = {
      host: '127.0.0.1:4999',
      origin: 'http://127.0.0.1:4999',
      'content-type': 'application/json',
    };
    try {
      const list = await app.inject({ url: `/api/projects/${projectId}/sessions`, headers });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(root);
      expect(
        (await app.inject({ url: `/api/projects/${projectId}/sessions?path=/arbitrary`, headers }))
          .statusCode,
      ).toBe(400);
      const url = `/api/projects/${projectId}/sessions/import`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...input(), confirmedStopped: false },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { host: headers.host },
            payload: input(),
          })
        ).statusCode,
      ).toBe(403);
      const imported = await app.inject({ method: 'POST', url, headers, payload: input() });
      expect(imported.statusCode).toBe(201);
      expect(imported.body).not.toContain(root);
      expect(imported.body).not.toContain(thread.id);
    } finally {
      await app.close();
    }
  });
});
