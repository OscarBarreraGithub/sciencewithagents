import { MirrorOutbox } from './mirror-outbox.js';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import {
  mirrorQueueQuerySchema,
  mirrorQueuedActionSchema,
  mirrorCommandSchema,
  mirrorFrameSchema,
  mirrorStateSchema,
  mirrorSendSchema,
  mirrorControlSchema,
  mirrorResultSchema,
  mirrorPageQuerySchema,
  mirrorPage,
  chatAttachmentCount,
  conversationListQuerySchema,
  type MirrorPageQuery,
  type MirrorState,
  type MirrorSend,
  type MirrorControl,
  type MirrorResult,
  nativeGoalActionSchema,
  nativeGoalViewSchema,
  nativeGoalActionProblem,
  type NativeGoalAction,
  type NativeGoalView,
} from '@dock/shared';
import { Store, Conflict, Missing } from './store.js';
import { conversationHidden } from './conversations.js';
import type { CodexDaemonChats } from './codex-daemon-chats.js';

type DaemonChats = Pick<
  CodexDaemonChats,
  'discover' | 'windows' | 'read' | 'send' | 'control' | 'goal' | 'goalAction' | 'close'
>;

type Peer = {
  socket: WebSocket;
  window: Omit<MirrorState, 'entries'>;
  summaryAt: number;
  refreshing?: Promise<void>;
  pending: Map<
    string,
    {
      read: boolean;
      text: string;
      bytes: number;
      timer: NodeJS.Timeout;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >;
};
/** Too many reads are already waiting; the editor is connected, not offline. */
class MirrorBusy extends Conflict {}
const uncertain: MirrorResult = {
  state: 'uncertain',
  message:
    'Delivery was not confirmed. Inspect the conversation on the computer before composing another message. This request will not be resent.',
};

/** Local extension transport only; the phone gets read + send, never arbitrary RPC. */
export class VscodeMirrors {
  private peers = new Map<string, Peer>();
  private listing?: Promise<void>;
  private reads = new Map<string, Promise<MirrorState>>();
  private goalChanges = new Set<string>();
  readonly queue: MirrorOutbox;
  constructor(
    private readonly store: Store,
    private readonly daemon?: DaemonChats,
    private readonly prepareText: (text: string) => string = (text) => text,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS mirror_deliveries (key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result TEXT NOT NULL)',
    );
    this.queue = new MirrorOutbox(store, {
      windows: () => this.list(true),
      read: (id) => this.read(id, {}),
      send: (id, input) => this.deliver(id, input),
      receipt: (key) => this.receipt(key),
    });
  }
  windows() {
    const editors = [...this.peers.values()].map((p) => p.window);
    return [
      ...editors,
      ...(this.daemon?.windows() ?? []).filter(
        (window) =>
          !editors.some(
            (editor) =>
              (editor.provider ?? 'codex') === 'codex' && editor.threadId === window.threadId,
          ),
      ),
    ];
  }
  async discover() {
    await this.daemon?.discover();
  }
  async list(includeArchived = false) {
    // The companion's hello is only an initial snapshot. Refresh through the
    // existing bounded read so a closed chat view cannot leave the list stale.
    // Share work across phone/desktop polling; an unresponsive editor must not
    // hold up the whole list for the normal 15-second command timeout.
    this.listing ??= Promise.all([
      this.discover(),
      ...[...this.peers.entries()].map(async ([id, peer]) => {
        if (Date.now() - peer.summaryAt < 5000) return;
        const previous = peer.summaryAt;
        // A long native transcript can take seconds to read. Keep waiting in the
        // background and keep the last reading while the editor still answers
        // pings; a frozen or unreachable editor is reported offline promptly.
        if (await this.refresh(id, peer, 2000)) return;
        if (!(await this.alive(peer))) this.offline(id, peer, previous);
      }),
    ]).then(() => {});
    try {
      await this.listing;
      const windows = this.windows();
      return includeArchived
        ? windows
        : windows.filter(
            (window) =>
              !window.threadId ||
              !conversationHidden(this.store, {
                kind: 'shared',
                provider: window.provider ?? 'codex',
                threadId: window.threadId,
              }),
          );
    } finally {
      this.listing = undefined;
    }
  }
  /** Resolves true when the shared refresh finished within `waitMs`. */
  private refresh(id: string, peer: Peer, waitMs: number): Promise<boolean> {
    peer.refreshing ??= (async () => {
      const previous = peer.summaryAt;
      try {
        await this.read(id, {});
      } catch (error) {
        // Other reads are in flight; whichever finishes next updates the summary.
        if (!(error instanceof MirrorBusy)) this.offline(id, peer, previous);
      } finally {
        peer.refreshing = undefined;
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      peer.refreshing.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  /** The extension host answers pings even while Codex is slow to return a transcript. */
  private alive(peer: Peer, waitMs = 1000): Promise<boolean> {
    if (peer.socket.readyState !== peer.socket.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const pong = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        peer.socket.off('pong', pong);
        resolve(false);
      }, waitMs);
      peer.socket.once('pong', pong);
      try {
        peer.socket.ping();
      } catch {
        clearTimeout(timer);
        peer.socket.off('pong', pong);
        resolve(false);
      }
    });
  }
  private offline(id: string, peer: Peer, previous: number) {
    // A newer successful reading always wins over this failed refresh.
    if (this.peers.get(id) !== peer || peer.summaryAt !== previous) return;
    peer.summaryAt = Date.now();
    peer.window = {
      ...peer.window,
      status: 'offline',
      message: 'VS Code is not responding. Open the conversation to retry.',
      stopToken: undefined,
      steerToken: undefined,
    };
  }
  private window(windowId: string) {
    return (
      this.peers.get(windowId)?.window ??
      this.daemon?.windows().find((window) => window.windowId === windowId)
    );
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
          peer = { socket, window: message.window, summaryAt: 0, pending: new Map() };
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
  private async request(windowId: string, command: unknown, timeoutMs = 15_000): Promise<unknown> {
    const peer = this.peers.get(windowId);
    const value = mirrorCommandSchema.parse(command);
    if (!peer && this.daemon && this.window(windowId)?.source === 'codex-daemon') {
      if (value.type === 'read') return this.daemon.read(windowId, value.page);
      if (value.type === 'send') return this.daemon.send(windowId, value.input);
      if (value.type === 'control') return this.daemon.control(windowId, value.input);
      if (value.type === 'goal_read') return this.daemon.goal(windowId);
      return this.daemon.goalAction(windowId, value.input);
    }
    if (!peer)
      throw new Missing(
        'This VS Code window is offline. Open it on the computer and share the conversation again.',
      );
    // Reads are bounded separately so polling never blocks an owner's send or stop.
    const read = value.type === 'read';
    if (
      (read && [...peer.pending.values()].filter((request) => request.read).length >= 4) ||
      peer.pending.size >= 8
    )
      throw new MirrorBusy('The mirror is catching up. Please wait.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.pending.delete(value.id);
        reject(
          new Error(
            'VS Code did not respond. Check the computer; no message is retried automatically.',
          ),
        );
      }, timeoutMs);
      peer.pending.set(value.id, { read, text: '', bytes: 0, timer, resolve, reject });
      peer.socket.send(JSON.stringify(value), (error) => {
        if (error) {
          clearTimeout(timer);
          peer.pending.delete(value.id);
          reject(error);
        }
      });
    });
  }
  read(windowId: string, page?: MirrorPageQuery) {
    // Phone, desktop and list refreshes poll the same latest page; share one editor read.
    const key = JSON.stringify([windowId, page ?? null]);
    let reading = this.reads.get(key);
    if (!reading) {
      reading = this.readOnce(windowId, page).finally(() => this.reads.delete(key));
      this.reads.set(key, reading);
    }
    return reading;
  }
  private async readOnce(windowId: string, page?: MirrorPageQuery) {
    const window = this.window(windowId);
    // Old paged companions cannot expand a grouped activity query. Only this
    // deliberate drilldown falls back to a full read; normal polling stays paged.
    const paged =
      !!window?.paged && page !== undefined && (!page.activity || !!window.groupedActivity);
    const value = mirrorStateSchema.parse(
      await this.request(windowId, { id: randomUUID(), type: 'read', ...(paged ? { page } : {}) }),
    );
    if (value.windowId !== windowId) throw new Conflict('The shared window identity changed.');
    const {
      entries: _,
      page: __,
      queuedMessages: _queue,
      queueHasMore: _more,
      queueReadError: _queueError,
      ...summary
    } = value;
    const peer = this.peers.get(windowId);
    if (peer && (value.provider ?? 'codex') !== (peer.window.provider ?? 'codex'))
      throw new Conflict('The shared provider identity changed. Share the conversation again.');
    if (peer) {
      peer.window = summary;
      peer.summaryAt = Date.now();
    }
    return page !== undefined && !paged ? mirrorPage(value, page) : value;
  }
  async send(windowId: string, raw: MirrorSend): Promise<MirrorResult> {
    const input = mirrorSendSchema.parse(raw);
    if (input.mode !== 'queue') return this.deliver(windowId, input);
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.store.transaction(() => {
      const saved = this.store.db
        .prepare('SELECT input_hash, result FROM mirror_deliveries WHERE key=?')
        .get(input.key);
      if (saved) {
        if (saved.input_hash !== digest)
          throw new Conflict(
            'This submission ID belongs to a different message. Nothing was queued.',
          );
        return mirrorResultSchema.parse(JSON.parse(String(saved.result)));
      }
      const window = this.window(windowId);
      if (
        !window ||
        window.threadId !== input.threadId ||
        (window.provider ?? 'codex') !== (input.provider ?? 'codex')
      )
        return {
          state: 'not_sent',
          message: 'This conversation is no longer shared. Nothing was queued.',
        } as MirrorResult;
      if (window.canAttachImages === false && chatAttachmentCount(input.text))
        return {
          state: 'not_sent',
          message:
            'Remote files cannot be sent here. Attach them in the native remote editor. Nothing was queued.',
        } as MirrorResult;
      if (this.prepareText(input.text).length > 32000)
        throw new Conflict(
          'Shorten the message slightly to leave room for its attachments. Nothing was queued.',
        );
      const result = this.queue.enqueue(window, input);
      this.store.db
        .prepare('INSERT INTO mirror_deliveries VALUES(?,?,?)')
        .run(input.key, digest, JSON.stringify(result));
      this.store.event('mirror.send_result', null, null, {
        key: input.key,
        state: result.state,
        outbox: result.state === 'sent',
      });
      return result;
    });
  }
  private async deliver(windowId: string, input: MirrorSend): Promise<MirrorResult> {
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
    const window = this.window(windowId);
    if (
      !window ||
      window.threadId !== input.threadId ||
      (window.provider ?? 'codex') !== (input.provider ?? 'codex')
    )
      return {
        state: 'not_sent',
        message: 'This conversation is no longer shared. Nothing was sent.',
      };
    if (window.canAttachImages === false && chatAttachmentCount(input.text))
      return {
        state: 'not_sent',
        message:
          'Files cannot be sent to this remote editor. Remove attachments from this draft and attach them in the native remote editor instead. Nothing was sent.',
      };
    const delivery = { ...input, text: this.prepareText(input.text) };
    if (delivery.text.length > 32000)
      throw new Conflict(
        'Shorten the message slightly to leave room for its attachments. Nothing was sent.',
      );
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
      (window.canSteer !== true || (window.provider ?? 'codex') !== 'codex')
    ) {
      result = {
        state: 'not_sent',
        message:
          'This editor connection does not support live steering. Nothing was sent; keep your draft until this reply finishes or the companion is updated.',
      };
    } else if (
      input.mode === 'queue' &&
      window.source !== 'codex-daemon' &&
      window.canQueue !== true
    ) {
      result = {
        state: 'not_sent',
        message:
          'This editor connection does not support queued follow-ups. Nothing was sent; keep your draft until this reply finishes or the companion is updated.',
      };
    } else {
      try {
        result = mirrorResultSchema.parse(
          await this.request(windowId, { id: randomUUID(), type: 'send', input: delivery }),
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
    const window = this.window(windowId);
    if (
      !window ||
      window.threadId !== input.threadId ||
      (window.provider ?? 'codex') !== (input.provider ?? 'codex')
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
            'No delivery receipt is available yet. Inspect the conversation on the computer before clearing this message. Nothing was resent.',
        };
  }
  private goalRevisionKey(threadId: string) {
    return `mirror:goal-revision:codex:${threadId}`;
  }
  private versionedGoal(view: NativeGoalView): NativeGoalView {
    if (!view.threadId || !view.token) return view;
    const revision = this.store.getSetting(this.goalRevisionKey(view.threadId)) ?? 0;
    return {
      ...view,
      token: createHash('sha256')
        .update(JSON.stringify([view.token, revision]))
        .digest('hex'),
    };
  }
  async goal(windowId: string): Promise<NativeGoalView> {
    return this.versionedGoal(await this.nativeGoal(windowId));
  }
  private async nativeGoal(windowId: string): Promise<NativeGoalView> {
    const window = this.window(windowId);
    const unavailable = (message: string): NativeGoalView => ({
      threadId: window?.threadId ?? null,
      supported: false,
      goal: null,
      token: null,
      message,
    });
    if (!window || window.status === 'offline')
      return unavailable(
        'The shared conversation is offline. Your messages and goal are retained.',
      );
    if ((window.provider ?? 'codex') !== 'codex')
      return unavailable(
        'This provider does not expose native goals. Messages remain available here.',
      );
    if (!window.canManageGoal)
      return unavailable(
        'The installed companion does not expose native goals yet. Existing messages remain available here.',
      );
    try {
      const view = nativeGoalViewSchema.parse(
        await this.request(windowId, { id: randomUUID(), type: 'goal_read' }),
      );
      if (
        view.threadId !== window.threadId ||
        (view.goal && view.goal.threadId !== window.threadId)
      )
        return unavailable('The shared conversation changed. Refresh its goal status.');
      return view;
    } catch {
      return unavailable(
        'Native goal status is unavailable. Refresh its status; your conversation is unchanged.',
      );
    }
  }
  async goalAction(windowId: string, raw: NativeGoalAction): Promise<MirrorResult> {
    const input = nativeGoalActionSchema.parse(raw);
    const digest = createHash('sha256')
      .update(JSON.stringify({ goal: input }))
      .digest('hex');
    const saved = this.store.db
      .prepare('SELECT input_hash,result FROM mirror_deliveries WHERE key=?')
      .get(input.key) as { input_hash: string; result: string } | undefined;
    if (saved) {
      if (saved.input_hash !== digest)
        throw new Conflict('This receipt belongs to a different action. Nothing was repeated.');
      return mirrorResultSchema.parse(JSON.parse(saved.result));
    }
    const window = this.window(windowId);
    if (
      !window ||
      window.status === 'offline' ||
      !window.canManageGoal ||
      window.threadId !== input.threadId ||
      (window.provider ?? 'codex') !== (input.provider ?? 'codex') ||
      (input.provider ?? 'codex') !== 'codex'
    )
      return {
        state: 'not_sent',
        message: 'Native goals are unavailable for this shared conversation. Nothing was changed.',
      };
    const identity = `codex:${input.threadId}`;
    if (this.goalChanges.has(identity))
      return {
        state: 'not_sent',
        message: 'Another goal action is pending. Refresh its status before choosing an action.',
      };
    const pending: MirrorResult = {
      state: 'uncertain',
      message:
        'The native goal action was not confirmed. Inspect its current status; nothing is repeated automatically.',
    };
    this.goalChanges.add(identity);
    try {
      this.store.transaction(() => {
        this.store.db
          .prepare('INSERT INTO mirror_deliveries(key,input_hash,result) VALUES (?,?,?)')
          .run(input.key, digest, JSON.stringify(pending));
        this.store.event('mirror.goal_requested', null, null, {
          key: input.key,
          windowId,
          threadId: input.threadId,
          action: input.action,
          ...(input.action === 'create' ? { objective: input.objective } : {}),
        });
      });
      let result: MirrorResult;
      try {
        const current = await this.nativeGoal(windowId);
        const problem = nativeGoalActionProblem(input, this.versionedGoal(current));
        this.store.event('mirror.goal_observed', null, null, {
          key: input.key,
          threadId: input.threadId,
          goal: current.goal,
        });
        if (problem) result = { state: 'not_sent', message: problem };
        else {
          // An app action invalidates older device controls even if native timestamps
          // and status return to the same value within one second. Progress is separate.
          const revisionKey = this.goalRevisionKey(input.threadId);
          const revision = z
            .number()
            .int()
            .nonnegative()
            .parse(this.store.getSetting(revisionKey) ?? 0);
          this.store.setSetting(revisionKey, revision + 1);
          const nativeInput = { ...input, expectedToken: current.token };
          result = mirrorResultSchema.parse(
            await this.request(windowId, {
              id: randomUUID(),
              type: 'goal_action',
              input: nativeInput,
            }),
          );
        }
      } catch {
        result = pending;
      }
      this.store.transaction(() => {
        this.store.db
          .prepare('UPDATE mirror_deliveries SET result=? WHERE key=?')
          .run(JSON.stringify(result), input.key);
        this.store.event('mirror.goal_result', null, null, { key: input.key, state: result.state });
      });
      return result;
    } finally {
      this.goalChanges.delete(identity);
    }
  }
  close() {
    this.queue.close();
    this.daemon?.close();
    for (const peer of this.peers.values()) peer.socket.terminate();
  }
}

/** Browser capability describes the app outbox; native snapshots stay authoritative internally. */
const publicQueueCapability = <T extends Omit<MirrorState, 'entries'>>(window: T): T => ({
  ...window,
  canQueue: !!window.threadId && ['idle', 'busy'].includes(window.status),
});

export function registerMirrorRoutes(
  app: FastifyInstance,
  mirrors: VscodeMirrors,
  remote: boolean,
) {
  const windowId = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  const discover = { preHandler: async () => mirrors.discover() };
  app.get('/api/vscode/queued', async (request) =>
    mirrors.queue.list(mirrorQueueQuerySchema.parse(request.query)),
  );
  app.get('/api/vscode/queued/:id', async (request) =>
    mirrors.queue.item(windowId(request.params)),
  );
  app.get('/api/vscode/queued/:id/receipts/:key', async (request) => {
    const params = z.object({ id: z.uuid(), key: z.uuid() }).parse(request.params);
    return mirrors.queue.receipt(params.id, params.key);
  });
  app.post('/api/vscode/queued/:id', async (request) =>
    mirrors.queue.action(windowId(request.params), mirrorQueuedActionSchema.parse(request.body)),
  );

  app.get('/api/vscode/windows', async (request) => {
    const query = conversationListQuerySchema.parse(request.query);
    return (await mirrors.list(query.includeArchived === 'true')).map(publicQueueCapability);
  });
  app.get('/api/vscode/deliveries/:id', async (request) =>
    mirrors.receipt(windowId(request.params)),
  );
  app.get('/api/vscode/windows/:id', discover, async (request) =>
    publicQueueCapability(
      await mirrors.read(windowId(request.params), mirrorPageQuerySchema.parse(request.query)),
    ),
  );
  app.post('/api/vscode/windows/:id/send', discover, async (request) =>
    mirrors.send(windowId(request.params), mirrorSendSchema.parse(request.body)),
  );
  app.post('/api/vscode/windows/:id/control', discover, async (request) =>
    mirrors.control(windowId(request.params), mirrorControlSchema.parse(request.body)),
  );
  // Goal reads are lazy metadata only, never full transcript discovery or a model turn.
  app.get('/api/vscode/windows/:id/goal', discover, async (request) =>
    mirrors.goal(windowId(request.params)),
  );
  app.post('/api/vscode/windows/:id/goal', discover, async (request) =>
    mirrors.goalAction(windowId(request.params), nativeGoalActionSchema.parse(request.body)),
  );
  // Never register the extension producer on the public/paired phone entry. A phone
  // may consume the chosen transcript; it cannot impersonate a local extension.
  if (!remote) {
    app.addHook('onReady', async () => mirrors.queue.start());
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
