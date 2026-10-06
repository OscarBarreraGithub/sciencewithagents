import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createECDH, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import webpush from 'web-push';
import {
  escalationPayload,
  isEscalation,
  notificationGlobalSchema,
  notificationProjectSchema,
  notificationStatusSchema,
  pushEndpointAllowed,
  pushEndpointSchema,
  pushPayloadSchema,
  pushSubscribeSchema,
  pushSubscriptionRemoveSchema,
  type AttentionItem,
  type NotificationStatus,
  type PushPayload,
  type QuotaHold,
} from '@dock/shared';
import { z } from 'zod';
import { Conflict, Missing, type Store } from './store.js';
import type { PhoneAccess } from './phone-access.js';

/** `local` is the authenticated owner on this computer; `device:<id>` is one paired phone/browser. */
export type PushOwner = 'local' | `device:${string}`;
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
/** Delivery abstraction. Tests use a fake; production wraps the maintained web-push package. */
export interface PushSender {
  send(target: PushTarget, payload: string, vapid: Vapid): Promise<void>;
}
export class PushRejected extends Error {
  constructor(readonly statusCode: number) {
    super(`Push service rejected the message (${statusCode}).`);
  }
}
type Vapid = { publicKey: string; privateKey: string; subject: string };
/** `paused`: phone access is off. The subscription is kept but nothing is sent. */
export type DeviceState = 'active' | 'revoked' | 'paused';
type Subscription = {
  id: string;
  owner: string;
  label: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  failures: number;
};
type Episode = {
  key: string;
  project_id: string;
  active: number;
  pending: number;
  started_at: number;
  notified_at: number | null;
};

export const webPushSender: PushSender = {
  async send(target, payload, vapid) {
    try {
      await webpush.sendNotification(target, payload, {
        vapidDetails: vapid,
        TTL: 6 * 60 * 60,
        urgency: 'high',
        timeout: 15_000,
      });
    } catch (error) {
      if (error instanceof webpush.WebPushError) throw new PushRejected(error.statusCode);
      throw error;
    }
  },
};

const base64url = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => Buffer.from(value, 'base64url').length === bytes);
/** P-256 VAPID pair: the public key must be the one derived from the private key. */
const vapidFileSchema = z
  .object({
    publicKey: base64url(65),
    privateKey: base64url(32),
    subject: z.string().regex(/^(?:https:\/\/|mailto:)\S+$/),
  })
  .strict()
  .refine(({ publicKey, privateKey }) => {
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
      return ecdh.getPublicKey('base64url') === publicKey;
    } catch {
      return false;
    }
  });

/**
 * Typed QUARK hold causes that are a deliberate pause (manager or owner pause, a saved project
 * schedule, an owner budget cap) or an expected allowance wait QUARK resumes by itself. A `lease`
 * hold (lost acknowledgement, coordination conflict) and stops without a hold still escalate.
 */
export const quietHoldCauses: ReadonlySet<QuotaHold['cause']> = new Set([
  'manual',
  'project',
  'budget',
  'hourly',
  'monitoring',
  'reset',
  'headroom',
  'cache',
]);

/**
 * Escalation projection for the watcher. An interrupted controller is quiet only when an
 * unreleased quiet hold stopped its newest nonqueued, uncancelled run; failures are never filtered. One
 * indexed run is read only for agents with such a hold. Future queued work cannot hide that
 * pause, and a hold on future queued work cannot quiet an earlier genuine interruption.
 */
export function escalationItems(
  items: AttentionItem[],
  holds: Array<Pick<QuotaHold, 'runId' | 'agentId' | 'cause'>>,
  runs: Pick<Store, 'latestAttentionRun'>,
) {
  return items.filter((item) => {
    if (!isEscalation(item)) return false;
    if (item.kind !== 'interrupted') return true;
    const quiet = holds.filter(
      (hold) => hold.agentId === item.agentId && quietHoldCauses.has(hold.cause),
    );
    if (!quiet.length) return true;
    const recent = runs.latestAttentionRun(item.agentId);
    return !quiet.some((hold) => recent?.id === hold.runId);
  });
}

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

/**
 * Opt-in escalation push. Driven by store events and the deterministic attention read model;
 * there is no timer polling or model call. Keys and the delivery ledger stay under data/push.
 */
export class PushNotifications {
  readonly db: DatabaseSync;
  readonly vapid: Vapid;
  private readonly sender: PushSender;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly itemCooldownMs: number;
  private readonly projectCooldownMs: number;
  private deviceState: (deviceId: string) => DeviceState;
  private running: Promise<unknown> = Promise.resolve();
  private wakeTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  /** Agents the owner just acted on directly (for example Stop). Their stops are not news. */
  private readonly ownerActions = new Map<string, number>();
  private readonly ownerWindowMs = 2 * 60_000;

  constructor(
    dataDir: string,
    options: {
      sender?: PushSender;
      deviceState?: (deviceId: string) => DeviceState;
      now?: () => number;
      settleMs?: number;
      itemCooldownMs?: number;
      projectCooldownMs?: number;
    } = {},
  ) {
    const dir = join(dataDir, 'push');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.vapid = PushNotifications.keys(dir);
    const file = join(dir, 'push.db');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS push_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_projects (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        label TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_success_at INTEGER, last_failure_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS push_episodes (key TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        active INTEGER NOT NULL, pending INTEGER NOT NULL, started_at INTEGER NOT NULL,
        notified_at INTEGER);
      CREATE TABLE IF NOT EXISTS push_project_sends (project_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);`);
    this.sender = options.sender ?? webPushSender;
    this.deviceState = options.deviceState ?? (() => 'paused');
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? 45_000;
    this.itemCooldownMs = options.itemCooldownMs ?? 6 * 60 * 60_000;
    this.projectCooldownMs = options.projectCooldownMs ?? 10 * 60_000;
  }

  private static keys(dir: string): Vapid {
    const file = join(dir, 'vapid.json');
    // Only a missing file creates keys. Rotating silently would orphan every subscription,
    // so an unreadable or mismatched file disables notifications and is left byte-for-byte.
    if (existsSync(file)) {
      chmodSync(file, 0o600);
      try {
        return vapidFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        throw new Error(
          'Notification keys in data/push/vapid.json are unreadable or do not match. Notifications stay off; move that file aside to create new keys, then turn notifications on again on each device.',
        );
      }
    }
    const generated = webpush.generateVAPIDKeys();
    // The subject identifies the application to push services, never the owner.
    const value: Vapid = { ...generated, subject: 'https://sciencewithagents.com' };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
    return value;
  }

  /** Record a successful owner request on an agent; a resulting stop is silently seen. */
  ownerActed(...agentIds: Array<string | null | undefined>) {
    const now = this.now();
    for (const [id, at] of this.ownerActions)
      if (now - at > this.ownerWindowMs) this.ownerActions.delete(id);
    for (const id of agentIds) if (id) this.ownerActions.set(id, now);
  }
  private ownerCaused(item: AttentionItem, now: number) {
    return [item.agentId, item.id].some((id) => {
      const at = this.ownerActions.get(id);
      return at !== undefined && now - at <= this.ownerWindowMs;
    });
  }

  /** Main supplies phone-access state so revocation and phone-off remain authoritative. */
  setDeviceState(state: (deviceId: string) => DeviceState) {
    this.deviceState = state;
  }

  private setting(key: string) {
    return (
      this.db.prepare('SELECT value FROM push_settings WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  private setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO push_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  get enabled() {
    return this.setting('enabled') !== 'false';
  }
  private projectEnabled(projectId: string) {
    return !!(
      this.db.prepare('SELECT enabled FROM push_projects WHERE project_id=?').get(projectId) as
        | { enabled: number }
        | undefined
    )?.enabled;
  }
  private subscriptions() {
    return this.db
      .prepare('SELECT * FROM push_subscriptions ORDER BY created_at')
      .all() as Subscription[];
  }
  /** Revoked device subscriptions are removed before they can be listed or used. */
  private usable(owner: string) {
    if (!owner.startsWith('device:')) return true;
    const state = this.deviceState(owner.slice('device:'.length));
    if (state === 'revoked')
      this.db.prepare('DELETE FROM push_subscriptions WHERE owner=?').run(owner);
    return state === 'active';
  }

  status(owner: PushOwner, projects: Array<{ id: string; name: string }>): NotificationStatus {
    const visible = this.subscriptions().filter(
      (row) => !row.owner.startsWith('device:') || this.usable(row.owner) || row.owner === owner,
    );
    const listed = visible.filter((row) => owner === 'local' || row.owner === owner);
    return notificationStatusSchema.parse({
      available: true,
      publicKey: this.vapid.publicKey,
      enabled: this.enabled,
      projects: projects.map((project) => ({
        ...project,
        enabled: this.projectEnabled(project.id),
      })),
      subscriptions: listed.map((row) => ({
        id: row.id,
        label: row.label,
        service: new URL(row.endpoint).hostname,
        createdAt: iso(row.created_at),
        lastSuccessAt: iso(row.last_success_at),
        lastFailureAt: iso(row.last_failure_at),
        mine: row.owner === owner,
      })),
      otherSubscriptions: visible.length - listed.length,
    });
  }

  subscribe(owner: PushOwner, raw: unknown) {
    const input = pushSubscribeSchema.parse(raw);
    const existing = this.db
      .prepare('SELECT id,owner FROM push_subscriptions WHERE endpoint=?')
      .get(input.endpoint) as { id: string; owner: string } | undefined;
    // A capability URL already bound to another identity is not transferable by replay.
    if (
      existing &&
      existing.owner !== owner &&
      (this.usable(existing.owner) || this.deviceState(existing.owner.slice(7)) === 'paused')
    )
      throw new Conflict('This browser subscription belongs to another device. Turn it off there.');
    const id = existing?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions(id,owner,label,endpoint,p256dh,auth,created_at,failures)
         VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET label=excluded.label,
         p256dh=excluded.p256dh, auth=excluded.auth, failures=0`,
      )
      .run(id, owner, input.label, input.endpoint, input.keys.p256dh, input.keys.auth, this.now());
    return { id };
  }

  unsubscribe(owner: PushOwner, raw: unknown) {
    const { endpoint } = pushEndpointSchema.parse(raw);
    this.db
      .prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND owner=?')
      .run(endpoint, owner);
    return { ok: true };
  }

  /** Paired devices manage only their own subscriptions; the local owner manages all. */
  remove(owner: PushOwner, raw: unknown) {
    const { id } = pushSubscriptionRemoveSchema.parse(raw);
    const row = this.db.prepare('SELECT owner FROM push_subscriptions WHERE id=?').get(id) as
      | { owner: string }
      | undefined;
    if (!row || (owner !== 'local' && row.owner !== owner))
      throw new Missing('That notification device was not found.');
    this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(id);
    return { ok: true };
  }

  setEnabled(raw: unknown) {
    const { enabled } = notificationGlobalSchema.parse(raw);
    this.setSetting('enabled', String(enabled));
    return { ok: true };
  }

  setProject(raw: unknown, known: (projectId: string) => boolean) {
    const { projectId, enabled } = notificationProjectSchema.parse(raw);
    if (!known(projectId)) throw new Missing('That project was not found.');
    this.db
      .prepare(
        'INSERT INTO push_projects(project_id,enabled) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled',
      )
      .run(projectId, enabled ? 1 : 0);
    return { ok: true };
  }

  /** Explicit owner check: only the caller's own subscriptions receive it. */
  async test(owner: PushOwner) {
    const rows = this.subscriptions().filter((row) => row.owner === owner);
    if (!rows.length) throw new Conflict('Turn on notifications on this device first.');
    const payload = pushPayloadSchema.parse({
      title: 'sciencewithagents',
      body: 'Notifications are on for this device.',
      url: '/?computer=entry',
      tag: 'dock-test',
    });
    const sent = await this.deliver(rows, payload);
    return { sent };
  }

  /**
   * Record attention episodes and send at most one concise message per project. Items present
   * before the first run, while disabled, or for opted-out projects are marked seen silently.
   */
  observe(items: AttentionItem[]) {
    const run = this.running.then(() => this.evaluate(items));
    this.running = run.catch(() => undefined);
    return run;
  }

  private async evaluate(items: AttentionItem[]) {
    const now = this.now();
    const current = new Map<string, AttentionItem>(
      items.filter(isEscalation).map((item) => [`${item.kind}:${item.id}`, item]),
    );
    const initialized = this.setting('initialized') === 'true';
    const sends: Array<{ payload: PushPayload }> = [];
    let wakeAt = Infinity;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const episode = this.db.prepare('SELECT * FROM push_episodes WHERE key=?');
      for (const [key, item] of current) {
        const row = episode.get(key) as Episode | undefined;
        if (!row)
          this.db
            .prepare(
              'INSERT INTO push_episodes(key,project_id,active,pending,started_at) VALUES(?,?,1,?,?)',
            )
            .run(key, item.projectId, initialized && !this.ownerCaused(item, now) ? 1 : 0, now);
        else if (!row.active)
          this.db
            .prepare(
              'UPDATE push_episodes SET project_id=?, active=1, pending=?, started_at=? WHERE key=?',
            )
            .run(item.projectId, this.ownerCaused(item, now) ? 0 : 1, now, key);
      }
      for (const row of this.db
        .prepare('SELECT key FROM push_episodes WHERE active=1')
        .all() as Array<{ key: string }>)
        if (!current.has(row.key))
          this.db.prepare('UPDATE push_episodes SET active=0, pending=0 WHERE key=?').run(row.key);
      this.setSetting('initialized', 'true');
      const hasTargets = this.subscriptions().some((row) => this.usable(row.owner));
      const pending = this.db
        .prepare('SELECT * FROM push_episodes WHERE pending=1 ORDER BY started_at, key')
        .all() as Episode[];
      const clear = this.db.prepare('UPDATE push_episodes SET pending=0 WHERE key=?');
      const byProject = new Map<string, Episode[]>();
      for (const row of pending) {
        if (!this.enabled || !hasTargets || !this.projectEnabled(row.project_id)) {
          clear.run(row.key);
          continue;
        }
        if (row.notified_at !== null && now - row.notified_at < this.itemCooldownMs) {
          clear.run(row.key);
          continue;
        }
        // A blocker resolved within moments (for example by its manager) is not escalated.
        if (now - row.started_at < this.settleMs) {
          wakeAt = Math.min(wakeAt, row.started_at + this.settleMs);
          continue;
        }
        byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
      }
      for (const [projectId, rows] of byProject) {
        const last = (
          this.db
            .prepare('SELECT sent_at FROM push_project_sends WHERE project_id=?')
            .get(projectId) as { sent_at: number } | undefined
        )?.sent_at;
        if (last !== undefined && now - last < this.projectCooldownMs) {
          wakeAt = Math.min(wakeAt, last + this.projectCooldownMs);
          continue;
        }
        const matched = rows.map((row) => current.get(row.key)!);
        sends.push({ payload: escalationPayload(matched[0]!.projectName, matched) });
        for (const row of rows)
          this.db
            .prepare('UPDATE push_episodes SET pending=0, notified_at=? WHERE key=?')
            .run(now, row.key);
        this.db
          .prepare(
            'INSERT INTO push_project_sends(project_id,sent_at) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET sent_at=excluded.sent_at',
          )
          .run(projectId, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (wakeAt !== Infinity) this.schedule(wakeAt - now);
    // The ledger commits before delivery: a crash may lose one message but never repeats it.
    let sent = 0;
    for (const { payload } of sends)
      sent += await this.deliver(
        this.subscriptions().filter((row) => this.usable(row.owner)),
        payload,
      );
    return sent;
  }

  private async deliver(rows: Subscription[], payload: PushPayload) {
    let sent = 0;
    const body = JSON.stringify(payload);
    for (const row of rows) {
      // Defense in depth for rows written by an older contract.
      if (!pushEndpointAllowed(row.endpoint) || !this.usable(row.owner)) continue;
      try {
        await this.sender.send(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          this.vapid,
        );
        sent++;
        this.db
          .prepare('UPDATE push_subscriptions SET failures=0, last_success_at=? WHERE id=?')
          .run(this.now(), row.id);
      } catch (error) {
        const status = error instanceof PushRejected ? error.statusCode : 0;
        // Gone/not-found subscriptions are permanent; repeated failures are pruned too.
        if (status === 404 || status === 410 || row.failures + 1 >= 5)
          this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);
        else
          this.db
            .prepare(
              'UPDATE push_subscriptions SET failures=failures+1, last_failure_at=? WHERE id=?',
            )
            .run(this.now(), row.id);
      }
    }
    return sent;
  }

  private schedule(delay: number) {
    if (!this.wake) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wake?.();
      },
      Math.max(1000, delay),
    );
    this.wakeTimer.unref();
  }

  /** Re-read attention after store events settle. A deferred wake handles cooldown expiry. */
  watch(store: EventEmitter, read: () => AttentionItem[], debounceMs = 2000) {
    let timer: NodeJS.Timeout | null = null;
    const run = () => {
      timer = null;
      void this.observe(read()).catch(() => undefined);
    };
    const trigger = () => {
      if (!timer) {
        timer = setTimeout(run, debounceMs);
        timer.unref();
      }
    };
    this.wake = trigger;
    store.on('event', trigger);
    trigger();
    return () => {
      store.off('event', trigger);
      if (timer) clearTimeout(timer);
      if (this.wakeTimer) clearTimeout(this.wakeTimer);
      this.wake = null;
    };
  }

  close() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.db.isOpen) this.db.close();
  }
}

/** Revocation and phone-off stay owned by phone access; nothing is sent to either. */
export function phoneDeviceState(phone: Pick<PhoneAccess, 'enabled' | 'valid'>) {
  return (deviceId: string): DeviceState =>
    !phone.enabled
      ? 'paused'
      : phone.valid({ deviceId, email: '', subject: deviceId, expiresAt: Number.MAX_SAFE_INTEGER })
        ? 'active'
        : 'revoked';
}

/** Same authentication as every other route; the identity decides per-device authority. */
export function registerNotificationRoutes(
  app: FastifyInstance,
  notifications: PushNotifications | undefined,
  options: {
    owner: (request: FastifyRequest) => PushOwner;
    projects: () => Array<{ id: string; name: string }>;
  },
) {
  const require = () => {
    if (!notifications)
      throw new Conflict('Notifications are not available on this computer entry.');
    return notifications;
  };
  app.get('/api/notifications', async (request) =>
    notifications
      ? notifications.status(options.owner(request), options.projects())
      : notificationStatusSchema.parse({
          available: false,
          publicKey: null,
          enabled: false,
          projects: [],
          subscriptions: [],
          otherSubscriptions: 0,
        }),
  );
  app.post('/api/notifications/subscribe', async (request) =>
    require().subscribe(options.owner(request), request.body),
  );
  app.post('/api/notifications/unsubscribe', async (request) =>
    require().unsubscribe(options.owner(request), request.body),
  );
  app.post('/api/notifications/remove', async (request) =>
    require().remove(options.owner(request), request.body),
  );
  app.post('/api/notifications/enabled', async (request) => require().setEnabled(request.body));
  app.post('/api/notifications/project', async (request) =>
    require().setProject(request.body, (id) =>
      options.projects().some((project) => project.id === id),
    ),
  );
  app.post('/api/notifications/test', async (request) => require().test(options.owner(request)));
}
