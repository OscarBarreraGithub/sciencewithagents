import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import {
  mirrorCommandSchema,
  mirrorFrameSchema,
  mirrorStateSchema,
  mirrorSendSchema,
  mirrorControlSchema,
  mirrorResultSchema,
  mirrorPageQuerySchema,
  mirrorPage,
  type MirrorPageQuery,
  type MirrorState,
  type MirrorSend,
  type MirrorControl,
  type MirrorResult,
} from '@dock/shared';
import { Store, Conflict, Missing } from './store.js';

type Peer = {
  socket: WebSocket;
  window: Omit<MirrorState, 'entries'>;
  pending: Map<
    string,
    {
      text: string;
      bytes: number;
      timer: NodeJS.Timeout;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >;
};
const uncertain: MirrorResult = {
  state: 'uncertain',
  message:
    'Delivery was not confirmed. Inspect the conversation in VS Code before composing another message. This request will not be resent.',
};

/** Local extension transport only; the phone gets read + send, never arbitrary RPC. */
export class VscodeMirrors {
  private peers = new Map<string, Peer>();
  constructor(private readonly store: Store) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS mirror_deliveries (key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result TEXT NOT NULL)',
    );
  }
  windows() {
    return [...this.peers.values()].map((p) => p.window);
  }
  connect(socket: WebSocket) {
    let peer: Peer | undefined;
    let lastPong = Date.now();
    const handshake = setTimeout(() => socket.close(1008), 5000);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 60_000) socket.terminate();
      else socket.ping();
    }, 20_000);
    heartbeat.unref();
    socket.on('pong', () => {
      lastPong = Date.now();
    });
    socket.on('error', () => {});
    socket.on('message', (data) => {
      try {
        const message = mirrorFrameSchema.parse(JSON.parse(data.toString()));
        if (message.type === 'hello') {
          if (peer || this.peers.size >= 20 || this.peers.has(message.window.windowId))
            return socket.close(1008);
          clearTimeout(handshake);
          peer = { socket, window: message.window, pending: new Map() };
          this.peers.set(peer.window.windowId, peer);
          return;
        }
        if (!peer) return socket.close(1008);
        const request = peer.pending.get(message.id);
        if (!request) return; // A late read response is not another request's result.
        request.bytes += Buffer.byteLength(message.text);
        if (request.bytes > 32 * 1024 * 1024) return socket.close(1009);
        request.text += message.text;
        if (!message.last) return;
        clearTimeout(request.timer);
        peer.pending.delete(message.id);
        try {
          request.resolve(JSON.parse(request.text));
        } catch {
          request.reject(new Error('The mirror returned invalid data.'));
        }
      } catch {
        socket.close(1008);
      }
    });
    socket.on('close', () => {
      clearTimeout(handshake);
      clearInterval(heartbeat);
      if (!peer) return;
      if (this.peers.get(peer.window.windowId) === peer) this.peers.delete(peer.window.windowId);
      for (const request of peer.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('VS Code disconnected. Open it on the computer to reconnect.'));
      }
      peer.pending.clear();
    });
  }
  private async request(windowId: string, command: unknown): Promise<unknown> {
    const peer = this.peers.get(windowId);
    if (!peer)
      throw new Missing(
        'This VS Code window is offline. Open it on the computer and share the conversation again.',
      );
    if (peer.pending.size >= 4) throw new Conflict('The mirror is catching up. Please wait.');
    const value = mirrorCommandSchema.parse(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(value.id);
        reject(
          new Error(
            'VS Code did not respond. Check the computer; no message is retried automatically.',
          ),
        );
      }, 15_000);
      peer.pending.set(value.id, { text: '', bytes: 0, timer, resolve, reject });
      peer.socket.send(JSON.stringify(value), (error) => {
        if (error) {
          clearTimeout(timer);
          peer.pending.delete(value.id);
          reject(error);
        }
      });
    });
  }
  async read(windowId: string, page?: MirrorPageQuery) {
    const window = this.peers.get(windowId)?.window;
    // Old paged companions cannot expand a grouped activity query. Only this
    // deliberate drilldown falls back to a full read; normal polling stays paged.
    const paged =
      !!window?.paged && page !== undefined && (!page.activity || !!window.groupedActivity);
    const value = mirrorStateSchema.parse(
      await this.request(windowId, { id: randomUUID(), type: 'read', ...(paged ? { page } : {}) }),
    );
    if (value.windowId !== windowId) throw new Conflict('The shared window identity changed.');
    const { entries: _, page: __, ...summary } = value;
    const peer = this.peers.get(windowId);
    if (peer && (value.provider ?? 'codex') !== (peer.window.provider ?? 'codex'))
      throw new Conflict('The shared provider identity changed. Share the conversation again.');
    if (peer) peer.window = summary;
    return page !== undefined && !paged ? mirrorPage(value, page) : value;
  }
  async send(windowId: string, input: MirrorSend): Promise<MirrorResult> {
    input = mirrorSendSchema.parse(input);
    // A VS Code restart changes its window connection ID, not the chosen provider
    // thread or this durable delivery identity. A retry only returns the old result.
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const saved = this.store.db
      .prepare('SELECT input_hash, result FROM mirror_deliveries WHERE key=?')
      .get(input.key) as { input_hash: string; result: string } | undefined;
    if (saved) {
      if (saved.input_hash !== digest)
        throw new Conflict('This submission ID belongs to a different message. Nothing was sent.');
      return mirrorResultSchema.parse(JSON.parse(saved.result));
    }
    const peer = this.peers.get(windowId);
    if (
      !peer ||
      peer.window.threadId !== input.threadId ||
      (peer.window.provider ?? 'codex') !== (input.provider ?? 'codex')
    )
      return {
        state: 'not_sent',
        message: 'This conversation is no longer shared. Nothing was sent.',
      };
    // Persist intent before touching the provider. A crash, disconnect or retry never
    // sends the same input twice, including across a gateway restart.
    this.store.transaction(() => {
      this.store.db
        .prepare('INSERT INTO mirror_deliveries(key,input_hash,result) VALUES (?,?,?)')
        .run(input.key, digest, JSON.stringify(uncertain));
      this.store.event('mirror.send_requested', null, null, {
        key: input.key,
        windowId,
        threadId: input.threadId,
      });
    });
    let result: MirrorResult;
    if (
      input.expectedTurnId &&
      (peer.window.canSteer !== true || (peer.window.provider ?? 'codex') !== 'codex')
    ) {
      result = {
        state: 'not_sent',
        message:
          'This editor connection does not support live steering. Nothing was sent; keep your draft until this reply finishes or the companion is updated.',
      };
    } else if (
      input.mode === 'queue' &&
      (peer.window.canQueue !== true || peer.window.provider !== 'claude')
    ) {
      result = {
        state: 'not_sent',
        message:
          'This editor connection does not support queued follow-ups. Nothing was sent; keep your draft until this reply finishes or the companion is updated.',
      };
    } else {
      try {
        result = mirrorResultSchema.parse(
          await this.request(windowId, { id: randomUUID(), type: 'send', input }),
        );
      } catch {
        result = uncertain;
      }
    }
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE mirror_deliveries SET result=? WHERE key=?')
        .run(JSON.stringify(result), input.key);
      this.store.event('mirror.send_result', null, null, { key: input.key, state: result.state });
    });
    return result;
  }
  async control(windowId: string, raw: MirrorControl): Promise<MirrorResult> {
    const input = mirrorControlSchema.parse(raw);
    const digest = createHash('sha256')
      .update(JSON.stringify({ control: input }))
      .digest('hex');
    const saved = this.store.db
      .prepare('SELECT input_hash, result FROM mirror_deliveries WHERE key=?')
      .get(input.key) as { input_hash: string; result: string } | undefined;
    if (saved) {
      if (saved.input_hash !== digest)
        throw new Conflict('This receipt belongs to a different action. Nothing was repeated.');
      return mirrorResultSchema.parse(JSON.parse(saved.result));
    }
    const peer = this.peers.get(windowId);
    if (
      !peer ||
      peer.window.threadId !== input.threadId ||
      (peer.window.provider ?? 'codex') !== (input.provider ?? 'codex')
    )
      return {
        state: 'not_sent',
        message: 'This conversation is no longer shared. Nothing was stopped.',
      };
    const pending: MirrorResult = {
      state: 'uncertain',
      message:
        'Stop was not confirmed. Inspect the conversation; nothing is repeated automatically.',
    };
    this.store.transaction(() => {
      this.store.db
        .prepare('INSERT INTO mirror_deliveries(key,input_hash,result) VALUES (?,?,?)')
        .run(input.key, digest, JSON.stringify(pending));
      this.store.event('mirror.control_requested', null, null, {
        key: input.key,
        windowId,
        threadId: input.threadId,
        action: input.action,
      });
    });
    let result: MirrorResult;
    try {
      result = mirrorResultSchema.parse(
        await this.request(windowId, { id: randomUUID(), type: 'control', input }),
      );
    } catch {
      result = pending;
    }
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE mirror_deliveries SET result=? WHERE key=?')
        .run(JSON.stringify(result), input.key);
      this.store.event('mirror.control_result', null, null, {
        key: input.key,
        state: result.state,
      });
    });
    return result;
  }
  receipt(key: string): MirrorResult {
    const saved = this.store.db
      .prepare('SELECT result FROM mirror_deliveries WHERE key=?')
      .get(key) as { result: string } | undefined;
    // Absence may mean the original HTTP request is still in flight. Never turn
    // a delivery check into a first send or claim it is safe to send a duplicate.
    return saved
      ? mirrorResultSchema.parse(JSON.parse(saved.result))
      : {
          state: 'uncertain',
          message:
            'No delivery receipt is available yet. Inspect the conversation in VS Code before clearing this message. Nothing was resent.',
        };
  }
  close() {
    for (const peer of this.peers.values()) peer.socket.terminate();
  }
}

export function registerMirrorRoutes(
  app: FastifyInstance,
  mirrors: VscodeMirrors,
  remote: boolean,
) {
  const windowId = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/vscode/windows', async () => mirrors.windows());
  app.get('/api/vscode/deliveries/:id', async (request) =>
    mirrors.receipt(windowId(request.params)),
  );
  app.get('/api/vscode/windows/:id', async (request) =>
    mirrors.read(windowId(request.params), mirrorPageQuerySchema.parse(request.query)),
  );
  app.post('/api/vscode/windows/:id/send', async (request) =>
    mirrors.send(windowId(request.params), mirrorSendSchema.parse(request.body)),
  );
  app.post('/api/vscode/windows/:id/control', async (request) =>
    mirrors.control(windowId(request.params), mirrorControlSchema.parse(request.body)),
  );
  // Never register the extension producer on the public/paired phone entry. A phone
  // may consume the chosen transcript; it cannot impersonate a local extension.
  if (!remote) {
    app.get('/api/vscode/bridge', { websocket: true }, (socket, request) => {
      if (
        request.headers.origin ||
        request.headers['sec-fetch-site'] ||
        !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.ip)
      ) {
        socket.close(1008);
        return;
      }
      mirrors.connect(socket);
    });
    app.addHook('preClose', async () => mirrors.close());
  }
}
