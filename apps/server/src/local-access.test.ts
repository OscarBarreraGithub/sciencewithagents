import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { LocalAccess, prepareLocalAccess, readLocalAccess } from './local-access.js';
import {
  localAuthorization,
  localRequestProof,
  type LocalRole,
} from '@dock/shared/dist/local-authorization.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { repoRoot } from './paths.js';
import { modelFixture } from './model-policy.fixture.js';
import { createServer } from './server.js';
import { PhoneAccess } from './phone-access.js';
import { browserDraftTransferSchema } from './local-browser-pages.js';
import { prepareBrowserHandoff } from './local-browser-handoff.js';

let root: string;
let store: Store;
let runtime: Runtime;
let app: Awaited<ReturnType<typeof createServer>> | undefined;
let access: LocalAccess;
const port = 4347;
const origin = `http://127.0.0.1:${port}`;
const headers = { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json' };
function authorization(role: LocalRole, method: string, path: string) {
  const challenge = randomBytes(32).toString('hex');
  const proof = access.proof({ role, challenge });
  return `Dock ${role}.${proof.nonce}.${localRequestProof(access.configuration[role], origin, role, challenge, proof.nonce, method, path)}`;
}
async function server() {
  app = await createServer(store, runtime, {
    port,
    localAccess: access,
    phone: new PhoneAccess(store, null),
    ownsRuntime: false,
  });
  return app;
}
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/local-access-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  store.register(repoRoot, 'Private project', 'Retained evidence');
  runtime = new Runtime(store, root, 'codex');
  access = new LocalAccess(prepareLocalAccess(root, port));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('retains private installation credentials across port changes and refuses shared or linked files', () => {
  const file = join(root, 'local-access.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const before = readLocalAccess(root);
  const changed = prepareLocalAccess(root, port + 1);
  expect(changed).toEqual({ ...before, origin: `http://127.0.0.1:${port + 1}` });
  chmodSync(file, 0o644);
  expect(() => readLocalAccess(root)).toThrow('private configuration');
  chmodSync(file, 0o600);
  renameSync(file, `${file}.saved`);
  symlinkSync(`${file}.saved`, file);
  expect(() => prepareLocalAccess(root, port)).toThrow();
});

it('binds one-use request proofs to role, method, path and the running server', () => {
  const value = authorization('owner', 'POST', '/api/local-access/handoff');
  expect(access.authenticate(value, 'GET', '/api/local-access/handoff')).toBeNull();
  expect(access.authenticate(value, 'POST', '/api/local-access/companion/code')).toBeNull();
  expect(
    access.authenticate(value.replace('owner.', 'host.'), 'POST', '/api/local-access/handoff'),
  ).toBeNull();
  expect(access.authenticate(value, 'POST', '/api/local-access/handoff')).toBe('owner');
  expect(access.authenticate(value, 'POST', '/api/local-access/handoff')).toBeNull();
  const other = authorization('owner', 'GET', '/api/snapshot');
  const reopened = new LocalAccess(readLocalAccess(root));
  expect(reopened.authenticate(other, 'GET', '/api/snapshot')).toBeNull();
  let now = Date.now();
  const timed = new LocalAccess(readLocalAccess(root), () => now);
  const challenge = randomBytes(32).toString('hex');
  const proof = timed.proof({ role: 'owner', challenge });
  const signed = `Dock owner.${proof.nonce}.${localRequestProof(timed.configuration.owner, origin, 'owner', challenge, proof.nonce, 'GET', '/api/snapshot')}`;
  now += 60_001;
  expect(timed.authenticate(signed, 'GET', '/api/snapshot')).toBeNull();
});

it('retains browser sessions through restart while refusing replay, duplicates, expiry and another installation', () => {
  let now = Date.now();
  const timed = new LocalAccess(readLocalAccess(root), () => now);
  const ticket = timed.issueHandoff();
  const cookie = timed.consumeHandoff(ticket.ticket).split(';')[0];
  expect(timed.browser(cookie)).toBe(true);
  expect(() => timed.consumeHandoff(ticket.ticket)).toThrow('Open sciencewithagents');
  expect(timed.browser(`${cookie}; ${cookie}`)).toBe(false);
  expect(new LocalAccess(readLocalAccess(root)).browser(cookie)).toBe(true);
  expect(
    new LocalAccess({ ...readLocalAccess(root), owner: randomBytes(32).toString('hex') }).browser(
      cookie,
    ),
  ).toBe(false);
  const stale = timed.issueHandoff();
  now += 60_001;
  expect(() => timed.consumeHandoff(stale.ticket)).toThrow('Open sciencewithagents');
  now += 30 * 24 * 60 * 60 * 1000;
  expect(timed.browser(cookie)).toBe(false);
});

it('binds draft transfers to their stage and exact local addresses, expires them and never resumes after restart', () => {
  let now = Date.now();
  const timed = new LocalAccess(readLocalAccess(root), () => now);
  const destination = timed.browserOrigin;
  const ticket = timed.issueMigration(origin, destination, true);
  expect(() => timed.importMigration(ticket, origin, destination)).toThrow();
  expect(() => timed.exportMigration(ticket, 'http://localhost:4347', destination)).toThrow();
  expect(() =>
    timed.exportMigration(ticket, origin, destination.replace('4347', '4348')),
  ).toThrow();
  const next = timed.exportMigration(ticket, origin, destination);
  expect(next.recover).toBe(true);
  expect(() => timed.exportMigration(ticket, origin, destination)).toThrow();
  expect(() => timed.exportMigration(next.ticket, origin, destination)).toThrow();
  expect(timed.importMigration(next.ticket, origin, destination).recover).toBe(true);
  expect(() => timed.importMigration(next.ticket, origin, destination)).toThrow();
  const expired = timed.issueMigration(origin, destination, false);
  now += 60_001;
  expect(() => timed.exportMigration(expired, origin, destination)).toThrow();
  const restart = timed.issueMigration(origin, destination, false);
  expect(() =>
    new LocalAccess(readLocalAccess(root)).exportMigration(restart, origin, destination),
  ).toThrow();
  expect(() => timed.issueMigration('https://example.com', destination, false)).toThrow();
  expect(() => timed.issueMigration(origin, 'http://another.localhost:4347', false)).toThrow();
});

it('accepts only bounded app draft keys, without connection metadata or duplicates', () => {
  const draft = { version: 1, local: [['dock:local:project', 'Unsent']], session: [] };
  expect(browserDraftTransferSchema.safeParse(draft).success).toBe(true);
  for (const key of ['unrelated', 'dock:local-access:migrated:http://127.0.0.1:4347'])
    expect(
      browserDraftTransferSchema.safeParse({ ...draft, local: [[key, 'value']] }).success,
    ).toBe(false);
  expect(
    browserDraftTransferSchema.safeParse({ ...draft, local: [...draft.local, ...draft.local] })
      .success,
  ).toBe(false);
});

it('transfers drafts only with authenticated issuance and purpose-bound forms, escaping text and retaining no server data', async () => {
  const api = await server();
  const privateOrigin = access.browserOrigin;
  const cookie = access.consumeHandoff(access.issueHandoff().ticket).split(';')[0];
  const browser = { ...headers, host: new URL(privateOrigin).host, origin: privateOrigin, cookie };
  const path = '/api/local-access/migrate';
  expect(
    (
      await api.inject({
        method: 'POST',
        url: path,
        headers,
        payload: { source: 'loopback', recover: true },
      })
    ).statusCode,
  ).toBe(401);
  const issued = await api.inject({
    method: 'POST',
    url: path,
    headers: browser,
    payload: { source: 'loopback', recover: true },
  });
  expect(issued.statusCode).toBe(200);
  expect(issued.json().target).toBe(`${origin}/api/local-access/export`);
  const form = {
    host: new URL(origin).host,
    origin: privateOrigin,
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-site': 'cross-site',
  };
  for (const badOrigin of ['null', 'https://example.com'])
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/api/local-access/export',
          headers: { ...form, origin: badOrigin },
          payload: new URLSearchParams({ ticket: issued.json().ticket }).toString(),
        })
      ).statusCode,
    ).toBe(403);
  const exported = await api.inject({
    method: 'POST',
    url: '/api/local-access/export',
    headers: form,
    payload: new URLSearchParams({ ticket: issued.json().ticket }).toString(),
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers['referrer-policy']).toBe('origin');
  const ticket = exported.body.match(/const ticket="([a-f0-9]{64})"/)![1];
  const secretText = '</script><script>window.draftExecuted=true</script>';
  const drafts = JSON.stringify({
    version: 1,
    local: [['dock:draft', secretText]],
    session: [['dock:pending', 'same-request-id']],
  });
  const importHeaders = { ...form, host: new URL(privateOrigin).host, origin };
  const imported = await api.inject({
    method: 'POST',
    url: '/api/local-access/import',
    headers: importHeaders,
    payload: new URLSearchParams({ ticket, drafts }).toString(),
  });
  expect(imported.statusCode).toBe(200);
  expect(imported.body).not.toContain(secretText);
  expect(imported.body).toContain('\\u003c/script>');
  expect(imported.headers['cache-control']).toBe('no-store');
  const replay = await api.inject({
    method: 'POST',
    url: '/api/local-access/import',
    headers: importHeaders,
    payload: new URLSearchParams({ ticket, drafts }).toString(),
  });
  expect(replay.statusCode).toBe(409);
  expect(replay.body).not.toContain(secretText);
  const malformed = await api.inject({
    method: 'POST',
    url: '/api/local-access/import',
    headers: importHeaders,
    payload: new URLSearchParams({ ticket, drafts: '{ private draft' }).toString(),
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('private draft');
  expect(store.runs()).toHaveLength(0);
});

it('closes anonymous private routes and allows only purpose-bound authenticated access', async () => {
  const api = await server();
  for (const url of [
    '/api/snapshot',
    '/api/phone/status',
    '/api/events',
    '/api/hosts',
    '/api/quark',
    '/api/recovery-backups',
  ])
    expect((await api.inject({ url, headers })).statusCode).toBe(401);
  for (const url of ['/api/projects', '/api/phone/enabled', '/api/local-access/handoff'])
    expect((await api.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(401);
  for (const url of ['/api/health', '/api/host-info'])
    expect((await api.inject({ url, headers })).statusCode).toBe(200);
  for (const url of [
    '/api%2fsnapshot',
    '/%61pi/snapshot',
    '/api/agent-client/../snapshot',
    '/api/agent-client/%2e%2e/snapshot',
  ]) {
    const result = await api.inject({ url, headers });
    expect(result.body).not.toContain('Private project');
  }
  for (const role of ['owner', 'host'] as const)
    expect(
      (
        await api.inject({
          url: '/api/snapshot',
          headers: { ...headers, authorization: authorization(role, 'GET', '/api/snapshot') },
        })
      ).json().projects,
    ).toHaveLength(1);
  expect(
    (
      await api.inject({
        url: '/api/snapshot',
        headers: { ...headers, authorization: authorization('bridge', 'GET', '/api/snapshot') },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/local-access/companion/code',
        headers: {
          ...headers,
          authorization: authorization('host', 'POST', '/api/local-access/companion/code'),
        },
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  for (const path of ['/api/phone/status', '/api/hosts'])
    expect(
      (
        await api.inject({
          url: path,
          headers: { ...headers, authorization: authorization('host', 'GET', path) },
        })
      ).statusCode,
    ).toBe(401);
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/phone/enabled',
        headers: { ...headers, authorization: authorization('host', 'POST', '/api/phone/enabled') },
        payload: { enabled: true },
      })
    ).statusCode,
  ).toBe(401);
  expect(store.runs()).toHaveLength(0);
});

it('exchanges a native ticket only at the private browser host, without exposing credentials in the URL or page', async () => {
  const api = await server();
  const minted = await api.inject({
    method: 'POST',
    url: '/api/local-access/handoff',
    headers: {
      ...headers,
      authorization: authorization('owner', 'POST', '/api/local-access/handoff'),
    },
    payload: {},
  });
  expect(minted.statusCode).toBe(200);
  const { ticket } = minted.json();
  const form = {
    ...headers,
    origin: 'null',
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-site': 'cross-site',
  };
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/local-access/consume',
        headers: form,
        payload: `ticket=${ticket}`,
      })
    ).statusCode,
  ).toBe(403);
  const consumed = await api.inject({
    method: 'POST',
    url: '/api/local-access/consume',
    headers: { ...form, host: new URL(access.browserOrigin).host },
    payload: `ticket=${ticket}`,
  });
  expect(consumed.statusCode).toBe(200);
  expect(consumed.body).not.toContain(ticket);
  expect(consumed.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
  const cookie = String(consumed.headers['set-cookie']).split(';')[0];
  expect(
    (await api.inject({ url: '/api/snapshot', headers: { ...headers, cookie } })).statusCode,
  ).toBe(401);
  const browser = {
    ...headers,
    host: new URL(access.browserOrigin).host,
    origin: access.browserOrigin,
    cookie,
  };
  expect(
    (await api.inject({ url: '/api/snapshot', headers: browser })).json().projects,
  ).toHaveLength(1);
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/local-access/handoff',
        headers: browser,
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/local-access/consume',
        headers: { ...form, host: new URL(access.browserOrigin).host },
        payload: `ticket=${ticket}`,
      })
    ).statusCode,
  ).toBe(409);
});

it('authenticates a real native client and websocket without sending the durable key', async () => {
  const api = await server();
  await api.listen({ port, host: '127.0.0.1' });
  const seen: string[] = [];
  api.server.on('request', (request) =>
    seen.push(JSON.stringify(request.headers), request.url ?? ''),
  );
  const header = await localAuthorization(
    origin,
    access.configuration.owner,
    'owner',
    'GET',
    '/api/snapshot',
  );
  const result = await fetch(`${origin}/api/snapshot`, { headers: { Authorization: header } });
  expect(result.status).toBe(200);
  expect((await result.json()).projects).toHaveLength(1);
  const handoff = await prepareBrowserHandoff(root, port);
  expect(handoff).toMatch(/^file:/);
  const file = fileURLToPath(handoff!);
  const text = readFileSync(file, 'utf8');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, 'launcher/browser')).mode & 0o777).toBe(0o700);
  expect(text).toContain(`${access.browserOrigin}/api/local-access/consume`);
  expect(text).not.toContain(access.configuration.owner);
  const ticket = text.match(/name="ticket" value="([a-f0-9]{64})"/)![1];
  expect(access.browser(access.consumeHandoff(ticket).split(';')[0])).toBe(true);
  await expect(prepareBrowserHandoff(root, port + 1)).rejects.toThrow('address');
  utimesSync(file, new Date(0), new Date(0));
  const unrelated = join(root, 'launcher/browser/keep.html');
  writeFileSync(unrelated, 'An unrelated file');
  await prepareBrowserHandoff(root, port);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(unrelated, 'utf8')).toBe('An unrelated file');
  await expect(
    localAuthorization(origin, '0'.repeat(64), 'owner', 'GET', '/api/snapshot'),
  ).rejects.toThrow('does not match');
  const bridge = await localAuthorization(
    origin,
    access.configuration.bridge,
    'bridge',
    'GET',
    '/api/vscode/bridge',
  );
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/vscode/bridge`, {
    headers: { Authorization: bridge },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
  } finally {
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close();
    await closed;
  }
  expect(seen.join(' ')).not.toContain(access.configuration.owner);
  expect(seen.join(' ')).not.toContain(access.configuration.bridge);
  expect(seen.join(' ')).not.toContain(access.configuration.host);
});

it('connects a native loopback editor without credentials while consumer routes stay protected', async () => {
  const api = await server();
  await api.listen({ port, host: '127.0.0.1' });
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/vscode/bridge`);
  const window = {
    windowId: randomUUID(),
    provider: 'claude',
    label: 'Local editor fixture',
    threadId: 'original-thread',
    title: 'Original conversation',
    status: 'idle',
    message: '',
  };
  const commands: string[] = [];
  socket.on('message', (raw) => {
    const command = JSON.parse(raw.toString());
    commands.push(command.type);
    socket.send(
      JSON.stringify({
        type: 'chunk',
        id: command.id,
        text: JSON.stringify({
          ...window,
          entries: [{ id: 'saved', role: 'user', text: 'Retained editor text' }],
        }),
        last: true,
      }),
    );
  });
  const read = (path: string) =>
    api.inject({
      url: path,
      headers: { ...headers, authorization: authorization('owner', 'GET', path) },
    });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', window }));
    await expect.poll(async () => (await read('/api/vscode/windows')).json()).toEqual([window]);
    const result = await read(`/api/vscode/windows/${window.windowId}`);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      threadId: 'original-thread',
      provider: 'claude',
      entries: [{ text: 'Retained editor text' }],
    });
    expect(commands).toEqual(['read']);
    expect(store.runs()).toHaveLength(0);
  } finally {
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close();
    await closed;
  }
});
