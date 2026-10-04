import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { get, globalAgent } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { hostConnectionsSchema, type HostConnection } from '@dock/shared';
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
    app.get(`/api/documents/${agentId}/pdf`, (_request, reply) =>
      reply
        .type('application/pdf')
        .header('Set-Cookie', 'private=secret')
        .send(Buffer.from('%PDF-1.4\n' + label)),
    );
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
    app.get('/api/events', (request, reply) => {
      fixture.headers.push(request.headers);
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('id: 12\nevent: change\ndata: {}\n\n');
      reply.raw.once('close', () => {
        fixture.eventsClosed++;
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
    expect(proxyPath('GET', '/resources')).toBe('/api/resources');
    for (const path of [
      '/project-rates',
      '/conversations',
      '/work-items',
      `/projects/${agentId}/workflow`,
      `/projects/${agentId}/notes`,
    ])
      expect(proxyPath('GET', path)).toBe(`/api${path}`);
    expect(proxyPath('GET', `/work-items?projectId=${agentId}`)).toBe(
      `/api/work-items?projectId=${agentId}`,
    );
    expect(proxyPath('GET', '/work-items?projectId=unknown')).toBeNull();
    expect(proxyPath('GET', `/workspace/${agentId}/drafts/${agentId}/history?before=20`)).toBe(
      `/api/workspace/${agentId}/drafts/${agentId}/history?before=20`,
    );
    expect(
      proxyPath('GET', `/workspace/${agentId}/drafts/${agentId}/history?before=-2`),
    ).toBeNull();
    for (const path of [
      '/work-items',
      '/conversations',
      `/projects/${agentId}/workflow`,
      `/projects/${agentId}/notes`,
      `/projects/${agentId}/open-in-editor`,
    ])
      expect(proxyPath('POST', path)).toBe(`/api${path}`);
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

  it('streams a registered PDF from the selected computer without forwarding private headers', async () => {
    const response = await gateway.inject(path(1, `/documents/${agentId}/pdf`));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body).toBe('%PDF-1.4\nSchool computer');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
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
