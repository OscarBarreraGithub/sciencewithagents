import { chooseFolder, FolderConnections, type FolderPicker } from './folder-picker.js';
import {
  folderBrowseSchema,
  folderBrowseRequestSchema,
  projectFolderSchema,
  projectConnectionSchema,
  projectOptionsSchema,
} from '@dock/shared';
import { distributionSchema } from '@dock/shared/dist/distribution.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { registerEntrySecurity } from './entry-security.js';
import { registerEntryPhoneRoutes } from './entry-phone-routes.js';
import { registerGroupHostRoutes } from './group-host-routes.js';
import type { LocalAccess } from './local-access.js';
import type { PhoneAccess } from './phone-access.js';
import type { GroupsServices } from './groups-services.js';

/** Narrow authenticated Groups entry. Unregistered full-SWA APIs fail with 404. */
export async function createGroupsServer(
  services: GroupsServices,
  options: {
    port: number;
    localAccess?: LocalAccess;
    phone?: PhoneAccess;
    remote?: boolean;
    devPort?: number;
    ready?: () => boolean;
    webDir?: string;
    folderPicker?: FolderPicker;
  },
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    requestTimeout: 30_000,
    keepAliveTimeout: 5000,
  });
  const security = await registerEntrySecurity(app, {
    ...options,
    dataDir: services.root,
    hostId: services.hostId,
    publicReadPaths: ['/api/distribution'],
    errorText: (error) => error.message,
  });
  const authenticated = (request: import('fastify').FastifyRequest) =>
    security.phoneSessions.has(request) ||
    security.localRoles.get(request) === 'owner' ||
    (!!options.localAccess &&
      security.browserOrigins.has(`http://${request.headers.host}`) &&
      options.localAccess.browser(request.headers.cookie));
  const folders = new FolderConnections(
    services.store,
    services.root,
    options.remote
      ? null
      : (options.folderPicker ?? (process.platform === 'darwin' ? chooseFolder : null)),
  );
  app.get('/api/project-options', async () =>
    projectOptionsSchema.parse({ canChooseFolder: true, folderBrowser: true }),
  );
  app.get('/api/project-folders', async (request) => {
    const { folderId, offset, ...input } = folderBrowseRequestSchema.parse(request.query);
    return folderBrowseSchema.parse(await folders.browser.browse(folderId, offset, input));
  });
  app.post('/api/projects/connect-folder', async (request) => {
    const input = projectFolderSchema
      .refine(
        (value) => value.selectOnly === true,
        'Groups selects folders without creating projects',
      )
      .parse(request.body);
    await folders.connect(input.key, undefined, true, input.folderId);
    return projectConnectionSchema.parse({
      project: null,
      selection: folders.selection(input.key),
    });
  });
  registerGroupHostRoutes(
    app,
    services.host,
    authenticated,
    folders,
    (request) =>
      !!request.headers.origin &&
      (options.remote
        ? request.headers.origin === security.remoteOrigin && security.phoneSessions.has(request)
        : !request.headers.authorization &&
          !!options.localAccess &&
          security.browserOrigins.has(request.headers.origin) &&
          security.browserOrigins.has(`http://${request.headers.host}`) &&
          options.localAccess.browser(request.headers.cookie)),
    services.sharing,
    { workspace: services.files, git: services.files },
  );
  // Hosted Groups phone pairing is independent. Retain existing owner device authentication.
  const locks = new Map<string, Promise<unknown>>();
  registerEntryPhoneRoutes(
    app,
    {
      ...options,
      withLock: async (key, body) => {
        const prior = locks.get(key) ?? Promise.resolve();
        const next = prior.catch(() => {}).then(body);
        locks.set(key, next);
        try {
          return await next;
        } finally {
          if (locks.get(key) === next) locks.delete(key);
        }
      },
    },
    security.phoneSessions,
    security.identities,
  );
  app.get('/api/distribution', async () =>
    distributionSchema.parse({ distribution: 'groups-only' }),
  );
  app.get('/api/health', async () => ({
    ok: true,
    pid: process.pid,
    distribution: 'groups-only',
    demo: false,
  }));
  app.get('/api/host-info', async () => ({
    hostId: services.hostId,
    protocolVersion: 1,
    localAuthentication: !!options.localAccess,
    distribution: 'groups-only',
    instanceId: createHash('sha256').update(resolve(services.root)).digest('hex'),
  }));
  app.get('/api/local-access/status', async () => ({ enabled: !!options.localAccess }));
  const streams = new Set<ServerResponse>();
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 1500\n\n');
    // Only ephemeral group hints; personal Store history is never replayed here.
    const unsubscribe = services.host.updates.subscribe((update) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded && !reply.raw.writableNeedDrain)
        reply.raw.write(`event: group\ndata: ${JSON.stringify(update)}\n\n`);
    });
    const session = security.phoneSessions.get(request);
    const unwatch = session ? options.phone!.watch(session, () => reply.raw.end()) : () => {};
    const timer = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded && !reply.raw.writableNeedDrain)
        reply.raw.write(': keepalive\n\n');
    }, 15_000);
    request.raw.once('close', () => {
      clearInterval(timer);
      unsubscribe();
      unwatch();
      streams.delete(reply.raw);
    });
  });
  if (options.webDir && existsSync(join(options.webDir, 'index.html'))) {
    await app.register(staticFiles, { root: options.webDir, cacheControl: false });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'This API is unavailable in Groups.' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
    folders.close();
  });
  return app;
}
