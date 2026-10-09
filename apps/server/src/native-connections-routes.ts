import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  id,
  nativeConnectionAttachSchema,
  nativeConnectionDetachSchema,
  nativeConnectionSendSchema,
  nativeConnectionPromptQuerySchema,
  promptBodyLimit,
} from '@dock/shared';
import type WebSocket from 'ws';
import { z } from 'zod';
import type { NativeConnections } from './native-connections.js';

export function registerNativeConnectionRoutes(
  app: FastifyInstance,
  native: NativeConnections,
  watch: (socket: WebSocket, request: FastifyRequest) => void,
  origin: (request: FastifyRequest) => string,
) {
  const attachment = (request: FastifyRequest) => z.object({ id }).parse(request.params).id;
  app.get('/api/native-connections', () => native.list());
  app.post('/api/native-connections/attach', (request) =>
    native.attach(nativeConnectionAttachSchema.parse(request.body)),
  );
  app.get('/api/native-connections/attachments/:id', (request) => native.read(attachment(request)));
  app.post('/api/native-connections/attachments/:id/detach', (request) =>
    native.detach(attachment(request), nativeConnectionDetachSchema.parse(request.body).key),
  );
  app.post(
    '/api/native-connections/attachments/:id/send',
    { bodyLimit: promptBodyLimit },
    (request) => native.send(attachment(request), nativeConnectionSendSchema.parse(request.body)),
  );
  app.get('/api/native-connections/attachments/:id/receipts/:key', (request) => {
    const input = z.object({ id, key: id }).parse(request.params);
    return native.receipt(input.id, input.key);
  });
  app.get('/api/native-connections/targets/:id/prompts', (request) =>
    native.prompts(
      attachment(request),
      nativeConnectionPromptQuerySchema.parse(request.query).before,
    ),
  );
  app.get(
    '/api/native-connections/attachments/:id/socket',
    { websocket: true },
    (socket, request) => {
      if (request.headers.origin !== origin(request)) {
        socket.close(1008, 'Same-origin required');
        return;
      }
      watch(socket, request);
      void native.connect(attachment(request), socket).catch(() => {
        if (socket.readyState === 1)
          socket.send(
            JSON.stringify({
              type: 'error',
              message: 'Native attachment unavailable. Read its status and reconnect explicitly.',
            }),
          );
        socket.close(1008, 'Native attachment unavailable');
      });
    },
  );
}
