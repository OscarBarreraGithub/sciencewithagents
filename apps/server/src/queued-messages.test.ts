import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { QueuedMessageAction } from '@dock/shared';
import { Store, type PrivateRun } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { WorkspaceState } from './workspace-state.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { proxyPath } from './hosts.js';
import { historyPage } from './history.js';

let root: string,
  store: Store,
  runtime: Runtime,
  app: FastifyInstance,
  agent: string,
  client: string;
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dock-queue-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  agent = store.register(root, 'Queue fixture', '').managerId;
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  app = await createServer(store, runtime, { port: 4999 });
  client = new WorkspaceState(store).register({ key: randomUUID(), label: 'First browser' }).client
    .id;
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
const edit = (
  runId: string,
  action: QueuedMessageAction['action'],
  changes: Partial<QueuedMessageAction> = {},
) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agent}/queued/${runId}`,
    headers,
    payload: {
      key: randomUUID(),
      clientId: client,
      revision: store.run(runId).queueRevision ?? 0,
      action,
      ...changes,
    },
  });
const queued = (text = 'Original accepted question') => store.enqueue(agent, randomUUID(), text);

it('holds before editing, persists through reopening, and only explicitly requeues the saved text', async () => {
  const run = queued();
  expect(
    (await app.inject({ url: `/api/agents/${agent}`, headers })).json().runs[0].queueEditable,
  ).toBe(true);
  expect((await edit(run.id, 'edit')).statusCode).toBe(200);
  expect((await edit(run.id, 'save', { text: 'Saved edited question' })).statusCode).toBe(200);
  const other = new Store(join(root, 'dock.sqlite'));
  try {
    expect(other.run(run.id)).toMatchObject({
      status: 'queued',
      text: run.text,
      queueEdit: { text: 'Saved edited question', clientId: client },
    });
    expect(other.transaction(() => other.claimQueuedRun(run.id))).toBeNull();
  } finally {
    other.close();
  }
  expect((await edit(run.id, 'queue')).json()).toMatchObject({
    queueEdit: null,
    text: 'Saved edited question',
  });
  expect(store.transaction(() => store.claimQueuedRun(run.id))?.text).toBe('Saved edited question');
});

it('keeps the original send receipt and retry identity after queued text is edited', async () => {
  const key = randomUUID();
  const run = store.enqueue(agent, key, 'Original accepted question');
  await edit(run.id, 'edit');
  await edit(run.id, 'queue', { text: 'Changed only in the queue' });
  const receipt = (
    await app.inject({ url: `/api/agents/${agent}/receipts/${key}`, headers })
  ).json();
  expect(receipt.submitted).toEqual({ text: 'Original accepted question', steer: false });
  const retry = await app.inject({
    method: 'POST',
    url: `/api/agents/${agent}/messages`,
    headers,
    payload: { key, text: 'Original accepted question' },
  });
  expect(retry.statusCode).toBe(202);
  expect(retry.json()).toMatchObject({ id: run.id, text: 'Changed only in the queue' });
  expect(store.runs()).toHaveLength(1);
});

it('reads queue action receipts without dispatching or retrying an acknowledged action', async () => {
  const run = queued();
  await edit(run.id, 'edit');
  const key = randomUUID();
  await edit(run.id, 'queue', { key, text: 'Acknowledged queued edit' });
  const url = `/api/agents/${agent}/queued/${run.id}/receipts/${key}`;
  expect((await app.inject({ url, headers })).json()).toMatchObject({
    status: 'applied',
    run: { id: run.id, text: 'Acknowledged queued edit', queueEdit: null },
  });
  expect((await app.inject({ url: url.replace(key, randomUUID()), headers })).json()).toMatchObject(
    { status: 'not_found' },
  );
  expect(store.runs()).toHaveLength(1);
  expect(proxyPath('GET', `/agents/${agent}/queued/${run.id}/receipts/${key}`)).not.toBeNull();
});

it('returns materially edited triaged wording to pending review while preserving work and searchable originals', async () => {
  const run = queued('Original scientific request about diffusion_tau');
  const item = runtime.workItems.saveForManager(agent, {
    key: randomUUID(),
    title: 'Original request tracked',
    status: 'done',
    sourceMessages: [{ agentId: agent, entryId: run.id }],
    sourceDisposition: 'Original wording reviewed and answered.',
  });
  expect(runtime.workItems.ownerRequests(agent).items).toHaveLength(0);
  await edit(run.id, 'edit');
  await edit(run.id, 'save', { text: 'Revised request about memory_tau' });
  expect(runtime.workItems.get(item.id).sourceDisposition).toBe(item.sourceDisposition);
  await edit(run.id, 'queue');
  expect(runtime.workItems.get(item.id)).toMatchObject({
    status: 'done',
    revision: item.revision + 1,
    sourceMessages: item.sourceMessages,
    sourceDisposition: null,
  });
  expect(runtime.workItems.ownerRequests(agent).items[0]).toMatchObject({
    entryId: run.id,
    coverage: 'linked',
    text: 'Revised request about memory_tau',
  });
  const original = historyPage(store, store.agent(agent).projectId, {
    query: 'diffusion_tau',
  }).items;
  expect(
    original.some(
      (entry) => entry.title === 'Original queued message' && entry.text.includes('diffusion_tau'),
    ),
  ).toBe(true);
  const revision = runtime.workItems.get(item.id).revision;
  await edit(run.id, 'edit');
  await edit(run.id, 'queue');
  expect(runtime.workItems.get(item.id).revision).toBe(revision);
  expect(
    store.entries(agent).filter((entry) => entry.title === 'Original queued message'),
  ).toHaveLength(1);
});

it('rejects editing if dispatch won and rejects stale captured dispatch if editing won', async () => {
  const first = queued();
  store.transaction(() => store.claimQueuedRun(first.id));
  expect((await edit(first.id, 'edit')).statusCode).toBe(409);
  const second = queued('Hold wins');
  const captured = store.run(second.id);
  await edit(second.id, 'edit');
  const attach = vi.spyOn(runtime, 'attach');
  await (runtime as unknown as { startRun(run: PrivateRun): Promise<void> }).startRun(captured);
  expect(attach).not.toHaveBeenCalled();
  expect(store.run(second.id)).toMatchObject({ status: 'queued', queueEdit: { state: 'editing' } });
});

it('uses revision checks and explicit takeover across devices without overwriting held text', async () => {
  const run = queued();
  const held = (await edit(run.id, 'edit')).json();
  const second = new WorkspaceState(store).register({ key: randomUUID(), label: 'Other browser' })
    .client.id;
  expect((await edit(run.id, 'edit', { clientId: second })).statusCode).toBe(409);
  await edit(run.id, 'save', { text: 'First browser work' });
  expect(
    (await edit(run.id, 'takeover', { clientId: second, revision: held.queueRevision })).statusCode,
  ).toBe(409);
  expect((await edit(run.id, 'takeover', { clientId: second })).json()).toMatchObject({
    queueEdit: { clientId: second, text: 'First browser work' },
  });
  expect((await edit(run.id, 'save', { text: 'Late first browser overwrite' })).statusCode).toBe(
    409,
  );
  expect(store.run(run.id).queueEdit?.text).toBe('First browser work');
});

it('keeps an old held item reachable after newer completed work exceeds the recent run preview', async () => {
  const run = queued('Held earlier owner question');
  await edit(run.id, 'edit');
  for (let i = 0; i < 55; i++) {
    const newer = queued(`Completed newer request ${i}`);
    store.updateRun(newer.id, { status: 'completed' });
  }
  const detail = (await app.inject({ url: `/api/agents/${agent}`, headers })).json();
  expect(detail.runs.find((value: { id: string }) => value.id === run.id)).toMatchObject({
    queueEdit: { state: 'editing' },
    queueEditable: true,
  });
  expect(runtime.pulsar.decision(store.run(run.id))).toMatchObject({
    eligible: false,
    reason: expect.stringContaining('Held for editing'),
  });
  expect(
    detail.runs.filter((value: { status: string }) => value.status === 'completed'),
  ).toHaveLength(50);
});

it('discards edits only with explicit requeue and retries the same action without changing another version', async () => {
  const run = queued();
  const input = { key: randomUUID(), revision: 0 };
  const first = await edit(run.id, 'edit', input);
  expect((await edit(run.id, 'edit', input)).json()).toEqual(first.json());
  await edit(run.id, 'save', { text: 'Held new words' });
  expect((await edit(run.id, 'discard')).json()).toMatchObject({ queueEdit: null, text: run.text });
});

it('steers a held app message once and never dispatches it as another follow-up', async () => {
  const run = queued();
  await edit(run.id, 'edit');
  const provider = new DemoProvider();
  const request = vi.spyOn(provider, 'request').mockResolvedValue({});
  runtime.clients.set(agent, provider);
  store.updateAgent(agent, {
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    status: 'running',
  });
  const input = {
    key: randomUUID(),
    revision: store.run(run.id).queueRevision!,
    text: 'Guide the current turn',
  };
  expect((await edit(run.id, 'steer', input)).statusCode).toBe(200);
  expect((await edit(run.id, 'steer', input)).statusCode).toBe(200);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    'turn/steer',
    expect.objectContaining({ expectedTurnId: 'fixture-turn' }),
  );
  expect(store.run(run.id)).toMatchObject({ status: 'cancelled', queueEdit: null });
  expect(store.transaction(() => store.claimQueuedRun(run.id))).toBeNull();
});

it('keeps uncertain steering held after failed acknowledgement, including across new action keys', async () => {
  const run = queued();
  await edit(run.id, 'edit');
  const provider = new DemoProvider();
  const request = vi
    .spyOn(provider, 'request')
    .mockRejectedValue(new Error('Lost acknowledgement'));
  runtime.clients.set(agent, provider);
  store.updateAgent(agent, {
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    status: 'running',
  });
  const input = { key: randomUUID(), revision: store.run(run.id).queueRevision! };
  expect((await edit(run.id, 'steer', input)).statusCode).toBe(500);
  expect((await edit(run.id, 'steer', input)).statusCode).toBe(409);
  expect((await edit(run.id, 'queue')).statusCode).toBe(409);
  expect((await edit(run.id, 'steer')).statusCode).toBe(409);
  expect(request).toHaveBeenCalledOnce();
  expect(store.run(run.id).queueEdit?.state).toBe('steering');
  expect(
    (
      await app.inject({
        url: `/api/agents/${agent}/queued/${run.id}/receipts/${input.key}`,
        headers,
      })
    ).json(),
  ).toMatchObject({ status: 'uncertain', run: { queueEdit: { state: 'steering' } } });
  const other = new WorkspaceState(store).register({ key: randomUUID(), label: 'Recovery browser' })
    .client.id;
  expect((await edit(run.id, 'takeover', { clientId: other })).json()).toMatchObject({
    queueEdit: { state: 'steering' },
  });
  expect((await edit(run.id, 'remove', { clientId: other })).json()).toMatchObject({
    status: 'cancelled',
    queueEdit: null,
  });
  expect(store.entries(agent).some((entry) => entry.text === run.text)).toBe(true);
});

it('does not advertise native steering for Claude or edit generated/native-owned input', async () => {
  agent = store.addManager(store.agent(agent).projectId, 'Claude fixture', '', 'claude').id;
  const run = queued();
  await edit(run.id, 'edit');
  expect((await edit(run.id, 'steer')).statusCode).toBe(409);
  expect(store.run(run.id).queueEdit?.state).toBe('editing');
  expect((await edit(run.id, 'queue')).statusCode).toBe(200);
  const generated = store.enqueue(agent, 'internal:generated', 'Coordination input');
  expect((await edit(generated.id, 'edit')).statusCode).toBe(409);
  store.updateAgent(agent, {
    nativeRootId: store.agents().find((value) => value.id !== agent)!.id,
  });
  expect((await edit(run.id, 'edit')).statusCode).toBe(409);
  expect(proxyPath('POST', `/agents/${agent}/queued/${run.id}`)).not.toBeNull();
  expect(proxyPath('POST', `/agents/${agent}/queued/arbitrary`)).toBeNull();
});
