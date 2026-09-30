import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import * as pty from 'node-pty';
import { conversationSearchResultSchema } from '@dock/shared';
import { conversationSearchCharter } from './conversation-search.js';
import { modelFixture } from './model-policy.fixture.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';

// A regression must fail here rather than launch a real native terminal during a test.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    throw new Error('Unexpected terminal launch');
  }),
}));

let root: string, store: Store, runtime: Runtime, app: FastifyInstance, sourceId: string;
const providers = new Map<string, DemoProvider>();
const sockets: WebSocket[] = [];
const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
const get = (url: string) => app.inject({ url, headers });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers, payload });
const ask = () => ({
  key: randomUUID(),
  query: 'Which chat discussed galaxy luminosity?',
  provider: 'codex' as const,
});
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/conversation-search-api-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  const project = store.register(root, 'Galaxy research', 'Existing project, unchanged by search.');
  sourceId = project.managerId;
  store.entry({
    id: randomUUID(),
    agentId: sourceId,
    runId: null,
    kind: 'assistant',
    title: 'Prior reply',
    text: 'GALAXY_EVIDENCE: We compared luminosity against distance.',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  runtime = new Runtime(store, root, 'codex', async (agent) => {
    const provider = new DemoProvider();
    vi.spyOn(provider, 'request');
    vi.spyOn(provider, 'close');
    providers.set(agent.id, provider);
    return provider;
  });
  app = await createServer(store, runtime, { port: 4999 });
  await runtime.initialize();
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app.close();
  providers.clear();
  vi.mocked(pty.spawn).mockClear();
  rmSync(root, { recursive: true, force: true });
});

it('creates one explicit queued search, marks its project internal and keeps navigation and retries saved-only', async () => {
  const catalog = vi.spyOn(runtime.modelPolicy, 'catalog');
  expect((await get(`/api/conversations/search/${randomUUID()}`)).statusCode).toBe(404);
  await get('/api/snapshot');
  await get('/api/conversations');
  expect(catalog).not.toHaveBeenCalled();
  expect(store.runs()).toHaveLength(0);
  const input = ask();
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/conversations/search',
    headers: { ...headers, origin: 'https://untrusted.invalid' },
    payload: input,
  });
  expect(foreign.statusCode).toBe(403);
  expect(
    (await post('/api/conversations/search', { ...input, transcripts: ['browser-selected data'] }))
      .statusCode,
  ).toBe(400);
  expect(catalog).not.toHaveBeenCalled();

  const response = await post('/api/conversations/search', input);
  expect(response.statusCode).toBe(201);
  const search = conversationSearchResultSchema.parse(response.json());
  expect(search).toMatchObject({ status: 'queued', model: 'demo', report: null });
  expect(store.runs()).toHaveLength(1);
  expect(runtime.clients.has(search.agentId)).toBe(false);
  const snapshot = (await get('/api/snapshot')).json();
  expect(
    snapshot.projects.find(
      (project: { id: string }) => project.id === store.agent(search.agentId).projectId,
    ),
  ).toMatchObject({ internal: true });
  expect(
    snapshot.projects.find(
      (project: { id: string }) => project.id === store.agent(sourceId).projectId,
    ),
  ).toMatchObject({ internal: false });
  expect((await get('/api/frontdesk')).json().agentId).toBeNull();

  const calls = catalog.mock.calls.length;
  catalog.mockRejectedValue(new Error('Discovery must not run for an old receipt'));
  expect((await get(`/api/conversations/search/${search.id}`)).json()).toEqual(search);
  expect((await get(`/api/agents/${search.agentId}`)).statusCode).toBe(200);
  expect((await post('/api/conversations/search', input)).json()).toEqual(search);
  expect(
    (await post('/api/conversations/search', { ...input, query: 'Conflicting retry' })).statusCode,
  ).toBe(409);
  expect(catalog).toHaveBeenCalledTimes(calls);
  expect(runtime.clients.has(search.agentId)).toBe(false);
  expect(store.runs()).toHaveLength(1);
  expect(
    store.events().filter((event) => event.type === 'conversation_search.requested'),
  ).toHaveLength(1);
});

it('runs the helper through normal QUARK admission with its bounded evidence charter and no dynamic tools or escalation', async () => {
  // An explicit undergrad choice is allowed for bulk work; it must not add dock_escalate.
  vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'terra-fixture', label: 'Terra fixture', isDefault: true, efforts: ['medium'] },
  ]);
  const response = await post('/api/conversations/search', {
    ...ask(),
    model: 'terra-fixture',
    effort: 'medium',
  });
  expect(response.statusCode).toBe(201);
  const search = conversationSearchResultSchema.parse(response.json());
  expect(store.agent(search.agentId).assignment?.tier).toBe('undergrad');
  expect(store.run(search.runId).status).toBe('queued');
  const before = store.agent(sourceId);
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 2 });
  runtime.kick();
  await vi.waitFor(() =>
    expect(
      store.run(search.runId).status,
      JSON.stringify(
        store.entries(search.agentId).map((entry) => ({ title: entry.title, text: entry.text })),
      ),
    ).toBe('completed'),
  );
  const provider = providers.get(search.agentId)!;
  const started = store.getSetting(`conversation-search:started:${search.runId}`);
  expect(typeof started).toBe('number');
  expect(Date.now() - Number(started)).toBeLessThan(180_000);
  expect(
    store
      .events()
      .some((event) => event.type === 'run.interrupted' && event.agentId === search.agentId),
  ).toBe(false);
  const requests = vi.mocked(provider.request).mock.calls;
  expect(requests.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({
    sandbox: 'read-only',
    developerInstructions: conversationSearchCharter,
    dynamicTools: [],
  });
  const turn = requests.find(([method]) => method === 'turn/start')?.[1] as {
    additionalContext: { agent_dock_state: { kind: string; value: string } };
  };
  expect(turn.additionalContext.agent_dock_state.kind).toBe('untrusted');
  const context = JSON.parse(
    turn.additionalContext.agent_dock_state.value.split('\n').slice(1).join('\n'),
  );
  expect(context).toEqual(runtime.conversationSearch.context(search.agentId));
  expect(JSON.stringify(context)).toContain('GALAXY_EVIDENCE');
  expect(JSON.stringify(context)).toContain(`#/chat/${sourceId}`);
  expect(context.coverage).toMatchObject({ bounded: true, editorTranscripts: false });
  expect(Object.keys(context).sort()).toEqual(['candidates', 'coverage', 'query']);
  expect(requests.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  expect(store.getSetting(`pulsar:estimate:${search.runId}`)).toMatchObject({
    priority: 'interactive',
  });
  expect(store.agent(sourceId)).toEqual(before);
  await expect(
    runtime.tool(search.agentId, randomUUID(), 'dock_escalate', {
      question: 'Search elsewhere',
      evidence: 'No supplied evidence',
    }),
  ).rejects.toThrow('supplied saved evidence');
  await expect(
    runtime.tool(search.agentId, randomUUID(), 'dock_message', {
      agentId: sourceId,
      text: 'Do not deliver this',
    }),
  ).rejects.toThrow('supplied saved evidence');
  expect(store.runs()).toHaveLength(1);
  const report = conversationSearchResultSchema.parse(
    (await get(`/api/conversations/search/${search.id}`)).json(),
  );
  expect(report).toMatchObject({
    status: 'completed',
    report: expect.stringContaining('demo mode'),
  });
  runtime.kick();
  await vi.waitFor(() => expect(runtime.clients.has(search.agentId)).toBe(false));
  expect(provider.close).toHaveBeenCalled();
});

it('keeps the completed result readable while rejecting direct messages, settings, interviews, native commands and terminals', async () => {
  const response = await post('/api/conversations/search', ask());
  expect(response.statusCode).toBe(201);
  const search = conversationSearchResultSchema.parse(response.json());
  store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 2 });
  runtime.kick();
  await vi.waitFor(() =>
    expect(
      store.run(search.runId).status,
      JSON.stringify(
        store.entries(search.agentId).map((entry) => ({ title: entry.title, text: entry.text })),
      ),
    ).toBe('completed'),
  );
  const before = store.agent(search.agentId);
  for (const [route, payload] of [
    ['messages', { key: randomUUID(), text: 'Bypass the explicit search action' }],
    ['settings', { model: 'demo', effort: 'medium', permission: 'read-only' }],
    ['interviews', { key: randomUUID() }],
    ['commands', { key: randomUUID(), command: 'resume' }],
    ['commands', { key: randomUUID(), command: 'new' }],
  ] as const) {
    const rejected = await post(`/api/agents/${search.agentId}/${route}`, payload);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain('single bounded request');
  }
  const received: { type: string; message?: string }[] = [];
  const socket = await app.injectWS(
    `/api/agents/${search.agentId}/terminal`,
    { headers },
    {
      onInit: (connection) =>
        connection.on('message', (raw) => received.push(JSON.parse(raw.toString()))),
    },
  );
  sockets.push(socket);
  await vi.waitFor(() =>
    expect(received).toContainEqual({
      type: 'error',
      message: expect.stringContaining('single bounded request'),
    }),
  );
  await vi.waitFor(() => expect(socket.readyState).toBe(3));
  expect(pty.spawn).not.toHaveBeenCalled();
  expect(runtime.externalControl.has(search.agentId)).toBe(false);
  expect(store.agent(search.agentId)).toEqual(before);
  expect(store.runs()).toHaveLength(1);
  expect(store.agents()).toHaveLength(2);
  expect((await get(`/api/agents/${search.agentId}`)).statusCode).toBe(200);
  expect((await get(`/api/conversations/search/${search.id}`)).json().report).toContain(
    'demo mode',
  );
});
