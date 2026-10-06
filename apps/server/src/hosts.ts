import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as reservePort } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import { NotebookDelegations } from './notebook-delegations.js';
import { localAuthorization } from '@dock/shared/dist/local-authorization.js';
import {
  agentDetailQuerySchema,
  hostConnectionsSchema,
  clusterNotebookOpenSchema,
  chatImageBodyLimit,
  hostInfoSchema,
  hostsStatusSchema,
  mirrorPageQuerySchema,
  ownerRequestHttpQuerySchema,
  conversationVisibilityQuerySchema,
  conversationListQuerySchema,
  mirrorQueueQuerySchema,
  type HostConnection,
  type HostSummary,
} from '@dock/shared';

export type HostTransport = {
  port: number;
  alive(): boolean;
  close(): Promise<void>;
};
export type ConnectHost = (host: HostConnection) => Promise<HostTransport>;
const unavailable =
  'This computer is unavailable. Turn it on, sign in and open sciencewithagents there, then try again. If it still cannot connect, ask your setup agent to check its connection.';

class HostUnavailable extends Error {
  constructor(message = unavailable) {
    super(message);
  }
}

export function readHostConfig(root: string): HostConnection[] {
  const file = join(root, 'hosts.json');
  if (!existsSync(file)) return [];
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.size > 65_536 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Computer connections require a private, bounded regular configuration file.');
  return hostConnectionsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Existing SSH configuration/authentication stays on this computer. No browser-selected command. */
export function sshArguments(host: HostConnection, port: number) {
  host = hostConnectionsSchema.parse([host])[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid forward port.');
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'GatewayPorts=no',
    '-L',
    `127.0.0.1:${port}:127.0.0.1:${host.remotePort}`,
    '--',
    host.sshAlias,
  ];
}

export function assertDedicatedForward(
  effectiveConfig: string,
  host: HostConnection,
  port: number,
) {
  const forwards = effectiveConfig
    .split('\n')
    .filter((line) => /^(localforward|remoteforward|dynamicforward) /.test(line));
  if (
    forwards.length !== 1 ||
    forwards[0] !== `localforward [127.0.0.1]:${port} [127.0.0.1]:${host.remotePort}`
  )
    throw new HostUnavailable(
      'This saved connection also changes unrelated network access. Ask your setup agent to prepare a dedicated sciencewithagents connection.',
    );
}

export async function connectSsh(host: HostConnection): Promise<HostTransport> {
  const reservation = reservePort();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new HostUnavailable();
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const lifetimeHost = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './provider-host.ts' : './provider-host.js',
      import.meta.url,
    ),
  );
  const args = sshArguments(host, address.port);
  // Read effective configuration privately: a convenient existing alias must not activate unrelated port forwards.
  const { stdout } = await promisify(execFile)('ssh', ['-G', ...args], {
    timeout: 5000,
    maxBuffer: 65_536,
  });
  assertDedicatedForward(stdout, host, address.port);
  // The existing lifetime pipe terminates this SSH process group if the app crashes.
  const child = spawn(process.execPath, [lifetimeHost, 'ssh', JSON.stringify(args)], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const finished = () => {
      exited = true;
      resolve();
    };
    child.once('error', finished);
    child.once('exit', finished);
  });
  child.stdin?.on('error', () => {});
  return {
    port: address.port,
    alive: () => !exited,
    async close() {
      if (exited) return;
      child.stdin?.end();
      await exit;
    },
  };
}

function headers(host: HostConnection, extra: { lastEventId?: string } = {}) {
  return {
    host: `127.0.0.1:${host.remotePort}`,
    origin: `http://127.0.0.1:${host.remotePort}`,
    'x-dock-target-host': host.expectedHostId,
    accept: 'application/json, application/octet-stream, text/event-stream, image/png',
    'content-type': 'application/json',
    ...(extra.lastEventId ? { 'last-event-id': extra.lastEventId } : {}),
  };
}

async function authenticatedHeaders(
  host: HostConnection,
  transport: HostTransport,
  method: string,
  path: string,
  lastEventId?: string,
) {
  const base = headers(host, { lastEventId });
  if (!host.credential) return base;
  try {
    return {
      ...base,
      authorization: await localAuthorization(base.origin, host.credential, 'host', method, path, {
        transportOrigin: `http://127.0.0.1:${transport.port}`,
        headers: base,
      }),
    };
  } catch (error) {
    // SSH has spawned but may not have opened its local listener yet. Only the initial
    // read-only handshake retries this; authentication/identity failures remain terminal.
    if (error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED') throw error;
    throw new HostUnavailable(
      'This computer could not authenticate its saved connection. No request was sent. Check its sciencewithagents connection setup before retrying.',
    );
  }
}

async function request(
  host: HostConnection,
  transport: HostTransport,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  lastEventId?: string,
): Promise<IncomingMessage> {
  const authenticated = await authenticatedHeaders(host, transport, method, path, lastEventId);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port: transport.port,
        method,
        path,
        headers: authenticated,
        signal,
      },
      (response) => {
        outgoing.setTimeout(0);
        resolve(response);
      },
    );
    outgoing.setTimeout(15_000, () => outgoing.destroy(new HostUnavailable()));
    outgoing.once('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function identity(host: HostConnection, transport: HostTransport) {
  const response = await request(
    host,
    transport,
    'GET',
    '/api/host-info',
    undefined,
    AbortSignal.timeout(2000),
  );
  if (response.statusCode === 409) {
    response.destroy();
    throw new HostUnavailable(
      'This connection reached a different sciencewithagents workspace. Nothing was sent. Ask your setup agent to verify the computer before reconnecting.',
    );
  }
  if (
    response.statusCode !== 200 ||
    !response.headers['content-type']?.includes('application/json')
  ) {
    response.destroy();
    throw new HostUnavailable(
      'This computer needs a compatible sciencewithagents update. Ask your setup agent to check it.',
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) {
      response.destroy();
      throw new HostUnavailable();
    }
    chunks.push(bytes);
  }
  const result = hostInfoSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!result.success)
    throw new HostUnavailable(
      'This computer needs a compatible sciencewithagents update. Ask your setup agent to check it.',
    );
  if (result.data.hostId !== host.expectedHostId)
    throw new HostUnavailable(
      'This connection reached a different sciencewithagents workspace. Nothing was sent. Ask your setup agent to verify the computer before reconnecting.',
    );
  if (result.data.localAuthentication && !host.credential)
    throw new HostUnavailable(
      'This computer now requires an authenticated connection. Reconnect it with your setup agent; this computer’s local workspace remains available.',
    );
}

/** One replaceable transport per configured computer. Histories/accounts are never copied here. */
export class Hosts {
  private states = new Map<
    string,
    {
      host: HostConnection;
      status: HostSummary['status'];
      error: string | null;
      transport?: HostTransport;
      connecting?: Promise<HostTransport>;
    }
  >();
  private stopped = false;
  private readonly setupError: string | null;
  constructor(
    root: string,
    private readonly connect: ConnectHost = connectSsh,
    config?: HostConnection[],
  ) {
    let hosts: HostConnection[] = [],
      error: string | null = null;
    try {
      hosts = config === undefined ? readHostConfig(root) : hostConnectionsSchema.parse(config);
    } catch {
      error =
        'Computer connections need setup. Ask your setup agent to check the saved connections; this computer is still available.';
    }
    this.setupError = error;
    for (const host of hosts)
      this.states.set(host.id, { host, status: 'disconnected', error: null });
  }
  status() {
    return hostsStatusSchema.parse({
      local: { id: 'local', label: hostname().replace(/\.local$/i, '') },
      setupError: this.setupError,
      hosts: [...this.states.values()].map((state) => ({
        id: state.host.id,
        label: state.host.label,
        accountLabel: state.host.accountLabel,
        status: state.transport && !state.transport.alive() ? 'error' : state.status,
        error: state.transport && !state.transport.alive() ? unavailable : state.error,
      })),
    });
  }
  private state(id: string) {
    const state = this.states.get(id);
    if (!state)
      throw new HostUnavailable(
        'This computer is not connected to sciencewithagents yet. Ask your setup agent to connect it.',
      );
    if (this.stopped) throw new HostUnavailable();
    return state;
  }
  async connection(id: string, retry = false) {
    const state = this.state(id);
    if (state.connecting) return state.connecting;
    if (state.transport?.alive()) return state.transport;
    if (state.status === 'error' && !retry) throw new HostUnavailable(state.error ?? unavailable);
    state.status = 'connecting';
    state.error = null;
    state.connecting = (async () => {
      await state.transport?.close();
      state.transport = undefined;
      const transport = await this.connect(state.host);
      try {
        // SSH can start before its forward is listening. Only the read-only identity handshake retries.
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (this.stopped || !transport.alive()) throw new HostUnavailable();
          try {
            await identity(state.host, transport);
            break;
          } catch (error) {
            if (error instanceof HostUnavailable || Date.now() >= deadline) throw error;
            await delay(100);
          }
        }
        if (this.stopped) throw new HostUnavailable();
        state.transport = transport;
        state.status = 'connected';
        state.error = null;
        return transport;
      } catch (error) {
        await transport.close();
        throw error;
      }
    })()
      .catch((error: unknown) => {
        state.status = 'error';
        state.error = error instanceof HostUnavailable ? error.message : unavailable;
        throw new HostUnavailable(state.error);
      })
      .finally(() => {
        state.connecting = undefined;
      });
    return state.connecting;
  }
  async checked(id: string) {
    const state = this.state(id),
      transport = await this.connection(id);
    // Check again before every request, including mutations: a restarted/replaced host cannot receive another account's input.
    try {
      await identity(state.host, transport);
    } catch (error) {
      const message = error instanceof HostUnavailable ? error.message : unavailable;
      if (state.transport === transport) {
        state.status = 'error';
        state.error = message;
        state.transport = undefined;
      }
      await transport.close();
      throw new HostUnavailable(message);
    }
    return { host: state.host, transport };
  }
  async forward(
    id: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    lastEventId?: string,
  ) {
    const { host, transport } = await this.checked(id);
    if (signal?.aborted) throw new HostUnavailable();
    try {
      return await request(host, transport, method, path, body, signal, lastEventId);
    } catch (error) {
      // A cancelled viewer is not a failed host. A broken request never retries its body.
      if (!signal?.aborted) {
        const state = this.states.get(id);
        if (state?.transport === transport) {
          state.status = 'error';
          state.error = unavailable;
          state.transport = undefined;
          await transport.close();
        }
      }
      throw error;
    }
  }
  async close() {
    this.stopped = true;
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        await state.connecting?.catch(() => {});
        await state.transport?.close();
        state.transport = undefined;
        state.status = 'disconnected';
      }),
    );
  }
}

const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const getPaths = new RegExp(
  `^/(?:owner-terminal/${uuid}|apps|publishing-accounts|chat-images/${uuid}|chat-files/${uuid}(?:/info|/preview)?|health|browser/setup|setup(?:/(?:sign-in|claude-sign-in))?|documents(?:/browse|/${uuid}(?:/pdf|/reading|/assets/[a-f0-9]{64}\\.(?:png|jpg|jpeg|webp|gif))?)?|snapshot|attention|capacity|resources|cluster(?:/sign-in|/notebooks)?|pulsar(?:/jobs/${uuid})?|quark(?:/(?:coordinator|focus))?|local-jobs|scheduler|models|model-policy|providers(?:/(?:codex|claude)/maintenance)?|project-options|project-folders|project-rates|archive/editors|work-items|bug-reports|app-updates|conversations(?:/visibility|/search/${uuid})?|events|frontdesk|recovery-backups(?:/${uuid})?|vscode/windows(?:/${uuid}(?:/goal)?)?|vscode/deliveries/${uuid}|vscode/queued(?:/${uuid}(?:/receipts/${uuid})?)?|agents/${uuid}(?:/native-commands|/chat-quark|/goal|/mcp|/export|/recovery|/owner-requests|/usage|/receipts/${uuid}|/queued/${uuid}/receipts/${uuid}|/images/${uuid})?|projects/${uuid}/(?:sessions|workflow|quark|notes|backup/setup|worker-tools(?:/catalog)?)|tasks/${uuid}/(?:diff|integration)|workspace/${uuid}(?:/drafts/${uuid}(?:/history)?)?)$`,
);
const postPaths = new RegExp(
  `^/(?:owner-terminal(?:/${uuid}/close)?|apps/${uuid}/remove|publishing-accounts/check|chat-images|chat-files|browser/(?:check|open-setup)|documents/(?:from-message|${uuid}/(?:open|build))|projects(?:/(?:connect-folder|track-folder))?|archive/(?:search|read)|work-items(?:/tickets)?|bug-reports|app-updates/(?:check|start)|conversations(?:/search|/visibility)?|setup/(?:check|sign-in(?:/cancel)?|claude-sign-in)|model-policy(?:/catalogs)?|quark/(?:budgets|settings|resume|focus(?:/release)?|coordinator/(?:start|settings))|local-jobs(?:/(?:control|read))?|providers/(?:check|update)|capacity/refresh|cluster/(?:settings|refresh|sign-in(?:/(?:respond|cancel))?|notebooks/(?:close|launch|renew|revoke))|resources/(?:ask|settings|stop)|pulsar/(?:policy|jobs)|scheduler/settings|frontdesk/(?:start|settings)|recovery-backups(?:/${uuid}/verify)?|vscode/windows/${uuid}/(?:send|control|goal)|vscode/queued/${uuid}|agents/${uuid}/(?:interviews|messages|goal|queued/${uuid}|commands|native-commands|settings|chat-quark|usage/refresh|terminal/close)|approvals/${uuid}|projects/${uuid}/(?:managers|tasks|workflow|quark|notes|open-in-editor|sessions/import|backup/(?:retry|preview|connect)|history|history/read|catalog|worker-tools)|tasks/${uuid}/(?:integrate|reconcile|cancel)|workspace/clients|workspace/${uuid}(?:/restore|/drafts/${uuid})?)$`,
);
const terminalPath = new RegExp(`^/(?:agents/${uuid}/terminal|owner-terminal/${uuid}/socket)$`);

/** Exact routes only. Reject encoded paths rather than reinterpret them across two routers. */
export function proxyPath(method: string, path: string, socket = false) {
  const [pathname, query, ...extra] = path.split('?');
  if (
    extra.length ||
    path.length > 8192 ||
    /[%\\#\x00-\x20]/.test(pathname) ||
    pathname.includes('..')
  )
    return null;
  if (
    socket
      ? method !== 'GET' || !terminalPath.test(pathname) || query !== undefined
      : method === 'GET'
        ? !getPaths.test(pathname)
        : method === 'POST'
          ? !postPaths.test(pathname)
          : true
  )
    return null;
  if (query !== undefined) {
    if (method !== 'GET') return null;
    const queryName =
      pathname === '/events'
        ? 'after'
        : new RegExp(`^/projects/${uuid}/sessions$`).test(pathname)
          ? 'cursor'
          : new RegExp(`^/workspace/${uuid}/drafts/${uuid}/history$`).test(pathname)
            ? 'before'
            : pathname === '/work-items'
              ? 'projectId'
              : null;
    const params = new URLSearchParams(query);
    const mirrorQueue = pathname === '/vscode/queued';
    if (mirrorQueue && !mirrorQueueQuerySchema.safeParse(Object.fromEntries(params)).success)
      return null;
    const mirrorRead = new RegExp(`^/vscode/windows/${uuid}$`).test(pathname);
    const ownerRequests = new RegExp(`^/agents/${uuid}/owner-requests$`).test(pathname);
    // The receiving detail route parses this same schema: optional opaque `before`, exact channel.
    const agentDetail = new RegExp(`^/agents/${uuid}$`).test(pathname);
    if (agentDetail && !agentDetailQuerySchema.safeParse(Object.fromEntries(params)).success)
      return null;
    const visibility = pathname === '/conversations/visibility';
    const conversationList = pathname === '/conversations' || pathname === '/vscode/windows';
    if (
      visibility &&
      !conversationVisibilityQuerySchema.safeParse(Object.fromEntries(params)).success
    )
      return null;
    if (
      conversationList &&
      !conversationListQuerySchema.safeParse(Object.fromEntries(params)).success
    )
      return null;
    if (ownerRequests && !ownerRequestHttpQuerySchema.safeParse(Object.fromEntries(params)).success)
      return null;
    if (mirrorRead && !mirrorPageQuerySchema.safeParse(Object.fromEntries(params)).success)
      return null;
    for (const [name, value] of params) {
      if (
        agentDetail ||
        mirrorRead ||
        mirrorQueue ||
        ownerRequests ||
        visibility ||
        conversationList
      ) {
        if (params.getAll(name).length !== 1 || /[\x00-\x1f]/.test(value)) return null;
        continue;
      }
      if (pathname === '/project-folders' || pathname === '/documents/browse') {
        if (
          params.getAll(name).length !== 1 ||
          !(
            (name === 'folderId' && new RegExp(`^${uuid}$`).test(value)) ||
            (name === 'offset' && /^\d{1,7}$/.test(value) && Number(value) <= 1000000) ||
            (pathname === '/project-folders' &&
              ((name === 'query' &&
                value.trim().length > 0 &&
                value.length <= 120 &&
                !/[\x00-\x1f]/.test(value)) ||
                (name === 'scope' && ['children', 'descendants'].includes(value)) ||
                (name === 'hidden' && ['true', 'false'].includes(value))))
          )
        )
          return null;
        continue;
      }
      if (pathname === '/models') {
        if (
          params.getAll(name).length !== 1 ||
          !(name === 'agentId'
            ? new RegExp(`^${uuid}$`).test(value)
            : name === 'provider' && ['codex', 'claude'].includes(value))
        )
          return null;
        continue;
      }
      if (
        name !== queryName ||
        params.getAll(name).length !== 1 ||
        value.length > 4096 ||
        /[\x00-\x1f]/.test(value)
      )
        return null;
      if (name === 'after' && !/^\d{1,16}$/.test(value)) return null;
      if (name === 'projectId' && !new RegExp(`^${uuid}$`).test(value)) return null;
      if (pathname.endsWith('/history') && !/^\d{1,16}$/.test(value)) return null;
    }
  }
  return `/api${path}`;
}

type GatewayOptions = { watch?: (request: FastifyRequest, close: () => void) => () => void };
export function registerHostRoutes(
  app: FastifyInstance,
  hosts: Hosts,
  options: GatewayOptions = {},
) {
  const active = new Set<() => void>();
  const notebookDelegations = new NotebookDelegations(async (hostId, action, key) => {
    const response = await hosts.forward(hostId, 'POST', `/api/cluster/notebooks/${action}`, {
      key,
    });
    const accepted = response.statusCode === 200;
    response.resume();
    if (!accepted) throw new HostUnavailable();
  });
  const watch = (request: FastifyRequest, close: () => void) => {
    active.add(close);
    const unwatch = options.watch?.(request, close) ?? (() => {});
    return () => {
      active.delete(close);
      unwatch();
    };
  };
  const failure = (error: unknown) => ({
    error: error instanceof HostUnavailable ? error.message : unavailable,
    code: 'HOST_UNAVAILABLE',
  });
  app.get('/api/hosts', async () => hosts.status());
  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/connect', async (request, reply) => {
    if (!z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: 'Connection setup is managed on the computer.' });
    try {
      await hosts.connection(request.params.hostId, true);
      return hosts.status();
    } catch (error) {
      return reply.code(502).send(failure(error));
    }
  });
  app.route<{ Params: { hostId: string; '*': string } }>({
    method: ['GET', 'POST'],
    url: '/api/hosts/:hostId/proxy/*',
    bodyLimit: chatImageBodyLimit,
    handler: async (request, reply) => {
      const prefix = `/api/hosts/${request.params.hostId}/proxy`;
      const raw = request.raw.url ?? request.url;
      const target = raw.startsWith(prefix)
        ? proxyPath(request.method, raw.slice(prefix.length))
        : null;
      if (
        !target ||
        ['/api/cluster/notebooks/renew', '/api/cluster/notebooks/revoke'].includes(target)
      )
        return reply
          .code(404)
          .send({ error: 'This action is not available through the computer connection.' });
      const abort = new AbortController();
      let response: IncomingMessage | undefined;
      const close = () => {
        abort.abort();
        response?.destroy();
        reply.raw.destroy();
      };
      const unwatch = watch(request, close);
      reply.raw.once('close', close);
      reply.raw.once('close', unwatch);
      try {
        response = await hosts.forward(
          request.params.hostId,
          request.method,
          target,
          request.body,
          abort.signal,
          typeof request.headers['last-event-id'] === 'string' &&
            /^\d{1,16}$/.test(request.headers['last-event-id'])
            ? request.headers['last-event-id']
            : undefined,
        );
        if (
          response.statusCode &&
          ([401, 503].includes(response.statusCode) ||
            (response.statusCode >= 300 && response.statusCode < 400))
        ) {
          response.destroy();
          return reply.code(502).send(failure(new HostUnavailable()));
        }
        if (
          !/^(application\/(?:json|pdf|octet-stream)|image\/png|text\/event-stream)(?:;|$)/i.test(
            response.headers['content-type'] ?? '',
          )
        ) {
          response.destroy();
          return reply.code(502).send(failure(new HostUnavailable()));
        }
        if (target === '/api/cluster/notebooks/launch' && response.statusCode === 200) {
          const { key } = clusterNotebookOpenSchema.parse(request.body);
          notebookDelegations.track(
            request.params.hostId,
            key,
            (close) => options.watch?.(request, close) ?? (() => {}),
          );
        }
        // Never relay cookies, auth, Location, forwarding headers or downstream security policy.
        for (const name of ['content-type', 'content-disposition']) {
          const value = response.headers[name];
          if (value) reply.header(name, value);
        }
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.code(response.statusCode ?? 502);
        response.once('error', close);
        return reply.send(response);
      } catch (error) {
        unwatch();
        if (!reply.raw.destroyed) return reply.code(502).send(failure(error));
      }
    },
  });
  for (const terminalRoute of ['agents/:agentId/terminal', 'owner-terminal/:agentId/socket'])
    app.get<{ Params: { hostId: string; agentId: string } }>(
      `/api/hosts/:hostId/proxy/${terminalRoute}`,
      { websocket: true },
      (socket, request) => {
        const terminalTarget = terminalRoute.replace(':agentId', request.params.agentId);
        const target = proxyPath('GET', `/${terminalTarget}`, true);
        const expectedPrefix = `/api/hosts/${request.params.hostId}/proxy/${terminalTarget}`;
        if (!target || request.raw.url !== expectedPrefix || !request.headers.origin) {
          socket.close(1008, 'Unknown terminal');
          return;
        }
        let upstream: WebSocket | undefined,
          ended = false,
          waiting = 0;
        const pending: { data: RawData; binary: boolean }[] = [];
        const close = () => {
          if (ended) return;
          ended = true;
          upstream?.terminate();
          socket.terminate();
        };
        const unwatch = watch(request, close);
        socket.once('close', () => {
          close();
          unwatch();
        });
        socket.once('error', close);
        socket.on('message', (data, binary) => {
          const length = Array.isArray(data)
            ? data.reduce((sum, part) => sum + part.length, 0)
            : data.byteLength;
          if (length > 32_768) {
            close();
            return;
          }
          if (upstream?.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount > 131_072) {
              close();
              return;
            }
            upstream.send(data, { binary });
          } else if (!ended && pending.length < 64 && waiting + length <= 32_768) {
            waiting += length;
            pending.push({ data, binary });
          } else close();
        });
        void hosts
          .checked(request.params.hostId)
          .then(async ({ host, transport }) => {
            if (ended) return;
            const authenticated = await authenticatedHeaders(host, transport, 'GET', target);
            if (ended) return;
            upstream = new WebSocket(`ws://127.0.0.1:${transport.port}${target}`, {
              headers: authenticated,
              perMessageDeflate: false,
              maxPayload: 16 * 1024 * 1024,
              handshakeTimeout: 10_000,
            });
            upstream.once('open', () => {
              if (ended) {
                upstream?.terminate();
                return;
              }
              for (const item of pending) upstream!.send(item.data, { binary: item.binary });
              pending.length = 0;
            });
            upstream.on('message', (data, binary) => {
              if (
                socket.readyState !== WebSocket.OPEN ||
                socket.bufferedAmount > 16 * 1024 * 1024
              ) {
                close();
                return;
              }
              socket.send(data, { binary });
            });
            upstream.once('error', close);
            upstream.once('close', (code, reason) => {
              if (ended) return;
              ended = true;
              // Preserve native input-control transfer (e.g. 4001), never replay bytes or seize it automatically.
              socket.close(
                code === 1005 || code === 1006 || code === 1015 ? 1011 : code,
                reason.toString().slice(0, 100),
              );
            });
          })
          .catch((error: unknown) => {
            if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: 'error', message: failure(error).error }));
            socket.close(1011, 'Computer connection unavailable');
          });
      },
    );
  app.addHook('preClose', async () => {
    notebookDelegations.close();
    for (const close of active) close();
    active.clear();
  });
}
