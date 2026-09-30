import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { PhoneAccess } from './phone-access.js';
import { PhoneTunnel } from './phone-tunnel.js';
import { repoRoot } from './paths.js';
import { inspectTailscale } from './tailscale.js';

let root: string, store: Store, phone: PhoneAccess, tunnel: PhoneTunnel;
let starts: number, stops: number, alive: boolean, ready: boolean;
const config = {
  origin: 'https://dock.example.test',
  issuer: 'https://owner.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  owner: 'owner@example.test',
  port: 4998,
};
const connect = async () => {
  starts++;
  alive = true;
  return {
    alive: () => alive,
    ready: async () => ready,
    close: async () => {
      stops++;
      alive = false;
    },
  };
};
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/phone-tunnel-'));
  store = new Store(join(root, 'dock.sqlite'));
  phone = new PhoneAccess(store, config);
  starts = stops = 0;
  ready = true;
  alive = false;
  writeFileSync(join(root, 'cloudflare-tunnel.token'), 'fixture-not-a-credential', { mode: 0o600 });
  tunnel = new PhoneTunnel(phone, root, connect);
});
afterEach(async () => {
  await tunnel.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
it('stays off until enabled, starts once, and stops its connector when disabled', async () => {
  tunnel.start();
  await tunnel.retry();
  expect(starts).toBe(0);
  phone.setEnabled(true);
  await tunnel.retry();
  expect(starts).toBe(1);
  expect(phone.status(false).connection).toBe('connected');
  await Promise.all([tunnel.retry(), tunnel.retry()]);
  expect(starts).toBe(1);
  phone.setEnabled(false);
  await tunnel.retry();
  expect(stops).toBe(1);
  expect(phone.connection).toBe('off');
});
it('reports actual readiness and lets an explicit retry replace an exited process without changing saved intent', async () => {
  ready = false;
  tunnel.start();
  phone.setEnabled(true);
  await tunnel.retry();
  expect(phone.connection).toBe('connecting');
  ready = true;
  await tunnel.retry();
  expect(phone.connection).toBe('connected');
  alive = false;
  const eventCount = store.db.prepare('SELECT count(*) AS n FROM events').get()!.n;
  await tunnel.retry();
  expect(starts).toBe(2);
  expect(phone.connection).toBe('connected');
  expect(phone.enabled).toBe(true);
  expect(store.db.prepare('SELECT count(*) AS n FROM events').get()!.n).toBe(eventCount);
});

it('automatically replaces an exited connector with backoff, leaving saved pairing and sessions untouched', async () => {
  vi.useFakeTimers();
  phone = new PhoneAccess(store, {
    origin: config.origin,
    authentication: 'paired',
    port: config.port,
  });
  tunnel = new PhoneTunnel(phone, root, connect);
  phone.setEnabled(true);
  const deviceId = randomUUID();
  store.db
    .prepare(
      `INSERT INTO paired_devices
    (id,name,browser_hash,credential_id,public_key,counter,created_at,require_unlock,setup_complete)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      deviceId,
      'Saved phone',
      'fixture-browser',
      'fixture-credential',
      'fixture-public-key',
      0,
      Date.now(),
      0,
      1,
    );
  store.db
    .prepare(
      `INSERT INTO device_unlocks
    (id,device_id,token_hash,expires_at,remembered) VALUES(?,?,?,?,?)`,
    )
    .run(randomUUID(), deviceId, 'fixture-unlock', Date.now() + 86_400_000, 1);
  const settings = store.db
    .prepare("SELECT * FROM settings WHERE key LIKE 'phone:%' ORDER BY key")
    .all();
  const pairing = store.db.prepare('SELECT * FROM paired_devices').all();
  const unlocks = store.db.prepare('SELECT * FROM device_unlocks').all();
  const revoke = vi.spyOn(phone.pairedDevices!, 'pause');
  tunnel.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toBe(1);
  ready = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(starts).toBe(1); // A live connector owns ordinary network reconnection.
  alive = false;
  await vi.advanceTimersByTimeAsync(3_000);
  expect(phone.connection).toBe('connecting');
  expect(stops).toBe(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(starts).toBe(1);
  ready = true;
  await vi.advanceTimersByTimeAsync(3_000);
  expect(starts).toBe(2);
  expect(phone.connection).toBe('connected');
  expect(revoke).not.toHaveBeenCalled();
  expect(
    store.db.prepare("SELECT * FROM settings WHERE key LIKE 'phone:%' ORDER BY key").all(),
  ).toEqual(settings);
  expect(store.db.prepare('SELECT * FROM paired_devices').all()).toEqual(pairing);
  expect(store.db.prepare('SELECT * FROM device_unlocks').all()).toEqual(unlocks);
});

it('bounds repeated failures, keeps manual retry, and renews automatic recovery only after sustained health', async () => {
  vi.useFakeTimers();
  let crash = true;
  tunnel = new PhoneTunnel(phone, root, async () => {
    const connector = await connect();
    if (crash) alive = false;
    return connector;
  });
  phone.setEnabled(true);
  tunnel.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toBe(1);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(starts).toBe(4); // Initial start plus three automatic retries.
  expect(phone.connection).toBe('error');
  await vi.advanceTimersByTimeAsync(300_000);
  expect(starts).toBe(4);
  crash = false;
  await tunnel.retry();
  expect(phone.connection).toBe('connected');
  expect(starts).toBe(5);
  for (let i = 0; i < 3; i++) {
    alive = false;
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync([6000, 15_000, 60_000][i]!);
    expect(phone.connection).toBe('connected');
  }
  expect(starts).toBe(8);
  await vi.advanceTimersByTimeAsync(123_000);
  alive = false;
  await vi.advanceTimersByTimeAsync(9_000);
  expect(starts).toBe(9);
  expect(phone.connection).toBe('connected');
});

it.each(['off', 'shutdown'])('cancels a pending automatic retry on %s', async (action) => {
  vi.useFakeTimers();
  phone.setEnabled(true);
  tunnel.start();
  await vi.advanceTimersByTimeAsync(0);
  alive = false;
  await vi.advanceTimersByTimeAsync(3_000);
  if (action === 'off') phone.setEnabled(false);
  else await tunnel.close();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(starts).toBe(1);
  expect(phone.connection).toBe('off');
});
it('closes before exit and restores enabled intent across an actual database restart', async () => {
  tunnel.start();
  phone.setEnabled(true);
  await tunnel.retry();
  await tunnel.close();
  expect(stops).toBe(1);
  expect(phone.enabled).toBe(true);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  phone = new PhoneAccess(store, config);
  expect(phone.enabled).toBe(true);
  tunnel = new PhoneTunnel(phone, root, connect);
  tunnel.start();
  await tunnel.retry();
  expect(starts).toBe(2);
  expect(phone.connection).toBe('connected');
});
it('refuses an insecure token file and offers retry after setup is corrected', async () => {
  chmodSync(join(root, 'cloudflare-tunnel.token'), 0o644);
  tunnel.start();
  phone.setEnabled(true);
  await tunnel.retry();
  expect(starts).toBe(0);
  expect(phone.connection).toBe('error');
  chmodSync(join(root, 'cloudflare-tunnel.token'), 0o600);
  await tunnel.retry();
  expect(starts).toBe(1);
  expect(phone.connection).toBe('connected');
});
it('does not supervise or kill externally managed tunnels when no scoped token is installed', async () => {
  rmSync(join(root, 'cloudflare-tunnel.token'));
  phone = new PhoneAccess(store, config);
  tunnel = new PhoneTunnel(phone, root, connect);
  tunnel.start();
  phone.setEnabled(true);
  await tunnel.retry();
  expect(phone.connection).toBe('external');
  expect(starts).toBe(0);
});
it('a late startup cannot outlive shutdown', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  tunnel = new PhoneTunnel(phone, root, async () => {
    await gate;
    return connect();
  });
  tunnel.start();
  phone.setEnabled(true);
  await Promise.resolve();
  const closing = tunnel.close();
  finish();
  await closing;
  expect(alive).toBe(false);
  expect(phone.connection).toBe('off');
});

it('does not launch a connector for an unavailable phone listener, including explicit retries', async () => {
  phone.setEnabled(true);
  phone.unavailable('listener');
  tunnel.start();
  await tunnel.retry();
  expect(starts).toBe(0);
  expect(phone.status(false)).toMatchObject({
    enabled: false,
    setupIssue: 'listener',
    connection: 'error',
  });
  expect(store.getSetting('phone:enabled')).toBe(true);
});

it('owns one foreground private connector, stops it on disable and restores intent without a persistent route', async () => {
  const binary = join(root, 'tailscale-fixture.cjs');
  const routeFile = join(root, 'private-route.json');
  const receipt = join(root, 'private-process.json');
  const state = {
    BackendState: 'Running',
    Self: { ID: 'fixture-node', DNSName: 'fixture.example.ts.net.', CapMap: { https: [] } },
  };
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(routeFile)};
if (args[0] === 'status') console.log(${JSON.stringify(JSON.stringify(state))});
else if (args[1] === 'status') console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}');
else {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, pid: process.pid }));
  fs.writeFileSync(file, JSON.stringify({ Foreground: { owned: { TCP: { 443: { HTTPS: true } }, Web: { 'fixture.example.ts.net:443': { Handlers: { '/': { Proxy: args[4] } } } } } } }));
  const close = () => { fs.rmSync(file, { force: true }); process.exit(0); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o700 },
  );
  vi.stubEnv('DOCK_TAILSCALE_BIN', binary);
  const preview = await inspectTailscale();
  expect(preview.state).toBe('ready');
  const privateConfig = {
    authentication: 'paired',
    transport: 'tailscale',
    origin: preview.origin,
    tailscaleNode: preview.node,
    port: 4998,
  };
  phone = new PhoneAccess(store, privateConfig);
  tunnel = new PhoneTunnel(phone, root);
  tunnel.start();
  phone.setEnabled(true);
  await expect
    .poll(async () => {
      await tunnel.retry();
      return phone.connection;
    })
    .toBe('connected');
  const first = JSON.parse(readFileSync(receipt, 'utf8'));
  expect(first.args).toEqual([
    'serve',
    '--bg=false',
    '--https=443',
    '--yes',
    'http://127.0.0.1:4998',
  ]);
  await tunnel.retry();
  expect(JSON.parse(readFileSync(receipt, 'utf8')).pid).toBe(first.pid);
  phone.setEnabled(false);
  await tunnel.retry();
  expect(existsSync(routeFile)).toBe(false);
  expect(() => process.kill(first.pid, 0)).toThrow();
  phone.setEnabled(true);
  await expect
    .poll(async () => {
      await tunnel.retry();
      return phone.connection;
    })
    .toBe('connected');
  await tunnel.close();
  expect(phone.enabled).toBe(true);
  expect(existsSync(routeFile)).toBe(false);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  phone = new PhoneAccess(store, privateConfig);
  tunnel = new PhoneTunnel(phone, root);
  tunnel.start();
  await expect
    .poll(async () => {
      await tunnel.retry();
      return phone.connection;
    })
    .toBe('connected');
  expect(JSON.parse(readFileSync(receipt, 'utf8')).pid).not.toBe(first.pid);
  await tunnel.close();
  expect(existsSync(routeFile)).toBe(false);
});
