import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModelPolicy } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider, seedDemo } from './demo.js';
import { GroupFixtureHost } from './group-fixture-host.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function setup(existing?: string) {
  mkdirSync(join(repoRoot, 'data/fixtures'), { recursive: true });
  const root = existing ?? mkdtempSync(join(repoRoot, 'data/fixtures/group-unit-'));
  if (!existing) roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new Store(join(root, 'dock.sqlite'));
  const policy = structuredClone(defaultModelPolicy);
  policy.enabledProviders = ['codex'];
  for (const tier of Object.keys(policy.models.codex) as (keyof typeof policy.models.codex)[])
    policy.models.codex[tier].model = 'demo';
  store.setSetting('model-policy', policy);
  seedDemo(store, workspace);
  const runtime = new Runtime(
    store,
    root,
    'never-native',
    async (agent) => new DemoProvider(agent.cwd),
    undefined,
    { workspace },
  );
  const host = new GroupFixtureHost(store, runtime);
  const app = await createServer(store, runtime, {
    port: 45428,
    demo: true,
    groupFixture: host,
    ownsRuntime: false,
  });
  await runtime.initialize();
  host.recover();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.close();
    await app.close();
    host.close();
    store.close();
  };
  closers.push(close);
  const post = (route: string, body: unknown, auth = true) =>
    app.inject({
      method: 'POST',
      url: `/api/group-fixture/${route}`,
      headers: {
        host: '127.0.0.1:45428',
        origin: 'http://127.0.0.1:45428',
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${host.token}` } : {}),
      },
      payload: body as Record<string, unknown>,
    });
  return { root, store, runtime, host, app, post, close };
}
const create = (f: Awaited<ReturnType<typeof setup>>, projectName = 'Test river') =>
  f.host.create({ key: randomUUID(), projectName, displayName: 'Amina · أمينة' });
const feed = (f: Awaited<ReturnType<typeof setup>>, handle: string) =>
  f.host.feed({ handle, query: { visibility: 'shared', after: 0, limit: 20, cursor: null } });
async function wait(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Fake reply timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

it('requires authenticated same-origin JSON, strict inputs and server-issued handles; default deny stays closed', async () => {
  const f = await setup();
  expect(
    (
      await f.post(
        'create',
        { key: randomUUID(), projectName: 'River', displayName: 'Name' },
        false,
      )
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.post('create', {
        key: randomUUID(),
        projectName: 'River',
        displayName: 'Name',
        cwd: '/tmp',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await f.post('create', { key: randomUUID(), projectName: 'River', displayName: ' ' }))
      .statusCode,
  ).toBe(400);
  expect((await f.post('open', { handle: randomUUID() })).statusCode).toBe(404);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/group-fixture/create',
        headers: {
          host: '127.0.0.1:45428',
          origin: 'https://evil.invalid',
          'content-type': 'application/json',
          authorization: `Bearer ${f.host.token}`,
        },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  for (const route of [
    '/api/agents/x/terminal',
    '/api/phone/setup',
    '/api/groups/publication',
    '/api/setup',
  ])
    expect((await f.app.inject({ method: 'POST', url: route })).statusCode).toBe(403);
  expect(
    (
      await f.post('feed', {
        handle: randomUUID(),
        query: { visibility: 'shared', limit: 21, after: 0, cursor: null },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await f.post('send', { handle: randomUUID(), key: randomUUID(), text: 'x'.repeat(25000) }))
      .statusCode,
  ).toBe(413);
});
it('actual send -> DemoProvider -> repository, exact Unicode originals and independent private/group canaries', async () => {
  const f = await setup();
  const a = await create(f);
  const b = await create(f, 'Second');
  const original = '  Shared original\n\nأمينة · 李明\t\u202e  ';
  const send = { handle: a.shared.handle, key: randomUUID(), text: original };
  expect((await f.post('send', send)).statusCode).toBe(200);
  f.host.send({ handle: a.private.handle, key: send.key, text: 'PRIVATE-ASIDE-CANARY' });
  f.host.send({ handle: b.shared.handle, key: randomUUID(), text: 'OTHER-GROUP-CANARY' });
  await wait(() => f.store.entries(a.shared.agent.id).some((e) => e.kind === 'assistant'));
  const page = feed(f, a.shared.handle);
  expect(page.entries).toHaveLength(2);
  expect(f.host.original({ handle: a.shared.handle, eventId: page.entries[0].eventId }).text).toBe(
    original,
  );
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE-ASIDE-CANARY|OTHER-GROUP-CANARY/);
  expect(f.host.catchUp({ handle: a.private.handle }).text).not.toMatch(
    /PRIVATE-ASIDE-CANARY|OTHER-GROUP-CANARY/,
  );
  const privateSlot = f.host.resolve(a.private.handle).slot;
  f.host.project(privateSlot);
  const privatePage = f.host.events.feed(f.host.access(privateSlot, 'read'), {
    visibility: 'private',
    after: 0,
    limit: 20,
    cursor: null,
  });
  expect(privatePage.entries.length).toBeGreaterThan(0);
  expect(() =>
    f.host.original({ handle: a.shared.handle, eventId: privatePage.entries[0].eventId }),
  ).toThrow();
  expect(() =>
    f.host.original({ handle: b.shared.handle, eventId: page.entries[0].eventId }),
  ).toThrow();
  expect(() =>
    f.host.feed({
      handle: a.private.handle,
      query: { visibility: 'shared', after: 0, limit: 20, cursor: null },
    }),
  ).toThrow();
  const generic = await f.app.inject({
    method: 'GET',
    url: `/api/agents/${a.private.agent.id}`,
    headers: { host: '127.0.0.1:45428', authorization: `Bearer ${f.host.token}` },
  });
  expect(generic.statusCode).toBe(403);
});
it('lost send ack/restart retain exact receipt without new run; draft CAS and create retry survive', async () => {
  let f = await setup();
  const root = f.root;
  const input = { key: randomUUID(), projectName: 'Persisted', displayName: 'Typed owner' };
  const a = await f.host.create(input);
  const message = { handle: a.shared.handle, key: randomUUID(), text: 'RESTART-ORIGINAL' };
  const receipt = f.host.send(message);
  await wait(() => f.store.run(receipt.runId).status === 'completed');
  const draft = { handle: a.private.handle, key: randomUUID(), revision: 0, text: 'PRIVATE-DRAFT' };
  expect(f.host.saveDraft(draft)).toEqual({ text: 'PRIVATE-DRAFT', revision: 1 });
  const token = f.host.token;
  await f.close();
  f = await setup(root);
  expect(f.host.token).toBe(token);
  expect(await f.host.create(input)).toEqual(f.host.open({ handle: a.group.handle }));
  expect(f.host.send(message)).toEqual(receipt);
  expect(f.store.runsForAgent(a.shared.agent.id)).toHaveLength(1);
  expect(feed(f, a.shared.handle).entries).toHaveLength(2);
  expect(f.host.saveDraft(draft)).toEqual({ text: 'PRIVATE-DRAFT', revision: 1 });
  expect(() => f.host.saveDraft({ ...draft, key: randomUUID(), text: 'stale' })).toThrow(
    /Draft changed/,
  );
  expect(f.host.chat({ handle: a.private.handle }).draft.text).toBe('PRIVATE-DRAFT');
  expect(() => f.host.send({ ...message, text: 'changed' })).toThrow(/content changed/);
});
it('recovers the send journal after crashes before projection and after event commit before projection marker', async () => {
  let f = await setup();
  const root = f.root;
  const a = await create(f);
  const message = { handle: a.shared.handle, key: randomUUID(), text: 'CRASH-HANDOFF' };
  const append = f.host.events.append.bind(f.host.events);
  f.host.events.append = () => {
    throw new Error('simulated crash before repository');
  };
  expect(() => f.host.send(message)).toThrow('simulated crash');
  f.host.events.append = append;
  await f.close();
  f = await setup(root);
  expect(feed(f, a.shared.handle).entries[0].condensedText).toContain('CRASH-HANDOFF');
  const receipt = f.host.send(message);
  await wait(() => f.store.run(receipt.runId).status === 'completed');
  feed(f, a.shared.handle);
  f.store.db.prepare('DELETE FROM gf_projection').run(); // interrupted marker write, existing immutable event wins
  await f.close();
  f = await setup(root);
  expect(feed(f, a.shared.handle).entries).toHaveLength(2);
  expect(f.store.runsForAgent(a.shared.agent.id)).toHaveLength(1);
});
it('does not publish ordinary fixture chat, arbitrary entries or unrelated raw host events; rechecks revocation', async () => {
  const f = await setup();
  const a = await create(f);
  f.store.entry({
    id: randomUUID(),
    agentId: a.shared.agent.id,
    runId: null,
    kind: 'assistant',
    title: 'Canary',
    text: 'UNREQUESTED-RAW-CANARY',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  f.store.event('native.private', null, null, { text: 'RAW-EVENT-CANARY' });
  expect(feed(f, a.shared.handle).entries).toEqual([]);
  const input = { handle: a.shared.handle, key: randomUUID(), text: 'valid' };
  f.host.send(input);
  f.host.events.revokeMember(a.group.id, a.member.memberId);
  for (const action of [
    () => f.host.send(input),
    () => feed(f, a.shared.handle),
    () => f.host.chat({ handle: a.private.handle }),
    () => f.host.catchUp({ handle: a.private.handle }),
  ])
    expect(action).toThrow();
});

it('explicit retry resumes the same interrupted fake run without duplicating its original', async () => {
  let f = await setup();
  const root = f.root;
  const a = await create(f);
  const input = {
    handle: a.private.handle,
    key: randomUUID(),
    text: 'INTERRUPTED-PRIVATE-ORIGINAL',
  };
  const receipt = f.host.send(input);
  f.store.updateRun(receipt.runId, { status: 'interrupted', turnId: null });
  f.store.updateAgent(a.private.agent.id, { status: 'interrupted', turnId: null });
  await f.close();
  f = await setup(root);
  expect(f.host.send(input)).toEqual(receipt);
  await wait(() => f.store.run(receipt.runId).status === 'completed');
  f.host.project(f.host.resolve(a.private.handle).slot);
  expect(f.store.runsForAgent(a.private.agent.id)).toHaveLength(1);
  expect(f.store.entries(a.private.agent.id).filter((e) => e.kind === 'user')).toHaveLength(1);
  expect(f.store.entries(a.private.agent.id).filter((e) => e.kind === 'assistant')).toHaveLength(1);
  expect(feed(f, a.shared.handle).entries).toHaveLength(0);
});
it('persisted feed pagination stays bounded and rejects another group cursor', async () => {
  const f = await setup();
  const a = await create(f);
  const b = await create(f, 'Other bounded group');
  for (let i = 0; i < 25; i++)
    f.host.send({
      handle: a.shared.handle,
      key: randomUUID(),
      text: `Bounded persisted original ${i}`,
    });
  const first = feed(f, a.shared.handle);
  expect(first.entries).toHaveLength(20);
  expect(first.continuation).not.toBeNull();
  const next = f.host.feed({
    handle: a.shared.handle,
    query: { visibility: 'shared', after: 0, limit: 20, cursor: first.continuation },
  });
  expect(next.entries).toHaveLength(5);
  expect(next.entries[0].sequence).toBe(21);
  expect(() =>
    f.host.feed({
      handle: b.shared.handle,
      query: { visibility: 'shared', after: 0, limit: 20, cursor: first.continuation },
    }),
  ).toThrow();
});

it('retries create after interruption between context provisioning and the visible group receipt', async () => {
  let f = await setup();
  const root = f.root;
  const input = {
    key: randomUUID(),
    projectName: 'Interrupted create',
    displayName: 'Typed owner',
  };
  const createContext = f.host.events.createContext.bind(f.host.events);
  let calls = 0;
  f.host.events.createContext = (value) => {
    if (++calls === 2) throw new Error('crash during provisioning');
    return createContext(value);
  };
  await expect(f.host.create(input)).rejects.toThrow('crash during provisioning');
  expect(f.host.records()).toHaveLength(0);
  f.host.events.createContext = createContext;
  await f.close();
  f = await setup(root);
  const recovered = await f.host.create(input);
  expect(f.host.records()).toHaveLength(1);
  expect(recovered.shared.context.sessionId).not.toBe(recovered.private.context.sessionId);
  expect(await f.host.create(input)).toEqual(recovered);
});
