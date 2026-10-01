import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { once } from 'node:events';
import { get, type IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { Terminals } from './terminal.js';
import { PhoneAccess, phoneConfigSchema } from './phone-access.js';
import { PairedDevices } from './paired-devices.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';

const origin = 'https://dock.example.test';
const config = phoneConfigSchema.parse({ origin, authentication: 'paired', port: 4998 });
const localHeaders = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
let root: string, store: Store, access: PhoneAccess, runtime: Runtime, terminals: Terminals;
let local: FastifyInstance, remote: FastifyInstance;
let cookies: Record<string, string>;
const headers = () => ({
  host: 'dock.example.test',
  origin,
  'content-type': 'application/json',
  cookie: Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; '),
});
async function request(path: string, body?: unknown, host = remote) {
  const response = await host.inject({
    url: `/api/phone/${path}`,
    ...(body === undefined ? {} : { method: 'POST', payload: body as object }),
    headers: host === local ? localHeaders : headers(),
  });
  if (host === remote)
    for (const value of [response.headers['set-cookie'] ?? []].flat()) {
      const [key, token] = String(value).split(';')[0].split('=');
      cookies[key] = token;
    }
  return response;
}
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/paired-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  store.register(root, 'Private fixture', '');
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  access = new PhoneAccess(store, config);
  terminals = new Terminals(runtime);
  local = await createServer(store, runtime, { port: 4999, phone: access, terminals });
  remote = await createServer(store, runtime, {
    port: 4998,
    phone: access,
    terminals,
    remote: true,
    ownsRuntime: false,
  });
  cookies = {};
  access.setEnabled(true);
});
afterEach(async () => {
  vi.useRealTimers();
  await remote?.close();
  await local?.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});

// Real ES256 signatures and standards-shaped "none" attestation, not a mocked verifier.
function cbor(value: string | number | Uint8Array | Map<unknown, unknown>): Buffer {
  const head = (major: number, size: number) =>
    size < 24
      ? Buffer.from([(major << 5) | size])
      : size < 256
        ? Buffer.from([(major << 5) | 24, size])
        : Buffer.from([(major << 5) | 25, size >> 8, size & 255]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([
    head(5, value.size),
    ...[...value].flatMap(([k, v]) => [cbor(k as number), cbor(v as string)]),
  ]);
}
function authenticator() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }),
    id = randomBytes(32),
    credentialId = id.toString('base64url');
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
  return {
    register(challenge: string, targetOrigin = origin, uv = true) {
      const key = cbor(
        new Map<unknown, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, 'base64url')],
          [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
      );
      const authData = Buffer.concat([
        digest('dock.example.test'),
        Buffer.from([uv ? 0x45 : 0x41]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        Buffer.from([0, id.length]),
        id,
        key,
      ]);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({
              type: 'webauthn.create',
              challenge,
              origin: targetOrigin,
              crossOrigin: false,
            }),
          ).toString('base64url'),
          attestationObject: cbor(
            new Map<unknown, unknown>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', authData],
            ]),
          ).toString('base64url'),
        },
      };
    },
  };
}
async function begin() {
  const code = (await request('code', { key: randomUUID() }, local)).json().code;
  const options = await request('enroll/options', { code, name: 'Fixture phone' });
  expect(options.statusCode).toBe(200);
  return { code, options: options.json() };
}
async function enroll() {
  const auth = authenticator(),
    { code, options } = await begin();
  expect((await request('enroll/finish', auth.register(options.challenge))).statusCode).toBe(200);
  const pending = (await request('status', undefined, local)).json().pending;
  expect(pending).not.toBeNull();
  expect(
    (await request('confirm', { id: pending.id, confirmation: pending.confirmation }, local))
      .statusCode,
  ).toBe(200);
  return { auth, code, deviceId: pending.id as string };
}

describe('secure enrollment and persistent paired access', () => {
  it('retains enrolled phones through unavailable setup without allowing remote access', async () => {
    const { deviceId } = await enroll();
    await request('setup/complete', { setupComplete: true });
    const devices = store.db.prepare('SELECT * FROM paired_devices').all();
    const fingerprint = store.getSetting('phone:configuration');
    const broken = new PhoneAccess(store, null, undefined, 'configuration');
    expect(broken.enabled).toBe(false);
    expect(broken.status(false)).toMatchObject({
      setupIssue: 'configuration',
      connection: 'error',
    });
    expect(() => broken.setEnabled(true)).toThrow('repair');
    expect(store.getSetting('phone:configuration')).toBe(fingerprint);
    expect(store.getSetting('phone:enabled')).toBe(true);
    const repaired = new PhoneAccess(store, config);
    expect(repaired.pairedDevices!.session(headers().cookie)).toMatchObject({ deviceId });
    repaired.unavailable('listener');
    expect(repaired.pairedDevices!.session(headers().cookie)).toBeNull();
    expect(store.db.prepare('SELECT * FROM paired_devices').all()).toEqual(devices);
    const restarted = new PhoneAccess(store, config);
    expect(restarted.pairedDevices!.session(headers().cookie)).toMatchObject({ deviceId });
  });

  it('migrates unchanged legacy configuration and retains verified phones across transport-only edits', async () => {
    const { deviceId } = await enroll();
    await request('setup/complete', { setupComplete: true });
    const devices = store.db.prepare('SELECT * FROM paired_devices').all();
    store.setSetting(
      'phone:configuration',
      createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    );
    const migrated = new PhoneAccess(store, config);
    expect(migrated.enabled).toBe(true);
    expect(String(store.getSetting('phone:configuration'))).toMatch(/^v2:/);
    expect(migrated.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId,
      expiresAt: null,
    });
    const transportChanged = new PhoneAccess(store, {
      ...config,
      port: 5888,
      owner: 'unused@example.test',
    });
    expect(transportChanged.enabled).toBe(true);
    expect(transportChanged.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId,
      expiresAt: null,
    });
    expect(store.db.prepare('SELECT * FROM paired_devices').all()).toEqual(devices);
    const trustChanged = new PhoneAccess(store, {
      ...config,
      origin: 'https://different.example.test',
    });
    expect(trustChanged.enabled).toBe(false);
    expect(trustChanged.pairedDevices!.status(true, headers().cookie).enrolled).toBe(false);
    expect(trustChanged.pairedDevices!.session(headers().cookie)).toBeNull();
    trustChanged.setEnabled(true);
    expect(trustChanged.pairedDevices!.session(headers().cookie)).toBeNull();
  });

  it('does not migrate an old fingerprint for a changed trust boundary', async () => {
    await enroll();
    store.setSetting(
      'phone:configuration',
      createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    );
    const changed = new PhoneAccess(store, { ...config, origin: 'https://another.example.test' });
    expect(changed.enabled).toBe(false);
    expect(changed.pairedDevices!.status(true, headers().cookie).enrolled).toBe(false);
  });

  it('shows the computer that passkey saving is in progress without exposing unverified details', async () => {
    expect(access.status(false)).toMatchObject({ enrollmentInProgress: false, pending: null });
    const { options } = await begin();
    expect((await request('status', undefined, local)).json()).toMatchObject({
      enrollmentOpen: false,
      enrollmentInProgress: true,
      pending: null,
      devices: [],
    });
    expect((await request('status')).json()).toMatchObject({
      enrollmentInProgress: false,
      pending: null,
    });
    expect(access.status(true)).toMatchObject({ enrollmentInProgress: false, pending: null });
    const auth = authenticator();
    expect((await request('enroll/finish', auth.register(options.challenge))).statusCode).toBe(200);
    const verified = (await request('status', undefined, local)).json();
    expect(verified.enrollmentInProgress).toBe(false);
    expect(verified.pending).not.toBeNull();
    expect((await request('confirm', verified.pending, local)).statusCode).toBe(400);
    const { id, confirmation } = verified.pending;
    expect((await request('confirm', { id, confirmation }, local)).statusCode).toBe(200);
    expect(access.status(false)).toMatchObject({ enrollmentInProgress: false, pending: null });
    cookies = {};
    await begin();
    expect(access.status(false).enrollmentInProgress).toBe(true);
    expect((await request('enrollment/close', {}, local)).statusCode).toBe(200);
    expect(access.status(false)).toMatchObject({ enrollmentInProgress: false, pending: null });
  });
  it('allows fifteen minutes for code entry, passkey saving and confirmation without extending the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = Date.now();
    const code = (await request('code', { key: randomUUID() }, local)).json();
    expect(Date.parse(code.expiresAt)).toBe(issuedAt + 15 * 60_000);
    vi.setSystemTime(issuedAt + 6 * 60_000);
    const started = await request('enroll/options', { code: code.code, name: 'Fixture phone' });
    expect(started.statusCode).toBe(200);
    const options = started.json();
    expect(options.user.displayName).toBe('sciencewithagents · Fixture phone');
    expect(options.timeout).toBe(9 * 60_000);
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    });
    vi.setSystemTime(issuedAt + 14 * 60_000);
    const auth = authenticator();
    expect((await request('enroll/finish', auth.register(options.challenge))).statusCode).toBe(200);
    const pending = (await request('status', undefined, local)).json().pending;
    expect(
      (await request('confirm', { id: pending.id, confirmation: pending.confirmation }, local))
        .statusCode,
    ).toBe(200);
    expect(access.status(false).devices).toHaveLength(1);
    vi.useRealTimers();
  });
  it('keeps the original fifteen-minute deadline after options are prepared or state is reconstructed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = Date.now();
    const code = (await request('code', { key: randomUUID() }, local)).json();
    vi.setSystemTime(issuedAt + 14 * 60_000);
    const started = await request('enroll/options', { code: code.code, name: 'Fixture phone' });
    expect(started.statusCode).toBe(200);
    expect(started.json().timeout).toBe(60_000);
    const restored = new PhoneAccess(store, config);
    vi.setSystemTime(issuedAt + 15 * 60_000);
    expect(restored.status(false)).toMatchObject({ enrollmentInProgress: false, pending: null });
    await expect(
      restored.pairedDevices!.finish(
        authenticator().register(started.json().challenge),
        headers().cookie,
      ),
    ).rejects.toThrow('unavailable');
    expect(restored.status(false).devices).toHaveLength(0);
    vi.useRealTimers();
  });
  it('cannot finish an enrollment after access is disabled or pairing cancelled during verification', async () => {
    for (const cancel of [
      () => access.pairedDevices!.closeEnrollment(),
      () => {
        access.setEnabled(false);
        access.setEnabled(true);
      },
    ]) {
      const { options } = await begin();
      const verification = access.pairedDevices!.finish(
        authenticator().register(options.challenge),
        headers().cookie,
      );
      cancel();
      await expect(verification).rejects.toThrow('cancelled');
      expect(access.pairedDevices!.session(headers().cookie)).toBeNull();
    }
  });
  it('denies private APIs, unapproved cookies, forged Access headers and all remote administration', async () => {
    expect((await request('status')).json()).toMatchObject({
      authentication: 'paired',
      paired: false,
      enrolled: false,
      enrollmentOpen: false,
      devices: [],
    });
    expect((await request('status')).headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
    for (const url of [
      '/%61pi/snapshot',
      '//api/snapshot',
      '/api%2Fsnapshot',
      '/api/../api/snapshot',
      '/api/snapshot/',
    ]) {
      const response = await remote.inject({ url, headers: headers() });
      expect(response.body).not.toContain('Private fixture');
      expect(response.statusCode).not.toBe(200);
    }
    for (const path of [
      '/api/snapshot',
      '/api/attention',
      '/api/scheduler',
      '/api/events',
      '/api/health',
      `/api/agents/${randomUUID()}/export`,
      `/api/agents/${randomUUID()}/terminal`,
    ])
      expect(
        (
          await remote.inject({
            url: path,
            headers: { ...headers(), 'cf-access-jwt-assertion': 'forged' },
          })
        ).statusCode,
      ).toBe(401);
    expect((await request('enroll/options', { code: 'WRONG', name: 'No' })).statusCode).toBe(409);
    await enroll();
    const status = await request('status');
    expect(status.json()).toMatchObject({ enrolled: true, paired: true });
    expect(String(status.headers['set-cookie'])).toContain('Secure; HttpOnly; SameSite=Strict');
    expect((await remote.inject({ url: '/api/snapshot', headers: headers() })).statusCode).toBe(
      200,
    );
    for (const path of [
      'confirm',
      'code',
      'enrollment/close',
      'enabled',
      'reconnect',
      `devices/${randomUUID()}/revoke`,
    ])
      expect((await request(path, {})).statusCode).toBe(403);
  });
  it('requires verified registration and exact local confirmation, then closes enrollment to another browser', async () => {
    const { options, code } = await begin(),
      auth = authenticator();
    expect((await request('enroll/finish', auth.register(options.challenge))).statusCode).toBe(200);
    const pending = (await request('status')).json().pending;
    expect(
      (await request('confirm', { id: pending.id, confirmation: '000000' }, local)).statusCode,
    ).toBe(409);
    expect((await request('status')).json().enrolled).toBe(false);
    expect(
      (await request('confirm', { id: pending.id, confirmation: pending.confirmation }, local))
        .statusCode,
    ).toBe(200);
    expect(
      (await request('confirm', { id: pending.id, confirmation: pending.confirmation }, local))
        .statusCode,
    ).toBe(200);
    expect(access.status(false).devices).toHaveLength(1);
    cookies = {};
    expect((await request('status')).json()).toMatchObject({
      pending: null,
      enrolled: false,
      enrollmentOpen: false,
      devices: [],
    });
    expect((await request('enroll/options', { code, name: 'Another' })).statusCode).toBe(409);
    expect((await remote.inject({ url: '/api/snapshot', headers: headers() })).statusCode).toBe(
      401,
    );
  });
  it('rejects wrong origin, missing verification, altered challenges and registration replay', async () => {
    for (const [target, uv] of [
      ['https://evil.test', true],
      [origin, false],
    ] as const) {
      const { options } = await begin();
      expect(
        (await request('enroll/finish', authenticator().register(options.challenge, target, uv)))
          .statusCode,
      ).toBe(409);
    }
    const { options } = await begin(),
      auth = authenticator();
    expect(
      (await request('enroll/finish', auth.register(randomBytes(32).toString('base64url'))))
        .statusCode,
    ).toBe(409);
    expect((await request('enroll/finish', auth.register(options.challenge))).statusCode).toBe(409);
    const next = await begin(),
      response = auth.register(next.options.challenge);
    expect((await request('enroll/finish', response)).statusCode).toBe(200);
    expect((await request('enroll/finish', response)).statusCode).toBe(409);
    expect(access.pairedDevices!.session(headers().cookie)).toBeNull(); // still needs the computer
  });
  it('preserves approved access through time, off/on and database restart without permanent secrets in the archive', async () => {
    const { code, deviceId } = await enroll();
    const enrollment = cookies.__Host_dock_enrollment ?? cookies['__Host-dock_enrollment'];
    const saved = JSON.stringify({
      settings: store.db.prepare('SELECT * FROM settings').all(),
      devices: store.db.prepare('SELECT * FROM paired_devices').all(),
      events: store.events(),
    });
    expect(saved).not.toContain(enrollment);
    expect(saved).not.toContain(code.replaceAll('-', ''));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 366 * 24 * 60 * 60 * 1000);
    expect(access.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId,
      expiresAt: null,
    });
    vi.useRealTimers();
    access.setEnabled(false);
    expect(access.pairedDevices!.session(headers().cookie)).toBeNull();
    expect((await remote.inject({ url: '/api/snapshot', headers: headers() })).statusCode).toBe(
      503,
    );
    access.setEnabled(true);
    expect((await request('status')).json()).toMatchObject({ enrolled: true, paired: true });
    await remote.close();
    await local.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const restored = new PhoneAccess(store, config);
    expect(restored.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId,
      expiresAt: null,
    });
    expect(restored.status(false).devices[0]).toMatchObject({ id: deviceId, expiresAt: null });
    restored.revoke(deviceId);
    expect(restored.pairedDevices!.status(true, headers().cookie).enrolled).toBe(false);
  });
  it('persists bounded code attempts and cancellation and cannot confirm an expired pending registration', async () => {
    const code = (await request('code', { key: randomUUID() }, local)).json().code;
    for (let i = 0; i < 5; i++)
      expect((await request('enroll/options', { code: 'WRONG', name: 'No' })).statusCode).toBe(409);
    expect((await request('enroll/options', { code, name: 'No' })).statusCode).toBe(409);
    const { options } = await begin(),
      auth = authenticator();
    await request('enrollment/close', {}, local);
    expect((await request('enroll/finish', auth.register(options.challenge))).statusCode).toBe(409);
    const next = await begin();
    await request('enroll/finish', auth.register(next.options.challenge));
    const pending = (await request('status')).json().pending;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    expect(() =>
      access.pairedDevices!.confirm({ id: pending.id, confirmation: pending.confirmation }),
    ).toThrow('no longer available');
    vi.useRealTimers();
    expect(access.status(false).devices).toHaveLength(0);
  });
  it('checks exact origin, JSON and duplicate browser cookies, never a browser fingerprint or IP allowlist', async () => {
    await enroll();
    for (const changes of [
      { origin: 'https://evil.test' },
      { 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect(
        (
          await remote.inject({
            method: 'POST',
            url: '/api/phone/setup/complete',
            headers: { ...headers(), ...changes },
            payload: '{}',
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await remote.inject({
          url: '/api/snapshot',
          headers: {
            ...headers(),
            cookie: `${headers().cookie}; __Host-dock_enrollment=${cookies['__Host-dock_enrollment']}`,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await local.inject({
          url: '/api/snapshot',
          headers: { ...localHeaders, 'cf-connecting-ip': '127.0.0.1' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it.each(['disabled', 'removed'] as const)(
    '%s closes event and terminal sockets while retaining projects and conversations',
    async (action) => {
      const { deviceId } = await enroll();
      vi.spyOn(terminals, 'connect').mockImplementation(async (_id, socket) => {
        socket.on('message', () => {});
      });
      await remote.listen({ host: '127.0.0.1', port: 0 });
      const port = (remote.server.address() as { port: number }).port;
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/api/agents/${store.agents()[0].id}/terminal`,
        { headers: headers() },
      );
      let response: IncomingMessage | undefined;
      try {
        await once(socket, 'open');
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          get(`http://127.0.0.1:${port}/api/events`, { headers: headers() }, resolve).once(
            'error',
            reject,
          );
        });
        expect(response.statusCode).toBe(200);
        response.resume();
        const ended = once(response, 'end'),
          closed = once(socket, 'close');
        if (action === 'disabled') access.setEnabled(false);
        else access.revoke(deviceId);
        await Promise.all([ended, closed]);
        expect(access.pairedDevices!.session(headers().cookie)).toBeNull();
        expect(store.projects()).toHaveLength(1);
        if (action === 'disabled') {
          access.setEnabled(true);
          expect(access.pairedDevices!.session(headers().cookie)).not.toBeNull();
        } else expect((await request('status')).json().enrolled).toBe(false);
      } finally {
        response?.destroy();
        socket.terminate();
      }
    },
  );
  it('requires approval before setup completion and revalidates revocation after request admission', async () => {
    expect((await request('setup/complete', { setupComplete: true })).statusCode).toBe(401);
    await begin();
    expect((await request('setup/complete', { setupComplete: true })).statusCode).toBe(401);
    access.pairedDevices!.closeEnrollment();
    const { deviceId } = await enroll();
    for (const input of [
      {},
      { setupComplete: false },
      { setupComplete: true, requireUnlock: false },
    ])
      expect((await request('setup/complete', input)).statusCode).toBe(400);
    expect((await request('setup/complete', { setupComplete: true }, local)).statusCode).toBe(403);
    expect((await request('setup/complete', { setupComplete: true })).json()).toMatchObject({
      paired: true,
      setupComplete: true,
    });
    expect((await request('setup/complete', { setupComplete: true })).statusCode).toBe(200);
    const session = access.pairedDevices!.session(headers().cookie)!;
    access.revoke(deviceId);
    expect(() =>
      access.pairedDevices!.completeSetup({ setupComplete: true }, headers().cookie, session),
    ).toThrow('Pair this browser');
    expect((await request('setup/complete', { setupComplete: true })).statusCode).toBe(401);
  });
  it('does not let removed lock endpoints change access or reveal private data', async () => {
    await enroll();
    for (const path of ['lock', 'unlock/options', 'unlock', 'preferences'])
      expect((await request(path, {})).statusCode).toBe(404);
    expect((await request('status')).json()).toMatchObject({ paired: true });
    expect((await request('status')).json()).not.toHaveProperty('requireUnlock');
  });
  it('keeps different approved browsers independent and rejects missing or forged tokens', async () => {
    const first = await enroll(),
      firstCookies = { ...cookies };
    cookies = {};
    const second = await enroll();
    access.revoke(first.deviceId);
    expect(access.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId: second.deviceId,
    });
    cookies = firstCookies;
    expect((await remote.inject({ url: '/api/snapshot', headers: headers() })).statusCode).toBe(
      401,
    );
    cookies = { '__Host-dock_enrollment': randomBytes(32).toString('base64url') };
    expect((await remote.inject({ url: '/api/snapshot', headers: headers() })).statusCode).toBe(
      401,
    );
    expect((await request('status')).headers['set-cookie']).toBeUndefined();
  });
  it('migrates existing locked and revoked devices without requiring a fresh pairing', async () => {
    const { deviceId } = await enroll();
    const before = store.db.prepare('SELECT * FROM paired_devices').all();
    store.db.exec(`ALTER TABLE paired_devices ADD COLUMN require_unlock INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE device_unlocks(id TEXT PRIMARY KEY,device_id TEXT REFERENCES paired_devices(id),expires_at INTEGER);
      CREATE TABLE device_challenges(device_id TEXT PRIMARY KEY REFERENCES paired_devices(id),challenge TEXT);`);
    store.db.prepare('INSERT INTO device_unlocks VALUES(?,?,?)').run('expired', deviceId, 1);
    store.setSetting('phone:unlock-revision', 7);
    const restored = new PhoneAccess(store, config);
    expect(restored.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId,
      expiresAt: null,
    });
    expect(store.db.prepare('SELECT * FROM paired_devices').all()).toEqual(before);
    expect(
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('device_unlocks','device_challenges')",
        )
        .all(),
    ).toHaveLength(0);
    restored.revoke(deviceId);
    const again = new PhoneAccess(store, config);
    expect(again.pairedDevices!.session(headers().cookie)).toBeNull();
  });
});
