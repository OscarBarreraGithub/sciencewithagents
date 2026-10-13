import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { promptTextLimit } from '@dock/shared';
import { Conflict, Invalid, Missing } from './store.js';
import type { LocalRole } from '@dock/shared/dist/local-authorization.js';
import type { LocalAccess } from './local-access.js';
import type { PhoneAccess, PhoneIdentity, PhoneSession } from './phone-access.js';
import {
  browserDraftTransferSchema,
  localPage,
  restorePage,
  exportPage,
  importPage,
} from './local-browser-pages.js';

/** Shared entry protection and launcher handoff, independent of an agent runtime. */
export async function registerEntrySecurity(
  app: FastifyInstance,
  options: {
    port: number;
    dataDir: string;
    hostId: string;
    errorText(error: Error): string;
    localAccess?: LocalAccess;
    phone?: PhoneAccess;
    remote?: boolean;
    devPort?: number;
    ready?: () => boolean;
    publicReadPaths?: readonly string[];
    hostAuthorized?: (request: FastifyRequest) => boolean;
    routeAllowed?: (method: string, route: string | undefined, path: string) => boolean;
  },
) {
  const phone = options.phone;
  if (options.remote && (options.localAccess || !phone?.config))
    throw new Error('The remote entry needs its protected phone configuration.');
  const remoteOrigin = options.remote ? phone!.config!.origin : null;
  const identities = new WeakMap<FastifyRequest, PhoneIdentity>();
  const phoneSessions = new WeakMap<FastifyRequest, PhoneSession>();
  const localRoles = new WeakMap<FastifyRequest, LocalRole>();
  const allowedHosts = new Set(
    remoteOrigin
      ? [new URL(remoteOrigin).host]
      : [`127.0.0.1:${options.port}`, `localhost:${options.port}`],
  );
  const browserHost = options.localAccess ? new URL(options.localAccess.browserOrigin).host : null;
  if (browserHost) allowedHosts.add(browserHost);
  const browserOrigins = new Set(options.localAccess ? [options.localAccess.browserOrigin] : []);
  const legacyOrigins = new Set([
    `http://127.0.0.1:${options.port}`,
    `http://localhost:${options.port}`,
  ]);
  if (options.devPort && !options.remote) {
    allowedHosts.add(`127.0.0.1:${options.devPort}`);
    allowedHosts.add(`localhost:${options.devPort}`);
    if (options.localAccess)
      allowedHosts.add(`${new URL(options.localAccess.browserOrigin).hostname}:${options.devPort}`);
    if (options.localAccess)
      browserOrigins.add(
        `http://${new URL(options.localAccess.browserOrigin).hostname}:${options.devPort}`,
      );
    legacyOrigins.add(`http://127.0.0.1:${options.devPort}`);
    legacyOrigins.add(`http://localhost:${options.devPort}`);
  }
  const reconnectUrl = (from: string) => {
    if (!options.localAccess) return '/';
    if (browserOrigins.has(from)) return `${from}/local-access/restore`;
    const development = !!options.devPort && new URL(from).port === String(options.devPort);
    const localhost = new URL(from).hostname === 'localhost';
    const source = development
      ? localhost
        ? 'development-localhost'
        : 'development'
      : localhost
        ? 'localhost'
        : 'loopback';
    const target = development
      ? `http://${new URL(options.localAccess.browserOrigin).hostname}:${options.devPort}`
      : options.localAccess.browserOrigin;
    return `${target}/local-access/restore?recover=1&source=${source}`;
  };
  app.setErrorHandler((error, _request, reply) => {
    const status =
      (error as { statusCode?: number }).statusCode === 413
        ? 413
        : error instanceof ZodError
          ? 400
          : error instanceof Missing
            ? 404
            : error instanceof Conflict
              ? 409
              : error instanceof Invalid
                ? 400
                : 500;
    if (
      options.localAccess &&
      [
        '/api/local-access/consume',
        '/api/local-access/export',
        '/api/local-access/import',
      ].includes(_request.url)
    ) {
      const from = legacyOrigins.has(_request.headers.origin ?? '')
        ? _request.headers.origin!
        : `http://${_request.headers.host}`;
      const target = reconnectUrl(
        legacyOrigins.has(from) || browserOrigins.has(from)
          ? from
          : options.localAccess.configuration.origin,
      );
      const script = `const a=document.createElement('a');a.className='action';a.textContent='Reconnect this tab';a.href=${JSON.stringify(target)};document.getElementById('actions').append(a);`;
      const page = localPage(
        'Reconnect this tab',
        'This browser handoff expired or could not finish. Your original drafts are retained. Open the installed app, then reconnect this tab.',
        script,
      );
      return reply
        .code(status)
        .header('Content-Security-Policy', page.csp)
        .type('text/html')
        .send(page.html);
    }
    const oversizedPrompt =
      error instanceof ZodError &&
      error.issues.some(
        (issue) =>
          issue.code === 'too_big' &&
          issue.maximum === promptTextLimit &&
          issue.path.at(-1) === 'text',
      );
    const message = oversizedPrompt
      ? `This message is longer than ${promptTextLimit.toLocaleString('en-US')} characters. Shorten it or attach it as a file; your draft is retained.`
      : status === 413
        ? 'This request is too large. Your draft is retained; shorten it or attach the text as a file.'
        : error instanceof ZodError
          ? 'The request does not match the input contract.'
          : error instanceof Error
            ? options.errorText(error)
            : 'The operation failed.';
    reply.code(status).send({
      error: message,
      ...(oversizedPrompt ? { code: 'PROMPT_TOO_LONG' } : {}),
      ...(error instanceof Conflict && error.code ? { code: error.code } : {}),
    });
  });
  // Mark real upgrade requests before an early security/readiness rejection.
  // The plugin's onResponse then closes refused upgrade sockets; authentication
  // still runs before its route handler can accept any WebSocket connection.
  await app.register(websocket, { options: { maxPayload: 32_768 } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (
      options.routeAllowed &&
      !options.routeAllowed(request.method, request.routeOptions.url, request.url.split('?')[0])
    )
      return reply.code(403).send({
        code: 'FIXTURE_ROUTE_DISABLED',
        error: 'This native or filesystem action is unavailable in a stub development fixture.',
      });
    if (options.ready && !options.ready())
      return reply
        .code(503)
        .header('Retry-After', '1')
        .send({
          error: 'sciencewithagents is starting or stopping. Please try again in a moment.',
          code: 'APP_NOT_READY',
          // This is an installation hint for the local launcher, not authentication.
          ...(!options.remote
            ? {
                protocolVersion: 1,
                instanceId: createHash('sha256').update(resolve(options.dataDir)).digest('hex'),
              }
            : {}),
        });
    if (
      !options.remote &&
      [
        'cf-access-jwt-assertion',
        'cf-connecting-ip',
        'cf-ray',
        'forwarded',
        'x-forwarded-host',
        'x-forwarded-for',
      ].some((name) => request.headers[name] !== undefined)
    )
      return reply.code(403).send({
        error: 'This is the local entry. Remote connections must use the protected phone entry.',
      });
    if (!allowedHosts.has(request.headers.host ?? ''))
      return reply.code(403).send({ error: 'Only the exact app host is allowed.' });
    if (
      request.headers['x-dock-target-host'] !== undefined &&
      request.headers['x-dock-target-host'] !== options.hostId
    )
      return reply.code(409).send({
        error: 'This request belongs to a different computer. Nothing was changed.',
        code: 'HOST_MISMATCH',
      });
    if (options.remote) {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${remoteOrigin!.replace('https:', 'wss:')}; font-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      );
      // The named tunnel is the only remote entry. A zone-wide HTTPS toggle may
      // be off for unrelated sites; never serve this application over HTTP.
      if (request.headers['x-forwarded-proto'] === 'http') {
        if (['GET', 'HEAD'].includes(request.method))
          return reply.code(308).header('Location', `${remoteOrigin}${request.url}`).send();
        return reply.code(403).send({ error: 'Open the secure phone address to continue.' });
      }
    }
    const origin = request.headers.origin;
    const expected = remoteOrigin ?? `http://${request.headers.host}`;
    const localHandoff =
      !!options.localAccess &&
      request.method === 'POST' &&
      ((request.headers.host === browserHost &&
        request.url === '/api/local-access/consume' &&
        (origin === 'null' || origin === expected)) ||
        (legacyOrigins.has(expected) &&
          request.url === '/api/local-access/export' &&
          browserOrigins.has(origin ?? '')) ||
        (browserOrigins.has(expected) &&
          request.url === '/api/local-access/import' &&
          legacyOrigins.has(origin ?? ''))) &&
      request.headers['content-type']?.startsWith('application/x-www-form-urlencoded');
    if (origin && origin !== expected && !localHandoff)
      return reply.code(403).send({ error: 'A same-origin request is required.' });
    // Access sign-in / QR links can arrive as cross-site document navigations, never API calls.
    const navigation =
      (options.remote || options.localAccess) &&
      request.method === 'GET' &&
      request.headers['sec-fetch-mode'] === 'navigate' &&
      request.headers['sec-fetch-dest'] === 'document' &&
      !request.url.startsWith('/api/');
    if (request.headers['sec-fetch-site'] === 'cross-site' && !navigation && !localHandoff)
      return reply.code(403).send({ error: 'Cross-site requests are not allowed.' });
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      !localHandoff &&
      (origin !== expected || !request.headers['content-type']?.startsWith('application/json'))
    )
      return reply.code(403).send({ error: 'Use a same-origin JSON request.' });
    if (options.localAccess) {
      const access = options.localAccess;
      const path = request.url.split('?')[0];
      const role = access.authenticate(request.headers.authorization, request.method, request.url);
      if (role) localRoles.set(request, role);
      const isApi = path.startsWith('/api/') || request.routeOptions.url?.startsWith('/api/');
      const publicRead =
        !request.headers.upgrade &&
        ['GET', 'HEAD'].includes(request.method) &&
        ([
          '/api/health',
          '/api/host-info',
          '/api/local-access/proof',
          ...(options.publicReadPaths ?? []),
        ].includes(path) ||
          !isApi);
      const separateClient =
        path.startsWith('/api/agent-client/') &&
        request.routeOptions.url?.startsWith('/api/agent-client/');
      const bridge = path === '/api/vscode/bridge';
      const allowed = bridge
        ? !options.remote // Native loopback/origin checks remain in the bridge route.
        : role === 'owner' ||
          (browserOrigins.has(expected) && access.browser(request.headers.cookie)) ||
          (role === 'host' && !!options.hostAuthorized?.(request));
      if (!allowed && !publicRead && !localHandoff && !separateClient)
        return reply.code(401).send({
          error:
            'Open the installed sciencewithagents app on this computer to connect this browser.',
          code: 'LOCAL_UNLOCK_REQUIRED',
          ...(!bridge
            ? {
                reconnectUrl: reconnectUrl(expected),
              }
            : {}),
        });
    }
    if (options.remote) {
      if (!phone!.enabled)
        return reply.code(503).send({ error: 'Phone access is turned off on your computer.' });
      let session: PhoneSession | null;
      if (phone!.pairedDevices) {
        session = phone!.pairedDevices.session(request.headers.cookie);
      } else {
        const identity = await phone!.identity(request.headers['cf-access-jwt-assertion']);
        if (!identity)
          return reply
            .code(401)
            .send({ error: 'Sign in again to connect.', code: 'SIGN_IN_REQUIRED' });
        identities.set(request, identity);
        session = phone!.session(identity, request.headers.cookie);
      }
      if (session) phoneSessions.set(request, session);
      const path = request.url.split('?')[0];
      if (
        !session &&
        !(
          ['GET', 'HEAD'].includes(request.method) &&
          !request.headers.upgrade &&
          options.publicReadPaths?.includes(path)
        ) &&
        (request.headers.upgrade ||
          ((path.startsWith('/api/') || request.routeOptions.url?.startsWith('/api/')) &&
            !(
              phone!.pairedDevices
                ? ['/api/phone/status', '/api/phone/enroll/options', '/api/phone/enroll/finish']
                : ['/api/phone/status', '/api/phone/pair']
            ).includes(path)))
      )
        return reply.code(401).send({
          error: 'Connect this device using the code on your computer.',
          code: 'PAIRING_REQUIRED',
        });
    }
  });
  if (options.localAccess) {
    const access = options.localAccess;
    const sourceSchema = z.enum(['loopback', 'localhost', 'development', 'development-localhost']);
    const sourceOrigin = (source: z.infer<typeof sourceSchema>) => {
      const development = source.startsWith('development');
      if (development && !options.devPort)
        throw new Conflict('Development browser access is not configured.');
      return `http://${source.includes('localhost') ? 'localhost' : '127.0.0.1'}:${development ? options.devPort : options.port}`;
    };
    const pageReply = (reply: import('fastify').FastifyReply, page: ReturnType<typeof localPage>) =>
      reply
        // These ticketed forms cross between this installation's fixed local origins.
        // no-referrer would also remove their Origin header. No credentials use URLs.
        .header('Referrer-Policy', 'origin')
        .header('Content-Security-Policy', page.csp)
        .type('text/html')
        .send(page.html);
    app.get('/api/local-access/proof', async (request) => access.proof(request.query));
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 8 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    app.post('/api/local-access/handoff', async (request, reply) => {
      if (localRoles.get(request) !== 'owner')
        return reply
          .code(403)
          .send({ error: 'Use the installed app launcher to open this browser.' });
      z.object({}).strict().parse(request.body);
      return access.issueHandoff();
    });
    app.post('/api/local-access/consume', async (request, reply) => {
      if (request.headers.host !== browserHost)
        return reply.code(403).send({ error: 'Open the installed app to connect this browser.' });
      const body = z.string().max(256).parse(request.body);
      const form = new URLSearchParams(body);
      if ([...form.keys()].length !== 1 || !form.has('ticket'))
        throw new Conflict('Open sciencewithagents again to connect this browser.');
      const cookie = access.consumeHandoff(form.get('ticket')!);
      const destination = options.devPort
        ? `http://${new URL(access.browserOrigin).hostname}:${options.devPort}/local-access/restore?source=development`
        : '/local-access/restore';
      const script = `location.replace(${JSON.stringify(destination)})`;
      reply.header('Set-Cookie', cookie);
      reply.header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; base-uri 'none'; frame-ancestors 'none'`,
      );
      return reply
        .type('text/html')
        .send(
          `<!doctype html><meta name="referrer" content="no-referrer"><title>Opening sciencewithagents</title><script>${script}</script><p>Connected. <a href="/">Open your workspace</a>.</p>`,
        );
    });
    app.get('/local-access/restore', async (request, reply) => {
      const { source, recover } = z
        .object({ source: sourceSchema.default('loopback'), recover: z.literal('1').optional() })
        .strict()
        .parse(request.query);
      return pageReply(reply, restorePage(source, recover === '1', sourceOrigin(source)));
    });
    app.post('/api/local-access/migrate', async (request) => {
      const { source, recover } = z
        .object({ source: sourceSchema, recover: z.boolean() })
        .strict()
        .parse(request.body);
      const destination = `http://${request.headers.host}`;
      if (!browserOrigins.has(destination))
        throw new Conflict('Reconnect from this app’s browser address.');
      const from = sourceOrigin(source);
      return {
        target: `${from}/api/local-access/export`,
        ticket: access.issueMigration(from, destination, recover),
      };
    });
    app.post('/api/local-access/export', async (request, reply) => {
      const form = new URLSearchParams(z.string().max(256).parse(request.body));
      if ([...form.keys()].length !== 1 || !form.has('ticket'))
        throw new Conflict('Reconnect this tab to restore its drafts.');
      const value = access.exportMigration(
        form.get('ticket')!,
        `http://${request.headers.host}`,
        request.headers.origin ?? '',
      );
      return pageReply(reply, exportPage(value.ticket, value.destination));
    });
    app.post('/api/local-access/import', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
      const form = new URLSearchParams(
        z
          .string()
          .max(8 * 1024 * 1024)
          .parse(request.body),
      );
      if ([...form.keys()].length !== 2 || !form.has('ticket') || !form.has('drafts'))
        throw new Conflict('Reconnect this tab to restore its drafts.');
      const raw = form.get('drafts')!;
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
        throw new Conflict(
          'Keep the original tab and download its retained drafts before continuing.',
        );
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new ZodError([
          { code: 'custom', path: [], message: 'The retained draft transfer is not valid.' },
        ]);
      }
      const payload = browserDraftTransferSchema.parse(decoded);
      const value = access.importMigration(
        form.get('ticket')!,
        request.headers.origin ?? '',
        `http://${request.headers.host}`,
      );
      return pageReply(reply, importPage(payload, value.source, value.recover));
    });
  }
  return { remoteOrigin, identities, phoneSessions, localRoles, browserOrigins };
}
