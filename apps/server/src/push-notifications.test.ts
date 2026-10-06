import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import {
  escalationPayload,
  pushEndpointAllowed,
  pushPayloadSchema,
  type AttentionItem,
} from '@dock/shared';
import {
  escalationItems,
  PushNotifications,
  PushRejected,
  registerNotificationRoutes,
  type DeviceState,
  type PushOwner,
  type PushSender,
} from './push-notifications.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dock-push-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeSender implements PushSender {
  sent: Array<{ endpoint: string; payload: ReturnType<typeof pushPayloadSchema.parse> }> = [];
  fail = new Map<string, number>();
  async send(target: { endpoint: string }, payload: string) {
    const status = this.fail.get(target.endpoint);
    if (status !== undefined) throw new PushRejected(status);
    this.sent.push({
      endpoint: target.endpoint,
      payload: pushPayloadSchema.parse(JSON.parse(payload)),
    });
  }
}

const key =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const auth = 'tBHItJI5svbpez7KI4CCXg';
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;
const subscription = (name: string) => ({ endpoint: endpoint(name), keys: { p256dh: key, auth } });
const projectId = randomUUID();
const item = (
  kind: AttentionItem['kind'],
  id = randomUUID(),
  project = projectId,
): AttentionItem => ({
  id,
  kind,
  projectId: project,
  projectName: 'Thesis',
  agentId: randomUUID(),
  taskId: null,
  title: 'Run `curl -H "Authorization: Bearer SECRET"`',
  description: 'private details',
  updatedAt: new Date().toISOString(),
  destination: 'conversation',
});

function setup(options: { deviceState?: (id: string) => DeviceState; dir?: string } = {}) {
  let clock = 1_000_000;
  const sender = new FakeSender();
  const notifications = new PushNotifications(options.dir ?? temp(), {
    sender,
    now: () => clock,
    settleMs: 1000,
    itemCooldownMs: 60_000,
    projectCooldownMs: 10_000,
    deviceState: options.deviceState ?? (() => 'active'),
  });
  return {
    notifications,
    sender,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
const enable = (notifications: PushNotifications, owner: PushOwner = 'local', name = 'a') => {
  notifications.subscribe(owner, subscription(name));
  notifications.setProject({ projectId, enabled: true }, () => true);
};

describe('push escalation notifications', () => {
  it('stores private keys and the ledger owner-only under data/push', () => {
    const dir = temp();
    const { notifications } = setup({ dir });
    expect(statSync(join(dir, 'push')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'push', 'vapid.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'push', 'push.db')).mode & 0o777).toBe(0o600);
    const key = notifications.vapid.publicKey;
    notifications.close();
    expect(setup({ dir }).notifications.vapid.publicKey).toBe(key);
  });

  it('never rotates an existing key file; an invalid one keeps notifications off', () => {
    for (const saved of [
      '{"publicKey":"x","privateKey":"y","subject":"https://sciencewithagents.com"}',
      'not json',
    ]) {
      const dir = temp();
      setup({ dir }).notifications.close();
      const file = join(dir, 'push', 'vapid.json');
      const valid = JSON.parse(readFileSync(file, 'utf8'));
      // A well-formed pair from another installation does not match this private key either.
      const other = temp();
      setup({ dir: other }).notifications.close();
      const mismatched = JSON.stringify({
        ...valid,
        publicKey: JSON.parse(readFileSync(join(other, 'push', 'vapid.json'), 'utf8')).publicKey,
      });
      for (const bytes of [saved, mismatched]) {
        writeFileSync(file, bytes);
        expect(() => setup({ dir })).toThrow(/Notifications stay off/);
        expect(readFileSync(file, 'utf8')).toBe(bytes);
      }
      writeFileSync(file, JSON.stringify(valid));
      expect(setup({ dir }).notifications.vapid.publicKey).toBe(valid.publicKey);
    }
  });

  it('refuses non-push-service endpoints before storage', () => {
    for (const value of [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://169.254.169.254/latest',
    ])
      expect(pushEndpointAllowed(value)).toBe(false);
    expect(pushEndpointAllowed('https://web.push.apple.com/abc')).toBe(true);
    const { notifications } = setup();
    expect(() =>
      notifications.subscribe('local', {
        endpoint: 'https://10.0.0.1/x',
        keys: { p256dh: key, auth },
      }),
    ).toThrow();
  });

  it('sends nothing for items that existed before enabling, then one concise message per new stop', async () => {
    const { notifications, sender, advance } = setup();
    const old = item('approval');
    await notifications.observe([old]);
    enable(notifications);
    advance(5000);
    await notifications.observe([old]);
    expect(sender.sent).toHaveLength(0);
    const fresh = item('failed');
    await notifications.observe([old, fresh]);
    expect(sender.sent).toHaveLength(0); // settling: a quick manager fix does not notify
    advance(1500);
    await notifications.observe([old, fresh]);
    expect(sender.sent).toHaveLength(1);
    const { payload } = sender.sent[0]!;
    expect(payload.title).toBe('Thesis needs you');
    expect(payload.body).toBe('A run stopped with an error. Open the app to continue.');
    expect(payload.url).toBe(`/?computer=entry#/chat/${fresh.agentId}`);
    expect(JSON.stringify(payload)).not.toMatch(/SECRET|curl|private/);
    advance(60_000);
    await notifications.observe([old, fresh]);
    expect(sender.sent).toHaveLength(1);
  });

  it('ignores non-blocking kinds and resolved-in-moments blockers', async () => {
    const { notifications, sender, advance } = setup();
    enable(notifications);
    await notifications.observe([]);
    const transient = item('approval');
    await notifications.observe([item('integration'), item('backup'), transient]);
    advance(500);
    await notifications.observe([]);
    advance(5000);
    await notifications.observe([]);
    expect(sender.sent).toHaveLength(0);
  });

  it('keeps dedup and cooldown across a restart and coalesces a project burst', async () => {
    const dir = temp();
    let first = setup({ dir });
    enable(first.notifications);
    await first.notifications.observe([]);
    const a = item('decision');
    await first.notifications.observe([a]);
    first.advance(2000);
    await first.notifications.observe([a]);
    expect(first.sender.sent).toHaveLength(1);
    const b = item('approval'),
      c = item('interrupted');
    await first.notifications.observe([a, b, c]);
    first.notifications.close();
    // Restart at the same moment: the ledger, pending items and cooldown are durable.
    const second = setup({ dir });
    second.advance(2000);
    await second.notifications.observe([a, b, c]);
    expect(second.sender.sent).toHaveLength(0); // project cooldown still active
    second.advance(10_000);
    await second.notifications.observe([a, b, c]);
    expect(second.sender.sent).toHaveLength(1);
    expect(second.sender.sent[0]!.payload.body).toBe(
      'An approval is waiting; A run was interrupted. Open the app to continue.',
    );
    second.advance(20_000);
    await second.notifications.observe([a, b, c]);
    expect(second.sender.sent).toHaveLength(1);
  });

  it('does not notify the owner about a stop they just made, but does later', async () => {
    const { notifications, sender, advance } = setup();
    enable(notifications);
    await notifications.observe([]);
    const stopped = item('interrupted');
    notifications.ownerActed(stopped.agentId);
    await notifications.observe([stopped]);
    advance(5000);
    await notifications.observe([stopped]);
    expect(sender.sent).toHaveLength(0);
    advance(3 * 60_000);
    await notifications.observe([]);
    await notifications.observe([stopped]);
    advance(2000);
    await notifications.observe([stopped]);
    expect(sender.sent).toHaveLength(1);
  });

  it('honors global and per-project switches without replaying suppressed stops', async () => {
    const { notifications, sender, advance } = setup();
    enable(notifications);
    await notifications.observe([]);
    notifications.setEnabled({ enabled: false });
    const stopped = item('failed'),
      elsewhere = item('failed', randomUUID(), randomUUID());
    await notifications.observe([stopped, elsewhere]);
    advance(2000);
    await notifications.observe([stopped, elsewhere]);
    notifications.setEnabled({ enabled: true });
    advance(2000);
    await notifications.observe([stopped, elsewhere]);
    expect(sender.sent).toHaveLength(0);
  });

  it('prunes gone subscriptions and those failing repeatedly', async () => {
    const { notifications, sender } = setup();
    enable(notifications, 'local', 'gone');
    notifications.subscribe('local', subscription('flaky'));
    sender.fail.set(endpoint('gone'), 410);
    sender.fail.set(endpoint('flaky'), 500);
    for (let attempt = 0; attempt < 5; attempt++)
      await notifications.test('local').catch(() => undefined);
    expect(notifications.status('local', []).subscriptions).toHaveLength(0);
  });

  it('binds subscriptions to the device and follows revocation and phone-off', async () => {
    const states = new Map<string, DeviceState>([
      ['phone-a', 'active'],
      ['phone-b', 'active'],
    ]);
    const { notifications, sender, advance } = setup({
      deviceState: (id) => states.get(id) ?? 'revoked',
    });
    enable(notifications, 'device:phone-a', 'a');
    notifications.subscribe('device:phone-b', subscription('b'));
    expect(() => notifications.subscribe('device:phone-b', subscription('a'))).toThrow(
      /another device/,
    );
    const view = notifications.status('device:phone-b', []);
    expect(view.subscriptions.map((row) => row.mine)).toEqual([true]);
    expect(view.otherSubscriptions).toBe(1);
    expect(JSON.stringify(view)).not.toContain('fcm/send');
    const phoneA = notifications.status('device:phone-a', []).subscriptions[0]!;
    expect(() => notifications.remove('device:phone-b', { id: phoneA.id })).toThrow(/not found/);
    await expect(notifications.test('device:phone-a')).resolves.toEqual({ sent: 1 });

    states.set('phone-a', 'paused');
    await expect(notifications.test('device:phone-a')).resolves.toEqual({ sent: 0 });
    states.set('phone-a', 'revoked');
    await notifications.observe([]);
    const stop = item('decision');
    await notifications.observe([stop]);
    advance(2000);
    await notifications.observe([stop]);
    expect(sender.sent.map((row) => row.endpoint)).toEqual([endpoint('a'), endpoint('b')]);
    expect(notifications.status('local', []).subscriptions).toHaveLength(1);
    // The revoked phone's endpoint can be claimed by a newly paired identity.
    expect(notifications.subscribe('device:phone-b', subscription('a')).id).toBeTruthy();
  });

  it('wakes once after the cooldown from store events without polling', async () => {
    const { notifications, sender } = setup();
    enable(notifications);
    const store = new EventEmitter();
    let items: AttentionItem[] = [];
    const stop = notifications.watch(store, () => items, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    items = [item('approval')];
    store.emit('event');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sender.sent).toHaveLength(0);
    stop();
    expect(store.listenerCount('event')).toBe(0);
  });

  it('builds lock-screen payloads with generic counts only', () => {
    const payload = escalationPayload('A very long project name '.repeat(6), [
      item('approval'),
      item('approval'),
      item('decision'),
    ]);
    expect(payload.title.length).toBeLessThanOrEqual(80);
    expect(payload.body).toBe(
      '2 approvals are waiting; A task needs your decision. Open the app to continue.',
    );
  });
});

describe('notification routes', () => {
  async function server(notifications?: PushNotifications) {
    const app = Fastify();
    registerNotificationRoutes(app, notifications, {
      owner: (request) => (request.headers['x-test-owner'] as PushOwner | undefined) ?? 'local',
      projects: () => [{ id: projectId, name: 'Thesis' }],
    });
    return app;
  }
  it('reports honest unavailability when the entry has no notifier', async () => {
    const app = await server();
    const response = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(response.json()).toMatchObject({ available: false, publicKey: null });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/notifications/test',
      payload: {},
    });
    expect(refused.statusCode).toBe(500);
  });
  it('scopes device management and validates project toggles', async () => {
    const { notifications } = setup();
    const app = await server(notifications);
    const subscribe = await app.inject({
      method: 'POST',
      url: '/api/notifications/subscribe',
      headers: { 'x-test-owner': 'device:phone-a' },
      payload: { ...subscription('route'), label: 'iPhone' },
    });
    expect(subscribe.statusCode).toBe(200);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/notifications/project',
      payload: { projectId: randomUUID(), enabled: true },
    });
    expect(unknown.statusCode).not.toBe(200);
    const status = (
      await app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: { 'x-test-owner': 'device:phone-b' },
      })
    ).json();
    expect(status).toMatchObject({ subscriptions: [], otherSubscriptions: 1 });
    expect(status.projects).toEqual([{ id: projectId, name: 'Thesis', enabled: false }]);
  });
});

describe('notifications through the real local and phone entries', () => {
  it('binds subscriptions to the paired device, scopes management and follows revocation', async () => {
    const { mkdirSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const { repoRoot } = await import('./paths.js');
    const { modelFixture } = await import('./model-policy.fixture.js');
    const { Store } = await import('./store.js');
    const { Runtime } = await import('./runtime.js');
    const { DemoProvider } = await import('./demo.js');
    const { Terminals } = await import('./terminal.js');
    const { PhoneAccess, phoneConfigSchema } = await import('./phone-access.js');
    const { createServer } = await import('./server.js');
    const { phoneDeviceState } = await import('./push-notifications.js');
    mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
    const root = mkdtempSync(join(repoRoot, 'data/tests/push-'));
    dirs.push(root);
    const store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const { projectId: fixtureProject } = store.agent(
      store.register(root, 'Fixture', '').managerId,
    );
    const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
    const origin = 'https://dock.example.test';
    const phone = new PhoneAccess(
      store,
      phoneConfigSchema.parse({ origin, authentication: 'paired', port: 4998 }),
    );
    const sender = new FakeSender();
    const notifications = new PushNotifications(root, {
      sender,
      deviceState: phoneDeviceState(phone),
    });
    const { localEntryOptions, phoneEntryOptions } = await import('./entry-options.js');
    // The same option builders main uses: a service missing from either entry fails here.
    const shared = { phone, terminals: new Terminals(runtime), notifications };
    const local = await createServer(store, runtime, localEntryOptions(shared, { port: 4999 }));
    const remote = await createServer(store, runtime, phoneEntryOptions(shared, { port: 4998 }));
    try {
      phone.setEnabled(true);
      phone.pairedDevices; // creates the paired device table
      const tokens = { a: 'token-a-'.padEnd(43, 'a'), b: 'token-b-'.padEnd(43, 'b') };
      const ids = { a: randomUUID(), b: randomUUID() };
      for (const name of ['a', 'b'] as const)
        store.db
          .prepare(
            'INSERT INTO paired_devices(id,name,browser_hash,credential_id,public_key,counter,created_at,revoked_at,setup_complete) VALUES(?,?,?,?,?,0,?,NULL,1)',
          )
          .run(
            ids[name],
            `Phone ${name}`,
            createHash('sha256').update(tokens[name]).digest('hex'),
            randomUUID(),
            'unused',
            Date.now(),
          );
      const phoneRequest = (name: 'a' | 'b' | null, url: string, payload?: object) =>
        remote.inject({
          url,
          ...(payload ? { method: 'POST' as const, payload } : {}),
          headers: {
            host: 'dock.example.test',
            origin,
            'content-type': 'application/json',
            ...(name ? { cookie: `__Host-dock_enrollment=${tokens[name]}` } : {}),
          },
        });
      const localRequest = (url: string, payload?: object) =>
        local.inject({
          url,
          ...(payload ? { method: 'POST' as const, payload } : {}),
          headers: {
            host: '127.0.0.1:4999',
            origin: 'http://127.0.0.1:4999',
            'content-type': 'application/json',
          },
        });
      expect((await phoneRequest(null, '/api/notifications')).statusCode).toBe(401);
      expect((await phoneRequest('a', '/api/notifications')).json()).toMatchObject({
        available: true,
        publicKey: notifications.vapid.publicKey,
      });
      const subscribed = await phoneRequest('a', '/api/notifications/subscribe', {
        ...subscription('phone-a'),
        label: 'iPhone',
      });
      expect(subscribed.statusCode).toBe(200);
      const fromB = (await phoneRequest('b', '/api/notifications')).json();
      expect(fromB).toMatchObject({ available: true, subscriptions: [], otherSubscriptions: 1 });
      expect(fromB.projects.map((project: { id: string }) => project.id)).toContain(fixtureProject);
      const removeByB = await phoneRequest('b', '/api/notifications/remove', {
        id: subscribed.json().id,
      });
      expect(removeByB.statusCode).toBe(404);
      expect((await phoneRequest('a', '/api/notifications/test', {})).json()).toEqual({ sent: 1 });
      const fromLocal = (await localRequest('/api/notifications')).json();
      expect(fromLocal.subscriptions).toMatchObject([{ label: 'iPhone', mine: false }]);
      expect(JSON.stringify(fromLocal)).not.toContain('phone-a');
      // Phone access off pauses delivery but keeps the subscription.
      phone.setEnabled(false);
      expect((await localRequest('/api/notifications')).json().subscriptions).toHaveLength(0);
      phone.setEnabled(true);
      expect((await localRequest('/api/notifications')).json().subscriptions).toHaveLength(1);
      phone.revoke(ids.a);
      expect((await phoneRequest('a', '/api/notifications')).statusCode).toBe(401);
      expect((await localRequest('/api/notifications')).json().subscriptions).toHaveLength(0);
      expect(
        notifications.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get(),
      ).toEqual({ n: 0 });
      expect(sender.sent).toHaveLength(1);
    } finally {
      await remote.close();
      await local.close();
      notifications.close();
      if (store.db.isOpen) store.close();
    }
  });
});

describe('expected pauses stay quiet', () => {
  it('uses typed QUARK hold causes: allowance waits and deliberate pauses are silent, genuine stops escalate once', async () => {
    const { mkdirSync } = await import('node:fs');
    const { repoRoot } = await import('./paths.js');
    const { modelFixture } = await import('./model-policy.fixture.js');
    const { Store } = await import('./store.js');
    const { Runtime } = await import('./runtime.js');
    const { DemoProvider } = await import('./demo.js');
    mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
    const root = mkdtempSync(join(repoRoot, 'data/tests/push-holds-'));
    dirs.push(root);
    const store = new Store(join(root, 'dock.sqlite'));
    try {
      modelFixture(store);
      const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
      const agent = store.agent(store.register(root, 'Fixture', '').managerId);
      const stop = () => {
        const run = store.enqueue(agent.id, randomUUID(), 'work');
        store.updateRun(run.id, { status: 'interrupted' });
        store.updateAgent(agent.id, { status: 'interrupted', turnId: null });
        return store.run(run.id);
      };
      const stopped: AttentionItem = {
        ...item('interrupted', agent.id, agent.projectId),
        agentId: agent.id,
      };
      // Long history must not be reread: at most one indexed run, only when held.
      for (let index = 0; index < 200; index++)
        store.updateRun(store.enqueue(agent.id, randomUUID(), 'old').id, { status: 'completed' });
      const reads: number[] = [];
      const reader = {
        latestAttentionRun: (agentId: string) => {
          const row = store.latestAttentionRun(agentId);
          reads.push(row ? 1 : 0);
          return row;
        },
      };
      const project = (items: AttentionItem[]) =>
        escalationItems(items, runtime.quark.holds(), reader);
      const first = stop();
      expect(project([stopped])).toEqual([stopped]);
      expect(reads).toEqual([]);
      for (const cause of ['reset', 'headroom', 'hourly', 'monitoring', 'cache'] as const) {
        runtime.quark.hold(first, 'Waiting for the allowance', false, cause);
        expect(project([stopped])).toEqual([]);
      }
      runtime.quark.hold(first, 'Manager requested pause: review', false, 'manual');
      expect(project([stopped])).toEqual([]);
      // A lost acknowledgement needs the owner; so does a failure even while held.
      runtime.quark.hold(first, 'The native turn acknowledgement was lost.', false, 'lease');
      expect(project([stopped])).toEqual([stopped]);
      runtime.quark.hold(first, 'Paused by budget', false, 'budget');
      expect(project([stopped])).toEqual([]);
      const future = store.enqueue(agent.id, randomUUID(), 'future work stays queued');
      expect(project([stopped])).toEqual([]);
      expect(store.run(future.id).status).toBe('queued');
      const failed = { ...stopped, kind: 'failed' as const };
      expect(project([failed])).toEqual([failed]);

      const { notifications, sender, advance } = setup();
      notifications.subscribe('local', subscription('holds'));
      notifications.setProject({ projectId: agent.projectId, enabled: true }, () => true);
      await notifications.observe([]);
      await notifications.observe(project([stopped]));
      advance(2000);
      expect(await notifications.observe(project([stopped]))).toBe(0);
      // A newer crash/restart stop is not covered by the older run's pause.
      stop();
      await notifications.observe(project([stopped]));
      advance(2000);
      expect(await notifications.observe(project([stopped]))).toBe(1);
      advance(2000);
      expect(await notifications.observe(project([stopped]))).toBe(0);
      expect(sender.sent).toHaveLength(1);
      notifications.close();
      // Holding future queued work cannot quiet the preceding genuine interruption.
      const queued = store.enqueue(agent.id, randomUUID(), 'next');
      runtime.quark.hold(store.run(queued.id), 'Manager requested pause: wait', false, 'manual');
      expect(project([stopped])).toEqual([stopped]);
      store.updateRun(queued.id, { status: 'cancelled' });
      expect(project([stopped])).toEqual([stopped]);
      expect(reads.length).toBeGreaterThan(0);
      expect(Math.max(...reads)).toBeLessThanOrEqual(1);
    } finally {
      if (store.db.isOpen) store.close();
    }
  });
});

describe('notification click target', () => {
  it('always opens a new entry-scoped document on this origin, never navigating an open tab', async () => {
    const { runInNewContext } = await import('node:vm');
    const { repoRoot } = await import('./paths.js');
    const listeners = new Map<string, (event: unknown) => void>();
    const opened: string[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    const self = {
      location: { origin: 'https://dock.example.test' },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      clients: {
        openWindow: async (url: string) => opened.push(url),
        matchAll: async () => {
          throw new Error('An existing tab must not be reused.');
        },
      },
    };
    runInNewContext(readFileSync(join(repoRoot, 'apps/web/public/notifications-sw.js'), 'utf8'), {
      self,
      URL,
    });
    const agent = randomUUID();
    for (const route of [
      `/?computer=entry#/chat/${agent}`,
      `/#/chat/${agent}`,
      'https://elsewhere.example/#/chat/x',
      '/?computer=other',
      undefined,
    ]) {
      listeners.get('notificationclick')!({
        notification: { close: () => undefined, data: { route } },
        waitUntil: (work: Promise<unknown>) => (pending = work),
      });
      await pending;
    }
    expect(opened).toEqual([
      `https://dock.example.test/?computer=entry#/chat/${agent}`,
      `https://dock.example.test/?computer=entry#/chat/${agent}`,
      'https://dock.example.test/?computer=entry',
      'https://dock.example.test/?computer=entry',
      'https://dock.example.test/?computer=entry',
    ]);
  });
});
