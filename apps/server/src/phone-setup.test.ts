import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { PhoneAccess, readPhoneConfig } from './phone-access.js';
import { PhoneSetup } from './phone-setup.js';
import { createServer } from './server.js';
import { Terminals } from './terminal.js';
import { inspectTailscale, tailscaleRouteReady } from './tailscale.js';

const origin = 'https://fixture.tail-test.ts.net';
const native = () => ({
  BackendState: 'Running',
  Self: { ID: 'fixture-node', DNSName: 'fixture.tail-test.ts.net.', CapMap: { https: [] } },
  Peer: { ignored: { secret: 'private-peer-details' } },
  User: { ignored: 'private-account' },
});
let root: string,
  store: Store,
  phone: PhoneAccess,
  setup: PhoneSetup,
  runtime: Runtime,
  app: FastifyInstance,
  remote: FastifyInstance | undefined;
let status: ReturnType<typeof native>, serve: unknown, closed: boolean;
const read = vi.fn(async (args: string[]) => (args[0] === 'status' ? status : serve));
const activate = vi.fn(async () => {});
const headers = { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' };
const post = (path: string, payload: object) =>
  app.inject({ method: 'POST', url: `/api/phone/${path}`, headers, payload });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-phone-setup-'));
  store = new Store(join(root, 'dock.sqlite'));
  phone = new PhoneAccess(store, null);
  runtime = new Runtime(store, root, 'never-spawn', async () => new DemoProvider());
  status = native();
  serve = {};
  closed = false;
  remote = undefined;
  read.mockClear();
  activate.mockReset().mockResolvedValue();
  setup = new PhoneSetup(phone, root, 4999, activate, read, () => !closed);
  app = await createServer(store, runtime, {
    port: 4999,
    phone,
    phoneSetup: setup,
    tunnel: {
      retry: async () => {
        phone.connection = phone.enabled ? 'connected' : 'off';
      },
    },
  });
});
afterEach(async () => {
  await remote?.close();
  await app.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});

it('checks locally, confirms the exact address once, and activates the existing pairing routes without a restart', async () => {
  const checked = await post('setup/check', {});
  expect(checked.statusCode).toBe(200);
  expect(checked.json()).toMatchObject({ state: 'ready', origin });
  expect(checked.body).not.toMatch(/fixture-node|private-peer|private-account/);
  expect(existsSync(join(root, 'phone-access.json'))).toBe(false);
  const input = { key: randomUUID(), previewId: checked.json().previewId, confirm: true };
  const accepted = await post('setup/confirm', input);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({
    configured: true,
    enabled: false,
    transport: 'tailscale',
    authentication: 'paired',
    origin,
  });
  expect((await post('setup/confirm', input)).json()).toEqual(accepted.json());
  expect(activate).toHaveBeenCalledOnce();
  expect(statSync(join(root, 'phone-access.json')).mode & 0o777).toBe(0o600);
  expect(readPhoneConfig(root)).toMatchObject({
    origin,
    transport: 'tailscale',
    authentication: 'paired',
  });
  const terminals = new Terminals(runtime);
  remote = await createServer(store, runtime, {
    port: 4331,
    phone,
    terminals,
    remote: true,
    ownsRuntime: false,
  });
  expect(
    (await remote.inject({ url: '/api/snapshot', headers: { host: new URL(origin).host } }))
      .statusCode,
  ).toBe(503);
  await post('enabled', { enabled: true });
  const code = await post('code', { key: randomUUID() });
  expect(code.statusCode).toBe(200);
  const options = await remote.inject({
    method: 'POST',
    url: '/api/phone/enroll/options',
    headers: { host: new URL(origin).host, origin },
    payload: { code: code.json().code, name: 'Fixture phone' },
  });
  expect(options.statusCode).toBe(200);
  expect(options.json().rp.id).toBe(new URL(origin).hostname);
  expect((await post('confirm', { id: randomUUID(), confirmation: '123456' })).statusCode).not.toBe(
    404,
  );
  expect(
    (await remote.inject({ url: '/api/snapshot', headers: { host: new URL(origin).host } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await remote.inject({
        method: 'POST',
        url: '/api/phone/setup/check',
        headers: { host: new URL(origin).host, origin },
        payload: {},
      })
    ).statusCode,
  ).not.toBe(200);
});

it('refuses changed identity, expiry, arbitrary addresses and existing files before changing access', async () => {
  const preview = await setup.check();
  const input = { key: randomUUID(), previewId: preview.previewId, confirm: true };
  expect(
    (await post('setup/confirm', { ...input, origin: 'https://other.example.test' })).statusCode,
  ).toBe(400);
  status.Self.ID = 'different-node';
  await expect(setup.configure(input)).rejects.toThrow('changed');
  expect(existsSync(join(root, 'phone-access.json'))).toBe(false);
  status = native();
  const next = await setup.check();
  store.setSetting('phone:setup-preview', {
    ...(store.getSetting('phone:setup-preview') as object),
    expiresAt: 0,
  });
  await expect(
    setup.configure({ ...input, key: randomUUID(), previewId: next.previewId }),
  ).rejects.toThrow('Check this computer');
  const ready = await setup.check();
  writeFileSync(join(root, 'phone-access.json'), 'existing host configuration');
  await expect(
    setup.configure({ ...input, key: randomUUID(), previewId: ready.previewId }),
  ).rejects.toThrow();
  expect(readFileSync(join(root, 'phone-access.json'), 'utf8')).toBe('existing host configuration');
  expect(phone.config).toBeNull();
  expect(activate).not.toHaveBeenCalled();
});

it('retains written setup after failed listener activation and reopens with access still off', async () => {
  const preview = await setup.check();
  activate.mockImplementation(async () => {
    phone.unavailable('listener');
    throw new Error('Fixture listener occupied');
  });
  await expect(
    setup.configure({ key: randomUUID(), previewId: preview.previewId, confirm: true }),
  ).rejects.toThrow('occupied');
  expect(phone.status(false)).toMatchObject({
    configured: true,
    enabled: false,
    setupIssue: 'listener',
  });
  const config = readPhoneConfig(root);
  const reloaded = new PhoneAccess(store, config);
  expect(reloaded.status(false)).toMatchObject({
    configured: true,
    enabled: false,
    setupIssue: null,
    origin,
  });
  const existing = new PhoneSetup(reloaded, root, 4999, activate, read);
  const calls = read.mock.calls.length;
  expect((await existing.check()).state).toBe('configured');
  expect(read).toHaveBeenCalledTimes(calls);
});

it('cancels setup on shutdown before writing a new phone configuration', async () => {
  const preview = await setup.check();
  closed = true;
  await expect(
    setup.configure({ key: randomUUID(), previewId: preview.previewId, confirm: true }),
  ).rejects.toThrow('closing');
  expect(existsSync(join(root, 'phone-access.json'))).toBe(false);
});

it('distinguishes unavailable, signed-out, HTTPS and conflicting routes, preserving unrelated ports', async () => {
  expect(
    (
      await inspectTailscale(async () => {
        throw new Error('private native error');
      })
    ).message,
  ).not.toContain('private native error');
  status.BackendState = 'NeedsLogin';
  expect((await inspectTailscale(read)).state).toBe('connect');
  status = native();
  status.Self.CapMap = {} as typeof status.Self.CapMap;
  expect((await inspectTailscale(read)).state).toBe('https');
  status = native();
  for (const config of [
    { TCP: { '443': { HTTPS: true } } },
    { Foreground: { other: { TCP: { '443': { HTTPS: true } } } } },
    { AllowFunnel: { 'fixture.tail-test.ts.net:443': true } },
  ]) {
    serve = config;
    expect((await inspectTailscale(read)).state).toBe('conflict');
  }
  serve = {
    TCP: { '8443': { HTTPS: true } },
    AllowFunnel: { 'fixture.tail-test.ts.net:8443': true },
  };
  expect((await inspectTailscale(read)).state).toBe('ready');
});

it('only reports the original private foreground route as ready, never a public or replacement route', async () => {
  const preview = await setup.check();
  await setup.configure({ key: randomUUID(), previewId: preview.previewId, confirm: true });
  expect(await tailscaleRouteReady(phone.config!, read)).toBe(false);
  serve = {
    Foreground: {
      owned: {
        TCP: { '443': { HTTPS: true } },
        Web: {
          'fixture.tail-test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4331' } } },
        },
      },
    },
  };
  expect(await tailscaleRouteReady(phone.config!, read)).toBe(true);
  serve = { ...(serve as object), AllowFunnel: { 'fixture.tail-test.ts.net:443': true } };
  await expect(tailscaleRouteReady(phone.config!, read)).rejects.toThrow('private route');
  serve = {};
  status.Self.ID = 'other-node';
  await expect(tailscaleRouteReady(phone.config!, read)).rejects.toThrow('original');
});
