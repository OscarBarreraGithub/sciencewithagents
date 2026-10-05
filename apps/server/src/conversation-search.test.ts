import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  conversationSearchResultSchema,
  defaultModelPolicy,
  type ConversationSearchResult,
  type ProviderId,
} from '@dock/shared';
import { ConversationSearch, registerConversationSearchRoutes } from './conversation-search.js';
import { ModelPolicy } from './model-policy.js';
import { historyPage, projectCatalog } from './history.js';
import { Conflict, Missing, Store } from './store.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swa-conversation-search-'));
  const file = join(root, 'dock.sqlite');
  let store = new Store(file);
  store.setSetting('model-policy', structuredClone(defaultModelPolicy));
  let now = Date.now();
  const models = vi.fn(async (provider: ProviderId) => [
    {
      id: provider === 'codex' ? 'luna-fixture' : 'sonnet-fixture',
      label: provider === 'codex' ? 'Luna' : 'Sonnet',
      isDefault: false,
      efforts: ['low', 'high'],
    },
    {
      id: 'native-next-fixture',
      label: 'Native future choice',
      isDefault: false,
      efforts: ['medium'],
    },
  ]);
  const mirrors = vi.fn((): unknown[] => []);
  const release = vi.fn(async () => true);
  const interrupt = vi.fn(async (agentId: string, _reason: string) => {
    for (const run of store
      .runs()
      .filter((item) => item.agentId === agentId && item.status === 'running'))
      store.updateRun(run.id, { status: 'interrupted' });
    store.updateAgent(agentId, { status: 'interrupted' });
  });
  const make = () =>
    new ConversationSearch(
      store,
      root,
      {
        policy: new ModelPolicy(store, models, () => now),
        mirrorWindows: mirrors,
        release,
        interrupt,
        waitReason: () => 'Waiting for the saved QUARK headroom.',
      },
      () => now,
    );
  let search = make();
  cleanups.push(async () => {
    await search.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    models,
    mirrors,
    release,
    interrupt,
    get store() {
      return store;
    },
    get search() {
      return search;
    },
    advance(ms: number) {
      now += ms;
    },
    async reopen(recover = false) {
      await search.close();
      store.close();
      store = new Store(file);
      if (recover) store.recover();
      search = make();
    },
  };
}
function seed(store: Store, root: string, name = 'Galaxy analysis') {
  const project = store.register(join(root, randomUUID()), name, 'Saved research', 'codex');
  store.entry({
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    kind: 'assistant',
    title: 'Previous reply',
    text: 'We discussed the galaxy luminosity data and its uncertainty.',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  return project;
}
function complete(
  store: Store,
  result: ConversationSearchResult,
  text = 'A likely match is the supplied galaxy conversation.',
) {
  store.entry({
    id: randomUUID(),
    agentId: result.agentId,
    runId: result.runId,
    kind: 'assistant',
    title: 'Conversation finder',
    text,
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  store.updateRun(result.runId, { status: 'completed' });
  store.updateAgent(result.agentId, { status: 'idle' });
}

it('uses central bulk defaults, saved evidence and one normal queued turn without changing a target', async () => {
  const f = fixture();
  const project = seed(f.store, f.root);
  const original = f.store.agent(project.managerId);
  const result = await f.search.ask({ key: randomUUID(), query: 'galaxy', provider: 'codex' });
  expect(result).toMatchObject({
    status: 'queued',
    provider: 'codex',
    model: 'luna-fixture',
    effort: 'low',
    report: null,
  });
  expect(result.candidates).toContainEqual(
    expect.objectContaining({
      id: project.managerId,
      href: `#/chat/${project.managerId}`,
      evidence: 'saved-excerpts',
      excerpt: expect.stringContaining('luminosity'),
    }),
  );
  expect(f.store.agent(result.agentId)).toMatchObject({
    permission: 'read-only',
    toolPolicy: 'restricted',
    assignment: { taskClass: 'bulk', tier: 'uncle' },
    webSearch: 'disabled',
    pluginsEnabled: false,
  });
  expect(f.store.getSetting(`pulsar:estimate:${result.runId}`)).toMatchObject({
    priority: 'interactive',
    tokenBudget: 16000,
  });
  expect(f.store.runs()).toHaveLength(1);
  expect(f.store.agent(project.managerId)).toEqual(original);
  expect(f.store.getSetting('frontdesk:identity')).toBeNull();
  expect(f.search.isAgent(project.managerId)).toBe(false);
  expect(f.search.isAgent(result.agentId)).toBe(true);
  expect(f.search.context(result.agentId)).toMatchObject({
    query: 'galaxy',
    candidates: result.candidates,
  });
  expect(() => f.search.context(project.managerId)).toThrow('not a conversation search helper');
});

it('excludes helper provenance after restart while retaining same-named personal and editor chats', async () => {
  const f = fixture();
  const project = seed(f.store, f.root, 'Computer health');
  f.store.updateAgent(project.managerId, { name: 'Computer health' });
  const helper = f.store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: null,
    role: 'manager',
    name: 'Computer health',
    cwd: f.root,
  });
  f.store.updateAgent(helper.id, { nativeRootId: project.managerId, surface: 'misc' });
  const resource = seed(f.store, f.root, 'Computer health');
  f.store.updateAgent(resource.managerId, {
    name: 'Computer health',
    resourceAssistant: { mode: 'snapshot' },
    surface: 'misc',
  });
  // The old resource project setting can be gone; durable agent identity still wins.
  f.store.setSetting('resources:project', null);
  const worker = f.store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: null,
    role: 'researcher',
    name: 'Computer health',
    cwd: f.root,
  });
  await f.reopen();
  const editorId = randomUUID();
  f.mirrors.mockReturnValue([
    {
      windowId: editorId,
      provider: 'codex',
      threadId: 'personal-editor',
      title: 'Computer health',
      label: 'Editor',
      status: 'idle',
      message: '',
    },
  ]);
  const result = await f.search.ask({
    key: randomUUID(),
    query: 'Computer health',
    provider: 'codex',
  });
  expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual(
    [project.managerId, editorId].sort(),
  );
  expect(result.candidates.find((candidate) => candidate.id === editorId)?.kind).toBe('editor');
  expect(f.store.agent(helper.id).nativeRootId).toBe(project.managerId);
  expect(f.store.agent(worker.id)).toBeDefined();
  expect(f.store.entries(resource.managerId)).toHaveLength(1);
});

it.each(['title', 'history', 'recent'] as const)(
  'keeps an older human chat in the %s selection after forty newer helpers and restart',
  async (selection) => {
    const f = fixture();
    const query = selection === 'recent' ? 'unmatched literal' : 'Computer health';
    const project = seed(f.store, f.root, 'Personal project');
    f.store.updateAgent(project.managerId, {
      name: selection === 'title' ? query : 'Human conversation',
    });
    f.store.entry({
      id: randomUUID(),
      agentId: project.managerId,
      runId: null,
      kind: 'assistant',
      title: 'Older evidence',
      text: selection === 'history' ? `Original ${query} evidence` : 'Original reply',
      status: 'complete',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // The matching source must survive even when it is outside the four-entry fallback.
    for (let index = 0; index < 6; index++)
      f.store.entry({
        id: randomUUID(),
        agentId: project.managerId,
        runId: null,
        kind: 'assistant',
        title: 'Later reply',
        text: 'Recent unrelated evidence',
        status: 'complete',
        createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      });
    const workers: string[] = [];
    for (let index = 0; index < 40; index++) {
      const helper = f.store.addAgent({
        projectId: project.id,
        parentId: project.managerId,
        taskId: null,
        role: index % 2 ? 'manager' : 'researcher',
        name: 'Computer health',
        cwd: f.root,
      });
      if (index % 2) f.store.updateAgent(helper.id, { nativeRootId: project.managerId });
      workers.push(helper.id);
      f.store.entry({
        id: randomUUID(),
        agentId: helper.id,
        runId: null,
        kind: 'assistant',
        title: 'Helper reply',
        text: selection === 'history' ? query : 'Helper evidence',
        status: 'complete',
        createdAt: '2026-10-01T00:00:00.000Z',
      });
    }
    await f.reopen();
    const result = await f.search.ask({ key: randomUUID(), query, provider: 'codex' });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([project.managerId]);
    if (selection === 'history')
      expect(result.candidates[0]?.excerpt).toContain(`Original ${query} evidence`);
    expect(result.coverage).toMatchObject({
      projectsAvailable: 1,
      projectsConsidered: 1,
      managedCandidates: 1,
      bounded: true,
      editorTranscripts: false,
    });
    // Finder eligibility must not remove worker evidence from normal project history.
    expect(projectCatalog(f.store, project.id, { kind: 'agents', limit: 50 }).items).toHaveLength(
      41,
    );
    expect(
      historyPage(f.store, project.id, { agentId: workers[0], source: 'conversations' }).items,
    ).toHaveLength(1);
  },
);

it('retries literal Unicode and markup evidence after discovery failure without changing its receipt', async () => {
  const f = fixture();
  const literal = `café 東京 🦊 20%_ \\ "' OR 1=1 -- <img src=x onerror=alert(1)>`;
  const project = seed(f.store, f.root, 'Literal evidence');
  f.store.updateAgent(project.managerId, { name: literal });
  f.store.entry({
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    kind: 'assistant',
    title: 'Literal reply',
    text: 'x'.repeat(2000) + literal,
    status: 'complete',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  const input = { key: randomUUID(), query: literal, provider: 'codex' };
  f.models.mockRejectedValueOnce(new Error('Temporary discovery failure'));
  await expect(f.search.ask(input)).rejects.toThrow(
    'Codex model discovery failed. Refresh available models to retry.',
  );
  expect(f.store.runs()).toHaveLength(0);
  await expect(f.search.ask(input)).rejects.toMatchObject({ code: 'MODEL_DISCOVERY_WAIT' });
  expect(f.models).toHaveBeenCalledTimes(1);
  f.advance(60_001);
  const result = await f.search.ask(input);
  expect(result.query).toBe(literal);
  expect(result.candidates).toEqual([
    expect.objectContaining({
      id: project.managerId,
      title: literal,
      excerpt: expect.stringContaining(literal),
      href: `#/chat/${project.managerId}`,
    }),
  ]);
  complete(f.store, result);
  await f.reopen();
  expect(await f.search.ask(input)).toEqual(f.search.get(result.id));
  expect(f.store.runs()).toHaveLength(1);
  expect(f.models).toHaveBeenCalledTimes(2);
  expect(historyPage(f.store, project.id, { query: '20%_' }).items).toHaveLength(1);
  expect(historyPage(f.store, project.id, { query: '20%Z' }).items).toEqual([]);
  expect(historyPage(f.store, project.id, { query: "' OR 1=1 -- missing" }).items).toEqual([]);
});

it('resolves Claude bulk to central Sonnet and preserves an explicit future native model and effort', async () => {
  const f = fixture();
  seed(f.store, f.root);
  const first = await f.search.ask({ key: randomUUID(), query: 'galaxy', provider: 'claude' });
  expect(first).toMatchObject({ provider: 'claude', model: 'sonnet-fixture', effort: 'low' });
  complete(f.store, first);
  const second = await f.search.ask({
    key: randomUUID(),
    query: 'galaxy',
    provider: 'codex',
    model: 'native-next-fixture',
    effort: 'medium',
  });
  expect(second).toMatchObject({
    provider: 'codex',
    model: 'native-next-fixture',
    effort: 'medium',
  });
  expect(second.agentId).not.toBe(first.agentId);
  expect(second.candidates.some((candidate) => candidate.id === first.agentId)).toBe(false);
  expect(f.release).toHaveBeenCalledWith(first.agentId);
});

it('coalesces simultaneous retries and preserves a lost-response receipt across restart and catalog failure', async () => {
  const f = fixture();
  const project = seed(f.store, f.root);
  const input = { key: randomUUID(), query: 'galaxy', provider: 'codex' };
  const [one, two] = await Promise.all([f.search.ask(input), f.search.ask(input)]);
  expect(two).toEqual(one);
  expect(f.models).toHaveBeenCalledTimes(1);
  expect(f.store.runs()).toHaveLength(1);
  complete(f.store, one, `[Galaxy](#/chat/${project.managerId}) discusses luminosity.`);
  await f.reopen();
  f.models.mockRejectedValue(new Error('Provider unavailable'));
  f.mirrors.mockImplementation(() => {
    throw new Error('No mirror work during retries or GET');
  });
  const retried = await f.search.ask(input);
  expect(retried).toMatchObject({
    id: one.id,
    agentId: one.agentId,
    runId: one.runId,
    status: 'completed',
    report: expect.stringContaining('luminosity'),
  });
  expect(f.search.get(one.id)).toEqual(retried);
  expect(f.store.runs()).toHaveLength(1);
  expect(f.models).toHaveBeenCalledTimes(1);
  await expect(f.search.ask({ ...input, query: 'different' })).rejects.toThrow('different input');
  expect(f.store.runs()).toHaveLength(1);
});

it('retains an interrupted search through host recovery without replaying its provider turn', async () => {
  const f = fixture();
  const input = { key: randomUUID(), query: 'a prior conversation', provider: 'codex' };
  const result = await f.search.ask(input);
  f.store.updateRun(result.runId, { status: 'running' });
  f.store.updateAgent(result.agentId, { status: 'running' });
  await f.reopen(true);
  expect((await f.search.ask(input)).status).toBe('interrupted');
  expect(f.store.runs()).toHaveLength(1);
  expect(f.models).toHaveBeenCalledTimes(1);
  await f.search.maintain();
  expect(f.release).toHaveBeenCalledWith(result.agentId);
});

it('truthfully caps saved evidence and includes only connected editor title metadata, never transcripts', async () => {
  const f = fixture();
  for (let index = 0; index < 24; index++) {
    const project = seed(f.store, f.root, `Galaxy ${index}`);
    const chat = f.store.addAgent({
      projectId: project.id,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: `Galaxy worker ${index}`,
      cwd: join(f.root, 'unused'),
      provider: 'codex',
    });
    f.store.updateAgent(chat.id, { surface: 'misc' });
    f.store.entry({
      id: randomUUID(),
      agentId: project.managerId,
      runId: null,
      kind: 'assistant',
      title: 'Saved reply',
      text: 'galaxy '.repeat(1000),
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
  }
  const firstWindow = randomUUID();
  f.mirrors.mockReturnValue(
    Array.from({ length: 10 }, (_, index) => ({
      windowId: index === 0 ? firstWindow : randomUUID(),
      provider: 'claude',
      label: 'Native editor',
      title: `Galaxy editor ${index}`,
      threadId: `thread ${index}/x`,
      status: 'busy',
      message: 'not model evidence',
      entries: [{ id: 'private', role: 'assistant', text: 'UNREQUESTED_NATIVE_TRANSCRIPT' }],
    })),
  );
  const result = await f.search.ask({ key: randomUUID(), query: 'galaxy', provider: 'codex' });
  expect(result.coverage).toMatchObject({
    projectsConsidered: 20,
    projectsAvailable: 24,
    managedCandidates: 32,
    editorCandidates: 8,
    bounded: true,
    editorTranscripts: false,
  });
  expect(result.candidates).toHaveLength(40);
  expect(result.candidates.find((candidate) => candidate.id === firstWindow)).toMatchObject({
    kind: 'editor',
    evidence: 'title-only',
    excerpt: '',
    href: '#/chats/vscode/claude%3Athread%200%2Fx',
  });
  expect(JSON.stringify(f.search.context(result.agentId))).not.toContain(
    'UNREQUESTED_NATIVE_TRANSCRIPT',
  );
  expect(JSON.stringify(f.search.context(result.agentId)).length).toBeLessThan(50_000);
  const calls = f.mirrors.mock.calls.length;
  f.search.get(result.id);
  f.search.get(result.id);
  expect(f.mirrors).toHaveBeenCalledTimes(calls);
});

it('expires a queued search and interrupts a running search within the existing maintenance boundary', async () => {
  const f = fixture();
  const queued = await f.search.ask({ key: randomUUID(), query: 'galaxy', provider: 'codex' });
  f.advance(15 * 60_000);
  await f.search.maintain();
  expect(f.search.get(queued.id)).toMatchObject({
    status: 'cancelled',
    message: expect.stringContaining('15 minutes'),
  });
  expect(f.interrupt).not.toHaveBeenCalled();
  const running = await f.search.ask({ key: randomUUID(), query: 'galaxy', provider: 'codex' });
  f.store.updateRun(running.runId, { status: 'running' });
  f.store.updateAgent(running.agentId, { status: 'running' });
  await f.search.maintain();
  f.advance(180_000);
  await f.search.maintain();
  expect(f.interrupt).toHaveBeenCalledWith(
    running.agentId,
    expect.stringContaining('three-minute'),
  );
  expect(f.search.get(running.id).status).toBe('interrupted');
  await f.search.maintain();
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  expect(f.store.runs()).toHaveLength(2);
});

it('refuses another active search and waits for idle cleanup before making a fresh helper', async () => {
  const f = fixture();
  const first = await f.search.ask({ key: randomUUID(), query: 'galaxy', provider: 'codex' });
  await expect(
    f.search.ask({ key: randomUUID(), query: 'another', provider: 'codex' }),
  ).rejects.toThrow('already queued or running');
  complete(f.store, first);
  let finish!: (released: boolean) => void;
  f.release.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const maintenance = f.search.maintain();
  const second = f.search.ask({ key: randomUUID(), query: 'another', provider: 'codex' });
  await Promise.resolve();
  expect(f.store.runs()).toHaveLength(1);
  finish(true);
  await maintenance;
  const fresh = await second;
  expect(fresh.agentId).not.toBe(first.agentId);
  expect(f.store.runs()).toHaveLength(2);
});

it('provides a saved-only GET, rejects browser-selected sources and preserves API request idempotency', async () => {
  const f = fixture();
  seed(f.store, f.root);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof Missing ? 404 : error instanceof Conflict ? 409 : 400)
      .send({ error: error instanceof Error ? error.message : 'Invalid request' }),
  );
  const kick = vi.fn();
  registerConversationSearchRoutes(app, f.search, kick);
  cleanups.push(() => app.close());
  expect((await app.inject({ url: `/api/conversations/search/${randomUUID()}` })).statusCode).toBe(
    404,
  );
  expect(f.models).not.toHaveBeenCalled();
  const input = { key: randomUUID(), query: 'galaxy', provider: 'codex' };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/conversations/search',
        payload: { ...input, transcript: 'browser-selected secret', agentId: randomUUID() },
      })
    ).statusCode,
  ).toBe(400);
  expect(f.models).not.toHaveBeenCalled();
  const response = await app.inject({
    method: 'POST',
    url: '/api/conversations/search',
    payload: input,
  });
  expect(response.statusCode).toBe(201);
  const result = conversationSearchResultSchema.parse(response.json());
  const retry = await app.inject({
    method: 'POST',
    url: '/api/conversations/search',
    payload: input,
  });
  expect(retry.json()).toEqual(result);
  const read = await app.inject({ url: `/api/conversations/search/${result.id}` });
  expect(read.json()).toEqual(result);
  expect(f.models).toHaveBeenCalledTimes(1);
  expect(f.mirrors).toHaveBeenCalledTimes(1);
  expect(f.store.runs()).toHaveLength(1);
  expect(kick).toHaveBeenCalledTimes(2);
});
