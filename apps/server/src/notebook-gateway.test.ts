import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.js';
import { PhoneAccess } from './phone-access.js';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { NotebookGateway, notebookConfigSchema, notebookLifetimes } from './notebook-gateway.js';
import { freeLoopbackPort, type NotebookConnection } from './cluster-notebooks.js';

const origin = 'https://notebooks.example.test',
  jobId = '50593230';
let upstream: Server, gateway: NotebookGateway, port: number, connection: NotebookConnection;
let valid: boolean,
  opened: boolean,
  watcher: (() => void) | undefined,
  phoneChange: (() => void) | undefined;
let observed: {
  path?: string;
  headers?: typeof import('node:http').IncomingMessage.prototype.headers;
};
let now: number, isolated: boolean;
const issuer = () => ({
  id: 'phone:owned-fixture',
  valid: () => valid,
  watch: (close: () => void) => {
    phoneChange = close;
    return () => {
      phoneChange = undefined;
    };
  },
});
const call = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
  new Promise<{
    status: number;
    body: string;
    headers: typeof import('node:http').IncomingMessage.prototype.headers;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Host: new URL(origin).host,
          ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
          ...extra,
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: text, headers: response.headers }),
        );
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
async function launch(delegated = false) {
  const input = { key: randomUUID(), jobId },
    result = await gateway.launch(
      input,
      delegated ? { id: 'host', delegated: true, valid: () => true } : issuer(),
    );
  return { input, result, secret: new URL(result.url).hash.slice(1) };
}
async function claim(secret: string) {
  const result = await call('/_gateway/claim', 'POST', { secret });
  expect(result.status).toBe(200);
  return result.headers['set-cookie']![0].split(';')[0];
}
beforeEach(async () => {
  now = Date.now();
  isolated = true;
  valid = true;
  opened = true;
  observed = {};
  phoneChange = undefined;
  upstream = createServer((request, response) => {
    observed = { path: request.url, headers: request.headers };
    response.setHeader('Set-Cookie', [
      '_xsrf=xsrf-fixture; Path=/; Domain=example.test',
      '__Host-dock_device=bad; Path=/; Domain=example.test',
    ]);
    if (request.url?.endsWith('/malformed')) {
      response.writeHead(302, { Location: 'http://[' });
      response.end();
    } else if (request.url?.endsWith('/redirect')) {
      response.writeHead(302, { Location: `/notebooks/${jobId}/lab` });
      response.end();
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"native":');
      setTimeout(() => response.end('true}'), 5);
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw Error();
  connection = {
    notebook: {
      alias: 'hpc',
      jobId,
      node: 'node201',
      localPort: address.port,
      remotePort: 6818,
      openedAt: new Date().toISOString(),
      baseUrl: `/notebooks/${jobId}/`,
    },
    token: 'native-notebook-token-fixture',
    baseUrl: `/notebooks/${jobId}/`,
  };
  port = await freeLoopbackPort();
  gateway = new NotebookGateway(
    { origin, port },
    {
      connect: async () => connection,
      isOpen: () => opened,
      watch: (change) => {
        watcher = change;
        return () => {
          watcher = undefined;
        };
      },
    },
    () => true,
    () => now,
    undefined,
    () => isolated,
  );
  await gateway.listen(['https://dock.example.test']);
});
afterEach(async () => {
  await gateway.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

it('uses a one-use fragment handoff and strips every app credential while streaming native HTTP', async () => {
  const pending = await launch();
  expect(new URL(pending.result.url).search).toBe('');
  expect(pending.result.url).not.toContain(connection.token);
  expect(await gateway.launch(pending.input, issuer())).toEqual(pending.result);
  const bootstrap = await call('/launch');
  expect(bootstrap.body).toContain("history.replaceState(null, '', '/launch')");
  expect(bootstrap.body).not.toContain(pending.secret);
  const cookie = await claim(pending.secret);
  expect((await call('/_gateway/claim', 'POST', { secret: pending.secret })).status).toBe(409);
  await expect(gateway.launch(pending.input, issuer())).rejects.toThrow('fresh link');
  const response = await call(
    `${connection.baseUrl}api?token=browser-token`,
    'POST',
    {},
    {
      Cookie: `${cookie}; _xsrf=xsrf-fixture; __Host-dock_device=owner-phone-secret; swa_local_test=owner-secret`,
      Authorization: 'Dock owner-secret',
      'cf-access-jwt-assertion': 'access-secret',
      'X-Dock-Target-Host': 'host-secret',
      'X-XSRFToken': 'xsrf-fixture',
    },
  );
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ native: true });
  expect(observed.path).toBe(`${connection.baseUrl}api`);
  expect(observed.headers).toMatchObject({
    authorization: `token ${connection.token}`,
    cookie: '_xsrf=xsrf-fixture',
    origin: `http://127.0.0.1:${connection.notebook.localPort}`,
  });
  expect(JSON.stringify(observed)).not.toMatch(
    /owner-phone-secret|owner-secret|access-secret|host-secret|browser-token/,
  );
  expect(response.headers['set-cookie']).toEqual([
    `_xsrf=xsrf-fixture; Path=${connection.baseUrl}; Secure; SameSite=Strict`,
  ]);
  expect(
    (await call(`${connection.baseUrl}redirect`, 'GET', undefined, { Cookie: cookie })).headers
      .location,
  ).toBe(`${origin}${connection.baseUrl}lab`);
});

it('rejects foreign origins, hosts, cookie-free tokens and paths outside the opened job', async () => {
  const { secret } = await launch();
  expect(
    (await call('/_gateway/claim', 'POST', { secret }, { Origin: 'https://dock.example.test' }))
      .status,
  ).toBe(403);
  const cookie = await claim(secret);
  for (const path of [
    '/api/snapshot',
    '/notebooks/999/lab',
    `${connection.baseUrl}%2e%2e/lab`,
    `${connection.baseUrl}%2fapi`,
  ])
    expect((await call(path, 'GET', undefined, { Cookie: cookie })).status).toBe(401);
  expect(
    (
      await call(
        `${connection.baseUrl}api`,
        'POST',
        {},
        { Cookie: cookie, Origin: 'https://dock.example.test' },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(`${connection.baseUrl}api`, 'GET', undefined, {
        Cookie: cookie,
        Host: 'dock.example.test',
      })
    ).status,
  ).toBe(403);
  expect((await call(`${connection.baseUrl}lab?token=${connection.token}`)).status).toBe(401);
});

it('expires unclaimed handoffs and rejects old templates without breaking local access', async () => {
  const pending = await launch();
  now += notebookLifetimes.handoffMs;
  expect((await call('/_gateway/claim', 'POST', { secret: pending.secret })).status).toBe(409);
  await expect(gateway.launch(pending.input, issuer())).rejects.toThrow('fresh link');
  connection.baseUrl = '/';
  await expect(launch()).rejects.toThrow('current notebook template');
});

it('proxies actual WebSocket upgrades, binary frames and native close codes, then closes on phone removal', async () => {
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, request) => {
    observed = { path: request.url, headers: request.headers };
    socket.on('message', (data, binary) => socket.send(data, { binary }));
  });
  const cookie = await claim((await launch()).secret);
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${connection.baseUrl}api/kernels/fixture/channels?token=native-client-token`,
    'fixture',
    { headers: { Host: new URL(origin).host, Origin: origin, Cookie: cookie } },
  );
  await once(socket, 'open');
  const message = once(socket, 'message');
  socket.send(Buffer.from([0, 255, 1]));
  expect((await message)[0]).toEqual(Buffer.from([0, 255, 1]));
  expect(socket.protocol).toBe('fixture');
  expect(observed.path).not.toContain('token=');
  expect(observed.headers?.authorization).toBe(`token ${connection.token}`);
  const closed = once(socket, 'close');
  valid = false;
  phoneChange?.();
  await closed;
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(401);
  wss.close();
});

it('revokes on target closure and bounds delegated source crashes or failed revokes to90 seconds', async () => {
  const pending = await launch(true),
    cookie = await claim(pending.secret);
  now += 60_000;
  gateway.renew({ key: pending.input.key });
  now += 60_000;
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(200);
  now += 30_000;
  gateway.sweep();
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(401);
  await expect(
    Promise.resolve().then(() => gateway.renew({ key: pending.input.key })),
  ).rejects.toThrow('fresh link');
  const localCookie = await claim((await launch()).secret);
  opened = false;
  watcher?.();
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: localCookie })).status,
  ).toBe(401);
});

it('keeps an unavailable optional listener separate and rejects app-hostname sharing', async () => {
  await gateway.close();
  gateway = new NotebookGateway(
    { origin, port: connection.notebook.localPort },
    { connect: async () => connection, isOpen: () => true, watch: () => () => {} },
  );
  await gateway.listen();
  expect(gateway.status().remoteAvailable).toBe(false);
  expect(upstream.listening).toBe(true);
  await expect(launch()).rejects.toThrow('could not start');
  await gateway.close();
  gateway = new NotebookGateway(
    { origin, port },
    { connect: async () => connection, isOpen: () => true, watch: () => () => {} },
  );
  await gateway.listen([`${origin}:4331`]);
  expect(gateway.status().remoteAvailable).toBe(false);
  expect(
    notebookConfigSchema.safeParse({ origin: 'http://notebooks.example.test', port }).success,
  ).toBe(false);
});

it('returns a safe error for a malformed native redirect and remains available', async () => {
  const cookie = await claim((await launch()).secret);
  expect(
    (await call(`${connection.baseUrl}malformed`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(502);
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(200);
});

it('uses real PhoneAccess.watch to close scoped access when the source device is revoked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-phone-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const phone = new PhoneAccess(store, {
    origin: 'https://dock.example.test',
    authentication: 'access',
    issuer: 'https://owner.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    owner: 'owner@example.test',
    port: 4331,
  });
  try {
    phone.setEnabled(true);
    const identity = {
      email: 'owner@example.test',
      subject: 'owned-phone',
      expiresAt: Date.now() + 60_000,
    };
    const code = phone.issueCode(randomUUID()).code;
    phone.pair(identity, { code, name: 'Owned fixture phone' });
    const deviceId = (store.db.prepare('SELECT id FROM phone_devices').get() as { id: string }).id;
    const session = { ...identity, deviceId };
    const result = await gateway.launch(
      { key: randomUUID(), jobId },
      {
        id: deviceId,
        valid: () => phone.valid(session),
        watch: (close) => phone.watch(session, close),
      },
    );
    const cookie = await claim(new URL(result.url).hash.slice(1));
    expect(
      (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
    ).toBe(200);
    phone.revoke(deviceId);
    expect(
      (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
    ).toBe(401);
  } finally {
    await gateway.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('revokes already-open kernel sockets when later phone setup loses hostname isolation', async () => {
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)));
  const cookie = await claim((await launch()).secret);
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${connection.baseUrl}api/kernels/fixture/channels`,
    {
      headers: { Host: new URL(origin).host, Origin: origin, Cookie: cookie },
    },
  );
  await once(socket, 'open');
  const closed = once(socket, 'close');
  isolated = false;
  gateway.sweep();
  await closed;
  expect(gateway.status().remoteAvailable).toBe(false);
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(403);
  isolated = true;
  expect(
    (await call(`${connection.baseUrl}api`, 'GET', undefined, { Cookie: cookie })).status,
  ).toBe(401);
  wss.close();
});
