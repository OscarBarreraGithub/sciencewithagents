import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { localRequestProof, type LocalRole } from '@dock/shared/dist/local-authorization.js';
import { ownerTerminalSessionSchema } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { OwnerTerminals } from './owner-terminal.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { PhoneAccess } from './phone-access.js';
import { Terminals } from './terminal.js';
import { createServer } from './server.js';
import { proxyPath } from './hosts.js';
import { parseCapacity } from './capacity.js';

let root: string, store: Store, runtime: Runtime, owner: OwnerTerminals, access: LocalAccess;
let app: Awaited<ReturnType<typeof createServer>>;
const port = 4999;
const origin = `http://127.0.0.1:${port}`;
const headers = { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json' };
const sockets = new Set<WebSocket>();
const launches = vi.fn(async () => {
  throw new Error('Providers are offline. No launch permitted.');
});
function authenticated(method: string, path: string, role: LocalRole = 'owner') {
  const challenge = randomBytes(32).toString('hex');
  const proof = access.proof({ role, challenge });
  return {
    ...headers,
    authorization: `Dock ${role}.${proof.nonce}.${localRequestProof(access.configuration[role], origin, role, challenge, proof.nonce, method, path)}`,
  };
}
async function open(key = randomUUID()) {
  const result = await app.inject({
    method: 'POST',
    url: '/api/owner-terminal',
    headers: authenticated('POST', '/api/owner-terminal'),
    payload: { key },
  });
  expect(result.statusCode).toBe(200);
  return ownerTerminalSessionSchema.parse(result.json());
}
async function connect(id: string) {
  let output = '',
    ready = false;
  const path = `/api/owner-terminal/${id}/socket`;
  const socket = await app.injectWS(
    path,
    { headers: authenticated('GET', path) },
    {
      onInit(client) {
        client.on('message', (raw) => {
          const value = JSON.parse(raw.toString()) as { type: string; data?: string };
          if (value.type === 'output') output += value.data;
          if (value.type === 'ready') ready = true;
        });
      },
    },
  );
  sockets.add(socket);
  await expect.poll(() => ready).toBe(true);
  return {
    socket,
    output: () => output,
    send: (data: string) => socket.send(JSON.stringify({ type: 'input', data })),
  };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'owner-terminal-'));
  store = new Store(join(root, 'dock.sqlite'));
  launches.mockClear();
  runtime = new Runtime(store, root, 'unavailable-provider', launches);
  owner = new OwnerTerminals({ shell: '/bin/sh', cwd: root, computer: 'Owned fixture computer' });
  access = new LocalAccess(prepareLocalAccess(root, port));
  for (const provider of ['codex', 'claude'] as const) {
    const now = Date.now();
    store.setSetting(
      `capacity:v1:${provider}`,
      parseCapacity(
        provider,
        [
          {
            provider,
            source: 'oauth',
            usage: {
              updatedAt: new Date(now).toISOString(),
              primary: {
                usedPercent: 100,
                windowMinutes: 300,
                resetsAt: new Date(now + 3600000).toISOString(),
              },
            },
          },
        ],
        now,
      ),
    );
  }
  app = await createServer(store, runtime, {
    port,
    localAccess: access,
    ownerTerminals: owner,
    ownsRuntime: false,
  });
});
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  owner.close();
  await app.close();
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('runs a real owner shell with both allowances at zero, retaining cwd/output across reconnect without replaying input', async () => {
  expect(runtime.capacity.status().providers.every((p) => p.windows[0]?.usedPercent === 100)).toBe(
    true,
  );
  const key = randomUUID();
  const session = await open(key);
  expect((await open(key)).id).toBe(session.id);
  const first = await connect(session.id);
  first.send("printf 'once\\n' >> marker; printf 'READY_%s\\n' \"$PWD\"\r");
  await expect.poll(first.output).toContain(`READY_${root}`);
  first.socket.close();
  await expect.poll(() => first.socket.readyState).toBe(WebSocket.CLOSED);
  const second = await connect(session.id);
  await expect.poll(second.output).toContain(`READY_${root}`);
  second.send("printf 'STILL_HERE\\n'\r");
  await expect.poll(second.output).toContain('STILL_HERE\r\n');
  expect(readFileSync(join(root, 'marker'), 'utf8')).toBe('once\n');
  expect(launches).not.toHaveBeenCalled();
  expect(store.agents()).toHaveLength(0);
  expect(store.runs()).toHaveLength(0);
});

it('rejects unauthenticated/foreign-origin requests, executable/path input and non-owner bridge credentials', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/owner-terminal',
        headers,
        payload: { key: randomUUID() },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/owner-terminal',
        headers: {
          ...authenticated('POST', '/api/owner-terminal'),
          origin: 'https://foreign.example.test',
        },
        payload: { key: randomUUID() },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/owner-terminal',
        headers: authenticated('POST', '/api/owner-terminal', 'bridge'),
        payload: { key: randomUUID() },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/owner-terminal',
        headers: authenticated('POST', '/api/owner-terminal'),
        payload: { key: randomUUID(), shell: '/bin/sh', cwd: '/tmp' },
      })
    ).statusCode,
  ).toBe(400);
  const session = await open();
  await expect(
    app.injectWS(`/api/owner-terminal/${session.id}/socket`, { headers }),
  ).rejects.toThrow();
  await expect(
    app.injectWS(`/api/owner-terminal/${session.id}/socket`, {
      headers: {
        ...authenticated('GET', `/api/owner-terminal/${session.id}/socket`),
        origin: 'https://foreign.example.test',
      },
    }),
  ).rejects.toThrow();
});

it('transfers input ownership explicitly and rejects malformed input without running it', async () => {
  const session = await open();
  const first = await connect(session.id);
  const second = await connect(session.id);
  await expect.poll(() => first.socket.readyState).toBe(WebSocket.CLOSED);
  second.socket.send(
    JSON.stringify({ type: 'input', data: "printf 'bad' > invalid", executable: '/bin/sh' }),
  );
  await expect.poll(() => second.socket.readyState).toBe(WebSocket.CLOSED);
  expect(() => readFileSync(join(root, 'invalid'))).toThrow();
});

it('closes the owned shell idempotently, leaves other shells alive and never opens one on a socket read', async () => {
  const first = await open(),
    second = await open();
  const path = `/api/owner-terminal/${first.id}/close`;
  for (let n = 0; n < 2; n++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: authenticated('POST', path),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  expect(owner.read(first.id).status).toBe('exited');
  expect(owner.read(second.id).status).toBe('running');
  const remaining = await connect(second.id);
  remaining.send("printf 'OTHER_ALIVE\\n'\r");
  await expect.poll(remaining.output).toContain('OTHER_ALIVE\r\n');
  const unknown = `/api/owner-terminal/${randomUUID()}`;
  expect(
    (await app.inject({ url: unknown, headers: authenticated('GET', unknown) })).statusCode,
  ).toBe(404);
  expect(launches).not.toHaveBeenCalled();
});

it('allows a verified phone session through the same shell and revokes its socket without replay or shell cancellation', async () => {
  const phone = new PhoneAccess(store, {
    origin: 'https://dock.example.test',
    authentication: 'access',
    issuer: 'https://owner.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    owner: 'owner@example.test',
    port: 4998,
  });
  phone.setEnabled(true);
  const identity = {
    email: 'owner@example.test',
    subject: 'fixture-phone',
    expiresAt: Date.now() + 60000,
  };
  vi.spyOn(phone, 'identity').mockResolvedValue(identity);
  const code = phone.issueCode(randomUUID()).code;
  const paired = phone.pair(identity, { code, name: 'Owned test phone' });
  const native = new Terminals(runtime);
  const remote = await createServer(store, runtime, {
    port: 4998,
    phone,
    terminals: native,
    ownerTerminals: owner,
    remote: true,
    ownsRuntime: false,
  });
  const h = {
    host: 'dock.example.test',
    origin: 'https://dock.example.test',
    'content-type': 'application/json',
    cookie: paired.cookie.split(';')[0],
    'cf-access-jwt-assertion': 'fixture-only',
  };
  try {
    const created = await remote.inject({
      method: 'POST',
      url: '/api/owner-terminal',
      headers: h,
      payload: { key: randomUUID() },
    });
    expect(created.statusCode).toBe(200);
    const session = ownerTerminalSessionSchema.parse(created.json());
    const client = await remote.injectWS(`/api/owner-terminal/${session.id}/socket`, {
      headers: h,
    });
    sockets.add(client);
    const deviceId = (store.db.prepare('SELECT id FROM phone_devices').get() as { id: string }).id;
    phone.revoke(deviceId);
    await expect.poll(() => client.readyState).toBe(WebSocket.CLOSED);
    expect(owner.read(session.id).status).toBe('running');
    expect(
      (
        await remote.inject({
          method: 'POST',
          url: '/api/owner-terminal',
          headers: h,
          payload: { key: randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await remote.close();
    native.close();
  }
});

it('allows only exact selected-computer shell routes, with no query/path/executable escape', () => {
  const id = randomUUID();
  expect(proxyPath('POST', '/owner-terminal')).toBe('/api/owner-terminal');
  expect(proxyPath('GET', `/owner-terminal/${id}`)).toBe(`/api/owner-terminal/${id}`);
  expect(proxyPath('GET', `/owner-terminal/${id}/socket`, true)).toBe(
    `/api/owner-terminal/${id}/socket`,
  );
  expect(proxyPath('POST', `/owner-terminal/${id}/close`)).toBe(`/api/owner-terminal/${id}/close`);
  for (const path of [
    `/owner-terminal/${id}/socket?command=echo`,
    `/owner-terminal/${id}/socket/extra`,
    '/owner-terminal/../socket',
    '/owner-terminal/%2f/socket',
  ])
    expect(proxyPath('GET', path, true)).toBeNull();
  expect(proxyPath('POST', '/owner-terminal?cwd=/tmp')).toBeNull();
});
