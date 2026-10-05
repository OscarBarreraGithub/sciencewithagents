import { modelFixture } from './model-policy.fixture.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dock-workspace-api-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Workspace fixture', '');
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  // Pause dispatch so the exact enqueue/receipt counts are deterministic.
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  const app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  cleanups.push(async () => {
    await app.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const get = (url: string) => app.inject({ url, headers: { host: '127.0.0.1:4330' } });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' },
    });
  return { store, runtime, project, app, get, post };
}

it('atomically sends copied device drafts once and resolves either browser receipt', async () => {
  const { store, project, get, post } = await fixture();
  const a = (await post('/api/workspace/clients', { key: randomUUID(), label: 'Computer' })).json();
  const b = (await post('/api/workspace/clients', { key: randomUUID(), label: 'Phone' })).json();
  const hostId = a.hostId;
  const path = (client: string) => `/api/workspace/${client}/drafts/${project.managerId}`;
  const saved = (
    await post(path(a.client.id), {
      key: randomUUID(),
      hostId,
      revision: 0,
      action: { kind: 'save', text: 'Send this exactly once' },
    })
  ).json().state.own;
  const copied = (
    await post(path(b.client.id), {
      key: randomUUID(),
      hostId,
      revision: 0,
      action: { kind: 'copy', sourceClientId: a.client.id, sourceRevision: saved.revision },
    })
  ).json().state.own;
  const request = (clientId: string, draft: typeof saved) => ({
    key: randomUUID(),
    text: draft.text,
    draft: { clientId, hostId, revision: draft.revision, deliveryKey: draft.deliveryKey },
  });
  const first = request(a.client.id, saved),
    second = request(b.client.id, copied);
  const [one, two] = await Promise.all([
    post(`/api/agents/${project.managerId}/messages`, first),
    post(`/api/agents/${project.managerId}/messages`, second),
  ]);
  expect(one.statusCode).toBe(202);
  expect(two.statusCode).toBe(202);
  expect(one.json().id).toBe(two.json().id);
  expect(store.runs()).toHaveLength(1);
  for (const input of [first, second]) {
    const receipt = (await get(`/api/agents/${project.managerId}/receipts/${input.key}`)).json();
    expect(receipt.submitted).toEqual({ text: first.text, steer: false });
    expect(receipt.run.id).toBe(one.json().id);
  }
  const changed = await post(`/api/agents/${project.managerId}/messages`, {
    ...first,
    text: 'Different content',
  });
  expect(changed.statusCode).toBe(409);
  expect(store.runs()).toHaveLength(1);
  expect((await get(`/api/agents/${project.managerId}/owner-requests`)).json().items).toMatchObject(
    [{ entryId: one.json().id, delivery: 'queued' }],
  );
});

it('retains exact canonical steering provenance for confirmed and uncertain sends without replay', async () => {
  const { store, runtime, project, get, post } = await fixture();
  const manager = project.managerId;
  store.updateAgent(manager, {
    threadId: randomUUID(),
    turnId: 'observed-turn',
    status: 'running',
  });
  const provider = new DemoProvider();
  let calls = 0;
  let loseResponse = false;
  provider.request = async (method) => {
    expect(method).toBe('turn/steer');
    calls++;
    if (loseResponse) throw new Error('Lost response');
    return {};
  };
  runtime.clients.set(manager, provider);
  const confirmed = { key: randomUUID(), text: 'Continue A and also handle B.', steer: true };
  expect((await post(`/api/agents/${manager}/messages`, confirmed)).statusCode).toBe(200);
  expect((await post(`/api/agents/${manager}/messages`, confirmed)).statusCode).toBe(200);
  expect(calls).toBe(1);
  const source = store.savedEntry(manager, `owner-steering:${confirmed.key}`)!;
  expect(source).toMatchObject({
    text: confirmed.text,
    kind: 'user',
    ownerInput: { delivery: 'submitted' },
  });
  loseResponse = true;
  const uncertain = { key: randomUUID(), text: 'Another independent ask', steer: true };
  expect((await post(`/api/agents/${manager}/messages`, uncertain)).statusCode).toBe(500);
  expect((await post(`/api/agents/${manager}/messages`, uncertain)).statusCode).toBe(409);
  expect(calls).toBe(2);
  expect(
    (await get(`/api/agents/${manager}/receipts/${uncertain.key}`)).json().submitted,
  ).toBeNull();
  expect((await get(`/api/agents/${manager}/owner-requests`)).json().items).toMatchObject([
    { entryId: `owner-steering:${uncertain.key}`, delivery: 'uncertain' },
    { entryId: source.id, delivery: 'submitted' },
  ]);
  store.updateAgent(manager, { turnId: null });
  expect(
    (
      await post(`/api/agents/${manager}/messages`, {
        key: randomUUID(),
        text: 'Not sent',
        steer: true,
      })
    ).statusCode,
  ).toBe(409);
  expect(runtime.workItems.ownerRequests(manager).total).toBe(2);
});

it('rejects cross-host draft sends and refuses inactive steering without claiming delivery', async () => {
  const { store, project, post } = await fixture();
  const a = (await post('/api/workspace/clients', { key: randomUUID(), label: 'Computer' })).json();
  const saved = (
    await post(`/api/workspace/${a.client.id}/drafts/${project.managerId}`, {
      key: randomUUID(),
      hostId: a.hostId,
      revision: 0,
      action: { kind: 'save', text: 'My text' },
    })
  ).json().state.own;
  const draft = {
    clientId: a.client.id,
    hostId: a.hostId,
    revision: saved.revision,
    deliveryKey: saved.deliveryKey,
  };
  const crossHost = await post(`/api/agents/${project.managerId}/messages`, {
    key: randomUUID(),
    text: saved.text,
    draft: { ...draft, hostId: randomUUID() },
  });
  expect(crossHost.statusCode).toBe(409);
  const inactive = await post(`/api/agents/${project.managerId}/messages`, {
    key: randomUUID(),
    text: saved.text,
    steer: true,
    draft,
  });
  expect(inactive.statusCode).toBe(409);
  expect(inactive.json().code).toBe('NO_ACTIVE_TURN');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM workspace_deliveries').get()!.n).toBe(0);
  expect(store.runs()).toHaveLength(0);
  const followup = await post(`/api/agents/${project.managerId}/messages`, {
    key: randomUUID(),
    text: saved.text,
    steer: false,
    draft,
  });
  expect(followup.statusCode).toBe(202);
  expect(store.runs()).toHaveLength(1);
});

it('serves project-bound history and recovery without changing provider session identity', async () => {
  const { store, project, post, get } = await fixture();
  store.entry({
    id: 'old-source',
    agentId: project.managerId,
    runId: null,
    kind: 'assistant',
    title: 'Earlier answer',
    text: 'Evidence retained from the beginning.',
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const page = await post(`/api/projects/${project.id}/history`, { query: 'retained' });
  expect(page.statusCode).toBe(200);
  expect(page.json().items[0].id).toBe('old-source');
  const source = await post(`/api/projects/${project.id}/history/read`, {
    source: 'entry',
    id: 'old-source',
  });
  expect(source.json().text).toContain('beginning');
  expect((await get(`/api/agents/${project.managerId}/recovery`)).json()).toBeNull();
  expect(store.agent(project.managerId).threadId).toBeNull();
  expect(store.runs()).toHaveLength(0);
});
