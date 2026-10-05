import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { z } from 'zod';
import { clusterNotebookOpenSchema, clusterNotebookLaunchKeySchema } from '@dock/shared';
import { Conflict } from './store.js';
import { notebookLaunchPage } from './notebook-launch-page.js';
import type { ClusterNotebooks, NotebookConnection } from './cluster-notebooks.js';

export const notebookConfigSchema = z
  .object({
    origin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.origin === value &&
          !url.port &&
          !url.username &&
          !url.password &&
          url.hostname.includes('.') &&
          !/^[\d.]+$/.test(url.hostname) &&
          !/\.(?:localhost|local)$/.test(url.hostname)
        );
      }, 'Use a canonical notebook-only HTTPS origin.'),
    port: z.number().int().min(1024).max(65535).default(4332),
  })
  .strict();
export type NotebookConfig = z.infer<typeof notebookConfigSchema>;
export function readNotebookConfig(root: string): NotebookConfig | null {
  const file = join(root, 'notebook-access.json');
  if (!existsSync(file)) return null;
  try {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    return notebookConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new Error(
      'Notebook access configuration is invalid. Check private data/notebook-access.json.',
    );
  }
}
export const notebookLifetimes = {
  handoffMs: 60_000,
  delegatedMs: 90_000,
  sessionMs: 8 * 60 * 60_000,
  renewalMs: 30_000,
};
const cookieName = '__Secure-swa_notebook';
const fresh = 'Open the notebook again for a fresh link.';
const secret = () => randomBytes(32).toString('base64url');
export type NotebookIssuer = {
  id: string;
  valid(): boolean;
  watch?(close: () => void): () => void;
  delegated?: boolean;
};
type Grant = {
  key: string;
  jobId: string;
  issuer: NotebookIssuer;
  connection: NotebookConnection;
  handoff: string | null;
  claimBy: number;
  endsAt: number;
  renewedUntil: number;
  cookie: string | null;
  unwatch?: () => void;
  active: Set<() => void>;
  revoked: boolean;
};
type Notebooks = Pick<ClusterNotebooks, 'connect' | 'isOpen' | 'watch'>;
const cookies = (value: string | undefined) =>
  new Map(
    (value ?? '').split(';').map((item) => {
      const index = item.indexOf('=');
      return [item.slice(0, index).trim(), item.slice(index + 1).trim()];
    }),
  );

/** Notebook-only HTTP/WS entry. It accepts no owner, host, bridge or provider credentials. */
export class NotebookGateway {
  private server = createServer((request, response) => {
    void this.handle(request, response).catch(() => this.fail(response, 502));
  });
  private grants = new Map<string, Grant>();
  private starting = new Map<string, Promise<{ jobId: string; url: string }>>();
  private unwatch: () => void;
  private timer: NodeJS.Timeout;
  private available = false;
  private message = 'Phone notebooks need a separate notebook address on this computer.';
  constructor(
    readonly config: NotebookConfig | null,
    private notebooks: Notebooks,
    private ready = () => true,
    private now = Date.now,
    issue?: string,
    private isolated = () => true,
  ) {
    if (config) notebookConfigSchema.parse(config);
    if (issue) this.message = issue;
    this.unwatch = notebooks.watch(() => this.sweep());
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    this.server.on('error', () => {}); // Optional listener errors never take down the app.
  }
  status() {
    return {
      remoteAvailable: this.available && this.isolated(),
      remoteMessage:
        this.available && this.isolated()
          ? 'Opens at this computer’s separate notebook address.'
          : this.message,
    };
  }
  async listen(forbiddenOrigins: string[] = [], forbiddenPorts: number[] = []) {
    if (!this.config) return;
    try {
      const hostname = new URL(this.config.origin).hostname;
      if (
        forbiddenOrigins.some((origin) => new URL(origin).hostname === hostname) ||
        forbiddenPorts.includes(this.config.port)
      )
        throw new Error('A separate notebook hostname and listener are required.');
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.config!.port, '127.0.0.1', () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      this.available = true;
    } catch {
      this.message =
        'The separate notebook connection could not start. App views still work; check notebook setup.';
    }
  }
  private usable(grant: Grant) {
    return (
      !grant.revoked &&
      this.isolated() &&
      grant.issuer.valid() &&
      this.now() < grant.endsAt &&
      (!grant.issuer.delegated || this.now() < grant.renewedUntil) &&
      this.notebooks.isOpen(grant.connection.notebook)
    );
  }
  private revokeGrant(grant: Grant) {
    if (grant.revoked) return;
    grant.revoked = true;
    grant.endsAt = Math.min(grant.endsAt, this.now() + 10 * 60_000);
    grant.handoff = null;
    grant.cookie = null;
    grant.unwatch?.();
    grant.unwatch = undefined;
    for (const close of [...grant.active]) close();
  }
  sweep() {
    for (const [key, grant] of this.grants) {
      if (!this.usable(grant) || (!grant.cookie && this.now() >= grant.claimBy))
        this.revokeGrant(grant);
      if (grant.revoked && this.now() >= grant.endsAt) this.grants.delete(key);
    }
  }
  async launch(raw: unknown, issuer: NotebookIssuer) {
    const { key, jobId } = clusterNotebookOpenSchema.parse(raw);
    if (!this.available || !this.config || !this.ready() || !this.isolated())
      throw new Conflict(this.status().remoteMessage);
    this.sweep();
    const previous = this.grants.get(key);
    if (previous) {
      if (previous.issuer.id !== issuer.id || previous.jobId !== jobId)
        throw new Conflict('This notebook request belongs to another launch.');
      if (!this.usable(previous) || !previous.handoff || this.now() >= previous.claimBy)
        throw new Conflict(fresh);
      return this.result(previous);
    }
    const running = this.starting.get(key);
    if (running) {
      const result = await running;
      const grant = this.grants.get(key);
      if (grant?.issuer.id !== issuer.id || grant.jobId !== jobId)
        throw new Conflict('This notebook request belongs to another launch.');
      return result;
    }
    if (this.grants.size + this.starting.size >= 128)
      throw new Conflict('Close older notebook sessions before opening another.');
    const opening = (async () => {
      const connection = await this.notebooks.connect(raw);
      if (connection.baseUrl !== `/notebooks/${jobId}/`)
        throw new Conflict(
          'Phone access needs the current notebook template. Existing jobs still open in this computer’s browser.',
        );
      if (
        !this.available ||
        !this.ready() ||
        !this.isolated() ||
        !issuer.valid() ||
        !this.notebooks.isOpen(connection.notebook)
      )
        throw new Conflict(fresh);
      const grant: Grant = {
        key,
        jobId,
        issuer,
        connection,
        handoff: secret(),
        cookie: null,
        claimBy: this.now() + notebookLifetimes.handoffMs,
        endsAt: this.now() + notebookLifetimes.sessionMs,
        renewedUntil: this.now() + notebookLifetimes.delegatedMs,
        active: new Set(),
        revoked: false,
      };
      this.grants.set(key, grant);
      grant.unwatch = issuer.watch?.(() => this.revokeGrant(grant));
      if (!this.usable(grant)) {
        this.revokeGrant(grant);
        throw new Conflict(fresh);
      }
      return this.result(grant);
    })().finally(() => this.starting.delete(key));
    this.starting.set(key, opening);
    return opening;
  }
  private result(grant: Grant) {
    return { jobId: grant.jobId, url: `${this.config!.origin}/launch#${grant.handoff}` };
  }
  renew(raw: unknown) {
    const { key } = clusterNotebookLaunchKeySchema.parse(raw),
      grant = this.grants.get(key);
    if (!grant?.issuer.delegated || !this.usable(grant)) throw new Conflict(fresh);
    grant.renewedUntil = this.now() + notebookLifetimes.delegatedMs;
    return { renewed: true };
  }
  revoke(raw: unknown) {
    const { key } = clusterNotebookLaunchKeySchema.parse(raw),
      grant = this.grants.get(key);
    if (grant?.issuer.delegated) this.revokeGrant(grant);
    return { revoked: true };
  }
  private exactHost(request: IncomingMessage) {
    return (
      this.available &&
      this.ready() &&
      this.isolated() &&
      request.headers.host === new URL(this.config!.origin).host &&
      request.headers['x-forwarded-proto'] !== 'http'
    );
  }
  private headers(response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }
  private fail(
    response: ServerResponse,
    status: number,
    message = 'Notebook connection unavailable. Reopen it from sciencewithagents.',
  ) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    this.headers(response);
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(message);
  }
  private session(request: IncomingMessage) {
    const url = request.url ?? '';
    if (url.length > 16384 || /[\\\x00-\x20#]/.test(url)) return null;
    const [path] = url.split('?');
    try {
      if (
        path.split('/').some((part) => {
          const decoded = decodeURIComponent(part);
          return decoded === '.' || decoded === '..' || /[\/\\\x00-\x1f]/.test(decoded);
        })
      )
        return null;
    } catch {
      return null;
    }

    const credential = cookies(request.headers.cookie).get(cookieName);
    return (
      [...this.grants.values()].find(
        (grant) =>
          grant.cookie &&
          grant.cookie === credential &&
          path.startsWith(grant.connection.baseUrl) &&
          this.usable(grant),
      ) ?? null
    );
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    this.headers(response);
    if (!this.exactHost(request)) return this.fail(response, 403);
    if (request.method === 'GET' && request.url === '/launch') {
      const nonce = secret();
      response.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      );
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(notebookLaunchPage(nonce));
    }
    if (request.method === 'POST' && request.url === '/_gateway/claim') {
      if (
        request.headers.origin !== this.config!.origin ||
        !request.headers['content-type']?.startsWith('application/json')
      )
        return this.fail(response, 403);
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) return this.fail(response, 413);
      }
      let handoff: string;
      try {
        handoff = z
          .object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict()
          .parse(JSON.parse(body)).secret;
      } catch {
        return this.fail(response, 400);
      }
      const grant = [...this.grants.values()].find((item) => item.handoff === handoff);
      if (!grant || !this.usable(grant) || this.now() >= grant.claimBy)
        return this.fail(response, 409, fresh);
      grant.handoff = null;
      grant.cookie = secret();
      response.setHeader(
        'Set-Cookie',
        `${cookieName}=${grant.cookie}; Path=${grant.connection.baseUrl}; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((grant.endsAt - this.now()) / 1000)}`,
      );
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ path: `${grant.connection.baseUrl}lab` }));
    }
    if (request.headers.origin && request.headers.origin !== this.config!.origin)
      return this.fail(response, 403);
    if (
      !['GET', 'HEAD'].includes(request.method ?? '') &&
      request.headers.origin !== this.config!.origin
    )
      return this.fail(response, 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') return this.fail(response, 403);
    const grant = this.session(request);
    if (!grant) return this.fail(response, 401);
    this.proxy(request, response, grant);
  }
  private upstreamPath(request: IncomingMessage) {
    const url = new URL(request.url!, this.config!.origin);
    // Native Jupyter clients may send their notebook token. It never authorizes this gateway.
    url.searchParams.delete('token');
    return `${url.pathname}${url.search}`;
  }
  private upstreamHeaders(request: IncomingMessage, grant: Grant, upgrade = false) {
    const headers: Record<string, string | string[]> = {};
    for (const name of [
      'accept',
      'accept-encoding',
      'accept-language',
      'content-type',
      'content-length',
      'content-encoding',
      'range',
      'if-none-match',
      'if-modified-since',
      'x-xsrftoken',
      'x-csrftoken',
      ...(upgrade
        ? [
            'upgrade',
            'connection',
            'sec-websocket-key',
            'sec-websocket-version',
            'sec-websocket-protocol',
            'sec-websocket-extensions',
          ]
        : []),
    ]) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const xsrf = cookies(request.headers.cookie).get('_xsrf');
    if (xsrf && /^[A-Za-z0-9|_-]{1,256}$/.test(xsrf)) headers.cookie = `_xsrf=${xsrf}`;
    const origin = `http://127.0.0.1:${grant.connection.notebook.localPort}`;
    headers.host = new URL(origin).host;
    headers.origin = origin;
    headers.authorization = `token ${grant.connection.token}`;
    return headers;
  }
  private proxy(request: IncomingMessage, response: ServerResponse, grant: Grant) {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: grant.connection.notebook.localPort,
      path: this.upstreamPath(request),
      method: request.method,
      headers: this.upstreamHeaders(request, grant),
    });
    let incoming: IncomingMessage | undefined;
    const close = () => {
      upstream.destroy();
      incoming?.destroy();
      response.destroy();
    };
    grant.active.add(close);
    const done = () => {
      grant.active.delete(close);
      upstream.setTimeout(0);
    };
    response.once('close', () => {
      done();
      if (!response.writableFinished) close();
    });
    request.once('aborted', close);
    upstream.setTimeout(15_000, () => {
      upstream.destroy();
      this.fail(response, 502);
    });
    upstream.on('error', () => {
      done();
      this.fail(response, 502);
    });
    upstream.on('response', (result) => {
      incoming = result;
      upstream.setTimeout(0);
      if (!this.usable(grant)) {
        close();
        return;
      }
      for (const [name, value] of Object.entries(result.headers)) {
        if (
          value === undefined ||
          [
            'set-cookie',
            'location',
            'connection',
            'transfer-encoding',
            'keep-alive',
            'upgrade',
            'authorization',
            'www-authenticate',
            'proxy-authenticate',
          ].includes(name) ||
          /^(?:x-dock-|cf-|access-control-)/.test(name)
        )
          continue;
        response.setHeader(name, value);
      }
      this.headers(response);
      const xsrf = result.headers['set-cookie']?.find((cookie) => cookie.startsWith('_xsrf='));
      if (xsrf)
        response.setHeader(
          'Set-Cookie',
          `${xsrf.split(';')[0]}; Path=${grant.connection.baseUrl}; Secure; SameSite=Strict`,
        );
      if (result.headers.location) {
        let destination: URL;
        try {
          destination = new URL(
            result.headers.location,
            `http://127.0.0.1:${grant.connection.notebook.localPort}`,
          );
        } catch {
          result.destroy();
          this.fail(response, 502);
          return;
        }
        if (
          destination.host !== `127.0.0.1:${grant.connection.notebook.localPort}` ||
          !destination.pathname.startsWith(grant.connection.baseUrl) ||
          destination.searchParams.has('token')
        ) {
          result.destroy();
          this.fail(response, 502);
          return;
        }
        response.setHeader(
          'Location',
          `${this.config!.origin}${destination.pathname}${destination.search}`,
        );
      }
      response.writeHead(result.statusCode ?? 502);
      result.once('error', () => this.fail(response, 502));
      result.pipe(response);
    });
    request.pipe(upstream);
  }
  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const denied = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (
      !this.exactHost(request) ||
      request.headers.origin !== this.config!.origin ||
      request.method !== 'GET' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket'
    )
      return denied(403);
    const grant = this.session(request);
    if (!grant) return denied(401);
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: grant.connection.notebook.localPort,
      path: this.upstreamPath(request),
      method: 'GET',
      headers: this.upstreamHeaders(request, grant, true),
    });
    let peer: Duplex | undefined;
    const close = () => {
      grant.active.delete(close);
      upstream.destroy();
      peer?.destroy();
      socket.destroy();
    };
    grant.active.add(close);
    socket.once('close', close);
    socket.once('error', close);
    upstream.setTimeout(15_000, () => {
      denied(502);
      upstream.destroy();
    });
    upstream.once('error', () => {
      denied(502);
      close();
    });
    upstream.once('response', (response) => {
      response.destroy();
      denied(502);
      close();
    });
    upstream.once('upgrade', (response, remote, initial) => {
      peer = remote;
      upstream.setTimeout(0);
      if (!this.usable(grant)) {
        close();
        return;
      }
      const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
      ];
      for (const name of [
        'sec-websocket-accept',
        'sec-websocket-protocol',
        'sec-websocket-extensions',
      ]) {
        const value = response.headers[name];
        if (typeof value === 'string') lines.push(`${name}: ${value}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (initial.length) socket.write(initial);
      if (head.length) remote.write(head);
      remote.once('close', close);
      remote.once('error', close);
      socket.pipe(remote);
      remote.pipe(socket);
    });
    upstream.end();
  }
  async close() {
    this.available = false;
    clearInterval(this.timer);
    this.unwatch();
    for (const grant of this.grants.values()) this.revokeGrant(grant);
    await Promise.allSettled([...this.starting.values()]);
    for (const grant of this.grants.values()) this.revokeGrant(grant);
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
