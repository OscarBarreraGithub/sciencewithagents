import { modelFixture } from './model-policy.fixture.js';
import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { Terminals } from './terminal.js';
import { PhoneAccess, phoneConfigSchema } from './phone-access.js';
import { createServer } from './server.js';
import { repoRoot } from './paths.js';

it.each([
  { state: 'locked', ready: true, status: 401 },
  { state: 'starting', ready: false, status: 503 },
])(
  'closes a real refused upgrade while $state without starting a terminal or provider',
  async ({ ready, status: expectedStatus }) => {
    mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
    const root = mkdtempSync(join(repoRoot, 'data/tests/rejected-upgrade-'));
    const store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const runtime = new Runtime(store, root, 'codex');
    const terminals = new Terminals(runtime);
    const origin = 'https://dock.example.test';
    const phone = new PhoneAccess(
      store,
      phoneConfigSchema.parse({ origin, authentication: 'paired', port: 4987 }),
    );
    phone.setEnabled(true);
    const app = await createServer(store, runtime, {
      port: 4987,
      phone,
      terminals,
      remote: true,
      ownsRuntime: false,
      ready: () => ready,
    });
    const sockets = new Set<Socket>();
    app.server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    let client: Socket | undefined;
    let closing: Promise<void> | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected a local TCP listener.');
      const headers = {
        host: 'dock.example.test',
        origin,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        cookie: '__Host-dock_enrollment=forged; __Host-dock_unlock=forged',
      };
      const privateRead = await app.inject({
        url: '/api/snapshot',
        headers: { host: 'dock.example.test', origin },
      });
      expect(privateRead.statusCode).toBe(expectedStatus);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path: `/api/agents/${randomUUID()}/terminal`,
            headers,
            agent: false,
          },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          },
        );
        request.once('upgrade', (_response, socket) => {
          socket.destroy();
          reject(new Error('Locked entry unexpectedly upgraded.'));
        });
        request.once('error', reject);
        request.setTimeout(2000, () =>
          request.destroy(new Error('Local rejected upgrade timed out.')),
        );
        request.end();
      });
      expect(status).toBe(expectedStatus);
      client = connect(address.port, '127.0.0.1');
      client.on('error', () => {});
      const response = new Promise<string>((resolve) =>
        client!.once('data', (chunk) => resolve(chunk.toString())),
      );
      client.write(
        `GET /api/agents/${randomUUID()}/terminal HTTP/1.1\r\n${Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n')}\r\n\r\n`,
      );
      expect(await response).toContain(`HTTP/1.1 ${expectedStatus}`);
      await expect.poll(() => client!.destroyed, { timeout: 1500 }).toBe(true);
      expect(runtime.clients.size).toBe(0);
      expect(store.runs()).toHaveLength(0);
      expect(app.websocketServer.clients.size).toBe(0);
      closing = app.close();
      await expect(
        Promise.race([closing.then(() => 'closed'), delay(1500, 'timeout')]),
      ).resolves.toBe('closed');
    } finally {
      client?.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.race([closing ?? app.close(), delay(2000)]);
      terminals.close();
      await runtime.close();
      if (store.db.isOpen) store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
