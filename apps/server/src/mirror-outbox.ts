import { randomUUID } from 'node:crypto';
import {
  mirrorQueueQuerySchema,
  mirrorQueuedActionSchema,
  mirrorQueuedMessageSchema,
  mirrorQueuedReceiptSchema,
  type MirrorQueueQuery,
  type MirrorQueuedAction,
  type MirrorQueuedMessage,
  type MirrorResult,
  type MirrorSend,
  type MirrorState,
} from '@dock/shared';
import { Conflict, Missing, Store, now } from './store.js';
import { WorkspaceState } from './workspace-state.js';
import { requireQueueHold } from './queue-hold.js';

type Window = Omit<MirrorState, 'entries'>;
type Saved = MirrorQueuedMessage & {
  key: string;
  acceptedText: string;
  waitToken: string | null;
  blocked: boolean;
};
type Transport = {
  windows(): Promise<Window[]>;
  read(id: string): Promise<MirrorState>;
  send(id: string, input: MirrorSend): Promise<MirrorResult>;
  receipt(key: string): MirrorResult;
};
const token = (state: Window) => state.steerToken ?? state.stopToken ?? null;
const active = ['queued', 'running', 'uncertain'];
const publicItem = (value: Saved): MirrorQueuedMessage => {
  const { key: _, acceptedText: __, waitToken: ___, blocked: ____, ...item } = value;
  return mirrorQueuedMessageSchema.parse(item);
};

/** An owner-message outbox, not a provider launcher or a second work scheduler. */
export class MirrorOutbox {
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private closed = false;
  constructor(
    private readonly store: Store,
    private readonly transport: Transport,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS mirror_outbox (
      id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, provider TEXT NOT NULL,
      thread_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mirror_outbox_target ON mirror_outbox(provider,thread_id,status);
    CREATE INDEX IF NOT EXISTS mirror_outbox_status ON mirror_outbox(status);`);
    // Persisted mirror receipts can resolve a finished handoff without replaying it.
    // A claim without a definitive receipt stays uncertain after restart.
    for (const row of this.rows('running')) {
      const result = row.deliveryKey
        ? transport.receipt(row.deliveryKey)
        : {
            state: 'uncertain' as const,
            message:
              'Delivery was interrupted. Inspect the native conversation. It was not repeated.',
          };
      this.recover(row, result);
    }
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.pump().catch(() => {});
    }, 1500);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
  private rows(status: string): Saved[] {
    return this.store.db
      .prepare('SELECT body FROM mirror_outbox WHERE status=? ORDER BY rowid')
      .all(status)
      .map((row) => JSON.parse(String(row.body)) as Saved);
  }
  private saved(id: string): Saved {
    const row = this.store.db.prepare('SELECT body FROM mirror_outbox WHERE id=?').get(id);
    if (!row) throw new Missing('This app-queued message is unavailable on this computer.');
    return JSON.parse(String(row.body)) as Saved;
  }
  private put(value: Saved): Saved {
    publicItem(value);
    this.store.db
      .prepare(
        `INSERT INTO mirror_outbox VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body`,
      )
      .run(
        value.id,
        value.key,
        value.provider,
        value.threadId,
        value.status,
        JSON.stringify(value),
      );
    this.store.event('mirror.queue_changed', null, null, {
      id: value.id,
      provider: value.provider,
      threadId: value.threadId,
      status: value.status,
      revision: value.queueRevision,
    });
    return value;
  }
  private recover(row: Saved, result: MirrorResult): Saved {
    const steering = row.queueEdit?.state === 'steering';
    const key =
      steering && row.deliveryKey === row.queueEdit?.operationKey ? row.deliveryKey : null;
    const operation = key ? `mirror-queue:${row.id}:${key}` : null;
    if (operation && result.state !== 'uncertain') {
      const intent = this.store.db
        .prepare('SELECT input FROM operations WHERE key=?')
        .get(operation);
      const acknowledged = this.store.db
        .prepare('SELECT 1 FROM operations WHERE key=?')
        .get(`${operation}:ack`);
      if (intent && JSON.parse(String(intent.input)).action === 'steer' && !acknowledged)
        return this.store.operation(`${operation}:ack`, { id: row.id }, () =>
          this.finish(row, result, true),
        );
    }
    return this.store.transaction(() => this.finish(row, result, steering));
  }
  private reconcile(row: Saved): Saved {
    if (row.status !== 'uncertain' || !row.deliveryKey) return row;
    const result = this.transport.receipt(row.deliveryKey);
    return result.state === 'uncertain' ? row : this.recover(row, result);
  }
  item(id: string) {
    return publicItem(this.reconcile(this.saved(id)));
  }
  list(raw: MirrorQueueQuery) {
    const target = mirrorQueueQuerySchema.parse(raw);
    const rows = this.store.db
      .prepare(
        `SELECT body FROM mirror_outbox
      WHERE provider=? AND thread_id=? AND status IN ('queued','running','uncertain') ORDER BY rowid LIMIT 100`,
      )
      .all(target.provider, target.threadId)
      .map((row) => this.reconcile(JSON.parse(String(row.body)) as Saved));
    return { items: rows.filter((row) => active.includes(row.status)).map(publicItem) };
  }
  /** Called inside the mirror delivery transaction; original text is retained as evidence. */
  enqueue(window: Window, input: MirrorSend): MirrorResult {
    if (!['idle', 'busy'].includes(window.status))
      return {
        state: 'not_sent',
        message:
          'The shared conversation needs attention or is offline. Your draft was not queued.',
      };
    const provider = input.provider ?? 'codex';
    const count = Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS total FROM mirror_outbox WHERE status IN ('queued','running','uncertain')",
        )
        .get()!.total,
    );
    const targetCount = Number(
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS total FROM mirror_outbox WHERE provider=? AND thread_id=? AND status IN ('queued','running','uncertain')",
        )
        .get(provider, input.threadId)!.total,
    );
    if (count >= 1000 || targetCount >= 100)
      throw new Conflict(
        'This app queue is full. Inspect its held messages before adding another.',
      );
    this.put({
      id: randomUUID(),
      key: input.key,
      provider,
      threadId: input.threadId,
      text: input.text,
      acceptedText: input.text,
      createdAt: now(),
      status: 'queued',
      queueRevision: 0,
      queueEdit: null,
      deliveryKey: null,
      waitToken: window.status === 'busy' ? token(window) : null,
      blocked: false,
      message: 'Queued here. You can hold and edit it before delivery to the native conversation.',
    });
    return {
      state: 'sent',
      message: 'Queued here. It remains editable until delivery to the native conversation.',
    };
  }
  receipt(id: string, key: string) {
    // Inspection may reconcile a definitive late native receipt and its exact steering ack.
    const item = this.item(id);
    const operation = `mirror-queue:${id}:${key}`;
    const intent = this.store.db.prepare('SELECT input FROM operations WHERE key=?').get(operation);
    const action = intent ? JSON.parse(String(intent.input)).action : null;
    const acknowledged =
      action !== 'steer' ||
      !!this.store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(`${operation}:ack`);
    return mirrorQueuedReceiptSchema.parse({
      status: !intent ? 'not_found' : acknowledged ? 'applied' : 'uncertain',
      item,
    });
  }
  async action(id: string, raw: MirrorQueuedAction) {
    if (this.closed)
      throw new Conflict('Conversation sharing is closing. Your queued message is retained.');
    const input = mirrorQueuedActionSchema.parse(raw);
    new WorkspaceState(this.store).snapshot(input.clientId);
    const operation = `mirror-queue:${id}:${input.key}`;
    const intent = { id, ...input };
    if (input.action !== 'steer')
      return publicItem(
        this.store.operation(operation, intent, () => {
          const row = this.saved(id);
          if (
            row.status !== 'queued' &&
            !(row.status === 'uncertain' && ['takeover', 'remove'].includes(input.action))
          )
            throw new Conflict(
              'This message has started delivery or left the app queue. It was not changed.',
            );
          if (input.revision !== row.queueRevision)
            throw new Conflict(
              'This queued message changed. Inspect its current revision before continuing.',
              'QUEUE_CHANGED',
            );
          if (row.status === 'uncertain' && input.action === 'remove') {
            // Explicit inspection/removal is not a resend or cancellation of native work.
            return this.put({
              ...row,
              status: 'cancelled',
              queueEdit: null,
              queueRevision: row.queueRevision + 1,
              message: 'Removed from this app queue after inspection. Native work was not changed.',
            });
          }
          if (
            row.status === 'uncertain' &&
            input.text !== undefined &&
            input.text !== (row.queueEdit?.text ?? row.text)
          )
            throw new Conflict('This delivery is uncertain. Its submitted text cannot be changed.');
          requireQueueHold(row, input);
          const text = input.text ?? row.queueEdit?.text ?? row.text;
          if (input.action === 'queue' && !text.trim())
            throw new Conflict('Write a message before queuing it.');
          const release = ['queue', 'discard', 'remove'].includes(input.action);
          return this.put({
            ...row,
            ...(input.action === 'queue' ? { text } : {}),
            ...(input.action === 'remove' ? { status: 'cancelled' as const } : {}),
            queueRevision: row.queueRevision + 1,
            queueEdit: release
              ? null
              : {
                  clientId: input.clientId,
                  text,
                  state:
                    row.status === 'uncertain' || row.queueEdit?.state === 'steering'
                      ? 'steering'
                      : 'editing',
                  ...(row.queueEdit?.operationKey
                    ? { operationKey: row.queueEdit.operationKey }
                    : {}),
                },
            blocked: release ? false : row.blocked,
            message: release
              ? input.action === 'remove'
                ? 'Removed from this app queue.'
                : 'Queued here until the native conversation can accept it.'
              : 'Held for editing. Save and queue releases it explicitly.',
          });
        }),
      );
    const previous = this.saved(id);
    if (previous.provider !== 'codex')
      throw new Conflict('Claude supports queued follow-ups here. Live steering is not enabled.');
    const prior = this.store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(operation);
    let window: Window | undefined, state: MirrorState | undefined;
    if (!prior) {
      window = (await this.transport.windows()).find(
        (value) =>
          value.threadId === previous.threadId && (value.provider ?? 'codex') === previous.provider,
      );
      if (window) state = await this.transport.read(window.windowId);
      if (
        !state ||
        state.threadId !== previous.threadId ||
        state.windowId !== window!.windowId ||
        (state.provider ?? 'codex') !== previous.provider ||
        !state.canSteer ||
        state.status !== 'busy' ||
        !state.steerToken
      )
        throw new Conflict(
          'That reply cannot be steered now. Your message remains held; choose Save and queue.',
        );
    }
    if (this.closed) throw new Conflict('Conversation sharing closed. Your message remains held.');
    const claimed = this.store.operation(operation, intent, () => {
      const row = this.saved(id);
      if (row.status !== 'queued')
        throw new Conflict('This message has started delivery. It was not steered.');
      requireQueueHold(row, input);
      const text = input.text ?? row.queueEdit!.text;
      if (!text.trim()) throw new Conflict('Write a message before steering it.');
      return this.put({
        ...row,
        status: 'running',
        queueRevision: row.queueRevision + 1,
        queueEdit: { clientId: input.clientId, text, state: 'steering', operationKey: input.key },
        deliveryKey: input.key,
        blocked: true,
        message: 'Steering the observed native reply…',
      });
    });
    const ack = this.store.db
      .prepare('SELECT result FROM operations WHERE key=?')
      .get(`${operation}:ack`);
    if (ack) return this.item(id);
    if (!window || !state)
      throw new Conflict('Steering needs inspection. This action was not repeated.');
    let result: MirrorResult;
    try {
      result = await this.transport.send(window.windowId, {
        key: claimed.deliveryKey!,
        threadId: claimed.threadId,
        provider: claimed.provider,
        expectedTurnId: state.steerToken!,
        text: claimed.queueEdit!.text,
      });
    } catch {
      result = {
        state: 'uncertain',
        message:
          'Steering was not confirmed. Inspect the native reply. This message stays held and will not be repeated.',
      };
    }
    return publicItem(
      this.store.operation(`${operation}:ack`, { id }, () => this.finish(claimed, result, true)),
    );
  }
  private finish(claimed: Saved, result: MirrorResult, steering: boolean) {
    const row = this.saved(claimed.id);
    return this.put({
      ...row,
      queueRevision: row.queueRevision + 1,
      status:
        result.state === 'sent'
          ? 'completed'
          : result.state === 'uncertain'
            ? 'uncertain'
            : 'queued',
      blocked: result.state !== 'sent',
      queueEdit:
        result.state === 'sent'
          ? null
          : steering
            ? { ...row.queueEdit!, state: result.state === 'uncertain' ? 'steering' : 'editing' }
            : null,
      text: result.state === 'sent' && steering ? row.queueEdit!.text : row.text,
      message:
        result.state === 'not_sent'
          ? `${result.message} Edit and explicitly Save and queue to retry.`.slice(0, 1000)
          : result.message,
    });
  }
  /** Poll only pending owner messages; one attempt per target, no native/provider launches. */
  pump(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pumping) return this.pumping;
    const candidates = this.rows('queued').filter((row) => !row.queueEdit && !row.blocked);
    if (!candidates.length) return Promise.resolve();
    this.pumping = (async () => {
      const windows = await this.transport.windows();
      const targets = new Set<string>();
      const selected = candidates.filter((row) => {
        const target = `${row.provider}:${row.threadId}`;
        if (targets.has(target)) return false;
        targets.add(target);
        return true;
      });
      // A disconnected target cannot stall messages for other loaded conversations.
      for (let offset = 0; offset < selected.length && !this.closed; offset += 8)
        await Promise.allSettled(
          selected.slice(offset, offset + 8).map(async (candidate) => {
            const window = windows.find(
              (value) =>
                value.threadId === candidate.threadId &&
                (value.provider ?? 'codex') === candidate.provider,
            );
            if (!window || window.status === 'offline') return;
            const state = await this.transport.read(window.windowId);
            if (
              this.closed ||
              state.threadId !== candidate.threadId ||
              (state.provider ?? 'codex') !== candidate.provider
            )
              return;
            const boundary =
              state.status === 'idle' ||
              (state.status === 'busy' &&
                state.canQueue &&
                candidate.waitToken &&
                token(state) &&
                token(state) !== candidate.waitToken);
            if (!boundary) return;
            const claimed = this.store.transaction(() => {
              const row = this.saved(candidate.id);
              if (
                this.closed ||
                row.status !== 'queued' ||
                row.queueEdit ||
                row.blocked ||
                row.queueRevision !== candidate.queueRevision
              )
                return null;
              return this.put({
                ...row,
                status: 'running',
                queueRevision: row.queueRevision + 1,
                deliveryKey: randomUUID(),
                message: 'Delivering to the native conversation; editing is closed.',
              });
            });
            if (!claimed) return;
            let result: MirrorResult;
            try {
              result = await this.transport.send(window.windowId, {
                key: claimed.deliveryKey!,
                threadId: claimed.threadId,
                provider: claimed.provider,
                text: claimed.text,
                ...(state.status === 'busy' ? { mode: 'queue' as const } : {}),
              });
            } catch {
              result = {
                state: 'uncertain',
                message:
                  'Delivery was not confirmed. Inspect the native conversation. This item will not be repeated.',
              };
            }
            if (!this.closed) this.store.transaction(() => this.finish(claimed, result, false));
          }),
        );
    })().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }
}
