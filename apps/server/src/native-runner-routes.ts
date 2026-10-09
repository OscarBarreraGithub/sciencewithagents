import type { FastifyInstance } from 'fastify';
import { id, nativeRunnerStartSchema } from '@dock/shared';
import { z } from 'zod';
import type { NativeRunnerLaunch } from './native-runner-launch.js';
import type { FolderBrowser } from './folder-browser.js';

export function registerNativeRunnerRoutes(
  app: FastifyInstance,
  launch: NativeRunnerLaunch,
  folders: FolderBrowser,
) {
  app.get('/api/native-connections/launch-options', () => launch.options());
  app.post('/api/native-connections/start', { bodyLimit: 8192 }, (request) =>
    launch.start(nativeRunnerStartSchema.parse(request.body), folders),
  );
  app.get('/api/native-connections/starts/:key', (request) =>
    launch.read(z.object({ key: id }).parse(request.params).key),
  );
}
