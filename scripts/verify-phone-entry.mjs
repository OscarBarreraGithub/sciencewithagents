import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { Terminals } from '../apps/server/dist/terminal.js';
import { createServer } from '../apps/server/dist/server.js';
import { PhoneAccess, readPhoneConfig } from '../apps/server/dist/phone-access.js';
import { PhoneTunnel } from '../apps/server/dist/phone-tunnel.js';

// No provider login, owner database, pairing, account API, token output or model turn.
// --public temporarily starts only the configured app-owned named connector.
if (!process.argv.includes('--run')) throw new Error('Pass --run for a bounded entry check.');
process.umask(0o077);
const data = resolve('data');
const config = readPhoneConfig(data);
assert.equal(config?.authentication, 'paired', 'Explicit paired configuration required.');
mkdirSync(join(data, 'checks'), { recursive: true });
const fixture = mkdtempSync(join(data, 'checks', 'phone-entry-'));
console.log(`Owned phone entry check PID ${process.pid}; disposable fixture: ${fixture}`);
const store = new Store(join(fixture, 'dock.sqlite'));
const runtime = new Runtime(store, fixture, 'codex');
const phone = new PhoneAccess(store, config);
const terminals = new Terminals(runtime);
const tunnel = new PhoneTunnel(phone, data);
let app;
try {
  phone.setEnabled(true);
  app = await createServer(store, runtime, {
    port: config.port,
    webDir: resolve('apps/web/dist'),
    phone,
    terminals,
    remote: true,
    ownsRuntime: false,
  });
  const host = new URL(config.origin).host;
  const privatePaths = [
    '/api/snapshot',
    '/api/events',
    '/api/attention',
    '/api/scheduler',
    '/api/host-info',
    '/api/hosts',
    '/api/frontdesk',
    `/api/workspace/${randomUUID()}`,
    `/api/hosts/${randomUUID()}/proxy/api/snapshot`,
    `/api/agents/${randomUUID()}/export`,
    `/api/agents/${randomUUID()}/recovery`,
    `/api/agents/${randomUUID()}/images/${randomUUID()}`,
    '/api/%73napshot',
  ];
  for (const path of privatePaths) {
    for (const extra of [
      {},
      {
        cookie: '__Host-dock_enrollment=forged; __Host-dock_unlock=forged',
        'cf-access-jwt-assertion': 'forged',
      },
    ]) {
      const response = await app.inject({ url: path, headers: { host, ...extra } });
      assert.equal(response.statusCode, 401, path);
    }
  }
  const privatePosts = [
    '/api/workspace/clients',
    '/api/frontdesk/start',
    '/api/frontdesk/settings',
    `/api/projects/${randomUUID()}/history`,
    `/api/projects/${randomUUID()}/catalog`,
  ];
  for (const path of privatePosts) {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { host, origin: config.origin },
      payload: {},
    });
    assert.equal(response.statusCode, 401, path);
  }
  const plaintext = await app.inject({ url: '/', headers: { host, 'x-forwarded-proto': 'http' } });
  assert.equal(plaintext.statusCode, 308);
  assert.equal(plaintext.headers.location, `${config.origin}/`);
  const socket = await app.inject({
    url: `/api/agents/${randomUUID()}/terminal`,
    headers: {
      host,
      origin: config.origin,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  });
  assert.equal(socket.statusCode, 401);
  console.log(
    'Local paired boundary passed: missing/forged credentials, all private surfaces, encoded path, socket, HTTP redirect.',
  );
  if (process.argv.includes('--public')) {
    await app.listen({ host: '127.0.0.1', port: config.port });
    tunnel.start();
    const until = Date.now() + 90_000;
    while (phone.connection !== 'connected' && Date.now() < until) {
      if (phone.connection === 'error') throw new Error('Named connector needs attention.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(phone.connection, 'connected');
    // Allow bounded edge configuration propagation, never interpret Access redirect as success.
    let status;
    while (Date.now() < until) {
      const response = await fetch(`${config.origin}/api/phone/status`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (
        response.status === 200 &&
        response.headers.get('content-type')?.includes('application/json')
      ) {
        status = await response.json();
        break;
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(status?.authentication, 'paired');
    assert.equal(status?.enrollmentOpen, false);
    assert.equal(status?.paired, false);
    assert.equal(status?.devices?.length, 0);
    for (const path of privatePaths) {
      const response = await fetch(`${config.origin}${path}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          cookie: '__Host-dock_enrollment=forged; __Host-dock_unlock=forged',
          'cf-access-jwt-assertion': 'forged',
        },
      });
      assert.equal(response.status, 401, `Public ${path}`);
      await response.body?.cancel();
    }
    for (const path of privatePosts) {
      const response = await fetch(`${config.origin}${path}`, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: { origin: config.origin, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 401, `Public mutation ${path}`);
      await response.body?.cancel();
    }
    const upgrade = await new Promise((resolve, reject) => {
      const request = httpsRequest(
        `${config.origin}/api/agents/${randomUUID()}/terminal`,
        {
          agent: false,
          headers: {
            origin: config.origin,
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-version': '13',
            cookie: '__Host-dock_enrollment=forged; __Host-dock_unlock=forged',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
          response.once('error', reject);
        },
      );
      request.once('upgrade', (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      request.once('error', reject);
      request.setTimeout(8000, () => request.destroy(new Error('Public socket check timed out.')));
      request.end();
    });
    assert.equal(upgrade, 401, 'Real HTTPS terminal upgrade must be refused while locked.');
    const http = await fetch(`${config.origin.replace('https:', 'http:')}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    assert([301, 302, 307, 308].includes(http.status), 'Plain HTTP must redirect.');
    assert.equal(new URL(http.headers.get('location'), config.origin).origin, config.origin);
    await http.body?.cancel();
    const wrong = await fetch(`${config.origin}/api/phone/enroll/options`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'AAAAAAAAAAAAAAAA', name: 'Not a device' }),
    });
    assert([400, 409].includes(wrong.status), 'Closed enrollment must refuse.');
    await wrong.body?.cancel();
    console.log(
      'Real HTTPS entry passed: no account redirect; closed enrollment; private reads, mutations and real socket upgrade denied; HTTP redirected; wrong code refused. Physical phone acceptance remains separate.',
    );
  }
} finally {
  await tunnel.close();
  await app?.close();
  terminals.close();
  await runtime.close();
  store.close();
  rmSync(fixture, { recursive: true, force: true });
  console.log('Owned check server/connector closed; disposable check database removed.');
}
