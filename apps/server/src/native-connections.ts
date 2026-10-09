import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import {
  nativeConnectionAttachSchema,
  nativeConnectionSendSchema,
  nativeConnectionAttachmentSchema,
  nativeConnectionSendReceiptSchema,
  nativeConnectionsViewSchema,
  terminalInputSchema,
  type NativeConnectionAttachment,
  type NativeConnectionSendReceipt,
  type NativeConnectionTarget,
} from '@dock/shared';
import { Conflict, Missing, Store } from './store.js';
import {
  readNativeConnectionProfiles,
  type NativeConnectionProfile,
} from './native-connections-config.js';
import {
  NativeCliDriver,
  profileSignature,
  type NativeClient,
  type NativeTargetProof,
  type NativeTerminalDriver,
  type NativeDiscovery,
} from './native-terminal-driver.js';

type TargetRow = { id: string; source: string; signature: string; proof: string; view: string };
type AttachmentRow = { id: string; key: string; input: string; target: string; body: string };
type Live = {
  client: NativeClient;
  socket: WebSocket;
  closed: boolean;
  pendingBytes: number;
  input: Promise<void>;
};
export const nativeConnectionLimits = {
  active: 4,
  journalBytes: 64 * 1024 * 1024,
  receiptReserve: 8192,
} as const;
const time = () => new Date().toISOString();
class JournalFull extends Conflict {}
/** Attachment clients and saved prompt receipts, not a scheduler or a native history database. */
export class NativeConnections {
  private live = new Map<string, Live>();
  private connecting = new Set<string>();
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  beforeOpen: () => void = () => {};
  constructor(
    private store: Store,
    root: string,
    private driver: NativeTerminalDriver = new NativeCliDriver(),
    private profiles: () => NativeConnectionProfile[] = () => readNativeConnectionProfiles(root),
    private enabled = true,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS nc_budget(id INTEGER PRIMARY KEY CHECK(id=1),used INTEGER NOT NULL);
      INSERT OR IGNORE INTO nc_budget VALUES(1,0);
      CREATE TABLE IF NOT EXISTS nc_targets(id TEXT PRIMARY KEY,source TEXT NOT NULL,signature TEXT NOT NULL,
        proof TEXT NOT NULL,view TEXT NOT NULL,UNIQUE(source,signature,proof));
      CREATE TABLE IF NOT EXISTS nc_attachments(id TEXT PRIMARY KEY,key TEXT UNIQUE NOT NULL,
        input TEXT NOT NULL,target TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nc_sends(key TEXT PRIMARY KEY,attachment TEXT NOT NULL,target TEXT NOT NULL,
        input TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS nc_sends_target ON nc_sends(target,created DESC,key DESC);
      CREATE TABLE IF NOT EXISTS nc_detaches(key TEXT PRIMARY KEY,attachment TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nc_events(seq INTEGER PRIMARY KEY,event TEXT NOT NULL,identity TEXT NOT NULL,at TEXT NOT NULL);
    `);
    // No client or input can be replayed after an app process ends.
    for (const row of store.db.prepare('SELECT id,body FROM nc_attachments').all() as {
      id: string;
      body: string;
    }[]) {
      const info = nativeConnectionAttachmentSchema.parse(JSON.parse(row.body));
      if (info.status === 'connecting' || info.status === 'connected')
        this.update(row.id, {
          ...info,
          status: 'unavailable',
          inputToken: undefined,
          message: 'The app restarted. Reconnect explicitly; no native input was replayed.',
        });
    }
  }
  activeCount() {
    return this.live.size + this.connecting.size + this.expiry.size;
  }
  private event(event: string, identity: string) {
    this.store.db
      .prepare('INSERT INTO nc_events(event,identity,at) VALUES(?,?,?)')
      .run(event, identity, time());
  }
  private reserve(bytes: number) {
    if (
      this.store.db
        .prepare('UPDATE nc_budget SET used=used+? WHERE id=1 AND used+?<=?')
        .run(bytes, bytes, nativeConnectionLimits.journalBytes).changes !== 1
    )
      throw new JournalFull(
        'Saved native connection receipts are full. Existing receipts remain readable; no new native action was sent.',
      );
  }
  private atomic<T>(work: () => T): T {
    this.store.db.exec('SAVEPOINT native_connection');
    try {
      const result = work();
      this.store.db.exec('RELEASE native_connection');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO native_connection; RELEASE native_connection');
      throw error;
    }
  }
  private target(id: string): TargetRow {
    const row = this.store.db.prepare('SELECT * FROM nc_targets WHERE id=?').get(id) as
      | TargetRow
      | undefined;
    if (!row) throw new Missing('Refresh native connections and choose an issued session.');
    return row;
  }
  private profile(target: TargetRow) {
    const p = this.profiles().find((p) => p.id === target.source);
    if (!p || profileSignature(p) !== target.signature)
      throw new Conflict(
        'This native source configuration changed. Refresh connections and choose its current identity.',
      );
    return p;
  }
  private async verify(target: TargetRow) {
    if (this.stopped) throw new Conflict('Native attachments are stopping.');
    const profile = this.profile(target),
      discovered = await this.driver.discover(profile);
    const current = discovered.targets.find((t) => JSON.stringify(t.proof) === target.proof);
    this.profile(target);
    if (this.stopped || !current)
      throw new Conflict(
        'This native server or pane changed. Refresh connections before reconnecting.',
      );
    return { profile, proof: JSON.parse(target.proof) as NativeTargetProof, current };
  }
  /** Reserve durable creation and identity storage before an explicit host launch. */
  reserveLaunch<T>(bytes: number, work: () => T) {
    if (this.stopped) throw new Conflict('Native connections are stopping.');
    return this.atomic(() => {
      this.reserve(bytes);
      return work();
    });
  }
  /** Only a funded, exact launch proof may use its already charged target slot. */
  retainCreated(
    key: string,
    profile: NativeConnectionProfile,
    native: NativeDiscovery['targets'][number],
  ) {
    const row = this.store.db
      .prepare('SELECT source,signature,proof,nonce FROM nc_starts WHERE key=?')
      .get(key) as
      | { source: string; signature: string; proof: string | null; nonce: string }
      | undefined;
    if (
      !row ||
      row.source !== profile.id ||
      row.signature !== profileSignature(profile) ||
      row.proof !== JSON.stringify(native.proof) ||
      native.view.label !== `swa-${row.nonce}`
    )
      throw new Conflict('Native creation has no exact funded identity receipt.');
    this.profile({ source: row.source, signature: row.signature } as TargetRow);
    const proof = JSON.stringify(native.proof),
      id = randomUUID(),
      view = { ...native.view, id, sourceId: profile.id };
    if (
      Buffer.byteLength(proof) + Buffer.byteLength(JSON.stringify(view)) >
      nativeConnectionLimits.receiptReserve
    )
      throw new Conflict('Native creation identity exceeds its reserved receipt slot.');
    const old = this.store.db
      .prepare('SELECT id FROM nc_targets WHERE source=? AND signature=? AND proof=?')
      .get(profile.id, row.signature, proof) as { id: string } | undefined;
    if (old) return old.id;
    this.store.db
      .prepare('INSERT INTO nc_targets VALUES(?,?,?,?,?)')
      .run(id, profile.id, row.signature, proof, JSON.stringify(view));
    return id;
  }
  async list() {
    const sources = [],
      targets: NativeConnectionTarget[] = [];
    const configured = this.enabled ? this.profiles() : [];
    for (const p of configured) {
      const signature = profileSignature(p),
        discovery = await this.driver.discover(p);
      if (this.stopped) throw new Conflict('Native connections are stopping.');
      // A changed profile during the probe cannot issue an identity for another destination.
      if (!this.profiles().some((q) => q.id === p.id && profileSignature(q) === signature))
        continue;
      const source = {
        id: p.id,
        label: p.label,
        kind: p.kind,
        location: p.sshAlias ? ('ssh' as const) : ('local' as const),
        state: discovery.state,
        message: discovery.message,
      };
      sources.push(source);
      for (const native of discovery.targets) {
        if (targets.length >= 512) break;
        const proof = JSON.stringify(native.proof);
        const old = this.store.db
          .prepare('SELECT * FROM nc_targets WHERE source=? AND signature=? AND proof=?')
          .get(p.id, signature, proof) as TargetRow | undefined;
        const id = old?.id ?? randomUUID(),
          view = { ...native.view, id, sourceId: p.id };
        try {
          this.atomic(() => {
            if (!old) {
              this.reserve(
                Buffer.byteLength(proof) +
                  Buffer.byteLength(JSON.stringify(view)) +
                  nativeConnectionLimits.receiptReserve,
              );
              this.store.db
                .prepare('INSERT INTO nc_targets VALUES(?,?,?,?,?)')
                .run(id, p.id, signature, proof, JSON.stringify(view));
            } else
              this.store.db
                .prepare('UPDATE nc_targets SET view=? WHERE id=?')
                .run(JSON.stringify(view), id);
          });
        } catch (error) {
          if (old || !(error instanceof JournalFull)) throw error;
          source.message =
            'Saved native connection receipts are full. Newly discovered sessions cannot be issued; retained connections and saved prompts remain readable.';
          continue;
        }
        targets.push(view);
      }
    }
    const attachments = (
      this.store.db
        .prepare('SELECT body FROM nc_attachments ORDER BY rowid DESC LIMIT 64')
        .all() as { body: string }[]
    ).map((row) => nativeConnectionAttachmentSchema.parse(JSON.parse(row.body)));
    return nativeConnectionsViewSchema.parse({ sources, targets, attachments, observedAt: time() });
  }
  read(id: string) {
    const row = this.store.db.prepare('SELECT * FROM nc_attachments WHERE id=?').get(id) as
      | AttachmentRow
      | undefined;
    if (!row) throw new Missing('This native attachment is not retained on this computer.');
    return nativeConnectionAttachmentSchema.parse(JSON.parse(row.body));
  }
  private update(id: string, body: NativeConnectionAttachment) {
    this.store.db
      .prepare('UPDATE nc_attachments SET body=? WHERE id=?')
      .run(JSON.stringify(body), id);
    this.event(`attachment.${body.status}`, id);
    return body;
  }
  attach(raw: unknown) {
    const input = nativeConnectionAttachSchema.parse(raw),
      json = JSON.stringify(input);
    const existing = this.store.db
      .prepare('SELECT * FROM nc_attachments WHERE key=?')
      .get(input.key) as AttachmentRow | undefined;
    if (existing) {
      if (existing.input !== json)
        throw new Conflict('This attachment request key already belongs to different input.');
      return this.read(existing.id);
    }
    this.beforeOpen();
    if (this.stopped || !this.enabled) throw new Conflict('Native attachments are unavailable.');
    const target = this.target(input.targetId),
      view = JSON.parse(target.view) as NativeConnectionTarget;
    this.profile(target);
    if (input.takeover)
      throw new Conflict('Native controller takeover is not supported by this verified protocol.');
    if (
      (input.mode === 'control' && !view.canControl) ||
      (input.mode === 'observe' && !view.canObserve)
    )
      throw new Conflict('This native source does not support the requested attachment mode.');
    if (this.activeCount() >= nativeConnectionLimits.active)
      throw new Conflict('Detach an existing native attachment before opening another.');
    const info = nativeConnectionAttachmentSchema.parse({
      id: randomUUID(),
      targetId: input.targetId,
      mode: input.mode,
      status: 'connecting',
      message: 'Open this attachment’s terminal to connect. No native input has been sent.',
      ...(input.mode === 'control' ? { inputToken: randomUUID() } : {}),
    });
    this.atomic(() => {
      this.reserve(Buffer.byteLength(json) + nativeConnectionLimits.receiptReserve);
      this.store.db
        .prepare('INSERT INTO nc_attachments VALUES(?,?,?,?,?)')
        .run(info.id, input.key, json, input.targetId, JSON.stringify(info));
      this.event('attachment.requested', info.id);
    });
    const timer = setTimeout(() => {
      this.expiry.delete(info.id);
      if (this.read(info.id).status === 'connecting')
        this.update(info.id, {
          ...this.read(info.id),
          status: 'detached',
          inputToken: undefined,
          message: 'No browser connected. Reconnect explicitly.',
        });
    }, 30_000);
    timer.unref();
    this.expiry.set(info.id, timer);
    return info;
  }
  async connect(id: string, socket: WebSocket) {
    const info = this.read(id);
    if (info.status !== 'connecting' || this.connecting.has(id))
      throw new Conflict('This attachment ended or is already open. Reconnect explicitly.');
    this.beforeOpen();
    this.connecting.add(id);
    const expired = this.expiry.get(id);
    if (expired) clearTimeout(expired);
    this.expiry.delete(id);
    let client: NativeClient | undefined;
    try {
      const target = this.target(info.targetId),
        { profile, proof } = await this.verify(target);
      if (socket.readyState !== 1)
        throw new Conflict('The owner browser disconnected before attachment.');
      client = await this.driver.open(profile, proof, info.mode, false);
      await this.verify(target);
      if (this.stopped || socket.readyState !== 1 || this.read(id).status !== 'connecting')
        throw new Conflict('This attachment was cancelled before it connected.');
      const live: Live = {
        client,
        socket,
        closed: false,
        pendingBytes: 0,
        input: Promise.resolve(),
      };
      this.live.set(id, live);
      const close = () =>
        this.stopClient(
          id,
          'Native attachment disconnected. The owner’s native session remains running.',
        );
      client.onOutput((data) => {
        if (live.closed || socket.readyState !== 1) return;
        if (Buffer.byteLength(data) > 1_000_000 || socket.bufferedAmount > 1_000_000) {
          socket.close(1013, 'Reconnect to refresh native output');
          close();
        } else socket.send(JSON.stringify({ type: 'output', data }));
      });
      client.onExit((code) => {
        if (!live.closed && socket.readyState === 1)
          socket.send(JSON.stringify({ type: 'exit', code }));
        close();
      });
      if (live.closed)
        throw new Conflict('The native attachment client ended before the terminal became ready.');
      socket.once('close', close);
      socket.once('error', close);
      socket.on('message', (raw, binary) => {
        if (live.closed) return;
        try {
          if (binary || raw.toString().length > 32_768) throw new Error('Invalid input');
          const input = terminalInputSchema.parse(JSON.parse(raw.toString()));
          if (input.type === 'input' && info.mode !== 'control')
            throw new Error('Observation does not grant input');
          const bytes = input.type === 'input' ? Buffer.byteLength(input.data) : 32;
          if (live.pendingBytes + bytes > 65_536) throw new Error('Input backpressure');
          live.pendingBytes += bytes;
          live.input = live.input
            .then(async () => {
              // This already-open native stream cannot reconnect or retarget on server replacement.
              // Rechecking native metadata for every key would spawn SSH commands while typing.
              this.profile(target);
              if (live.closed || socket.readyState !== 1 || this.live.get(id) !== live) return;
              if (input.type === 'input') client!.input(input.data);
              else client!.resize(input.cols, input.rows);
            })
            .catch(() => {
              socket.close(1008, 'Native identity changed or input was refused');
              close();
            })
            .finally(() => {
              live.pendingBytes -= bytes;
            });
        } catch {
          socket.close(1008, 'Invalid terminal input');
          close();
        }
      });
      this.update(id, {
        ...info,
        status: 'connected',
        message:
          info.mode === 'observe'
            ? 'Observing the native terminal.'
            : profile.kind === 'herdr'
              ? 'Native control acquired. The owner’s pane remains a native terminal.'
              : 'Native terminal input is shared with its existing clients.',
      });
      socket.send(JSON.stringify({ type: 'ready' }));
      // Ask the native client to redraw; never replay a saved raw screen or keys.
      client.resize(81, 24);
      client.resize(80, 24);
    } catch (error) {
      client?.close();
      const current = this.read(id);
      if (current.status === 'connecting')
        this.update(id, {
          ...current,
          status: 'unavailable',
          inputToken: undefined,
          message:
            error instanceof Conflict
              ? error.message
              : 'Native attachment failed. The original session was left running.',
        });
      throw error;
    } finally {
      this.connecting.delete(id);
    }
  }
  private stopClient(id: string, message: string) {
    const live = this.live.get(id);
    if (live) {
      this.live.delete(id);
      live.closed = true;
      live.client.close();
      if (live.socket.readyState === 1) live.socket.close(1000, 'Native attachment detached');
    }
    const timer = this.expiry.get(id);
    if (timer) clearTimeout(timer);
    this.expiry.delete(id);
    const info = this.read(id);
    if (info.status === 'connected' || info.status === 'connecting')
      this.update(id, { ...info, status: 'detached', inputToken: undefined, message });
  }
  detach(id: string, key: string) {
    const old = this.store.db
      .prepare('SELECT attachment,body FROM nc_detaches WHERE key=?')
      .get(key) as { attachment: string; body: string } | undefined;
    if (old) {
      if (old.attachment !== id)
        throw new Conflict('This detach request key belongs to another attachment.');
      return nativeConnectionAttachmentSchema.parse(JSON.parse(old.body));
    }
    const info = this.read(id);
    // The attachment's admission already reserved its one final detach receipt.
    // Later fresh keys do not append redundant receipts for an already-released client.
    if (this.store.db.prepare('SELECT 1 FROM nc_detaches WHERE attachment=?').get(id)) return info;
    const result = {
      ...info,
      status: 'detached' as const,
      inputToken: undefined,
      message: 'Detached. The owner’s native session remains running.',
    };
    this.atomic(() => {
      this.store.db
        .prepare('INSERT INTO nc_detaches VALUES(?,?,?)')
        .run(key, id, JSON.stringify(result));
      this.update(id, result);
    });
    this.stopClient(id, result.message);
    return result;
  }
  receipt(id: string, key: string) {
    const row = this.store.db
      .prepare('SELECT attachment,body FROM nc_sends WHERE key=?')
      .get(key) as { attachment: string; body: string } | undefined;
    if (!row || row.attachment !== id)
      throw new Missing('No saved prompt receipt is recorded for this attachment and key.');
    return nativeConnectionSendReceiptSchema.parse(JSON.parse(row.body));
  }
  async send(id: string, raw: unknown): Promise<NativeConnectionSendReceipt> {
    const input = nativeConnectionSendSchema.parse(raw),
      json = JSON.stringify(input);
    const previous = this.store.db
      .prepare('SELECT attachment,input,body FROM nc_sends WHERE key=?')
      .get(input.key) as { attachment: string; input: string; body: string } | undefined;
    if (previous) {
      if (previous.attachment !== id || previous.input !== json)
        throw new Conflict('This saved prompt key already belongs to different input.');
      return nativeConnectionSendReceiptSchema.parse(JSON.parse(previous.body));
    }
    const attachment = this.read(id),
      live = this.live.get(id);
    if (
      attachment.mode !== 'control' ||
      attachment.status !== 'connected' ||
      !live ||
      attachment.inputToken !== input.inputToken
    )
      throw new Conflict(
        'This control attachment or input token is no longer current. No prompt was sent.',
      );
    const target = this.target(attachment.targetId),
      createdAt = time();
    const receipt: NativeConnectionSendReceipt = {
      ...input,
      attachmentId: id,
      targetId: target.id,
      state: 'uncertain',
      message:
        'The saved prompt may reach the native pane. Inspect the original terminal; this request will never be replayed.',
      createdAt,
    };
    this.atomic(() => {
      // Both the immutable input and receipt retain the exact text.
      this.reserve(2 * Buffer.byteLength(json) + nativeConnectionLimits.receiptReserve);
      this.store.db
        .prepare('INSERT INTO nc_sends VALUES(?,?,?,?,?,?)')
        .run(input.key, id, target.id, json, JSON.stringify(receipt), createdAt);
      this.event('prompt.requested', input.key);
    });
    let dispatching = false;
    try {
      const { profile, proof } = await this.verify(target);
      if (
        live.closed ||
        this.live.get(id) !== live ||
        this.read(id).inputToken !== input.inputToken
      )
        throw new Conflict('The control attachment ended before prompt handoff.');
      dispatching = true;
      receipt.state = await this.driver.submit(profile, proof, live.client, input.text);
      receipt.message =
        receipt.state === 'delivered'
          ? 'Submitted to the native pane. This does not prove an agent accepted it or completed a turn.'
          : receipt.state === 'not_sent'
            ? 'The native pane changed before submission. No prompt was sent.'
            : 'Native pane handoff has no confirmation. Inspect the original terminal; this request will never be replayed.';
    } catch {
      if (!dispatching) {
        receipt.state = 'not_sent';
        receipt.message =
          'The native identity or control attachment changed before handoff. No prompt was sent.';
      }
    }
    this.atomic(() => {
      this.store.db
        .prepare('UPDATE nc_sends SET body=? WHERE key=?')
        .run(JSON.stringify(receipt), input.key);
      this.event(`prompt.${receipt.state}`, input.key);
    });
    return receipt;
  }
  prompts(targetId: string, before?: string) {
    this.target(targetId);
    const cursor = before
      ? (this.store.db
          .prepare('SELECT created,key FROM nc_sends WHERE key=? AND target=?')
          .get(before, targetId) as { created: string; key: string } | undefined)
      : undefined;
    if (before && !cursor)
      throw new Missing('This saved prompt cursor is not retained for that native identity.');
    const rows = this.store.db
      .prepare(
        `SELECT body FROM nc_sends WHERE target=? ${cursor ? 'AND (created<? OR (created=? AND key<?))' : ''}
      ORDER BY created DESC,key DESC LIMIT 21`,
      )
      .all(targetId, ...(cursor ? [cursor.created, cursor.created, cursor.key] : [])) as {
      body: string;
    }[];
    const items = rows.slice(0, 20).map((row) => {
      const {
        text,
        inputToken: _token,
        ...receipt
      } = nativeConnectionSendReceiptSchema.parse(JSON.parse(row.body));
      return { ...receipt, textPreview: text.slice(0, 1200), textLength: text.length };
    });
    return { items, nextCursor: rows.length > 20 ? items.at(-1)!.key : null };
  }
  close() {
    this.stopped = true;
    for (const id of [...new Set([...this.live.keys(), ...this.expiry.keys()])])
      this.stopClient(id, 'App attachment closed. The native session was left running.');
  }
}
