import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Agent, get, globalAgent, type IncomingMessage } from 'node:http';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {
  agentDetailQuerySchema,
  hostConnectionsSchema,
  managedGoalActionSchema,
  type HostConnection,
} from '@dock/shared';
import {
  assertDedicatedForward,
  Hosts,
  proxyPath,
  readHostConfig,
  registerHostRoutes,
  sshArguments,
} from './hosts.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { WorkspaceState } from './workspace-state.js';
import { createServer } from './server.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';

type Fixture = {
  app: FastifyInstance;
  hostId: string;
  config: HostConnection;
  writes: unknown[];
  headers: Record<string, unknown>[];
  closed: number;
  eventsClosed: number;
  terminals: Set<WebSocket>;
  modelMode: 'json' | 'redirect' | 'html' | 'auth' | 'drop';
  access?: LocalAccess;
};
let fixtures: Fixture[], gateway: FastifyInstance, hosts: Hosts, root: string;
let watchers: Map<string, Set<() => void>>;
const agentId = randomUUID();
const queuedId = randomUUID();
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dock-hosts-'));
  fixtures = [];
  for (const label of ['Personal computer', 'School computer', 'Parents’ computer']) {
    const app = Fastify();
    await app.register(websocket);
    const fixture: Fixture = {
      app,
      hostId: randomUUID(),
      config: {} as HostConnection,
      writes: [],
      headers: [],
      closed: 0,
      eventsClosed: 0,
      terminals: new Set(),
      modelMode: 'json',
    };
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers.host !== `127.0.0.1:${fixture.config.remotePort}`)
        return reply.code(403).send({ error: 'Only the exact app host is allowed.' });
      if (
        fixture.access &&
        !['/api/host-info', '/api/local-access/proof'].includes(request.url.split('?')[0]) &&
        fixture.access.authenticate(request.headers.authorization, request.method, request.url) !==
          'host'
      )
        return reply.code(401).send({ error: 'Host authentication required.' });
    });
    app.get('/api/host-info', () => ({
      hostId: fixture.hostId,
      protocolVersion: 1,
      localAuthentication: !!fixture.access,
    }));
    app.get('/api/local-access/proof', (request) => fixture.access?.proof(request.query));
    app.get('/api/snapshot', (request, reply) => {
      fixture.headers.push(request.headers);
      reply.header('Set-Cookie', 'private-provider-cookie=secret');
      reply.header('CF-Access-Jwt-Assertion', 'secret');
      return { label, messages: fixture.writes };
    });
    app.get('/api/pulsar/jobs/:id', (request) => {
      fixture.headers.push(request.headers);
      return { label, runId: (request.params as { id: string }).id };
    });
    app.get(`/api/documents/${agentId}/pdf`, (_request, reply) =>
      reply
        .type('application/pdf')
        .header('Set-Cookie', 'private=secret')
        .send(Buffer.from('%PDF-1.4\n' + label)),
    );
    app.post('/api/cluster/notebooks/launch', (request) => {
      fixture.writes.push({ notebookAction: 'launch', body: request.body });
      return { jobId: '50593230', url: 'https://notebooks.example.test/launch#fixture' };
    });
    for (const action of ['renew', 'revoke']) {
      app.post(`/api/cluster/notebooks/${action}`, (request) => {
        fixture.writes.push({ notebookAction: action, body: request.body });
        return { accepted: true };
      });
    }
    app.post('/api/chat-files', (request) => {
      fixture.headers.push(request.headers);
      fixture.writes.push({ upload: request.body });
      return { id: agentId, name: 'notes.tex', size: 12, mimeType: 'text/plain' };
    });
    app.get(`/api/chat-files/${agentId}/info`, () => ({
      id: agentId,
      name: 'notes.tex',
      size: 12,
      mimeType: 'text/plain',
    }));
    app.get(`/api/chat-files/${agentId}`, (request, reply) => {
      fixture.headers.push(request.headers);
      return reply
        .type('application/octet-stream')
        .header('Content-Disposition', 'attachment; filename="notes.tex"')
        .header('Set-Cookie', 'private=secret')
        .send(Buffer.from('File on ' + label));
    });
    app.get('/api/project-options', () => ({ canChooseFolder: true, folderBrowser: true }));
    app.get('/api/project-folders', () => ({
      current: { id: agentId, name: label, canSelect: true },
      parentId: null,
      folders: [],
      nextOffset: null,
    }));
    app.post('/api/projects/connect-folder', (request) => {
      fixture.writes.push(request.body);
      return { project: null };
    });
    let visibility: Record<string, unknown> | null = null;
    app.get('/api/conversations/visibility', (request) => {
      fixture.headers.push(request.headers);
      return { records: visibility ? [visibility] : [], nextCursor: null };
    });
    app.post('/api/conversations/visibility', (request) => {
      fixture.writes.push(request.body);
      fixture.headers.push(request.headers);
      const body = request.body as { target: unknown; expectedRevision: number; archived: boolean };
      const updatedAt = new Date().toISOString();
      visibility = {
        id: randomUUID(),
        target: body.target,
        revision: body.expectedRevision + 1,
        archived: body.archived,
        archivedAt: body.archived ? updatedAt : null,
        updatedAt,
        provider: 'codex',
        source: 'app',
        title: 'Fixture chat',
        caption: label,
      };
      return visibility;
    });
    app.get('/api/models', (_request, reply) => {
      if (fixture.modelMode === 'drop') {
        reply.raw.destroy();
        return reply;
      }
      if (fixture.modelMode === 'redirect')
        return reply.redirect('https://never-fetch.example.test/');
      if (fixture.modelMode === 'html')
        return reply.type('text/html').send('<script>private</script>');
      if (fixture.modelMode === 'auth') return reply.code(401).send({ error: 'private login' });
      return [];
    });
    app.post(`/api/agents/${agentId}/messages`, (request) => {
      fixture.headers.push(request.headers);
      fixture.writes.push(request.body);
      return { saved: true };
    });
    app.post(`/api/agents/${agentId}/queued/${queuedId}`, (request) => {
      fixture.headers.push(request.headers);
      fixture.writes.push(request.body);
      return { held: true };
    });
    // The receiving routes parse their own typed query/body; these echo what arrived.
    app.get(`/api/agents/${agentId}`, (request) => {
      fixture.headers.push(request.headers);
      return { hostId: fixture.hostId, query: agentDetailQuerySchema.parse(request.query) };
    });
    app.get(`/api/agents/${agentId}/goal`, (request) => {
      fixture.headers.push(request.headers);
      return { hostId: fixture.hostId, goal: null };
    });
    app.post(`/api/agents/${agentId}/goal`, (request) => {
      fixture.headers.push(request.headers);
      const action = managedGoalActionSchema.parse(request.body);
      fixture.writes.push({ goal: action });
      return { hostId: fixture.hostId, goal: action };
    });
    app.get('/api/events', (request, reply) => {
      fixture.headers.push(request.headers);
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('id: 12\nevent: change\ndata: {}\n\n');
      reply.raw.once('close', () => {
        fixture.eventsClosed++;
      });
    });
    app.post('/api/owner-terminal', (request) => {
      fixture.headers.push(request.headers);
      fixture.writes.push(request.body);
      return { id: queuedId, computer: label };
    });
    app.get(`/api/owner-terminal/${queuedId}`, (request) => {
      fixture.headers.push(request.headers);
      return { id: queuedId, computer: label };
    });
    app.post(`/api/owner-terminal/${queuedId}/close`, (request) => {
      fixture.headers.push(request.headers);
      fixture.writes.push({ close: request.body });
      return { ok: true };
    });
    app.get(`/api/owner-terminal/${queuedId}/socket`, { websocket: true }, (socket, request) => {
      fixture.headers.push(request.headers);
      fixture.terminals.add(socket);
      socket.once('close', () => fixture.terminals.delete(socket));
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (data) => {
        fixture.writes.push(JSON.parse(data.toString()));
        socket.send(JSON.stringify({ type: 'output', data: label }));
      });
    });
    app.get(`/api/agents/${agentId}/terminal`, { websocket: true }, (socket, request) => {
      fixture.headers.push(request.headers);
      fixture.terminals.add(socket);
      socket.once('close', () => fixture.terminals.delete(socket));
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (data) => {
        fixture.writes.push(JSON.parse(data.toString()));
        socket.send(JSON.stringify({ type: 'output', data: `${label}: ${data.toString()}` }));
      });
    });
    app.addHook('preClose', async () => {
      for (const socket of fixture.terminals) socket.terminate();
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    fixture.config = {
      id: randomUUID(),
      label,
      accountLabel: label.split(' ')[0],
      expectedHostId: fixture.hostId,
      sshAlias: `dock-${fixtures.length}`,
      remotePort: (app.server.address() as { port: number }).port,
    };
    fixtures.push(fixture);
  }
  hosts = new Hosts(
    root,
    async (host) => {
      const fixture = fixtures.find((item) => item.config.id === host.id)!;
      return {
        port: fixture.config.remotePort,
        alive: () => true,
        async close() {
          fixture.closed++;
        },
      };
    },
    fixtures.map((fixture) => fixture.config),
  );
  gateway = Fastify();
  await gateway.register(websocket, { options: { maxPayload: 32_768 } });
  watchers = new Map();
  registerHostRoutes(gateway, hosts, {
    watch(request, close) {
      const scope = String(request.headers['x-test-device'] ?? 'local');
      const set = watchers.get(scope) ?? new Set();
      watchers.set(scope, set);
      set.add(close);
      return () => set.delete(close);
    },
  });
});
afterEach(async () => {
  await gateway.close();
  await hosts.close();
  for (const fixture of fixtures) await fixture.app.close();
  rmSync(root, { recursive: true, force: true });
});
const path = (index: number, suffix: string) =>
  `/api/hosts/${fixtures[index].config.id}/proxy${suffix}`;
const privateHeaders = {
  cookie: 'entry-phone-cookie=secret',
  authorization: 'Bearer secret',
  'cf-access-jwt-assertion': 'private-cloud-token',
  'x-forwarded-for': '192.0.2.1',
  'x-forwarded-host': 'entry.example.test',
  origin: 'https://entry.example.test',
};
function checkHeaders(index: number) {
  const expected = `127.0.0.1:${fixtures[index].config.remotePort}`;
  for (const sent of fixtures[index].headers) {
    expect(sent.host).toBe(expected);
    expect(sent.origin).toBe(`http://${expected}`);
    expect(sent['x-dock-target-host']).toBe(fixtures[index].config.expectedHostId);
    for (const name of Object.keys(privateHeaders).filter((key) => key !== 'origin'))
      expect(sent[name]).toBeUndefined();
    expect(sent['x-test-device']).toBeUndefined();
  }
}

describe('isolated computer connections', () => {
  it('reuses a private cluster pipe while checking fresh proofs and identity before every write', async () => {
    const fixture = fixtures[0];
    fixture.access = new LocalAccess(prepareLocalAccess(root, fixture.config.remotePort));
    const config = { ...fixture.config, credential: fixture.access.configuration.host };
    const agent = new Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 24 });
    const connections = new Set<unknown>();
    const challenges: string[] = [];
    let identities = 0;
    const observe = (request: IncomingMessage) => {
      connections.add(request.socket);
      if (request.url?.startsWith('/api/local-access/proof?')) challenges.push(request.url);
      if (request.url === '/api/host-info') identities++;
    };
    fixture.app.server.on('request', observe);
    const pooled = new Hosts(
      root,
      async () => ({
        port: config.remotePort,
        connectionStartTimeoutMs: 15_000,
        agent,
        alive: () => true,
        close: async () => agent.destroy(),
      }),
      [config],
    );
    const write = async (key: string) => {
      const response = await pooled.forward(config.id, 'POST', `/api/agents/${agentId}/messages`, {
        key,
        text: 'Owned fixture input',
      });
      for await (const _chunk of response) {
        /* Fully release the pooled connection. */
      }
    };
    try {
      await write(randomUUID());
      await write(randomUUID());
      expect(connections.size).toBe(1);
      expect(identities).toBe(3); // Initial connection plus both independent write guards.
      expect(challenges).toHaveLength(5);
      expect(new Set(challenges).size).toBe(challenges.length);
      expect(fixture.writes).toHaveLength(2);
      fixture.hostId = randomUUID();
      await expect(write(randomUUID())).rejects.toThrow('different sciencewithagents workspace');
      expect(fixture.writes).toHaveLength(2);
      expect(connections.size).toBe(1);
      await vi.waitFor(() => {
        expect(Object.keys(agent.sockets)).toHaveLength(0);
        expect(Object.keys(agent.freeSockets)).toHaveLength(0);
      });
    } finally {
      await pooled.close();
      agent.destroy();
      fixture.app.server.off('request', observe);
    }
  });

  it.each(['match', 'wrong-host', 'wrong-credential'] as const)(
    'checks identity and peer proof through delayed native connections (%s)',
    async (identity) => {
      const fixture = fixtures[0];
      fixture.access = new LocalAccess(prepareLocalAccess(root, fixture.config.remotePort));
      const config = { ...fixture.config, credential: fixture.access.configuration.host };
      if (identity === 'wrong-host') fixture.hostId = randomUUID();
      if (identity === 'wrong-credential') config.credential = '0'.repeat(64);
      const sockets = new Set<ReturnType<typeof createConnection>>();
      const pending = new Set<Promise<void>>();
      const forward = createTcpServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        // Each fresh HTTP connection pays native ownership + srun startup latency.
        const ready = delay(5200).then(() => {
          if (socket.destroyed) return;
          const upstream = createConnection(fixture.config.remotePort, '127.0.0.1');
          sockets.add(upstream);
          upstream.once('close', () => sockets.delete(upstream));
          upstream.on('error', () => socket.destroy());
          socket.pipe(upstream).pipe(socket);
        });
        pending.add(ready);
        void ready.finally(() => pending.delete(ready));
      });
      forward.listen(0, '127.0.0.1');
      await once(forward, 'listening');
      const port = (forward.address() as { port: number }).port;
      const delayed = new Hosts(
        root,
        async () => ({
          port,
          connectionStartTimeoutMs: 15_000,
          alive: () => true,
          close: async () => {},
        }),
        [config],
      );
      try {
        if (identity === 'wrong-host') {
          await expect(delayed.connection(config.id)).rejects.toThrow(
            'different sciencewithagents workspace',
          );
        } else if (identity === 'wrong-credential') {
          await expect(delayed.connection(config.id)).rejects.toThrow(
            'could not authenticate its saved connection',
          );
        } else {
          await delayed.connection(config.id);
          expect(delayed.status().hosts[0].status).toBe('connected');
        }
        expect(fixture.writes).toEqual([]);
      } finally {
        await delayed.close();
        for (const socket of sockets) socket.destroy();
        await Promise.all(pending);
        await new Promise<void>((resolve) => forward.close(() => resolve()));
      }
    },
    20_000,
  );

  it('waits for a cold authenticated tunnel and preserves the destination Host on a different port', async () => {
    const fixture = fixtures[0];
    fixture.access = new LocalAccess(prepareLocalAccess(root, fixture.config.remotePort));
    const config = { ...fixture.config, credential: fixture.access.configuration.host };
    const reservation = createTcpServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const sockets = new Set<ReturnType<typeof createConnection>>();
    const forward = createTcpServer((socket) => {
      const upstream = createConnection(fixture.config.remotePort, '127.0.0.1');
      for (const peer of [socket, upstream]) {
        sockets.add(peer);
        peer.on('close', () => sockets.delete(peer));
        peer.on('error', () => {
          socket.destroy();
          upstream.destroy();
        });
      }
      socket.pipe(upstream).pipe(socket);
    });
    let ready: Promise<void> = Promise.resolve();
    const authenticated = new Hosts(root, async () => {
      ready = delay(250).then(async () => {
        forward.listen(port, '127.0.0.1');
        await once(forward, 'listening');
      });
      return { port, alive: () => true, close: async () => {} };
    }, [config]);
    try {
      const response = await authenticated.forward(config.id, 'GET', '/api/snapshot');
      expect(response.statusCode).toBe(200);
      response.resume();
      await once(response, 'end');
      expect(authenticated.status().hosts[0].status).toBe('connected');
      expect(fixture.headers[0].host).toBe(`127.0.0.1:${fixture.config.remotePort}`);
      expect(fixture.headers[0].authorization).toMatch(/^Dock host\./);
      expect(fixture.writes).toEqual([]);
    } finally {
      await authenticated.close();
      await ready;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => forward.close(() => resolve()));
    }
  });

  it('authenticates protected host reads, writes, streams and sockets without forwarding entry credentials', async () => {
    const fixture = fixtures[0];
    fixture.access = new LocalAccess(prepareLocalAccess(root, fixture.config.remotePort));
    const protectedConfig = { ...fixture.config, credential: fixture.access.configuration.host };
    const authenticated = new Hosts(
      root,
      async () => ({
        port: fixture.config.remotePort,
        alive: () => true,
        close: async () => {},
      }),
      [protectedConfig],
    );
    const entry = Fastify();
    await entry.register(websocket);
    registerHostRoutes(entry, authenticated);
    try {
      const snapshot = await entry.inject({ url: path(0, '/snapshot'), headers: privateHeaders });
      expect(snapshot.statusCode).toBe(200);
      const sent = await entry.inject({
        method: 'POST',
        url: path(0, `/agents/${agentId}/messages`),
        headers: { ...privateHeaders, 'content-type': 'application/json' },
        payload: { text: 'An authenticated host request' },
      });
      expect(sent.statusCode).toBe(200);
      expect(fixture.writes).toEqual([{ text: 'An authenticated host request' }]);
      const stream = await authenticated.forward(
        protectedConfig.id,
        'GET',
        '/api/events',
        undefined,
        undefined,
        '11',
      );
      expect(stream.statusCode).toBe(200);
      expect(String((await once(stream, 'data'))[0])).toContain('id: 12');
      stream.destroy();
      await entry.listen({ host: '127.0.0.1', port: 0 });
      const socket = new WebSocket(
        `ws://127.0.0.1:${(entry.server.address() as { port: number }).port}${path(0, `/agents/${agentId}/terminal`)}`,
        { origin: 'http://127.0.0.1' },
      );
      try {
        expect(JSON.parse(String((await once(socket, 'message'))[0]))).toEqual({ type: 'ready' });
        socket.send(JSON.stringify({ type: 'input', data: 'retained terminal input' }));
        expect(JSON.parse(String((await once(socket, 'message'))[0])).data).toContain(
          'retained terminal input',
        );
      } finally {
        const closed = once(socket, 'close');
        socket.close();
        await closed;
      }
      for (const sent of fixture.headers) {
        expect(sent.authorization).toMatch(/^Dock host\./);
        expect(JSON.stringify(sent)).not.toContain(protectedConfig.credential);
        expect(sent.cookie).toBeUndefined();
        expect(sent['cf-access-jwt-assertion']).toBeUndefined();
      }
      expect(JSON.stringify(authenticated.status())).not.toContain(protectedConfig.credential);
      expect(JSON.stringify(authenticated.status())).not.toContain('credential');
    } finally {
      await entry.close();
      await authenticated.close();
    }
  });

  it('refuses missing and mismatched host credentials before forwarding a private body', async () => {
    const fixture = fixtures[0];
    fixture.access = new LocalAccess(prepareLocalAccess(root, fixture.config.remotePort));
    await expect(
      hosts.forward(fixture.config.id, 'POST', `/api/agents/${agentId}/messages`, {
        text: 'Never forward this',
      }),
    ).rejects.toThrow('requires an authenticated connection');
    const wrong = new Hosts(
      root,
      async () => ({ port: fixture.config.remotePort, alive: () => true, close: async () => {} }),
      [{ ...fixture.config, credential: '0'.repeat(64) }],
    );
    try {
      await expect(
        wrong.forward(fixture.config.id, 'POST', `/api/agents/${agentId}/messages`, {
          text: 'Never forward this either',
        }),
      ).rejects.toThrow('authenticate');
      expect(fixture.writes).toEqual([]);
      expect(fixture.headers).toEqual([]);
    } finally {
      await wrong.close();
    }
  });

  it('requires host-only pinned configuration and safe SSH arguments without collecting credentials', () => {
    expect(readHostConfig(root)).toEqual([]);
    for (const sshAlias of ['-oProxyCommand=bad', 'a b', '../host', 'host;bad', 'host\nnext'])
      expect(hostConnectionsSchema.safeParse([{ ...fixtures[0].config, sshAlias }]).success).toBe(
        false,
      );
    expect(
      hostConnectionsSchema.safeParse([{ ...fixtures[0].config, expectedHostId: undefined }])
        .success,
    ).toBe(false);
    const file = join(root, 'hosts.json');
    writeFileSync(file, JSON.stringify([fixtures[0].config]), { mode: 0o600 });
    expect(readHostConfig(root)).toEqual([fixtures[0].config]);
    chmodSync(file, 0o644);
    expect(() => readHostConfig(root)).toThrow('private');
    const args = sshArguments(fixtures[0].config, 54321);
    for (const value of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'ExitOnForwardFailure=yes',
      'ForwardAgent=no',
      'PermitLocalCommand=no',
      'ControlPath=none',
    ])
      expect(args).toContain(value);
    expect(args).toContain(`127.0.0.1:54321:127.0.0.1:${fixtures[0].config.remotePort}`);
    expect(args.slice(-2)).toEqual(['--', fixtures[0].config.sshAlias]);
    const effective = `localforward [127.0.0.1]:54321 [127.0.0.1]:${fixtures[0].config.remotePort}`;
    expect(() => assertDedicatedForward(effective, fixtures[0].config, 54321)).not.toThrow();
    for (const extra of [
      'remoteforward 9000 localhost:9000',
      'dynamicforward 9999',
      'localforward [0.0.0.0]:9000 [127.0.0.1]:4330',
    ])
      expect(() =>
        assertDedicatedForward(`${effective}\n${extra}`, fixtures[0].config, 54321),
      ).toThrow('dedicated');
  });

  it('keeps three hosts separate even when agent IDs and retry keys match', async () => {
    const key = randomUUID();
    for (let index = 0; index < fixtures.length; index++) {
      const result = await gateway.inject({
        method: 'POST',
        url: path(index, `/agents/${agentId}/messages`),
        headers: { ...privateHeaders, 'content-type': 'application/json' },
        payload: { key, text: `Only host ${index}` },
      });
      expect(result.statusCode).toBe(200);
    }
    for (let index = 0; index < fixtures.length; index++) {
      const result = await gateway.inject({
        url: path(index, '/snapshot'),
        headers: privateHeaders,
      });
      expect(result.json()).toEqual({
        label: fixtures[index].config.label,
        messages: [{ key, text: `Only host ${index}` }],
      });
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(result.headers['cf-access-jwt-assertion']).toBeUndefined();
      checkHeaders(index);
    }
    const state = (await gateway.inject('/api/hosts')).json();
    expect(state.hosts.map((host: { status: string }) => host.status)).toEqual([
      'connected',
      'connected',
      'connected',
    ]);
    expect(JSON.stringify(state)).not.toContain('sshAlias');
    expect(JSON.stringify(state)).not.toContain('expectedHostId');
  });

  it('allows typed native connection routes while refusing browser-selected commands and paths', () => {
    const id = randomUUID();
    for (const path of [
      '/native-connections',
      '/native-connections/launch-options',
      `/native-connections/starts/${id}`,
      `/native-connections/attachments/${id}`,
      `/native-connections/attachments/${id}/receipts/${id}`,
      `/native-connections/targets/${id}/prompts?before=${id}`,
    ])
      expect(proxyPath('GET', path)).toBe(`/api${path}`);
    for (const path of [
      '/native-connections/attach',
      '/native-connections/start',
      `/native-connections/attachments/${id}/detach`,
      `/native-connections/attachments/${id}/send`,
    ])
      expect(proxyPath('POST', path)).toBe(`/api${path}`);
    const socket = `/native-connections/attachments/${id}/socket`;
    expect(proxyPath('GET', socket, true)).toBe(`/api${socket}`);
    expect(proxyPath('GET', socket)).toBeNull();
    expect(proxyPath('GET', '/native-connections', true)).toBeNull();
    for (const [method, path] of [
      ['POST', '/native-connections/start?command=sh'],
      ['GET', '/native-connections/launch-options?path=/tmp'],
      ['POST', '/native-connections/profiles'],
      ['POST', '/native-connections/rpc'],
      ['DELETE', `/native-connections/starts/${id}`],
      ['GET', '/native-connections/starts/unknown'],
      ['GET', `/native-connections/targets/${id}/prompts?path=/tmp`],
      ['GET', `/native-connections/targets/${id}/prompts?before=${id}&before=${id}`],
    ] as const)
      expect(proxyPath(method, path)).toBeNull();
  });
  it('refuses path escapes, unknown routes and methods without forwarding any action', async () => {
    for (const invalid of [
      '/phone/code',
      '/hosts',
      '/projects/connect-folder',
      '/unknown',
      '/snapshot/../phone/status',
      '/%73napshot',
      '/snapshot%2f..%2fphone%2fstatus',
      '//snapshot',
      '/snapshot\\x',
      '/snapshot?after=1&after=2',
      '/snapshot?cursor=1',
      `/agents/${agentId}?after=1`,
      '/snapshot?url=https://wrong.test',
    ])
      expect(proxyPath('GET', invalid)).toBeNull();
    expect(proxyPath('DELETE', `/agents/${agentId}`)).toBeNull();
    expect(proxyPath('POST', '/phone/enabled')).toBeNull();
    expect(proxyPath('POST', '/work-items/tickets')).toBe('/api/work-items/tickets');
    expect(proxyPath('GET', '/work-items/tickets')).toBeNull();
    expect(proxyPath('POST', '/work-items/tickets/delete')).toBeNull();
    expect(proxyPath('GET', `/agents/${agentId}/chat-quark`)).toBe(
      `/api/agents/${agentId}/chat-quark`,
    );
    expect(proxyPath('POST', `/agents/${agentId}/chat-quark`)).toBe(
      `/api/agents/${agentId}/chat-quark`,
    );
    expect(proxyPath('POST', `/agents/${agentId}/chat-quark/worker`)).toBeNull();
    expect(proxyPath('GET', '/resources')).toBe('/api/resources');
    expect(proxyPath('GET', `/pulsar/jobs/${queuedId}`)).toBe(`/api/pulsar/jobs/${queuedId}`);
    for (const invalid of [
      '/pulsar/jobs/unknown',
      `/pulsar/jobs/${queuedId}?path=/tmp`,
      `/pulsar/jobs/${queuedId}/history`,
    ])
      expect(proxyPath('GET', invalid)).toBeNull();
    for (const path of [
      '/project-rates',
      '/conversations',
      '/work-items',
      '/archive/editors',
      `/agents/${agentId}/owner-requests`,
      `/projects/${agentId}/workflow`,
      `/projects/${agentId}/notes`,
    ])
      expect(proxyPath('GET', path)).toBe(`/api${path}`);
    expect(proxyPath('GET', `/work-items?projectId=${agentId}`)).toBe(
      `/api/work-items?projectId=${agentId}`,
    );
    expect(proxyPath('GET', '/work-items?projectId=unknown')).toBeNull();
    expect(
      proxyPath(
        'GET',
        `/agents/${agentId}/owner-requests?limit=10&includeHandled=true&cursor=c29tZQ`,
      ),
    ).toBe(`/api/agents/${agentId}/owner-requests?limit=10&includeHandled=true&cursor=c29tZQ`);
    expect(proxyPath('GET', `/agents/${agentId}/owner-requests?limit=100`)).toBeNull();
    expect(proxyPath('GET', `/agents/${agentId}/owner-requests?projectId=${agentId}`)).toBeNull();
    expect(proxyPath('GET', `/workspace/${agentId}/drafts/${agentId}/history?before=20`)).toBe(
      `/api/workspace/${agentId}/drafts/${agentId}/history?before=20`,
    );
    expect(
      proxyPath('GET', `/workspace/${agentId}/drafts/${agentId}/history?before=-2`),
    ).toBeNull();
    for (const path of [
      '/work-items',
      '/conversations',
      '/archive/search',
      '/archive/read',
      `/projects/${agentId}/workflow`,
      `/projects/${agentId}/notes`,
      `/projects/${agentId}/open-in-editor`,
    ])
      expect(proxyPath('POST', path)).toBe(`/api${path}`);
    const preflight = `/groups/documents/${agentId}/${agentId}/${'a'.repeat(64)}/preflight`;
    expect(proxyPath('POST', preflight)).toBe(`/api${preflight}`);
    expect(proxyPath('GET', preflight)).toBeNull();
    expect(proxyPath('POST', preflight + '?path=/tmp')).toBeNull();
    expect(proxyPath('POST', preflight.replace('/preflight', '/capacity/rpc'))).toBeNull();
    expect(proxyPath('GET', '/bug-reports')).toBe('/api/bug-reports');
    expect(proxyPath('POST', '/bug-reports')).toBe('/api/bug-reports');
    expect(proxyPath('GET', '/bug-reports?path=/tmp')).toBeNull();
    expect(proxyPath('GET', '/quark')).toBe('/api/quark');
    for (const action of ['settings', 'budgets', 'resume'])
      expect(proxyPath('POST', `/quark/${action}`)).toBe(`/api/quark/${action}`);
    expect(proxyPath('POST', '/quark/override')).toBeNull();
    expect(proxyPath('POST', '/resources/ask')).toBe('/api/resources/ask');
    expect(proxyPath('POST', '/resources/settings')).toBe('/api/resources/settings');
    expect(proxyPath('POST', '/resources/kill')).toBeNull();
    expect(proxyPath('GET', '/events?after=7')).toBe('/api/events?after=7');
    expect(proxyPath('GET', `/models?agentId=${agentId}&provider=claude`)).toBe(
      `/api/models?agentId=${agentId}&provider=claude`,
    );
    expect(proxyPath('GET', '/models?provider=codex')).toBe('/api/models?provider=codex');
    for (const invalid of [
      '/models?provider=other',
      '/models?provider=claude&provider=codex',
      '/models?agentId=bad',
      '/models?method=turn/start',
      '/models?provider=claude&path=/tmp',
    ])
      expect(proxyPath('GET', invalid)).toBeNull();
    expect(proxyPath('GET', `/agents/${agentId}?before=${agentId}`)).toBe(
      `/api/agents/${agentId}?before=${agentId}`,
    );
    expect(proxyPath('GET', `/projects/${agentId}/sessions?cursor=page%2Fnext`)).toBe(
      `/api/projects/${agentId}/sessions?cursor=page%2Fnext`,
    );
    expect(proxyPath('GET', `/agents/${agentId}/terminal?takeover=1`, true)).toBeNull();
    for (const suffix of ['/phone/code', '/hosts', '/snapshot%2f..%2fphone%2fstatus']) {
      expect((await gateway.inject({ url: path(0, suffix) })).statusCode).toBe(404);
    }
    expect(
      (await gateway.inject({ method: 'DELETE', url: path(0, `/agents/${agentId}`) })).statusCode,
    ).toBe(404);
    expect(fixtures.flatMap((fixture) => fixture.writes)).toEqual([]);
    expect(fixtures.flatMap((fixture) => fixture.headers)).toEqual([]);
  });

  it('reads a saved job only from the selected pinned computer', async () => {
    const saved = await gateway.inject(
      `/api/hosts/${fixtures[1].config.id}/proxy/pulsar/jobs/${queuedId}`,
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ label: 'School computer', runId: queuedId });
    expect(fixtures[0].headers).toEqual([]);
    expect(fixtures[2].headers).toEqual([]);
    expect(fixtures.flatMap((fixture) => fixture.writes)).toEqual([]);
  });
  it('keeps conversation visibility on the selected host and accepts only its exact typed queries', async () => {
    const path = '/conversations/visibility';
    const host = fixtures[1].config.id;
    const body = {
      key: randomUUID(),
      target: { kind: 'agent', agentId },
      archived: true,
      expectedRevision: 0,
    };
    const result = await gateway.inject({
      method: 'POST',
      url: `/api/hosts/${host}/proxy${path}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        cookie: 'entry-phone-cookie=never-forward',
        authorization: 'entry-credential=never-forward',
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      target: body.target,
      archived: true,
      caption: 'School computer',
    });
    expect(fixtures[0].writes).toEqual([]);
    expect(fixtures[2].writes).toEqual([]);
    expect(fixtures[1].writes).toEqual([body]);
    const page = await gateway.inject(`/api/hosts/${host}/proxy${path}?limit=100&archived=true`);
    expect(page.statusCode).toBe(200);
    expect(page.json().records[0].target).toEqual(body.target);
    expect(
      fixtures[1].headers.every(
        (headers) => !headers.cookie && headers.authorization !== 'entry-credential=never-forward',
      ),
    ).toBe(true);
    for (const valid of [
      path,
      `${path}?cursor=${agentId}&limit=1&archived=false`,
      '/conversations?includeArchived=true',
      '/vscode/windows?includeArchived=true',
    ])
      expect(proxyPath('GET', valid)).toBe(`/api${valid}`);
    for (const invalid of [
      `${path}/unknown`,
      `${path}?limit=101`,
      `${path}?cursor=unknown`,
      `${path}?limit=1&limit=2`,
      `${path}?path=/tmp`,
      '/vscode/windows?includeArchived=1',
      '/conversations?includeArchived=true&method=archive',
    ])
      expect(proxyPath('GET', invalid)).toBeNull();
    expect(proxyPath('POST', `${path}?archived=true`)).toBeNull();
  });
  it('opens a remote manager by exact detail channel and managed goal routes only', async () => {
    // Saved entry IDs are opaque (`agent:item`, `agent:claude:report:tool`) and travel encoded.
    const before = encodeURIComponent(`${agentId}:claude:report:toolu_01`);
    for (const channel of ['all', 'conversation', 'coordination'])
      for (const query of [
        `channel=${channel}`,
        `before=${before}&channel=${channel}`,
        `channel=${channel}&before=${before}`,
      ])
        expect(proxyPath('GET', `/agents/${agentId}?${query}`)).toBe(
          `/api/agents/${agentId}?${query}`,
        );
    expect(proxyPath('GET', `/agents/${agentId}/goal`)).toBe(`/api/agents/${agentId}/goal`);
    expect(proxyPath('POST', `/agents/${agentId}/goal`)).toBe(`/api/agents/${agentId}/goal`);
    for (const invalid of [
      `/agents/${agentId}?channel=private`,
      `/agents/${agentId}?channel=`,
      `/agents/${agentId}?channel=all&channel=conversation`,
      `/agents/${agentId}?before=a&before=b`,
      `/agents/${agentId}?before=`,
      `/agents/${agentId}?before=${'x'.repeat(121)}`,
      `/agents/${agentId}?channel=all&path=/tmp`,
      `/agents/${agentId}?before=a%0Ab`,
      `/agents/${agentId}?channel=all%00`,
      `/agents/${agentId}/goal?channel=all`,
      `/agents/${agentId}/goal/history`,
      `/agents/${agentId}/goals`,
      '/agents/not-an-id/goal',
    ])
      expect(proxyPath('GET', invalid)).toBeNull();
    expect(proxyPath('POST', `/agents/${agentId}/goal?action=pause`)).toBeNull();
    expect(proxyPath('POST', `/agents/${agentId}/goal/clear`)).toBeNull();
    expect(proxyPath('DELETE', `/agents/${agentId}/goal`)).toBeNull();
    expect(proxyPath('PUT', `/agents/${agentId}/goal`)).toBeNull();

    const detail = await gateway.inject({
      url: path(1, `/agents/${agentId}?channel=conversation&before=${before}`),
      headers: privateHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      hostId: fixtures[1].hostId,
      query: { before: `${agentId}:claude:report:toolu_01`, channel: 'conversation' },
    });
    const goal = await gateway.inject({ url: path(1, `/agents/${agentId}/goal`) });
    expect(goal.json()).toEqual({ hostId: fixtures[1].hostId, goal: null });
    const action = { key: randomUUID(), action: 'pause', expectedRevision: 1 };
    const saved = await gateway.inject({
      method: 'POST',
      url: path(1, `/agents/${agentId}/goal`),
      payload: action,
      headers: privateHeaders,
    });
    expect(saved.json()).toEqual({ hostId: fixtures[1].hostId, goal: action });
    expect(fixtures[1].writes).toEqual([{ goal: action }]);
    checkHeaders(1);
    for (const url of [
      path(1, `/agents/${agentId}?channel=private`),
      path(1, `/agents/${agentId}/goal?channel=all`),
    ])
      expect((await gateway.inject({ url })).statusCode).toBe(404);
    expect(fixtures[0].headers.concat(fixtures[2].headers)).toEqual([]);
    expect(fixtures[1].headers).toHaveLength(3);
  });
  it('streams a registered PDF from the selected computer without forwarding private headers', async () => {
    const response = await gateway.inject(path(1, `/documents/${agentId}/pdf`));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body).toBe('%PDF-1.4\nSchool computer');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uploads and downloads general attachments only on the selected computer', async () => {
    const payload = {
      key: randomUUID(),
      name: 'notes.tex',
      data: Buffer.from('Private fixture').toString('base64'),
    };
    const uploaded = await gateway.inject({
      method: 'POST',
      url: path(1, '/chat-files'),
      headers: privateHeaders,
      payload,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().name).toBe('notes.tex');
    expect(fixtures[1].writes).toEqual([{ upload: payload }]);
    expect(fixtures[0].writes).toEqual([]);
    expect(fixtures[2].writes).toEqual([]);
    const response = await gateway.inject({
      url: path(1, '/chat-files/' + agentId),
      headers: privateHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('notes.tex');
    expect(response.rawPayload.toString()).toBe('File on School computer');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    checkHeaders(1);
  });

  it('forwards folder browsing and selection to the selected computer only', async () => {
    expect((await gateway.inject(path(1, '/project-options'))).json()).toEqual({
      canChooseFolder: true,
      folderBrowser: true,
    });
    expect((await gateway.inject(path(1, '/project-folders'))).json().current.name).toBe(
      'School computer',
    );
    const payload = { key: randomUUID(), folderId: agentId, selectOnly: true };
    expect(
      (await gateway.inject({ method: 'POST', url: path(1, '/projects/connect-folder'), payload }))
        .statusCode,
    ).toBe(200);
    expect(fixtures.map((f) => f.writes)).toEqual([[], [payload], []]);
    expect(proxyPath('GET', `/project-folders?folderId=${agentId}&offset=100`)).toBe(
      `/api/project-folders?folderId=${agentId}&offset=100`,
    );
    expect(
      proxyPath(
        'GET',
        `/project-folders?folderId=${agentId}&query=Research&scope=descendants&hidden=true`,
      ),
    ).toBe(`/api/project-folders?folderId=${agentId}&query=Research&scope=descendants&hidden=true`);
    expect(proxyPath('GET', '/documents/browse?query=Research')).toBeNull();
    for (const query of [
      'path=/tmp',
      'folderId=bad',
      'offset=-1',
      'offset=1000001',
      'offset=0&offset=1',
      'query=a&query=b',
      'query=%00',
      'scope=everywhere',
      'hidden=yes',
    ])
      expect(proxyPath('GET', `/project-folders?${query}`)).toBeNull();
  });

  it('checks downstream identity before any body is sent, including after a replacement restart', async () => {
    await hosts.connection(fixtures[0].config.id);
    fixtures[0].hostId = fixtures[1].hostId;
    const result = await gateway.inject({
      method: 'POST',
      url: path(0, `/agents/${agentId}/messages`),
      payload: { text: 'Private school draft' },
    });
    expect(result.statusCode).toBe(502);
    expect(result.json()).toMatchObject({ code: 'HOST_UNAVAILABLE' });
    expect(result.json().error).toContain('different sciencewithagents workspace');
    expect(fixtures[0].writes).toEqual([]);
    expect(fixtures[0].closed).toBe(1);
    expect(hosts.status().hosts[0].status).toBe('error');
    fixtures[0].hostId = fixtures[0].config.expectedHostId;
    expect(
      (
        await gateway.inject({
          method: 'POST',
          url: `/api/hosts/${fixtures[0].config.id}/connect`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(fixtures[0].writes).toEqual([]); // Connect/retry never resubmits the draft.
  });

  it('keeps unavailable hosts and downstream login/redirect/HTML failures distinct from phone authentication', async () => {
    const unknown = await gateway.inject(`/api/hosts/${randomUUID()}/proxy/snapshot`);
    expect(unknown.statusCode).toBe(502);
    expect(unknown.json().code).toBe('HOST_UNAVAILABLE');
    for (const mode of ['redirect', 'html', 'auth'] as const) {
      fixtures[0].modelMode = mode;
      const response = await gateway.inject(path(0, '/models'));
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: 'HOST_UNAVAILABLE' });
      expect(response.headers.location).toBeUndefined();
      expect(response.body).not.toContain('private login');
    }
    expect((await gateway.inject('/api/hosts')).statusCode).toBe(200);
  });

  it('the actual receiving server rejects replacement between identity check and mutation on the same port', async () => {
    const apps: FastifyInstance[] = [];
    const stores: Store[] = [];
    let relay: Hosts | undefined;
    try {
      // Reuse one fixture port only after closing its owned listener; the two app databases are distinct.
      const port = fixtures[0].config.remotePort;
      await fixtures[0].app.close();
      const make = async () => {
        const directory = join(root, randomUUID());
        const store = new Store(join(directory, 'dock.sqlite'));
        modelFixture(store);
        stores.push(store);
        const runtime = new Runtime(store, directory, 'codex', async () => new DemoProvider());
        const workspace = new WorkspaceState(store);
        const app = await createServer(store, runtime, { port, demo: true });
        apps.push(app);
        await app.listen({ host: '127.0.0.1', port });
        return { app, store, hostId: workspace.hostId };
      };
      const original = await make();
      relay = new Hosts(root, async () => ({ port, alive: () => true, async close() {} }), [
        {
          ...fixtures[0].config,
          expectedHostId: original.hostId,
        },
      ]);
      const checked = relay.checked.bind(relay);
      let replacement: Awaited<ReturnType<typeof make>> | undefined;
      relay.checked = async (id) => {
        const result = await checked(id);
        await original.app.close();
        // Force this fixture's next request onto the replacement, rather than an already-closed keepalive socket.
        for (const socket of globalAgent.freeSockets[
          globalAgent.getName({ host: '127.0.0.1', port })
        ] ?? [])
          socket.destroy();
        replacement = await make();
        return result;
      };
      const response = await relay.forward(fixtures[0].config.id, 'POST', '/api/projects', {
        key: randomUUID(),
        name: 'Must not cross accounts',
        description: '',
      });
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ code: 'HOST_MISMATCH' });
      expect(replacement!.store.projects()).toEqual([]);
    } finally {
      await relay?.close();
      for (const app of apps) await app.close();
      for (const store of stores) if (store.db.isOpen) store.close();
    }
  });

  it('a dropped request exposes reconnect without replay and cancelled viewers do not invalidate the shared host', async () => {
    fixtures[0].modelMode = 'drop';
    expect((await gateway.inject(path(0, '/models'))).statusCode).toBe(502);
    expect(hosts.status().hosts[0].status).toBe('error');
    expect(fixtures[0].closed).toBe(1);
    fixtures[0].modelMode = 'json';
    expect((await gateway.inject(path(0, '/models'))).statusCode).toBe(502);
    expect(
      (
        await gateway.inject({
          method: 'POST',
          url: `/api/hosts/${fixtures[0].config.id}/connect`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await gateway.inject(path(0, '/models'))).statusCode).toBe(200);
    const abort = new AbortController();
    abort.abort();
    await expect(
      hosts.forward(fixtures[0].config.id, 'GET', '/api/snapshot', undefined, abort.signal),
    ).rejects.toThrow();
    expect(hosts.status().hosts[0].status).toBe('connected');
    expect(fixtures[0].writes).toEqual([]);
  });

  it('terminates a scoped SSE stream and upstream request when the entry phone locks', async () => {
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const port = (gateway.server.address() as { port: number }).port;
    const outgoing = get(`http://127.0.0.1:${port}${path(0, '/events?after=3')}`, {
      headers: { ...privateHeaders, 'x-test-device': 'phone', 'last-event-id': '9' },
    });
    const [response] = await once(outgoing, 'response');
    const [first] = await once(response, 'data');
    expect(first.toString()).toContain('id: 12');
    expect(fixtures[0].headers.at(-1)?.['last-event-id']).toBe('9');
    response.on('error', () => {});
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    for (const close of watchers.get('phone')!) close();
    await closed;
    await expect.poll(() => fixtures[0].eventsClosed).toBe(1);
    await expect.poll(() => watchers.get('phone')?.size).toBe(0);
    checkHeaders(0);
  });

  it('forwards terminal input once, preserves moved-control close codes and closes scoped sockets', async () => {
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const port = (gateway.server.address() as { port: number }).port;
    const connect = async (index: number) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}${path(index, `/agents/${agentId}/terminal`)}`,
        {
          headers: { ...privateHeaders, 'x-test-device': 'phone' },
        },
      );
      const ready = once(socket, 'message');
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'input', data: 'exact input' }));
      await ready;
      await expect.poll(() => fixtures[index].writes.length).toBe(1);
      return socket;
    };
    const first = await connect(0);
    const moved = once(first, 'close');
    [...fixtures[0].terminals][0].close(4001, 'Control moved');
    expect((await moved)[0]).toBe(4001);
    const second = await connect(1);
    const closed = once(second, 'close');
    for (const close of watchers.get('phone')!) close();
    await closed;
    await expect.poll(() => fixtures[1].terminals.size).toBe(0);
    expect(fixtures[0].writes).toEqual([{ type: 'input', data: 'exact input' }]);
    expect(fixtures[1].writes).toEqual([{ type: 'input', data: 'exact input' }]);
    checkHeaders(0);
    checkHeaders(1);
  });
});

it('routes queued messages to only the selected pinned host without forwarding phone credentials', async () => {
  const input = { key: randomUUID(), clientId: randomUUID(), revision: 0, action: 'edit' };
  const response = await gateway.inject({
    method: 'POST',
    url: path(1, `/agents/${agentId}/queued/${queuedId}`),
    headers: privateHeaders,
    payload: input,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ held: true });
  expect(fixtures[1].writes).toEqual([input]);
  expect(fixtures[0].writes).toEqual([]);
  expect(fixtures[2].writes).toEqual([]);
  checkHeaders(1);
});

it('tracks a selected-host notebook launch beyond its response and revokes only its receipt on source removal', async () => {
  const fixture = fixtures[0],
    key = randomUUID();
  const result = await gateway.inject({
    method: 'POST',
    url: `/api/hosts/${fixture.config.id}/proxy/cluster/notebooks/launch`,
    headers: { 'x-test-device': 'notebook-phone' },
    payload: { key, jobId: '50593230' },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().url).toMatch(/^https:\/\/notebooks\./);
  expect(watchers.get('notebook-phone')?.size).toBe(1);
  for (const close of watchers.get('notebook-phone') ?? []) close();
  const deadline = Date.now() + 1000;
  while (
    !fixture.writes.some(
      (item) => (item as { notebookAction?: string }).notebookAction === 'revoke',
    ) &&
    Date.now() < deadline
  )
    await delay(5);
  expect(fixture.writes).toContainEqual({ notebookAction: 'revoke', body: { key } });
  expect(watchers.get('notebook-phone')?.size).toBe(0);
  const denied = await gateway.inject({
    method: 'POST',
    url: `/api/hosts/${fixture.config.id}/proxy/cluster/notebooks/renew`,
    payload: { key },
  });
  expect(denied.statusCode).toBe(404);
});

it('keeps owner-terminal creation, read, input and close on the selected authenticated computer', async () => {
  const fixture = fixtures[1];
  fixture.access = new LocalAccess(prepareLocalAccess(root, fixture.config.remotePort));
  const selected = new Hosts(
    root,
    async () => ({ port: fixture.config.remotePort, alive: () => true, async close() {} }),
    [{ ...fixture.config, credential: fixture.access.configuration.host }],
  );
  const entry = Fastify();
  await entry.register(websocket);
  registerHostRoutes(entry, selected);
  let socket: WebSocket | undefined;
  try {
    const prefix = `/api/hosts/${fixture.config.id}/proxy/owner-terminal`;
    const key = randomUUID();
    expect(
      (
        await entry.inject({
          method: 'POST',
          url: prefix,
          headers: privateHeaders,
          payload: { key },
        })
      ).json(),
    ).toEqual({ id: queuedId, computer: 'School computer' });
    expect(
      (await entry.inject({ url: `${prefix}/${queuedId}`, headers: privateHeaders })).statusCode,
    ).toBe(200);
    await entry.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(
      `ws://127.0.0.1:${(entry.server.address() as { port: number }).port}${prefix}/${queuedId}/socket`,
      { headers: privateHeaders },
    );
    const ready = once(socket, 'message');
    await once(socket, 'open');
    await ready;
    socket.send(JSON.stringify({ type: 'input', data: 'owner typed harmless input' }));
    await expect.poll(() => fixture.writes.length).toBe(2);
    socket.close();
    expect(
      (
        await entry.inject({
          method: 'POST',
          url: `${prefix}/${queuedId}/close`,
          headers: privateHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(fixture.writes).toEqual([
      { key },
      { type: 'input', data: 'owner typed harmless input' },
      { close: {} },
    ]);
    expect(fixtures[0].writes).toEqual([]);
    expect(fixtures[2].writes).toEqual([]);
    for (const sent of fixture.headers) {
      expect(sent.origin).toBe(`http://127.0.0.1:${fixture.config.remotePort}`);
      expect(sent.cookie).toBeUndefined();
      expect(String(sent.authorization)).toMatch(/^Dock host\./);
      expect(sent['cf-access-jwt-assertion']).toBeUndefined();
    }
  } finally {
    socket?.terminate();
    await entry.close();
    await selected.close();
  }
});

it('allows only the typed native command routes on a selected host', () => {
  const agentId = randomUUID();
  for (const method of ['GET', 'POST'])
    expect(proxyPath(method, `/agents/${agentId}/native-commands`)).toBe(
      `/api/agents/${agentId}/native-commands`,
    );
  expect(proxyPath('POST', `/agents/${agentId}/native-commands/run`)).toBeNull();
  expect(proxyPath('POST', `/agents/${agentId}/native-commands?method=turn/start`)).toBeNull();
  expect(proxyPath('DELETE', `/agents/${agentId}/native-commands`)).toBeNull();
});
