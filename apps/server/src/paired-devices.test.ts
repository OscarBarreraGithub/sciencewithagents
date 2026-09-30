import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
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
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }),
    id = randomBytes(32),
    credentialId = id.toString('base64url');
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
  let counter = 0;
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
    authenticate(challenge: string, targetOrigin = origin, uv = true) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authData = Buffer.concat([
        digest('dock.example.test'),
        Buffer.from([uv ? 5 : 1]),
        count,
      ]);
      const client = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge,
          origin: targetOrigin,
          crossOrigin: false,
        }),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: sign('sha256', Buffer.concat([authData, digest(client)]), privateKey).toString(
            'base64url',
          ),
          userHandle: null,
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
async function unlock(auth: ReturnType<typeof authenticator>) {
  const options = await request('unlock/options', {});
  expect(options.statusCode).toBe(200);
  const response = await request('unlock', auth.authenticate(options.json().challenge));
  expect(response.statusCode, response.body).toBe(200);
  return response;
}

describe('permanent device enrollment and separate unlock', () => {
  it('retains enrolled phones and their unlocks through unavailable setup without allowing remote access', async () => {
    const { auth, deviceId } = await enroll();
    await unlock(auth);
    await request('preferences', { requireUnlock: false, setupComplete: true });
    const devices = store.db.prepare('SELECT * FROM paired_devices').all();
    const unlocks = store.db.prepare('SELECT * FROM device_unlocks').all();
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
    expect(store.db.prepare('SELECT * FROM device_unlocks').all()).toEqual(unlocks);
    const restarted = new PhoneAccess(store, config);
    expect(restarted.pairedDevices!.session(headers().cookie)).toMatchObject({ deviceId });
  });

  it('migrates unchanged legacy configuration and retains verified phones across transport-only edits', async () => {
    const { auth, deviceId } = await enroll();
    await unlock(auth);
    await request('preferences', { requireUnlock: false, setupComplete: true });
    const devices = store.db.prepare('SELECT * FROM paired_devices').all();
    const unlocks = store.db.prepare('SELECT * FROM device_unlocks').all();
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
    expect(store.db.prepare('SELECT * FROM device_unlocks').all()).toEqual(unlocks);
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
  it('does not resurrect an unlock that was verifying when access was locked or paused', async () => {
    const { auth } = await enroll();
    for (const pause of [
      () => access.pairedDevices!.lock(headers().cookie),
      () => {
        access.setEnabled(false);
        access.setEnabled(true);
      },
    ]) {
      const options = (await request('unlock/options', {})).json();
      const verification = access.pairedDevices!.unlock(
        auth.authenticate(options.challenge),
        headers().cookie,
      );
      pause();
      await expect(verification).rejects.toThrow('access changed');
      expect(access.pairedDevices!.session(headers().cookie)).toBeNull();
      expect(access.pairedDevices!.status(true, headers().cookie).enrolled).toBe(true);
    }
  });
  it('denies private APIs, cookies without an unlock, forged Access headers and all remote administration', async () => {
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
    const { auth } = await enroll();
    expect((await request('status')).json()).toMatchObject({ enrolled: true, paired: false });
    expect((await remote.inject({ url: '/api/snapshot', headers: headers() })).statusCode).toBe(
      401,
    );
    const result = await unlock(auth);
    expect(String(result.headers['set-cookie'])).toContain('Secure; HttpOnly; SameSite=Strict');
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
    expect((await request('unlock/options', {})).statusCode).toBe(409);
  });
  it('rejects wrong origin, missing user verification, signature tampering and assertion replay', async () => {
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
    const { auth } = await enroll();
    for (const [target, uv] of [
      ['https://evil.test', true],
      [origin, false],
    ] as const) {
      const options = (await request('unlock/options', {})).json();
      expect(
        (await request('unlock', auth.authenticate(options.challenge, target, uv))).statusCode,
      ).toBe(409);
    }
    let options = (await request('unlock/options', {})).json();
    const forged = auth.authenticate(options.challenge);
    forged.response.signature = randomBytes(64).toString('base64url');
    expect((await request('unlock', forged)).statusCode).toBe(409);
    options = (await request('unlock/options', {})).json();
    const response = auth.authenticate(options.challenge);
    expect((await request('unlock', response)).statusCode).toBe(200);
    expect((await request('unlock', response)).statusCode).toBe(409);
  });
  it('preserves enrollment through unlock expiry, lock, off/on and database restart without permanent secrets in the archive', async () => {
    const { auth, code, deviceId } = await enroll();
    await unlock(auth);
    const enrollment = cookies.__Host_dock_enrollment ?? cookies['__Host-dock_enrollment'];
    const saved = JSON.stringify({
      settings: store.db.prepare('SELECT * FROM settings').all(),
      devices: store.db.prepare('SELECT * FROM paired_devices').all(),
      unlocks: store.db.prepare('SELECT * FROM device_unlocks').all(),
      events: store.events(),
    });
    expect(saved).not.toContain(enrollment);
    expect(saved).not.toContain(cookies['__Host-dock_unlock']);
    expect(saved).not.toContain(code.replaceAll('-', ''));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 366 * 24 * 60 * 60 * 1000);
    expect(access.pairedDevices!.status(true, headers().cookie).enrolled).toBe(true);
    expect(access.pairedDevices!.session(headers().cookie)).toBeNull();
    vi.useRealTimers();
    await request('lock', {});
    expect((await request('status')).json()).toMatchObject({ enrolled: true, paired: false });
    await unlock(auth);
    access.setEnabled(false);
    access.setEnabled(true);
    expect((await request('status')).json()).toMatchObject({ enrolled: true, paired: false });
    await remote.close();
    await local.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const restored = new PhoneAccess(store, config);
    expect(restored.pairedDevices!.status(true, headers().cookie).enrolled).toBe(true);
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
    const { auth } = await enroll();
    await unlock(auth);
    for (const changes of [
      { origin: 'https://evil.test' },
      { 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect(
        (
          await remote.inject({
            method: 'POST',
            url: '/api/phone/lock',
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
  it.each(['lock', 'remember', 'requireUnlock'] as const)(
    '%s closes existing event and terminal sockets without revoking the phone or stopping the agent',
    async (action) => {
      const { auth, deviceId } = await enroll();
      await unlock(auth);
      if (action === 'requireUnlock')
        expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(200);
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
        if (action === 'lock') await request('lock', {});
        else
          expect(
            (await request('preferences', { requireUnlock: action === 'requireUnlock' }))
              .statusCode,
          ).toBe(200);
        await Promise.all([ended, closed]);
        expect(access.status(false).devices[0]).toMatchObject({ id: deviceId, revokedAt: null });
        expect((await request('status')).json()).toMatchObject({
          enrolled: true,
          paired: action !== 'lock',
        });
      } finally {
        response?.destroy();
        socket.terminate();
      }
    },
  );
});

describe('device-local repeat verification preferences', () => {
  it('rejects an HTTP preference update when its previously admitted session changed during body parsing', async () => {
    let changeDuringRequest: (() => void) | undefined;
    remote.addHook('preValidation', async (incoming) => {
      if (incoming.url === '/api/phone/preferences') {
        const change = changeDuringRequest;
        changeDuringRequest = undefined;
        change?.();
      }
    });
    const { auth } = await enroll();
    await unlock(auth);
    changeDuringRequest = () => {
      access.pairedDevices!.preferences({ requireUnlock: false }, headers().cookie);
    };
    expect((await request('preferences', { requireUnlock: true })).statusCode).toBe(409);
    expect((await request('status')).json()).toMatchObject({ paired: true, requireUnlock: false });
    expect((await request('preferences', { requireUnlock: true })).statusCode).toBe(200);
    changeDuringRequest = () => {
      access.pairedDevices!.lock(headers().cookie);
    };
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(409);
    expect((await request('status')).json()).toMatchObject({ paired: false, requireUnlock: true });
    expect(store.db.prepare('SELECT * FROM device_unlocks').all()).toHaveLength(0);
  });
  it('defaults safely and requires this approved phone to be currently unlocked with same-origin JSON', async () => {
    expect((await request('status')).json()).toMatchObject({
      requireUnlock: true,
      setupComplete: false,
    });
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(401);
    const { auth } = await enroll();
    expect((await request('status')).json()).toMatchObject({
      enrolled: true,
      paired: false,
      requireUnlock: true,
      setupComplete: false,
    });
    expect(
      (await request('preferences', { requireUnlock: false, setupComplete: true })).statusCode,
    ).toBe(401);
    expect((await request('preferences', { requireUnlock: false }, local)).statusCode).toBe(403);
    await unlock(auth);
    for (const body of [
      { requireUnlock: 'false' },
      { requireUnlock: false, deviceId: randomUUID() },
      { setupComplete: true },
    ])
      expect((await request('preferences', body)).statusCode).toBe(400);
    for (const changes of [
      { origin: 'https://evil.test' },
      { 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect(
        (
          await remote.inject({
            method: 'POST',
            url: '/api/phone/preferences',
            headers: { ...headers(), ...changes },
            payload: JSON.stringify({ requireUnlock: false }),
          })
        ).statusCode,
      ).toBe(403);
    expect((await request('status')).json()).toMatchObject({
      paired: true,
      requireUnlock: true,
      setupComplete: false,
    });
  });

  it('remembers a verified phone across time and database restart and renews only its browser retention', async () => {
    const { auth, code, deviceId } = await enroll();
    await unlock(auth);
    const originalToken = cookies['__Host-dock_unlock'];
    const saved = await request('preferences', { requireUnlock: false, setupComplete: true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      paired: true,
      requireUnlock: false,
      setupComplete: true,
      devices: [],
    });
    expect(cookies['__Host-dock_unlock']).toBe(originalToken);
    expect(String(saved.headers['set-cookie'])).toContain(
      'Secure; HttpOnly; SameSite=Strict; Max-Age=34560000',
    );
    expect(access.pairedDevices!.session(headers().cookie)).toMatchObject({
      deviceId,
      expiresAt: null,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 366 * 24 * 60 * 60_000);
    const status = await request('status');
    expect(status.json()).toMatchObject({
      paired: true,
      enrolled: true,
      requireUnlock: false,
      setupComplete: true,
    });
    expect(String(status.headers['set-cookie'])).toContain(`__Host-dock_unlock=${originalToken};`);
    expect((await request('status', undefined, local)).json()).toMatchObject({
      requireUnlock: true,
      setupComplete: false,
    });
    expect(Object.keys(access.status(false).devices[0])).not.toContain('requireUnlock');
    const persisted = JSON.stringify({
      devices: store.db.prepare('SELECT * FROM paired_devices').all(),
      unlocks: store.db.prepare('SELECT * FROM device_unlocks').all(),
      events: store.events(),
    });
    expect(persisted).not.toContain(originalToken);
    expect(persisted).not.toContain(cookies['__Host-dock_enrollment']);
    expect(persisted).not.toContain(code.replaceAll('-', ''));
    await remote.close();
    await local.close();
    store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const restored = new PhoneAccess(store, config);
    expect(restored.pairedDevices!.status(true, headers().cookie)).toMatchObject({
      requireUnlock: false,
      setupComplete: true,
    });
    const session = restored.pairedDevices!.session(headers().cookie)!;
    expect(session).toMatchObject({ deviceId, expiresAt: null });
    expect(restored.valid(session)).toBe(true);
  });

  it('never promotes an expired short unlock, including revalidation after earlier request admission', async () => {
    const { auth } = await enroll();
    await unlock(auth);
    const session = access.pairedDevices!.session(headers().cookie)!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(session.expiresAt!);
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(401);
    expect(() =>
      access.pairedDevices!.preferences({ requireUnlock: false }, headers().cookie, session),
    ).toThrow('Unlock sciencewithagents');
    const status = await request('status');
    expect(status.json()).toMatchObject({
      paired: false,
      enrolled: true,
      requireUnlock: true,
      setupComplete: false,
    });
    expect(String(status.headers['set-cookie'])).not.toContain('__Host-dock_unlock=');
    expect(store.db.prepare('SELECT remembered FROM device_unlocks').get()).toMatchObject({
      remembered: 0,
    });
  });

  it('closes stale session watchers in both directions without giving remembered sessions an expiry timer', async () => {
    const { auth } = await enroll();
    await unlock(auth);
    vi.useFakeTimers();
    const phone = access.pairedDevices!;
    const short = phone.session(headers().cookie)!;
    const shortClosed = vi.fn();
    const stopShort = access.watch(short, shortClosed);
    phone.preferences({ requireUnlock: false }, headers().cookie, short);
    expect(shortClosed).toHaveBeenCalledTimes(1);
    stopShort();
    const remembered = phone.session(headers().cookie)!;
    const rememberedClosed = vi.fn();
    const stopRemembered = access.watch(remembered, rememberedClosed);
    vi.advanceTimersByTime(30 * 24 * 60 * 60_000);
    expect(rememberedClosed).not.toHaveBeenCalled();
    expect(phone.valid(remembered)).toBe(true);
    phone.preferences({ requireUnlock: true }, headers().cookie, remembered);
    expect(rememberedClosed).toHaveBeenCalledTimes(1);
    stopRemembered();
    const bounded = phone.session(headers().cookie)!;
    expect(bounded.expiresAt).toBe(Date.now() + 15 * 60_000);
    const boundedClosed = vi.fn();
    const stopBounded = access.watch(bounded, boundedClosed);
    vi.advanceTimersByTime(60_000);
    phone.preferences({ requireUnlock: true, setupComplete: true }, headers().cookie, bounded);
    expect(phone.session(headers().cookie)!.expiresAt).toBe(bounded.expiresAt);
    expect(boundedClosed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(14 * 60_000);
    expect(boundedClosed).toHaveBeenCalledTimes(1);
    expect(phone.session(headers().cookie)).toBeNull();
    stopBounded();
  });

  it('keeps lost-ack retries valid but rejects an older admitted request after an intervening preference change', async () => {
    const { auth } = await enroll();
    await unlock(auth);
    vi.useFakeTimers({ toFake: ['Date'] });
    const phone = access.pairedDevices!;
    const originalCookies = headers().cookie;
    const admitted = phone.session(originalCookies)!;
    vi.setSystemTime(admitted.expiresAt! - 15 * 60_000);
    phone.preferences({ requireUnlock: false }, originalCookies, admitted); // Ignore Set-Cookie / lost response.
    const first = phone.session(originalCookies)!;
    phone.preferences({ requireUnlock: false }, originalCookies, first);
    expect(phone.session(originalCookies)).toEqual(first);
    phone.preferences({ requireUnlock: true }, originalCookies, first);
    const changedBack = phone.session(originalCookies)!;
    expect(changedBack.expiresAt).toBe(admitted.expiresAt);
    expect(changedBack.unlockRevision).not.toBe(admitted.unlockRevision);
    expect(() => phone.preferences({ requireUnlock: false }, originalCookies, admitted)).toThrow(
      'Unlock sciencewithagents',
    );
    expect(phone.session(originalCookies)).toEqual(changedBack);
    vi.setSystemTime(Date.now() + 60_000);
    phone.preferences({ requireUnlock: true }, originalCookies, changedBack);
    expect(phone.session(originalCookies)).toEqual(changedBack);
  });

  it('manual lock, off/on and revocation end remembered access without status or old cookies recreating it', async () => {
    const { auth, deviceId } = await enroll();
    await unlock(auth);
    await request('preferences', { requireUnlock: false, setupComplete: true });
    const replay = { ...cookies };
    const admitted = access.pairedDevices!.session(headers().cookie)!;
    await request('lock', {});
    cookies = replay;
    expect(() =>
      access.pairedDevices!.preferences({ requireUnlock: false }, headers().cookie, admitted),
    ).toThrow('Unlock sciencewithagents');
    let status = await request('status');
    expect(status.json()).toMatchObject({
      paired: false,
      enrolled: true,
      requireUnlock: false,
      setupComplete: true,
    });
    expect(String(status.headers['set-cookie'])).not.toContain('__Host-dock_unlock=');
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(401);
    await unlock(auth);
    expect(access.pairedDevices!.session(headers().cookie)!.expiresAt).toBeNull();
    access.setEnabled(false);
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(503);
    access.setEnabled(true);
    expect((await request('status')).json()).toMatchObject({
      paired: false,
      enrolled: true,
      requireUnlock: false,
      setupComplete: true,
    });
    await unlock(auth);
    access.revoke(deviceId);
    status = await request('status');
    expect(status.json()).toMatchObject({
      paired: false,
      enrolled: false,
      requireUnlock: true,
      setupComplete: false,
    });
    expect(status.headers['set-cookie']).toBeUndefined();
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(401);
    expect(store.db.prepare('SELECT * FROM device_unlocks').all()).toHaveLength(0);
  });

  it('fences in-flight passkey verification when preferences change', async () => {
    const { auth } = await enroll();
    await unlock(auth);
    const options = (await request('unlock/options', {})).json();
    const unlocking = access.pairedDevices!.unlock(
      auth.authenticate(options.challenge),
      headers().cookie,
    );
    access.pairedDevices!.preferences({ requireUnlock: false }, headers().cookie);
    await expect(unlocking).rejects.toThrow('Device access changed');
    expect(access.pairedDevices!.session(headers().cookie)!.expiresAt).toBeNull();
  });

  it('isolates another approved device and never prunes its remembered session when this phone unlocks', async () => {
    const first = await enroll();
    await unlock(first.auth);
    await request('preferences', { requireUnlock: false, setupComplete: true });
    const firstCookies = { ...cookies };
    const firstSession = access.pairedDevices!.session(headers().cookie)!;
    cookies = {};
    const second = await enroll();
    await unlock(second.auth);
    expect((await request('status')).json()).toMatchObject({
      requireUnlock: true,
      setupComplete: false,
    });
    expect(access.valid(firstSession)).toBe(true);
    const secondToken = cookies['__Host-dock_unlock'];
    cookies = { ...firstCookies, '__Host-dock_unlock': secondToken };
    expect(access.pairedDevices!.session(headers().cookie)).toBeNull();
    expect((await request('preferences', { requireUnlock: false })).statusCode).toBe(401);
    cookies = firstCookies;
    expect((await request('status')).json()).toMatchObject({
      paired: true,
      requireUnlock: false,
      setupComplete: true,
    });
  });

  it('migrates old enrollments and short unlock rows additively, without promoting expired or inconsistent rows', async () => {
    const { auth } = await enroll();
    await unlock(auth);
    const device = store.db.prepare('SELECT * FROM paired_devices').get()!;
    const session = store.db.prepare('SELECT * FROM device_unlocks').get()!;
    const legacy = new Store(join(root, 'legacy.sqlite'));
    modelFixture(legacy);
    try {
      legacy.db.exec(`CREATE TABLE paired_devices (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,browser_hash TEXT NOT NULL UNIQUE,
        credential_id TEXT NOT NULL UNIQUE,public_key TEXT NOT NULL,counter INTEGER NOT NULL,
        created_at INTEGER NOT NULL,revoked_at INTEGER);
        CREATE TABLE device_unlocks (id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES paired_devices(id),token_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL);`);
      legacy.db
        .prepare(
          'INSERT INTO paired_devices(id,name,browser_hash,credential_id,public_key,counter,created_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          device.id,
          device.name,
          device.browser_hash,
          device.credential_id,
          device.public_key,
          device.counter,
          device.created_at,
          device.revoked_at,
        );
      legacy.db
        .prepare('INSERT INTO device_unlocks(id,device_id,token_hash,expires_at) VALUES(?,?,?,?)')
        .run(session.id, session.device_id, session.token_hash, session.expires_at);
      const migrated = new PairedDevices(
        legacy,
        origin,
        () => true,
        () => {},
      );
      expect(migrated.status(true, headers().cookie)).toMatchObject({
        enrolled: true,
        requireUnlock: true,
        setupComplete: false,
      });
      expect(migrated.session(headers().cookie)).toMatchObject({
        unlockId: session.id,
        expiresAt: session.expires_at,
        unlockRevision: 0,
      });
      expect(
        legacy.db.prepare('SELECT credential_id,public_key,counter FROM paired_devices').get(),
      ).toMatchObject({
        credential_id: device.credential_id,
        public_key: device.public_key,
        counter: device.counter,
      });
      legacy.db.prepare('UPDATE device_unlocks SET expires_at=?').run(Date.now() - 1);
      const restarted = new PairedDevices(
        legacy,
        origin,
        () => true,
        () => {},
      );
      expect(restarted.session(headers().cookie)).toBeNull();
      legacy.db.exec('UPDATE paired_devices SET require_unlock=0');
      expect(restarted.session(headers().cookie)).toBeNull();
      expect(() => restarted.preferences({ requireUnlock: false }, headers().cookie)).toThrow(
        'Unlock sciencewithagents',
      );
      legacy.db.exec(
        'UPDATE device_unlocks SET remembered=1,expires_at=0; UPDATE paired_devices SET require_unlock=1',
      );
      expect(restarted.session(headers().cookie)).toBeNull();
      expect(legacy.db.prepare('SELECT COUNT(*) AS count FROM paired_devices').get()!.count).toBe(
        1,
      );
    } finally {
      legacy.close();
    }
  });
});
