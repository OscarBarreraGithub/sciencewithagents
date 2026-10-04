import { registerWorkItemRoutes } from './work-items.js';
import { registerConversationRoutes } from './conversations.js';
import { QuarkFocus, registerQuarkFocusRoutes } from './quark-focus.js';
import { registerConversationSearchRoutes } from './conversation-search.js';
import { registerProjectWorkflowRoutes } from './project-workflow.js';
import { openProjectEditor, type ProjectEditorOpener } from './project-editor.js';
import { providerMaintenanceRequestSchema, providerIdSchema } from '@dock/shared';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { z, ZodError } from 'zod';
import {
  agentSchema,
  attention,
  approvalReplySchema,
  approvalSchema,
  commandSchema,
  decisionSchema,
  detailSchema,
  id,
  modelSchema,
  mcpCatalogSchema,
  managerCreateSchema,
  projectCreateSchema,
  projectEditorOpenSchema,
  projectOptionsSchema,
  folderBrowseSchema,
  folderBrowseRequestSchema,
  projectFolderSchema,
  projectTrackingRequestSchema,
  projectConnectionSchema,
  projectSchema,
  projectToolsRequestSchema,
  projectToolsSchema,
  runSchema,
  sendSchema,
  settingsSchema,
  snapshotSchema,
  taskRequestSchema,
  taskSchema,
  phoneCodeRequestSchema,
  phoneEnabledSchema,
  capacityRefreshSchema,
  quotaResumeSchema,
} from '@dock/shared';
import { Conflict, Missing, Store, publicTask } from './store.js';
import { Runtime } from './runtime.js';
import { Terminals } from './terminal.js';
import { Sessions } from './sessions.js';
import { diff, integrate, integrationPreview, reconcileTask } from './workspaces.js';
import { createProject } from './projects.js';
import { chooseFolder, FolderConnections, type FolderPicker } from './folder-picker.js';
import { PhoneAccess, type PhoneIdentity, type PhoneSession } from './phone-access.js';
import type { FastifyRequest } from 'fastify';
import type { PhoneTunnel } from './phone-tunnel.js';
import type { PhoneSetup } from './phone-setup.js';
import { SourceBackups, sourceBackupStatus } from './source-backups.js';
import { SourceBackupSetup } from './source-backup-setup.js';
import { registerRecoveryBackupRoutes } from './recovery-backups.js';
import { saveSchedulerSettings, schedulerStatus } from './scheduler.js';
import { historyPage, historyRead, latestRecovery, projectCatalog } from './history.js';
import { WorkspaceState } from './workspace-state.js';
import { Hosts, registerHostRoutes, proxyPath } from './hosts.js';
import { providerCatalog, requireEnabledProvider } from './providers.js';
import { recordCodexRateLimits, usageSummary } from './usage.js';
import { VscodeMirrors, registerMirrorRoutes } from './vscode-mirror.js';
import {
  createInterview,
  requireActiveAssignment,
  nativeDiscussionBoundary,
} from './interviews.js';
import { registerAgentClient, type prepareAgentClient } from './agent-client.js';
import type { LocalAccess } from './local-access.js';
import type { LocalRole } from '@dock/shared/dist/local-authorization.js';
import { projectTools } from './worker-tools.js';
import {
  browserDraftTransferSchema,
  localPage,
  restorePage,
  exportPage,
  importPage,
} from './local-browser-pages.js';

export async function createServer(
  store: Store,
  runtime: Runtime,
  options: {
    port: number;
    agentClient?: ReturnType<typeof prepareAgentClient>;
    localAccess?: LocalAccess;
    webDir?: string;
    devPort?: number;
    demo?: boolean;
    folderPicker?: FolderPicker;
    editorOpener?: ProjectEditorOpener;
    terminals?: Terminals;
    ownsRuntime?: boolean;
    phone?: PhoneAccess;
    tunnel?: Pick<PhoneTunnel, 'retry'>;
    phoneSetup?: PhoneSetup;
    repairPhoneListener?: () => Promise<void>;
    remote?: boolean;
    backups?: SourceBackups;
    backupSetup?: SourceBackupSetup;
    hosts?: Hosts;
    mirrors?: VscodeMirrors;
    /** Main owns startup/shutdown admission; embedded servers are ready by default. */
    ready?: () => boolean;
  },
) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 30_000 });
  const terminals = options.terminals ?? new Terminals(runtime);
  const phone = options.phone;
  if (options.remote && options.localAccess)
    throw new Error('The phone entry cannot accept local installation credentials.');
  if (options.remote && (!phone?.config || !options.terminals || options.ownsRuntime !== false))
    throw new Error('The remote entry requires phone configuration and the shared local runtime.');
  const remoteOrigin = options.remote ? phone!.config!.origin : null;
  const identities = new WeakMap<FastifyRequest, PhoneIdentity>();
  const phoneSessions = new WeakMap<FastifyRequest, PhoneSession>();
  const localRoles = new WeakMap<FastifyRequest, LocalRole>();
  const sessions = new Sessions(runtime);
  const workspace = new WorkspaceState(store);
  const backupSetup =
    options.backupSetup ??
    (options.backups && !options.demo ? new SourceBackupSetup(options.backups) : null);
  const requireWorkProject = (projectId: string) => {
    if (
      runtime.frontdesk.status().projectId === projectId ||
      runtime.conversationSearch.projectId() === projectId ||
      runtime.coordinator.identity()?.projectId === projectId
    )
      throw new Conflict(
        'Your assistant routes work to your selected projects. Choose a project manager for this action.',
      );
  };
  const folders = new FolderConnections(
    store,
    runtime.dataDir,
    options.remote
      ? null
      : (options.folderPicker ??
        (!options.demo && process.platform === 'darwin' ? chooseFolder : null)),
  );
  const streams = new Set<ServerResponse>();
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
      error instanceof ZodError
        ? 400
        : error instanceof Missing
          ? 404
          : error instanceof Conflict
            ? 409
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
    const message =
      error instanceof ZodError
        ? 'The request does not match the input contract.'
        : error instanceof Error
          ? runtime.errorText(error)
          : 'The operation failed.';
    reply.code(status).send({ error: message });
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
                instanceId: createHash('sha256').update(resolve(runtime.dataDir)).digest('hex'),
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
      request.headers['x-dock-target-host'] !== workspace.hostId
    )
      return reply.code(409).send({
        error: 'This request belongs to a different computer. Nothing was changed.',
        code: 'HOST_MISMATCH',
      });
    if (options.remote) {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${remoteOrigin!.replace('https:', 'wss:')}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
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
        (['/api/health', '/api/host-info', '/api/local-access/proof'].includes(path) || !isApi);
      const separateClient =
        path.startsWith('/api/agent-client/') &&
        request.routeOptions.url?.startsWith('/api/agent-client/');
      const bridge = path === '/api/vscode/bridge';
      const allowed = bridge
        ? !options.remote // Native loopback/origin checks remain in the bridge route.
        : role === 'owner' ||
          (browserOrigins.has(expected) && access.browser(request.headers.cookie)) ||
          (role === 'host' &&
            proxyPath(request.method, request.url.slice(4), !!request.headers.upgrade) ===
              request.url);
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
  if (options.hosts)
    registerHostRoutes(app, options.hosts, {
      watch: (request, close) => {
        const session = phoneSessions.get(request);
        return session ? phone!.watch(session, close) : () => {};
      },
    });
  const agentId = (params: unknown) => z.object({ id }).parse(params).id;
  registerRecoveryBackupRoutes(app, store, runtime.dataDir);
  registerProjectWorkflowRoutes(app, store, runtime.modelPolicy);
  registerWorkItemRoutes(app, runtime.workItems, () => runtime.kick());
  app.post('/api/projects/:id/open-in-editor', async (request) => {
    const project = store.project(agentId(request.params));
    const { key } = projectEditorOpenSchema.parse(request.body);
    return runtime.withLock(`project-editor:${project.id}`, () =>
      store.externalOperation(
        key,
        { kind: 'project.open-editor', projectId: project.id },
        async () => {
          await (options.editorOpener ?? openProjectEditor)(project.root);
          store.event('project.editor_opened', project.id, null, {});
          return { opened: true, message: 'Opened in VS Code on this project’s computer.' };
        },
      ),
    );
  });
  registerConversationRoutes(app, store, runtime.modelPolicy, runtime.dataDir, (key, fn) =>
    runtime.withLock(key, fn),
  );
  const mirrors = options.mirrors ?? new VscodeMirrors(store);
  if (!options.remote) runtime.conversationSearchMirrorWindows = () => mirrors.windows();
  registerMirrorRoutes(app, mirrors, !!options.remote);
  registerConversationSearchRoutes(app, runtime.conversationSearch, () => runtime.kick());
  if (phone) {
    app.post('/api/phone/setup/check', async (request, reply) => {
      if (options.remote || options.demo || !options.phoneSetup)
        return reply.code(403).send({ error: 'Set up the phone connection on its computer.' });
      z.object({}).strict().parse(request.body);
      return options.phoneSetup.check();
    });
    app.post('/api/phone/setup/confirm', async (request, reply) => {
      if (options.remote || options.demo || !options.phoneSetup)
        return reply.code(403).send({ error: 'Set up the phone connection on its computer.' });
      return runtime.withLock('phone:setup', () => options.phoneSetup!.configure(request.body));
    });
    app.post('/api/phone/reconnect', async (_request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Manage phone access on your computer.' });
      if (phone.setupIssue === 'listener') await options.repairPhoneListener?.();
      await options.tunnel?.retry();
      return phone.status(false);
    });
    app.get('/api/phone/status', async (request, reply) => {
      if (options.remote) {
        const renewed = phone.pairedDevices?.renewedCookies(request.headers.cookie);
        if (renewed?.length) reply.header('Set-Cookie', renewed);
      }
      return phone.status(!!options.remote, phoneSessions.has(request), request.headers.cookie);
    });
    {
      const paired = () => {
        if (!phone.pairedDevices) throw new Conflict('Finish passkey phone setup first.');
        return phone.pairedDevices;
      };
      app.post('/api/phone/setup/complete', async (request, reply) => {
        if (!options.remote)
          return reply.code(403).send({ error: 'Change these settings on your paired phone.' });
        const devices = paired();
        const cookies = request.headers.cookie;
        const renewed = devices.completeSetup(request.body, cookies, phoneSessions.get(request));
        return reply
          .header('Set-Cookie', renewed)
          .send(phone.status(true, !!devices.session(cookies), cookies));
      });
      for (const action of ['enroll/options', 'enroll/finish']) {
        app.post(`/api/phone/${action}`, async (request, reply) => {
          if (!options.remote)
            return reply
              .code(403)
              .send({ error: 'Use your phone address for device verification.' });
          const devices = paired();
          const cookies = request.headers.cookie;
          if (action === 'enroll/options') {
            const result = await devices.begin(request.body, cookies);
            return reply.header('Set-Cookie', result.cookie).send(result.options);
          }
          return devices.finish(request.body, cookies);
        });
      }
      app.post('/api/phone/confirm', async (request, reply) => {
        if (options.remote)
          return reply.code(403).send({ error: 'Confirm pairing on your computer.' });
        paired().confirm(request.body);
        return phone.status(false);
      });
      app.post('/api/phone/enrollment/close', async (request, reply) => {
        if (options.remote)
          return reply.code(403).send({ error: 'Manage pairing on your computer.' });
        z.object({}).strict().parse(request.body);
        paired().closeEnrollment();
        return phone.status(false);
      });
    }
    app.post('/api/phone/pair', async (request, reply) => {
      if (!options.remote)
        return reply.code(403).send({ error: 'Open your phone address to pair a device.' });
      const result = phone.pair(identities.get(request)!, request.body);
      return reply.header('Set-Cookie', result.cookie).send({ ok: true });
    });
    app.post('/api/phone/code', async (request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Create pairing codes on your computer.' });
      return phone.issueCode(phoneCodeRequestSchema.parse(request.body).key);
    });
    app.post('/api/phone/enabled', async (request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Manage phone access on your computer.' });
      phone.setEnabled(phoneEnabledSchema.parse(request.body).enabled);
      return phone.status(false);
    });
    app.post('/api/phone/devices/:id/revoke', async (request, reply) => {
      if (options.remote)
        return reply.code(403).send({ error: 'Disconnect devices on your computer.' });
      z.object({}).strict().parse(request.body);
      phone.revoke(agentId(request.params));
      return phone.status(false);
    });
  }
  registerAgentClient(app, runtime, options.remote ? undefined : options.agentClient);
  app.get('/api/health', async () => ({
    ok: true,
    pid: process.pid,
    demo: !!options.demo,
    provider: runtime.health,
  }));
  const readSnapshot = () =>
    snapshotSchema.parse({
      backups: store.projects().map((project) => sourceBackupStatus(store, project.id)),
      projects: store.projects().map((p) =>
        projectSchema.parse({
          ...p,
          internal:
            p.internal === true ||
            runtime.resources.projectId() === p.id ||
            runtime.conversationSearch.projectId() === p.id ||
            runtime.frontdesk.status().projectId === p.id ||
            runtime.coordinator.identity()?.projectId === p.id ||
            !!store.agent(p.managerId).surface,
        }),
      ),
      agents: store.agents().map((a) => agentSchema.parse(a)),
      tasks: store.tasks().map(publicTask),
      approvals: store
        .approvals()
        .filter((a) => a.status === 'pending')
        .map((a) => approvalSchema.parse(a)),
      decisions: store
        .decisions()
        .slice(-200)
        .map((d) => decisionSchema.parse(d)),
      eventId: store.head,
      provider: runtime.health,
    });
  app.get('/api/snapshot', async () => readSnapshot());
  app.get('/api/local-access/status', async () => ({ enabled: !!options.localAccess }));
  app.get('/api/frontdesk', async () => runtime.frontdesk.status());
  app.post('/api/frontdesk/start', async (request) => runtime.frontdesk.create(request.body));
  app.post('/api/frontdesk/settings', async (request) => runtime.frontdesk.save(request.body));
  app.get('/api/host-info', async () => ({
    hostId: workspace.hostId,
    protocolVersion: 1,
    localAuthentication: !!options.localAccess,
    // An installation hint for the local launcher, not authentication or a filesystem API.
    instanceId: createHash('sha256').update(resolve(runtime.dataDir)).digest('hex'),
  }));
  app.post('/api/workspace/clients', async (request) => workspace.register(request.body));
  app.get('/api/workspace/:id', async (request) => workspace.snapshot(agentId(request.params)));
  app.post('/api/workspace/:id', async (request) =>
    workspace.update(agentId(request.params), request.body),
  );
  app.post('/api/workspace/:id/restore', async (request) => {
    const { hostId } = z.object({ hostId: id }).strict().parse(request.body);
    if (hostId !== workspace.hostId)
      throw new Conflict('Open the original computer to restore this workspace.');
    return runtime.restoreSessions(workspace.snapshot(agentId(request.params)).client.openAgentIds);
  });
  app.get('/api/workspace/:id/drafts/:agentId', async (request) => {
    const value = z.object({ id, agentId: id }).parse(request.params);
    return workspace.drafts(value.id, value.agentId);
  });
  app.get('/api/workspace/:id/drafts/:agentId/history', async (request) => {
    const value = z.object({ id, agentId: id }).parse(request.params);
    const query = z
      .object({
        before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .parse(request.query);
    return workspace.draftHistory(value.id, value.agentId, query.before);
  });
  app.post('/api/workspace/:id/drafts/:agentId', async (request) => {
    const value = z.object({ id, agentId: id }).parse(request.params);
    return workspace.saveDraft(value.id, value.agentId, request.body);
  });
  app.post('/api/projects/:id/history', async (request) =>
    historyPage(store, agentId(request.params), request.body),
  );
  app.post('/api/projects/:id/history/read', async (request) =>
    historyRead(store, agentId(request.params), request.body),
  );
  app.post('/api/projects/:id/catalog', async (request) =>
    projectCatalog(store, agentId(request.params), request.body),
  );
  app.get('/api/agents/:id/recovery', async (request) => {
    const agent = store.agent(agentId(request.params));
    return latestRecovery(store, agent.projectId, agent.id);
  });
  app.get('/api/attention', async () => attention(readSnapshot()));
  app.get('/api/project-rates', async () => runtime.quark.projectRates());
  app.get('/api/capacity', async () => runtime.capacity.status());
  app.get('/api/resources', async () => runtime.resources.status());
  app.post('/api/resources/settings', async (request) => {
    if (options.demo)
      throw new Conflict('Automatic resource checks are configured in your real installation.');
    return runtime.resources.save(request.body);
  });
  app.post('/api/resources/ask', async (request) => {
    if (options.demo) throw new Conflict('The resource assistant runs in your real installation.');
    const result = await runtime.resources.ask(request.body);
    runtime.kick();
    return result;
  });
  app.post('/api/resources/stop', async (request) => runtime.resources.stop(request.body));
  app.get('/api/pulsar', async () => runtime.pulsar.status());
  app.get('/api/providers/:provider/maintenance', async (request) => {
    const provider = providerIdSchema.parse((request.params as { provider: string }).provider);
    return runtime.providerMaintenance.status(provider);
  });
  app.post('/api/providers/update', async (request) => {
    if (options.demo) throw new Conflict('Provider updates run only in your real installation.');
    return runtime.providerMaintenance.request(request.body);
  });
  app.post('/api/providers/check', async (request) => {
    const { provider } = providerMaintenanceRequestSchema.parse(request.body);
    await runtime.capacity.refresh(provider);
    return runtime.setup.refresh(provider);
  });
  app.get('/api/quark/coordinator', async () => runtime.coordinator.status());
  registerQuarkFocusRoutes(app, new QuarkFocus(store, runtime.coordinator), () => runtime.kick());
  app.get('/api/projects/:id/quark', async (request) =>
    runtime.coordinator.projectPolicy(agentId(request.params)),
  );
  app.post('/api/projects/:id/quark', async (request) => {
    const policy = runtime.coordinator.saveProjectPriority(agentId(request.params), request.body);
    runtime.kick();
    return policy;
  });
  app.post('/api/quark/coordinator/start', async (request) =>
    runtime.withLock('quark:settings', () => runtime.coordinator.start(request.body)),
  );
  app.post('/api/quark/coordinator/settings', async (request) =>
    runtime.withLock('quark:settings', async () => {
      const previous = runtime.coordinator.identity()?.agentId;
      const result = await runtime.coordinator.save(request.body);
      if (previous) await runtime.reconnectTools(previous);
      return result;
    }),
  );
  app.get('/api/quark', async () => runtime.quark.status());
  app.post('/api/quark/settings', async (request) => {
    runtime.quark.saveSettings(request.body);
    runtime.kick();
    return runtime.quark.status();
  });
  app.post('/api/quark/budgets', async (request) => {
    runtime.quark.saveBudget(request.body);
    runtime.kick();
    return runtime.quark.status();
  });
  app.post('/api/quark/resume', async (request) => {
    const input = quotaResumeSchema.parse(request.body);
    store.operation(input.key, { kind: 'quark.resume', ...input }, () => {
      runtime.quark.release(input.runId);
      return { resumed: true };
    });
    runtime.kick();
    return runtime.quark.status();
  });
  app.get('/api/local-jobs', async () => runtime.localJobs.status());
  app.post('/api/local-jobs', async (request) => {
    if (options.demo)
      throw new Conflict(
        'Local transcription runs in your real installation, not demonstration mode.',
      );
    const job = runtime.localJobs.create(request.body);
    runtime.kick();
    return job;
  });
  app.post('/api/local-jobs/control', async (request) => {
    const job = await runtime.localJobs.control(request.body);
    runtime.kick();
    return job;
  });
  app.post('/api/local-jobs/read', async (request) => runtime.localJobs.read(request.body));
  app.post('/api/pulsar/policy', async (request) => {
    runtime.pulsar.savePolicy(request.body);
    runtime.kick();
    return runtime.pulsar.status();
  });
  app.post('/api/pulsar/jobs', async (request) => {
    runtime.pulsar.control(request.body);
    runtime.kick();
    return runtime.pulsar.status();
  });
  app.post('/api/capacity/refresh', async (request) => {
    const input = capacityRefreshSchema.parse(request.body);
    if (options.demo) return runtime.capacity.status();
    return runtime.capacity.refresh(input.provider);
  });
  app.get('/api/scheduler', async () => schedulerStatus(store, runtime.externalControl));
  app.post('/api/scheduler/settings', async (request) => {
    saveSchedulerSettings(store, request.body);
    runtime.kick();
    return schedulerStatus(store, runtime.externalControl);
  });
  app.post('/api/projects', async (request, reply) => {
    const input = projectCreateSchema.parse(request.body);
    const project = await runtime.withLock(`project-create:${input.key}`, () =>
      createProject(store, runtime.dataDir, input),
    );
    return reply.code(201).send(project);
  });
  app.post('/api/projects/:id/backup/retry', async (request) => {
    const projectId = agentId(request.params);
    const { key } = z.object({ key: id }).strict().parse(request.body);
    store.project(projectId);
    if (!options.backups || !sourceBackupStatus(store, projectId).configured)
      throw new Conflict(
        'Ask your setup agent to connect this project to its private GitHub backup.',
      );
    return store.operation(key, { kind: 'backup.retry', projectId }, () => {
      options.backups!.retry(projectId);
      return { queued: true };
    });
  });
  app.get('/api/projects/:id/backup/setup', async (request) => {
    if (!backupSetup) throw new Conflict('Source backup setup is not available on this computer.');
    return {
      ...backupSetup.status(agentId(request.params)),
      canSignIn:
        !options.remote && localRoles.get(request) !== 'host' && process.platform === 'darwin',
    };
  });
  app.post('/api/projects/:id/backup/sign-in', async (request) => {
    if (
      !backupSetup ||
      options.remote ||
      localRoles.get(request) === 'host' ||
      process.platform !== 'darwin'
    )
      throw new Conflict(
        'Open source backup setup on the Mac running this project to sign in to GitHub.',
      );
    return backupSetup.signIn(agentId(request.params), request.body);
  });
  app.post('/api/projects/:id/backup/preview', async (request) => {
    if (!backupSetup) throw new Conflict('Source backup setup is not available on this computer.');
    const projectId = agentId(request.params);
    requireWorkProject(projectId);
    return runtime.withLock(`backup-setup:${projectId}`, () =>
      backupSetup.preview(projectId, request.body),
    );
  });
  app.post('/api/projects/:id/backup/connect', async (request) => {
    if (!backupSetup) throw new Conflict('Source backup setup is not available on this computer.');
    const projectId = agentId(request.params);
    requireWorkProject(projectId);
    return runtime.withLock(`backup-setup:${projectId}`, () =>
      backupSetup.connect(projectId, request.body),
    );
  });
  app.get('/api/project-options', async () =>
    projectOptionsSchema.parse({ canChooseFolder: true, folderBrowser: true }),
  );
  app.get('/api/project-folders', async (request) => {
    const { folderId, offset } = folderBrowseRequestSchema.parse(request.query);
    return folderBrowseSchema.parse(await folders.browser.browse(folderId, offset));
  });
  app.post('/api/projects/connect-folder', async (request) => {
    const { key, provider, selectOnly, folderId } = projectFolderSchema.parse(request.body);
    const project = await folders.connect(key, provider, selectOnly, folderId);
    return projectConnectionSchema.parse({
      project,
      ...(selectOnly
        ? { selection: folders.selection(key) }
        : project
          ? {}
          : { tracking: folders.tracking(key) }),
    });
  });
  app.post('/api/projects/track-folder', async (request) => {
    const { key } = projectTrackingRequestSchema.parse(request.body);
    return runtime.withLock('folder-tracking', async () =>
      projectConnectionSchema.parse({ project: await folders.track(key) }),
    );
  });
  app.get('/api/agents/:id', async (request) => {
    const target = agentId(request.params);
    const { before } = z.object({ before: z.string().max(120).optional() }).parse(request.query);
    const entries = store.entries(target, before, 200);
    const agent = store.agent(target);
    return detailSchema.parse({
      agent: agentSchema.parse(agent),
      nativeDiscussion:
        agent.interview?.continuity === 'native-fork' &&
        agent.threadId &&
        (agent.provider !== 'claude' ||
          store.getSetting(`claude:started:${agent.threadId}`) === true)
          ? 'prepared'
          : nativeDiscussionBoundary(store, agent)
            ? 'available'
            : undefined,
      entries,
      runs: store
        .runs()
        .filter((r) => r.agentId === target)
        .slice(-50)
        .map((r) => runSchema.parse(r)),
      hasMore: entries.length === 200,
    });
  });
  app.get('/api/models', async (request) => {
    const { agentId: selectedAgent, provider } = z
      .object({ agentId: id.optional(), provider: z.enum(['codex', 'claude']).optional() })
      .strict()
      .parse(request.query);
    return z
      .array(modelSchema)
      .parse(
        await runtime.modelPolicy.catalog(
          provider ?? (selectedAgent ? store.agent(selectedAgent).provider : 'codex'),
        ),
      );
  });
  app.get('/api/providers', async () => providerCatalog());
  app.get('/api/model-policy', async () => runtime.modelPolicy.status());
  app.get('/api/setup', async () => runtime.setup.status());
  app.post('/api/setup/check', async (request) => {
    z.object({}).strict().parse(request.body);
    return runtime.setup.refresh();
  });
  app.get('/api/setup/sign-in', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runtime.codexSignIn.status();
  });
  app.post('/api/setup/sign-in', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runtime.codexSignIn.start(request.body);
  });
  app.post('/api/setup/sign-in/cancel', async (request) =>
    runtime.codexSignIn.cancel(request.body),
  );
  app.get('/api/setup/claude-sign-in', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return options.demo ? { available: false, attempt: null } : runtime.claude.signInStatus();
  });
  app.post('/api/setup/claude-sign-in', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.demo) throw new Conflict('Claude sign-in opens from your real installation.');
    return runtime.withLock('setup:claude-sign-in', () => runtime.claude.signIn(request.body));
  });
  app.post('/api/model-policy', async (request) => runtime.modelPolicy.save(request.body));
  app.post('/api/model-policy/catalogs', async () => runtime.modelPolicy.refresh());
  app.get('/api/agents/:id/usage', async (request) => {
    const agent = store.agent(agentId(request.params));
    return usageSummary(store, agent.projectId, agent.id);
  });
  app.post('/api/agents/:id/usage/refresh', async (request) => {
    const agent = store.agent(agentId(request.params));
    const { key } = z.object({ key: id }).strict().parse(request.body);
    runtime.requireDirectControl(agent.id);
    requireEnabledProvider(agent.provider);
    if (agent.provider === 'claude')
      throw new Conflict(
        'Claude reports tokens after each reply. Subscription quota refresh is not available here; check Claude’s native usage view.',
      );
    // Read-only provider metadata: never create a thread, turn, reset credit or
    // account login. A failed read may safely be explicitly retried.
    return runtime.withLock(`usage-refresh:${agent.id}`, async () => {
      const receipt = store.db.prepare('SELECT input, result FROM operations WHERE key=?').get(key);
      const input = { kind: 'usage.refresh', agentId: agent.id };
      if (receipt) {
        if (receipt.input !== JSON.stringify(input))
          throw new Conflict('This retry key belongs to another action.');
        // Receipt prevents a duplicate provider read, but freshness is evaluated
        // now. An old successful response is not proof the old quota is current.
        return usageSummary(store, agent.projectId, agent.id);
      }
      let raw: unknown;
      try {
        const client = await runtime.client(agent);
        raw = await client.request('account/rateLimits/read', {});
      } catch {
        throw new Conflict(
          'Usage could not be refreshed. Previously reported values are retained; you can retry.',
        );
      }
      return store.operation(key, input, () => {
        if (recordCodexRateLimits(store, agent.id, raw, 'read', key).status === 'ignored')
          throw new Conflict(
            'This provider did not report supported usage limits. Availability remains unknown.',
          );
        return usageSummary(store, agent.projectId, agent.id);
      });
    });
  });
  app.get('/api/agents/:id/images/:imageId', async (request, reply) => {
    const params = z.object({ id, imageId: id }).parse(request.params);
    const bytes = store.image(params.id, params.imageId);
    return reply
      .type('image/png')
      .header('Content-Disposition', `inline; filename="generated-${params.imageId}.png"`)
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .send(bytes);
  });
  app.get('/api/agents/:id/receipts/:key', async (request) => {
    const params = z.object({ id, key: id }).parse(request.params);
    store.agent(params.id);
    const key = workspace.receiptKey(params.id, params.key);
    const run = store.runs().find((r) => r.key === key && r.agentId === params.id);
    const external = z
      .object({ input: z.string(), state: z.string() })
      .passthrough()
      .safeParse(store.getSetting(`external:${key}`));
    let submitted: { text: string; steer: boolean } | null = run
      ? { text: run.text, steer: false }
      : null;
    if (!submitted && external.success && external.data.state === 'complete') {
      try {
        const intent = z
          .object({ kind: z.literal('steer'), agentId: z.literal(params.id), text: z.string() })
          .strict()
          .parse(JSON.parse(external.data.input));
        submitted = { text: intent.text, steer: true };
      } catch {
        /* Only the exact confirmed agent submission is a receipt. */
      }
    }
    return { run: run ? runSchema.parse(run) : null, submitted };
  });
  app.post('/api/agents/:id/interviews', async (request) => {
    const target = agentId(request.params);
    // A finished native worker can still have a separate evidence discussion. Only the
    // bounded search helper must not become a new unrestricted continuation entry.
    if (runtime.conversationSearch.isAgent(target)) runtime.requireDirectControl(target);
    return createInterview(store, target, request.body);
  });
  app.post('/api/agents/:id/messages', async (request, reply) => {
    const target = agentId(request.params);
    runtime.requireDirectControl(target);
    const value = sendSchema.parse(request.body);
    const agent = store.agent(target);
    if (terminals.active(target))
      throw new Conflict('Return from the native terminal before sending from chat.');
    // This endpoint sends literal text. Native slash commands use their separate
    // controls; file paths and explicit literal messages must remain sendable.
    if (value.steer) {
      requireActiveAssignment(store, agent);
      if (agent.provider !== 'codex')
        throw new Conflict(
          'For Claude, stop the current reply or send your next message as a follow-up. Live steering is not enabled.',
        );
      return runtime.withLock(target, async () => {
        const candidate = value.draft?.deliveryKey ?? value.key;
        if (!store.getSetting(`external:${candidate}`)) {
          const current = store.agent(target);
          if (!current.threadId || !current.turnId)
            return reply.code(409).send({
              code: 'NO_ACTIVE_TURN',
              error:
                'That reply finished before your update could be sent. Your draft is retained.',
            });
          if (!runtime.clients.get(target)?.ready) throw new Conflict('Codex is disconnected.');
        }
        const key = value.draft
          ? store.transaction(() =>
              workspace.reserveSubmission(target, value.draft, value.key, value.text, 'steer'),
            )
          : value.key;
        return store.externalOperation(
          key,
          { kind: 'steer', agentId: target, text: value.text },
          async () => {
            const agent = store.agent(target);
            if (!agent.threadId || !agent.turnId)
              throw new Conflict('There is no running turn to steer.');
            const client = runtime.clients.get(target);
            if (!client?.ready) throw new Conflict('Codex is disconnected.');
            await client.request('turn/steer', {
              threadId: agent.threadId,
              expectedTurnId: agent.turnId,
              input: [{ type: 'text', text: value.text, text_elements: [] }],
            });
            runtime.system(target, 'Owner steering', value.text);
            return { status: 'submitted' };
          },
        );
      });
    }
    const result = store.transaction(() => {
      const key = value.draft
        ? workspace.reserveSubmission(target, value.draft, value.key, value.text)
        : value.key;
      // A receipt-only retry must not unpause later interrupted/queued work.
      if (store.runs().some((run) => run.key === key))
        return store.enqueue(target, key, value.text);
      requireActiveAssignment(store, store.agent(target));
      if (['failed', 'interrupted', 'waiting'].includes(agent.status) && !agent.turnId)
        store.updateAgent(target, { status: 'idle', autoTurns: 0 });
      const run = store.enqueue(target, key, value.text);
      if (value.scheduling) store.setSetting(`pulsar:estimate:${run.id}`, value.scheduling);
      return run;
    });
    runtime.kick();
    return reply.code(202).send(result);
  });
  app.post('/api/agents/:id/commands', async (request) => {
    const target = agentId(request.params);
    const { command, key } = commandSchema.parse(request.body);
    if (command !== 'interrupt') runtime.requireDirectControl(target);
    if (terminals.active(target))
      throw new Conflict('Return from the native terminal before using chat controls.');
    return runtime.withLock(`command:${target}`, () =>
      store.externalOperation(key, { kind: 'command', agentId: target, command }, async () => {
        if (command === 'interrupt') await runtime.interrupt(target);
        if (command === 'new') await runtime.newContext(target);
        if (command === 'compact') {
          await runtime.compact(target);
        }
        if (command === 'resume') {
          const agent = store.agent(target);
          requireActiveAssignment(store, agent);
          if (agent.turnId) throw new Conflict('This agent is already running.');
          store.transaction(() => {
            store.updateAgent(target, { status: 'idle', autoTurns: 0 });
            store.enqueue(
              target,
              key,
              'Resume from the saved state. Inspect actual task/worktree state first. Do not repeat uncertain side effects. Continue the last unfinished objective if possible, and report any blocker.',
              'resume',
            );
          });
          runtime.kick();
        }
        return { ok: true };
      }),
    );
  });
  app.get('/api/projects/:id/worker-tools', async (request) =>
    projectTools(store, agentId(request.params)),
  );
  app.get('/api/projects/:id/worker-tools/catalog', async (request) =>
    mcpCatalogSchema.parse(await runtime.projectMcpCatalog(agentId(request.params))),
  );
  app.post('/api/projects/:id/worker-tools', async (request) => {
    const projectId = agentId(request.params);
    const value = projectToolsRequestSchema.parse(request.body);
    const input = { kind: 'project.worker-tools', projectId, ...value };
    return runtime.withLock(`project-tools:${projectId}`, async () => {
      const saved = store.db.prepare('SELECT key FROM operations WHERE key=?').get(value.key);
      if (saved) return store.operation(value.key, input, () => projectTools(store, projectId));
      const previous = projectTools(store, projectId);
      if (previous.revision !== value.revision)
        throw new Conflict(
          'Worker tool settings changed in another tab. Reload the saved settings before changing them.',
        );
      // Returning to native settings retains the old ceiling for explicit requests.
      // It neither grants dormant tools nor depends on an optional inventory probe.
      const codex = value.toolPolicy === 'native' ? previous.codex : value.codex;
      const added = codex.mcpServers.filter((name) => !previous.codex.mcpServers.includes(name));
      if (added.length) {
        const catalog = await runtime.projectMcpCatalog(projectId);
        if (added.some((name) => !catalog.some((server) => server.name === name)))
          throw new Conflict('Select MCP servers from this computer’s configured Codex catalog.');
      }
      return store.operation(value.key, input, () => {
        if (projectTools(store, projectId).revision !== value.revision)
          throw new Conflict('Worker tool settings changed. Reload the saved settings first.');
        const policy = projectToolsSchema.parse({
          revision: previous.revision + 1,
          toolPolicy: value.toolPolicy ?? 'restricted',
          codex,
          updatedAt: new Date().toISOString(),
        });
        store.setSetting(`worker-tools:${projectId}`, policy);
        store.event('project.worker-tools', projectId, null, policy);
        return policy;
      });
    });
  });
  app.get('/api/agents/:id/mcp', async (request) =>
    mcpCatalogSchema.parse(await runtime.mcpCatalog(agentId(request.params))),
  );
  app.post('/api/agents/:id/settings', async (request) => {
    const target = agentId(request.params);
    const settings = settingsSchema.parse(request.body);
    const agent = store.agent(target);
    const snapshotModelChange =
      runtime.resources.isSnapshot(target) &&
      runtime.resources.canChooseModel(target) &&
      settings.permission === 'read-only' &&
      (settings.toolPolicy ?? agent.toolPolicy) === 'restricted' &&
      !settings.pluginsEnabled &&
      !settings.imageGeneration &&
      !settings.mcpServers?.length &&
      (!settings.webSearch || settings.webSearch === 'disabled');
    if (!snapshotModelChange) runtime.requireDirectControl(target);
    if (
      agent.interview &&
      (settings.permission !== 'read-only' ||
        settings.toolPolicy === 'native' ||
        settings.pluginsEnabled ||
        settings.imageGeneration ||
        settings.mcpServers?.length ||
        (settings.webSearch && settings.webSearch !== 'disabled'))
    )
      throw new Conflict(
        'Questions about past work stay read-only, without plugins or external tools.',
      );
    const provider = settings.provider ?? agent.provider;
    // Older clients explicitly saving per-tool controls keep their meaning.
    // Model-only edits do not silently migrate a conversation's capabilities.
    const toolPolicy =
      settings.toolPolicy ??
      (['mcpServers', 'pluginsEnabled', 'webSearch', 'imageGeneration'].some((key) =>
        Object.hasOwn(settings, key),
      )
        ? 'restricted'
        : (agent.toolPolicy ?? 'restricted'));
    const inherits = toolPolicy === 'native';
    if (inherits && runtime.resources.isSnapshot(target))
      throw new Conflict('The resource assistant remains a bounded read-only check.');
    if (inherits && runtime.frontdesk.isFrontdesk(target))
      throw new Conflict(
        'The personal assistant keeps its selected-project privacy boundary. Use a project manager for native work.',
      );
    requireEnabledProvider(provider);
    if (provider !== agent.provider)
      throw new Conflict(
        'A saved conversation keeps its provider. Create a new agent to use another provider.',
      );
    if (
      !inherits &&
      provider === 'claude' &&
      (settings.mcpServers?.length ||
        settings.pluginsEnabled ||
        settings.imageGeneration ||
        (settings.webSearch && settings.webSearch !== 'disabled'))
    )
      throw new Conflict(
        'Managed Claude supports restricted project tools. External MCPs, plugins, web and images remain in the native Claude app.',
      );
    if (!inherits && agent.role === 'manager' && settings.pluginsEnabled)
      throw new Conflict('Managers delegate plugin use to workers.');
    if (
      !inherits &&
      agent.role === 'manager' &&
      settings.webSearch &&
      settings.webSearch !== 'disabled'
    )
      throw new Conflict('Managers delegate web research to workers.');
    if (!inherits && agent.role === 'manager' && settings.imageGeneration)
      throw new Conflict('Managers delegate image generation to workers.');
    if (['running', 'waiting', 'queued'].includes(agent.status) || terminals.active(target))
      throw new Conflict('Change settings when the agent is idle.');
    if (
      agent.role !== 'implementer' &&
      !(
        agent.role === 'manager' &&
        !runtime.frontdesk.isFrontdesk(target) &&
        !runtime.coordinator.isAgent(target) &&
        !runtime.resources.isSnapshot(target) &&
        !runtime.conversationSearch.isAgent(target)
      ) &&
      !agent.surface &&
      !runtime.resources.isInteractive(target) &&
      settings.permission !== 'read-only'
    )
      throw new Conflict('This read-only role cannot receive workspace write permission.');
    const catalog = await runtime.modelPolicy.catalog(provider);
    const resolved = settings.model
      ? null
      : await runtime.modelPolicy.resolve(
          agent.assignment?.taskClass ??
            (agent.surface ? 'reasoning' : agent.role === 'manager' ? 'manager' : 'reasoning'),
          { mode: 'automatic', provider, difficulty: 'unspecified' },
        );
    const model = catalog.find((m) => m.id === (settings.model ?? resolved?.model));
    if (!model || !model.efforts.includes(resolved?.effort ?? settings.effort))
      throw new Conflict('Select a model and reasoning level from the installed provider catalog.');
    if (!inherits && settings.mcpServers?.length) {
      if (agent.role === 'manager')
        throw new Conflict('Managers delegate external tool use to workers.');
      const catalog = await runtime.mcpCatalog(target);
      if (settings.mcpServers.some((name) => !catalog.some((s) => s.name === name)))
        throw new Conflict('Select MCP servers from the installed Codex configuration.');
    }
    return runtime.withLock('terminal-control', async () => {
      if (
        ['running', 'waiting', 'queued'].includes(store.agent(target).status) ||
        terminals.active(target)
      )
        throw new Conflict('Change settings when the agent is idle.');
      const previous = store.agent(target).mcpServers;
      const permissionChanged = settings.permission !== store.agent(target).permission;
      const policyChanged = toolPolicy !== store.agent(target).toolPolicy;
      const pluginsChanged =
        settings.pluginsEnabled !== undefined &&
        settings.pluginsEnabled !== store.agent(target).pluginsEnabled;
      const webSearchChanged =
        settings.webSearch !== undefined && settings.webSearch !== store.agent(target).webSearch;
      const imageGenerationChanged =
        settings.imageGeneration !== undefined &&
        settings.imageGeneration !== store.agent(target).imageGeneration;
      const updated = store.updateAgent(target, {
        ...settings,
        toolPolicy,
        model: model.id,
        modelSelection: settings.model === null ? 'policy' : 'exact',
        effort: resolved?.effort ?? settings.effort,
        assignment: resolved ?? agent.assignment,
      });
      store.setSetting(`model-policy:follow:${target}`, settings.model === null);
      if (
        provider === 'claude' ||
        permissionChanged ||
        policyChanged ||
        pluginsChanged ||
        webSearchChanged ||
        imageGenerationChanged ||
        JSON.stringify(previous) !== JSON.stringify(updated.mcpServers)
      )
        await runtime.reconnectTools(target, snapshotModelChange);
      return agentSchema.parse(updated);
    });
  });
  app.post('/api/approvals/:id', async (request) => {
    const value = approvalReplySchema.parse(request.body);
    await runtime.approve(agentId(request.params), value.decision, value.answers, value.formValues);
    return { ok: true };
  });
  app.post('/api/projects/:id/managers', async (request, reply) => {
    const projectId = agentId(request.params);
    requireWorkProject(projectId);
    const input = managerCreateSchema.parse(request.body);
    requireEnabledProvider(input.provider ?? 'codex');
    const result = store.operation(
      input.key,
      {
        kind: 'manager.create',
        projectId,
        name: input.name,
        scope: input.scope,
        ...(input.provider ? { provider: input.provider } : {}),
      },
      () => agentSchema.parse(store.addManager(projectId, input.name, input.scope, input.provider)),
    );
    return reply.code(201).send(result);
  });
  app.get('/api/projects/:id/sessions', async (request) => {
    requireWorkProject(agentId(request.params));
    const { cursor } = z
      .object({ cursor: z.string().min(1).max(4096).optional() })
      .strict()
      .parse(request.query);
    return sessions.list(agentId(request.params), cursor);
  });
  app.post('/api/projects/:id/sessions/import', async (request, reply) => {
    requireWorkProject(agentId(request.params));
    return reply
      .code(201)
      .send(agentSchema.parse(await sessions.import(agentId(request.params), request.body)));
  });
  app.post('/api/projects/:id/tasks', async (request, reply) => {
    const projectId = agentId(request.params);
    requireWorkProject(projectId);
    store.project(projectId);
    const input = taskRequestSchema.parse(request.body);
    const result = store.operation(
      input.key,
      { projectId, task: input.task, ...(input.managerId ? { managerId: input.managerId } : {}) },
      () => {
        if (input.task.parentId && store.task(input.task.parentId).projectId !== projectId)
          throw new Conflict('Parent task is outside this project.');
        const task = store.addTask(projectId, {
          ...input.task,
          managerId: input.managerId,
          parentId: input.task.parentId ?? null,
        });
        const run = store.enqueue(
          task.managerId,
          `task:${input.key}`,
          `Please manage task ${task.id}: ${task.title}. Outcome: ${task.goal}. Acceptance: ${task.acceptance}. Delegate the bounded work and bring back results.`,
        );
        store.setSetting(`pulsar:task:${run.id}`, task.id);
        return publicTask(task);
      },
    );
    // Receipts from before module managers retain their original task fields and
    // original (primary) manager while gaining the additive public ownership field.
    return reply.code(201).send(
      taskSchema.parse({
        ...result,
        managerId: result.managerId ?? store.project(projectId).managerId,
      }),
    );
  });
  app.post('/api/tasks/:id/cancel', async (request) =>
    runtime.cancelTask(agentId(request.params), request.body),
  );
  app.get('/api/tasks/:id/diff', async (request) => diff(store, agentId(request.params)));
  app.get('/api/tasks/:id/integration', async (request) =>
    integrationPreview(store, agentId(request.params)),
  );
  app.post('/api/tasks/:id/reconcile', async (request) => {
    const taskId = agentId(request.params);
    return runtime.withLock(`integrate:${store.task(taskId).projectId}`, async () => {
      const result = await reconcileTask(store, taskId, request.body);
      runtime.kick();
      return result;
    });
  });
  app.post('/api/tasks/:id/integrate', async (request) => {
    const target = agentId(request.params);
    const value = z
      .object({
        key: id,
        source: z.string().regex(/^[a-f0-9]{40,64}$/),
        target: z.string().regex(/^[a-f0-9]{40,64}$/),
      })
      .strict()
      .parse(request.body);
    return runtime.withLock(`integrate:${store.task(target).projectId}`, async () => {
      return store.externalOperation(
        value.key,
        { kind: 'integrate', taskId: target, source: value.source, target: value.target },
        async () => {
          if (
            store
              .agents()
              .some(
                (a) =>
                  a.taskId === target &&
                  (terminals.active(a.id) || ['running', 'queued', 'waiting'].includes(a.status)),
              )
          )
            throw new Conflict('Wait for all task sessions to be idle before integration.');
          return integrate(store, target, value);
        },
      );
    });
  });
  app.get('/api/agents/:id/export', async (request, reply) => {
    const target = agentId(request.params);
    const agent = store.agent(target);
    // Deliberate owner export. Only this registered agent's visible archive is included.
    const entries = store.db
      .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid')
      .all(target)
      .map((row) => JSON.parse(String(row.body)) as unknown);
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      agent: agentSchema.parse(agent),
      entries,
      decisions: store.decisions().filter((d) => d.agentId === target),
      runs: store
        .runs()
        .filter((r) => r.agentId === target)
        .map((r) => runSchema.parse(r)),
    };
    return reply
      .header('Content-Disposition', `attachment; filename="agent-${target}.json"`)
      .send(data);
  });
  app.get('/api/events', async (request, reply) => {
    const query = z
      .object({
        after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
      })
      .parse(request.query);
    const header = request.headers['last-event-id'];
    let cursor =
      header === undefined
        ? query.after
        : z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(header);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 1500\n\n');
    if (cursor > store.head) {
      reply.raw.write(`id: ${store.head}\nevent: reset\ndata: {}\n\n`);
      cursor = store.head;
    }
    const session = phoneSessions.get(request);
    const stopWatching = session ? phone!.watch(session, () => reply.raw.end()) : () => {};
    let pumping = false;
    const pump = () => {
      if (pumping || reply.raw.destroyed || reply.raw.writableEnded) return;
      pumping = true;
      try {
        let events = store.events(cursor);
        while (events.length) {
          for (const event of events) {
            // SSE is an invalidation stream. Fetch typed records; never serve private RPC payloads.
            if (
              !reply.raw.write(
                `id: ${event.id}\nevent: change\ndata: ${JSON.stringify({ type: event.type, projectId: event.projectId, agentId: event.agentId })}\n\n`,
              )
            ) {
              cursor = event.id;
              reply.raw.once('drain', pump);
              return;
            }
            cursor = event.id;
          }
          events = events.length === 300 ? store.events(cursor) : [];
        }
      } finally {
        pumping = false;
      }
    };
    store.on('event', pump);
    pump();
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
    }, 15_000);
    request.raw.on('close', () => {
      streams.delete(reply.raw);
      clearInterval(heartbeat);
      stopWatching();
      store.off('event', pump);
    });
  });
  app.get('/api/agents/:id/terminal', { websocket: true }, (socket, request) => {
    if (request.headers.origin !== (remoteOrigin ?? `http://${request.headers.host}`)) {
      socket.close(1008, 'Same-origin required');
      return;
    }
    const session = phoneSessions.get(request);
    if (session) {
      const stopWatching = phone!.watch(session, () => socket.terminate());
      socket.once('close', stopWatching);
    }
    void terminals.connect(agentId(request.params), socket).catch((error) => {
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: 'error', message: runtime.errorText(error) }));
      socket.close();
    });
  });
  app.post('/api/agents/:id/terminal/close', async (request) => {
    terminals.stop(agentId(request.params));
    return { ok: true };
  });
  if (options.webDir && existsSync(join(options.webDir, 'index.html'))) {
    // Preserve the no-store header set above. The static plugin's default cache
    // header otherwise replaces it, including on the app's entry document.
    await app.register(staticFiles, { root: options.webDir, cacheControl: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Unknown API route.' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('preClose', async () => {
    // Endless SSE responses must end before Fastify waits for active requests.
    // Otherwise an open browser prevents a normal service restart forever.
    for (const stream of streams) stream.end();
    streams.clear();
    if (options.ownsRuntime !== false) terminals.close();
    folders.close();
  });
  app.addHook('onClose', async () => {
    if (options.ownsRuntime !== false) {
      await options.hosts?.close();
      await runtime.close();
      store.close();
    }
  });
  return app;
}
