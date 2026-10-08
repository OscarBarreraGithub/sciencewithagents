import { expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { get, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { PhoneAccess, phoneConfigSchema } from './phone-access.js';
import { Terminals } from './terminal.js';
import { Hosts } from './hosts.js';
import type { ClusterProjects } from './cluster-projects.js';
import { createServer } from './server.js';

it('revoking a paired session closes its live cluster stream and socket without closing another device', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dock-cluster-revocation-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const origin = 'https://dock.example.test';
  const phone = new PhoneAccess(
    store,
    phoneConfigSchema.parse({ origin, authentication: 'paired', port: 4998 }),
  );
  phone.setEnabled(true);
  // Approved device credentials are fixture data; passkey enrollment has its own real-signature suite.
  const device = () => {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    store.db
      .prepare(
        `INSERT INTO paired_devices
      (id,name,browser_hash,credential_id,public_key,counter,created_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        id,
        'Fixture phone',
        createHash('sha256').update(token).digest('hex'),
        randomUUID(),
        'fixture-only',
        0,
        Date.now(),
      );
    return {
      id,
      headers: { host: 'dock.example.test', origin, cookie: `__Host-dock_enrollment=${token}` },
    };
  };
  const revoked = device(),
    retained = device();
  const projectId = randomUUID(),
    hostId = randomUUID(),
    agentId = randomUUID();
  const upstream = Fastify();
  await upstream.register(websocket);
  const upstreamSockets = new Set<WebSocket>();
  const streams = new Set<import('node:http').ServerResponse>();
  upstream.get('/api/host-info', () => ({
    hostId,
    protocolVersion: 1,
    localAuthentication: false,
  }));
  upstream.get('/api/events', (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.raw.write(': fixture connected\n\n');
    streams.add(reply.raw);
    reply.raw.once('close', () => streams.delete(reply.raw));
  });
  upstream.get(`/api/agents/${agentId}/terminal`, { websocket: true }, (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
    socket.send('ready');
    socket.on('message', (data) => socket.send(data.toString()));
  });
  upstream.addHook('preClose', async () => {
    for (const socket of upstreamSockets) socket.terminate();
    for (const stream of streams) stream.destroy();
  });
  let entry: FastifyInstance | undefined;
  let gateway: Hosts | undefined;
  const sockets: WebSocket[] = [],
    responses: IncomingMessage[] = [];
  try {
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    const port = (upstream.server.address() as { port: number }).port;
    // The only transport is this injected loopback fixture; no SSH or provider is used.
    gateway = new Hosts(root, async () => ({ port, alive: () => true, close: async () => {} }), [
      {
        id: hostId,
        label: 'Cluster fixture',
        accountLabel: 'Fixture owner',
        expectedHostId: hostId,
        sshAlias: 'unused-fixture',
        remotePort: port,
      },
    ]);
    const projects = {
      record(id: string) {
        expect(id).toBe(projectId);
        return { hostId };
      },
      runtimes: {
        gateway(id: string) {
          expect(id).toBe(projectId);
          return gateway!;
        },
      },
    } as unknown as ClusterProjects;
    entry = await createServer(store, runtime, {
      port: 4998,
      phone,
      terminals: new Terminals(runtime),
      remote: true,
      ownsRuntime: false,
      clusterProjects: projects,
    });
    await entry.listen({ host: '127.0.0.1', port: 0 });
    const entryPort = (entry.server.address() as { port: number }).port;
    const prefix = `/api/cluster/projects/${projectId}/proxy`;
    const connect = async (headers: typeof revoked.headers) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${entryPort}${prefix}/agents/${agentId}/terminal`,
        { headers },
      );
      sockets.push(socket);
      const ready = once(socket, 'message');
      await once(socket, 'open');
      expect((await ready)[0].toString()).toBe('ready');
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        get(`http://127.0.0.1:${entryPort}${prefix}/events`, { headers }, resolve).once(
          'error',
          reject,
        );
      });
      responses.push(response);
      response.on('error', () => {}); // Revocation can terminate a response mid-chunk.
      response.resume();
      expect(response.statusCode).toBe(200);
      return { socket, response };
    };
    const removed = await connect(revoked.headers),
      other = await connect(retained.headers);
    expect(streams.size).toBe(2);
    expect(upstreamSockets.size).toBe(2);
    let streamClosed = false,
      socketClosed = false;
    removed.response.once('close', () => {
      streamClosed = true;
    });
    removed.socket.once('close', () => {
      socketClosed = true;
    });
    phone.revoke(revoked.id);
    await expect.poll(() => streamClosed && socketClosed, { timeout: 1_500 }).toBe(true);
    await expect.poll(() => streams.size === 1 && upstreamSockets.size === 1).toBe(true);
    const echo = once(other.socket, 'message');
    other.socket.send('still authorized');
    expect((await echo)[0].toString()).toBe('still authorized');
    expect(other.response.destroyed).toBe(false);
    expect(phone.pairedDevices!.session(retained.headers.cookie)?.deviceId).toBe(retained.id);
    expect(
      (await entry.inject({ url: `${prefix}/snapshot`, headers: revoked.headers })).statusCode,
    ).toBe(401);
  } finally {
    for (const response of responses) response.destroy();
    for (const socket of sockets) socket.terminate();
    await entry?.close();
    await gateway?.close();
    await upstream.close();
    await runtime.close();
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
