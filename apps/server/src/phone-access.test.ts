import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { get, type IncomingMessage } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { Terminals } from './terminal.js';
import { createServer } from './server.js';
import { PhoneAccess, phoneConfigSchema } from './phone-access.js';
import { repoRoot } from './paths.js';

const config = phoneConfigSchema.parse({
  origin: 'https://dock.example.test',
  issuer: 'https://owner.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  owner: 'owner@example.test',
  port: 4998,
});
const keys = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture' }],
});
const token = (overrides: JWTPayload = {}) =>
  new SignJWT({
    type: 'app',
    email: config.owner,
    sub: 'owner-subject',
    iss: config.issuer,
    aud: config.audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .sign(keys.privateKey);
const localHeaders = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
let root: string, store: Store, runtime: Runtime, access: PhoneAccess, terminals: Terminals;
let local: FastifyInstance, remote: FastifyInstance, manager: string, assertion: string;
const remoteHeaders = (cookie?: string) => ({
  host: 'dock.example.test',
  origin: config.origin,
  'content-type': 'application/json',
  'cf-access-jwt-assertion': assertion,
  ...(cookie ? { cookie } : {}),
});
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/phone-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Private project', '').managerId;
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  access = new PhoneAccess(store, config, jwks);
  terminals = new Terminals(runtime);
  local = await createServer(store, runtime, { port: 4999, phone: access, terminals });
  remote = await createServer(store, runtime, {
    port: config.port,
    phone: access,
    terminals,
    remote: true,
    ownsRuntime: false,
  });
  assertion = await token();
});
afterEach(async () => {
  vi.useRealTimers();
  await remote.close();
  await local.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
async function pair() {
  access.setEnabled(true);
  const result = await local.inject({
    method: 'POST',
    url: '/api/phone/code',
    headers: localHeaders,
    payload: { key: randomUUID() },
  });
  expect(result.statusCode).toBe(200);
  const paired = await remote.inject({
    method: 'POST',
    url: '/api/phone/pair',
    headers: remoteHeaders(),
    payload: { code: result.json().code, name: 'My phone' },
  });
  expect(paired.statusCode).toBe(200);
  return {
    code: result.json().code as string,
    cookie: String(paired.headers['set-cookie']).split(';')[0],
    response: paired,
  };
}

describe('protected phone entry', () => {
  it('protects mirror consumers and never registers the extension producer remotely', async () => {
    access.setEnabled(true);
    expect(
      (await remote.inject({ url: '/api/vscode/windows', headers: remoteHeaders() })).statusCode,
    ).toBe(401);
    expect(
      (
        await remote.inject({
          url: `/api/vscode/deliveries/${randomUUID()}`,
          headers: remoteHeaders(),
        })
      ).statusCode,
    ).toBe(401);
    const { cookie } = await pair();
    expect(
      (
        await remote.inject({
          url: `/api/vscode/deliveries/${randomUUID()}`,
          headers: remoteHeaders(cookie),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await remote.inject({ url: '/api/vscode/windows', headers: remoteHeaders(cookie) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await remote.inject({ url: '/api/vscode/bridge', headers: remoteHeaders(cookie) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await remote.inject({
          method: 'POST',
          url: `/api/vscode/windows/${randomUUID()}/send`,
          headers: remoteHeaders(),
          payload: { key: randomUUID(), threadId: 'a', text: 'hello' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('is off by default and never trusts the local socket or forwarded identity', async () => {
    expect((await remote.inject({ url: '/api/health', headers: remoteHeaders() })).statusCode).toBe(
      503,
    );
    access.setEnabled(true);
    for (const headers of [
      { host: 'dock.example.test' },
      { host: 'dock.example.test', 'cf-access-authenticated-user-email': config.owner },
      { host: 'dock.example.test', 'x-forwarded-for': '127.0.0.1' },
      { ...remoteHeaders(), 'cf-access-jwt-assertion': 'not-a-jwt' },
    ])
      expect((await remote.inject({ url: '/api/phone/status', headers })).statusCode).toBe(401);
    expect(
      (await remote.inject({ url: '/api/phone/status', headers: localHeaders })).statusCode,
    ).toBe(403);
    expect(
      (
        await local.inject({
          url: '/api/snapshot',
          headers: { ...localHeaders, 'cf-access-jwt-assertion': assertion },
        })
      ).statusCode,
    ).toBe(403);
    expect((await local.inject({ url: '/api/snapshot', headers: localHeaders })).statusCode).toBe(
      200,
    );
  });

  it('verifies signature, issuer, audience, expiry and owner, not just JWT presence', async () => {
    access.setEnabled(true);
    expect(await access.identity(assertion)).toMatchObject({
      email: config.owner,
      subject: 'owner-subject',
    });
    for (const changes of [
      { iss: 'https://attacker.cloudflareaccess.com' },
      { aud: 'b'.repeat(64) },
      { email: 'other@example.test' },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { type: 'service' },
      { sub: '' },
      { email: undefined },
    ])
      expect(await access.identity(await token(changes))).toBeNull();
    const forged = await new SignJWT({ email: config.owner })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .sign((await generateKeyPair('RS256')).privateKey);
    expect(await access.identity(forged)).toBeNull();
    for (const changes of [
      { origin: 'http://dock.example.test' },
      { origin: `${config.origin}/path` },
      { issuer: 'https://evil.test' },
      { audience: 'short' },
    ])
      expect(phoneConfigSchema.safeParse({ ...config, ...changes }).success).toBe(false);
  });

  it('requires pairing for every private API and rejects remote device administration', async () => {
    access.setEnabled(true);
    expect(
      (await remote.inject({ url: '/api/phone/status', headers: remoteHeaders() })).json(),
    ).toMatchObject({ mode: 'remote', paired: false, devices: [] });
    for (const url of [
      '/api/health',
      '/api/snapshot',
      '/api/attention',
      '/api/scheduler',
      '/api/events',
      `/api/agents/${manager}`,
      `/api/agents/${manager}/export`,
      `/api/agents/${manager}/images/${randomUUID()}`,
    ])
      expect((await remote.inject({ url, headers: remoteHeaders() })).statusCode).toBe(401);
    const { cookie, response } = await pair();
    expect(response.headers['set-cookie']).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      (await remote.inject({ url: '/api/snapshot', headers: remoteHeaders(cookie) })).json()
        .projects[0].name,
    ).toBe('Private project');
    expect(
      (await remote.inject({ url: '/api/phone/status', headers: remoteHeaders(cookie) })).json(),
    ).toMatchObject({ paired: true, devices: [] });
    for (const url of [
      '/api/phone/code',
      '/api/phone/enabled',
      `/api/phone/devices/${randomUUID()}/revoke`,
      '/api/phone/reconnect',
    ])
      expect(
        (await remote.inject({ method: 'POST', url, headers: remoteHeaders(cookie), payload: {} }))
          .statusCode,
      ).toBe(403);
    expect(
      (await remote.inject({ url: '/api/project-options', headers: remoteHeaders(cookie) })).json()
        .canChooseFolder,
    ).toBe(true);
  });

  it('keeps exact HTTPS origin / JSON checks for writes and does not accept a copied cookie alone', async () => {
    const { cookie } = await pair();
    for (const headers of [
      { ...remoteHeaders(cookie), origin: 'https://attacker.test' },
      Object.fromEntries(Object.entries(remoteHeaders(cookie)).filter(([key]) => key !== 'origin')),
      { ...remoteHeaders(cookie), 'sec-fetch-site': 'cross-site' },
      { ...remoteHeaders(cookie), 'content-type': 'text/plain' },
    ])
      expect(
        (await remote.inject({ method: 'POST', url: '/api/projects', headers, payload: '{}' }))
          .statusCode,
      ).toBe(403);
    expect(
      (
        await remote.inject({
          url: '/api/snapshot',
          headers: { host: 'dock.example.test', cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await remote.inject({
          url: '/api/snapshot',
          headers: remoteHeaders(`${cookie}; ${cookie}`),
        })
      ).statusCode,
    ).toBe(401);
    const otherIdentity = await access.identity(await token({ sub: 'different-subject' }));
    expect(access.session(otherIdentity!, cookie)).toBeNull();
  });

  it('hashes codes and sessions, consumes codes once and persists enrollments across restart', async () => {
    const { cookie, code } = await pair();
    expect(
      (
        await remote.inject({
          method: 'POST',
          url: '/api/phone/pair',
          headers: remoteHeaders(),
          payload: { code, name: 'Replay' },
        })
      ).statusCode,
    ).toBe(409);
    const persisted = JSON.stringify({
      settings: store.db.prepare('SELECT * FROM settings').all(),
      devices: store.db.prepare('SELECT * FROM phone_devices').all(),
      events: store.events(),
    });
    expect(persisted).not.toContain(code.replaceAll('-', ''));
    expect(persisted).not.toContain(cookie.split('=')[1]);
    const identity = await access.identity(assertion);
    await remote.close();
    await local.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const restored = new PhoneAccess(store, config, jwks);
    expect(restored.enabled).toBe(true);
    expect(restored.session(identity!, cookie)).not.toBeNull();
    restored.revoke(restored.status(false).devices[0].id);
    expect(restored.session(identity!, cookie)).toBeNull();
  });

  it('preserves legacy Access enrollment through fingerprint migration and port changes, but revokes changed authentication', async () => {
    const { cookie } = await pair();
    const identity = (await access.identity(assertion))!;
    const { authentication: _authentication, ...legacyConfig } = config;
    store.setSetting(
      'phone:configuration',
      createHash('sha256').update(JSON.stringify(legacyConfig)).digest('hex'),
    );
    const migrated = new PhoneAccess(store, config, jwks);
    expect(migrated.enabled).toBe(true);
    expect(migrated.session(identity, cookie)).not.toBeNull();
    const transport = new PhoneAccess(store, { ...config, port: 5888 }, jwks);
    expect(transport.enabled).toBe(true);
    expect(transport.session(identity, cookie)).not.toBeNull();
    const changed = new PhoneAccess(store, { ...config, audience: 'b'.repeat(64) }, jwks);
    expect(changed.enabled).toBe(false);
    changed.setEnabled(true);
    expect(changed.session(identity, cookie)).toBeNull();
  });

  it('limits attempts across reconstruction, expires codes, and does not recover plaintext after restart', async () => {
    access.setEnabled(true);
    const key = randomUUID(),
      code = access.issueCode(key);
    expect(access.issueCode(key)).toEqual(code);
    const identity = (await access.identity(assertion))!;
    for (let i = 0; i < 5; i++)
      expect(() => access.pair(identity, { code: 'WRONG', name: 'Phone' })).toThrow();
    const restored = new PhoneAccess(store, config, jwks);
    expect(() => restored.pair(identity, { code: code.code, name: 'Phone' })).toThrow(
      'unavailable',
    );
    const fresh = access.issueCode(randomUUID());
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
    expect(() => access.pair(identity, { code: fresh.code, name: 'Phone' })).toThrow('unavailable');
    vi.useRealTimers();
    const otherKey = randomUUID();
    access.issueCode(otherKey);
    expect(() => restored.issueCode(otherKey)).toThrow('no longer available');
  });

  it('closes session watchers at expiry or disable, and disables old enrollments when config changes', async () => {
    const { cookie } = await pair();
    const session = access.session((await access.identity(assertion))!, cookie)!;
    vi.useFakeTimers();
    const expired = vi.fn(),
      cancel = access.watch({ ...session, expiresAt: Date.now() + 100 }, expired);
    vi.advanceTimersByTime(101);
    expect(expired).toHaveBeenCalledOnce();
    cancel();
    vi.useRealTimers();
    const closed = vi.fn(),
      stop = access.watch(session, closed);
    access.setEnabled(false);
    expect(closed).toHaveBeenCalledOnce();
    stop();
    access.setEnabled(true);
    expect(access.session(session, cookie)).toBeNull();
    new PhoneAccess(store, { ...config, origin: 'https://changed.example.test' }, jwks);
    expect(access.enabled).toBe(false);
  });

  it('shares terminal ownership without closing the local runtime when the remote entry closes', async () => {
    const { cookie } = await pair();
    vi.spyOn(terminals, 'active').mockReturnValue(true);
    for (const [app, headers] of [
      [local, localHeaders],
      [remote, remoteHeaders(cookie)],
    ] as const)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/agents/${manager}/messages`,
            headers,
            payload: { key: randomUUID(), text: 'Hello' },
          })
        ).statusCode,
      ).toBe(409);
    const close = vi.spyOn(runtime, 'close');
    await remote.close();
    expect(close).not.toHaveBeenCalled();
    expect((await local.inject({ url: '/api/snapshot', headers: localHeaders })).statusCode).toBe(
      200,
    );
  });

  it('terminates an already-open remote terminal and event stream when its device is revoked', async () => {
    const { cookie } = await pair();
    vi.spyOn(terminals, 'connect').mockImplementation(async (_id, socket) => {
      socket.on('message', () => {});
    });
    await remote.listen({ host: '127.0.0.1', port: 0 });
    const address = remote.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/agents/${manager}/terminal`, {
      headers: remoteHeaders(cookie),
    });
    let response: IncomingMessage | undefined;
    try {
      await once(socket, 'open');
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        get(
          `http://127.0.0.1:${address.port}/api/events`,
          { headers: remoteHeaders(cookie) },
          resolve,
        ).once('error', reject);
      });
      expect(response.statusCode).toBe(200);
      const ended = once(response, 'end');
      response.resume();
      const closed = once(socket, 'close');
      access.revoke(access.status(false).devices[0].id);
      await closed;
      await ended;
      expect(
        (await remote.inject({ url: '/api/snapshot', headers: remoteHeaders(cookie) })).statusCode,
      ).toBe(401);
    } finally {
      response?.destroy();
      socket.terminate();
    }
  });
});

it('lets paired phones browse host folders while keeping unpaired requests and arbitrary paths out', async () => {
  access.setEnabled(true);
  expect(
    (await remote.inject({ url: '/api/project-folders', headers: remoteHeaders() })).statusCode,
  ).toBe(401);
  const { cookie } = await pair();
  const headers = remoteHeaders(cookie);
  expect((await remote.inject({ url: '/api/project-options', headers })).json()).toEqual({
    canChooseFolder: true,
    folderBrowser: true,
  });
  const folders = await remote.inject({ url: '/api/project-folders', headers });
  expect(folders.statusCode).toBe(200);
  expect(folders.json().current.id).toMatch(/^[a-f0-9-]{36}$/);
  expect((await remote.inject({ url: '/api/project-folders?path=/tmp', headers })).statusCode).toBe(
    400,
  );
  expect(
    (
      await remote.inject({
        method: 'POST',
        url: '/api/projects/connect-folder',
        headers,
        payload: { key: randomUUID(), folderId: randomUUID(), selectOnly: true },
      })
    ).statusCode,
  ).toBe(409);
});

it('connects a chosen host folder from a paired phone and retries without duplicating a manager', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'swa-phone-project-')));
  writeFileSync(join(folder, 'notes.txt'), 'Preserve this work.');
  try {
    const { cookie } = await pair();
    const headers = remoteHeaders(cookie);
    const browse = async (id?: string, offset = 0) => {
      const query = new URLSearchParams({ offset: String(offset) });
      if (id) query.set('folderId', id);
      const response = await remote.inject({ url: `/api/project-folders?${query}`, headers });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    let list = await browse();
    while (list.parentId) list = await browse(list.parentId);
    for (const segment of folder.split('/').filter(Boolean)) {
      let choice = list.folders.find((f: { name: string }) => f.name === segment);
      while (!choice && list.nextOffset !== null) {
        list = await browse(list.current.id, list.nextOffset);
        choice = list.folders.find((f: { name: string }) => f.name === segment);
      }
      expect(choice).toBeTruthy();
      list = await browse(choice.id);
    }
    const key = randomUUID();
    const selected = await remote.inject({
      method: 'POST',
      url: '/api/projects/connect-folder',
      headers,
      payload: { key, folderId: list.current.id, selectOnly: true },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().selection.needsTracking).toBe(true);
    const count = store.projects().length;
    const connected = await remote.inject({
      method: 'POST',
      url: '/api/projects/connect-folder',
      headers,
      payload: { key },
    });
    expect(connected.json().tracking.key).toBe(key);
    const track = () =>
      remote.inject({
        method: 'POST',
        url: '/api/projects/track-folder',
        headers,
        payload: { key, confirmedTracking: true },
      });
    const created = await track();
    expect(created.statusCode).toBe(200);
    expect((await track()).json()).toEqual(created.json());
    expect(store.projects()).toHaveLength(count + 1);
    expect(store.agent(created.json().project.managerId).permission).toBe('workspace-write');
    expect(store.runs()).toHaveLength(0);
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('Preserve this work.');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
