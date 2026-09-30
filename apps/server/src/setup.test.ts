import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultModelPolicy, modelPolicySchema, type ProviderAccountState } from '@dock/shared';
import { ModelPolicy } from './model-policy.js';
import { initializeScheduling, Pulsar } from './pulsar.js';
import { Setup } from './setup.js';
import { CodexSignIn } from './codex-sign-in.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { proxyPath } from './hosts.js';
import type { Provider } from './codex.js';

let root: string, store: Store;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-setup-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const model = (id: string) => ({ id, label: id, efforts: ['low', 'high'], isDefault: false });

it('a clean installation routes managers, workers, checks and escalation tiers to its single selected provider', async () => {
  const discover = vi.fn(async (provider: string) => {
    if (provider !== 'codex') throw new Error('No Claude account');
    return ['astra', 'sol', 'terra', 'luna'].map(model);
  });
  const policy = new ModelPolicy(store, discover);
  expect(policy.policy().enabledProviders).toEqual(['codex']);
  for (const task of [
    'manager',
    'routine',
    'reasoning',
    'calculation',
    'orchestration',
    'bulk',
  ] as const)
    expect((await policy.resolve(task, undefined, true)).provider).toBe('codex');
  const project = store.register(root, 'First project', '');
  expect(store.agent(project.managerId).provider).toBe('codex');
  expect(store.defaultProvider('implementer')).toBe('codex');
  await policy.refresh();
  expect(discover.mock.calls.every(([provider]) => provider === 'codex')).toBe(true);
  // Pick remains deliberate; an explicit native or saved provider identity is never remapped.
  const p = policy.policy();
  p.preset = 'pick';
  policy.save({ key: randomUUID(), policy: p, expectedRevision: 0 });
  expect(() => policy.provider('manager')).toThrow(/choose/i);
  expect(policy.provider('routine', undefined, true)).toBe('codex');
  expect(policy.provider('reasoning', 'claude')).toBe('claude');
});

it('legacy policies, old workspaces, native providers and exact pins retain their original meaning', () => {
  const legacy = structuredClone(defaultModelPolicy);
  const { enabledProviders: _ignored, ...raw } = legacy;
  raw.models.codex.grad.model = 'older-exact-model';
  raw.providers.reasoning = 'claude';
  store.setSetting('model-policy', raw);
  const before = JSON.stringify(store.getSetting('model-policy'));
  const policy = new ModelPolicy(store, async () => []);
  expect(policy.policy().enabledProviders).toEqual(['codex', 'claude']);
  expect(policy.provider('reasoning')).toBe('claude');
  expect(policy.policy().models.codex.grad.model).toBe('older-exact-model');
  expect(JSON.stringify(store.getSetting('model-policy'))).toBe(before);
  expect(modelPolicySchema.safeParse({ ...legacy, enabledProviders: [] }).success).toBe(false);
  expect(
    modelPolicySchema.safeParse({ ...legacy, enabledProviders: ['codex', 'codex'] }).success,
  ).toBe(false);
  expect(() =>
    policy.save({
      key: randomUUID(),
      expectedRevision: 0,
      policy: { ...legacy, enabledProviders: ['codex'] },
    }),
  ).toThrow('enabled providers');
});

it('metadata checks coalesce, retry failure honestly and never infer or change provider routing', async () => {
  let state: ProviderAccountState = 'sign-in',
    fail = false;
  const account = vi.fn(async () => {
    if (fail) throw new Error('secret account data');
    return state;
  });
  const discover = vi.fn(async () => [model('astra')]);
  const policy = new ModelPolicy(store, discover);
  const setup = new Setup(policy, account);
  cleanups.push(() => setup.close());
  expect(setup.status().accounts[0]?.state).toBe('unchecked');
  expect(account).not.toHaveBeenCalled();
  await Promise.all([setup.refresh(), setup.refresh()]);
  expect(account).toHaveBeenCalledOnce();
  expect(discover).not.toHaveBeenCalled();
  state = 'signed-in';
  await setup.refresh();
  expect(setup.status().policy.catalogs[0]?.models).toHaveLength(1);
  fail = true;
  await setup.refresh();
  expect(setup.status().accounts[0]?.state).toBe('unavailable');
  expect(JSON.stringify(setup.status())).not.toContain('secret');
  expect(policy.policy().enabledProviders).toEqual(['codex']);
  fail = false;
  await setup.refresh();
  expect(setup.status().accounts[0]?.state).toBe('signed-in');
});

it('setup APIs only probe on explicit protected requests, sanitize identity and close discovery clients without a turn', async () => {
  const clients: DemoProvider[] = [],
    calls: string[] = [];
  const runtime = new Runtime(store, root, 'unused', async () => {
    const client = new DemoProvider();
    const original = client.request.bind(client);
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      calls.push(method);
      if (method === 'account/read')
        return {
          account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'private-plan' },
          requiresOpenaiAuth: true,
        };
      return original(method, params);
    });
    vi.spyOn(client, 'close');
    clients.push(client);
    return client;
  });
  const app = await createServer(store, runtime, { port: 4998 });
  cleanups.push(() => app.close());
  const headers = { host: '127.0.0.1:4998', origin: 'http://127.0.0.1:4998' };
  expect((await app.inject({ url: '/api/setup', headers })).statusCode).toBe(200);
  expect(calls).toEqual([]);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/setup/check',
        headers: { ...headers, origin: 'https://wrong.invalid' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/setup/check',
        headers,
        payload: { command: 'anything' },
      })
    ).statusCode,
  ).toBe(400);
  const result = await app.inject({
    method: 'POST',
    url: '/api/setup/check',
    headers,
    payload: {},
  });
  expect(result.statusCode).toBe(200);
  expect(result.body).not.toContain('private@');
  expect(result.body).not.toContain('private-plan');
  expect(calls).toEqual(['account/read', 'model/list']);
  expect(clients.every((c) => vi.mocked(c.close).mock.calls.length === 1)).toBe(true);
  expect(store.runs()).toHaveLength(0);
  expect(store.agents()).toHaveLength(0);
  expect(proxyPath('GET', '/setup')).toBe('/api/setup');
  expect(proxyPath('POST', '/setup/check')).toBe('/api/setup/check');
  expect(proxyPath('POST', '/setup/sign-in')).toBe('/api/setup/sign-in');
});

class LoginProvider extends EventEmitter implements Provider {
  ready = true;
  signedIn = false;
  early = false;
  badUrl = false;
  fail = false;
  request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'account/read')
      return { account: this.signedIn ? { type: 'chatgpt' } : null, requiresOpenaiAuth: true };
    if (method === 'account/login/start') {
      if (this.fail) throw new Error('private provider diagnostic');
      if (this.early)
        this.emit('notification', 'account/login/completed', {
          loginId: 'native-login',
          success: true,
        });
      return {
        type: 'chatgptDeviceCode',
        loginId: 'native-login',
        verificationUrl: this.badUrl
          ? 'https://evil.invalid/sign-in'
          : 'https://auth.openai.com/codex/device',
        userCode: 'SECRET-CODE',
      };
    }
    return {};
  });
  respond() {}
  close = vi.fn(async () => {
    this.ready = false;
  });
}

it('native sign-in retains one code across lost responses, closes on exact completion and never persists secrets', async () => {
  const client = new LoginProvider(),
    connect = vi.fn(async () => client);
  const login = new CodexSignIn(store, connect);
  cleanups.push(() => login.close());
  const key = randomUUID();
  const [one, two] = await Promise.all([login.start({ key }), login.start({ key })]);
  expect(one).toEqual(two);
  expect(one.state).toBe('pending');
  expect(connect).toHaveBeenCalledOnce();
  expect(await login.start({ key })).toEqual(one);
  await expect(login.start({ key: randomUUID() })).rejects.toThrow('already open');
  const saved = JSON.stringify(store.db.prepare('SELECT * FROM settings').all());
  expect(saved).not.toContain('SECRET-CODE');
  expect(saved).not.toContain('auth.openai.com');
  client.emit('notification', 'account/login/completed', { loginId: 'other-login', success: true });
  expect(login.status().state).toBe('pending');
  client.emit('notification', 'account/login/completed', {
    loginId: 'native-login',
    success: true,
  });
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
  expect(login.status()).toMatchObject({
    state: 'completed',
    userCode: null,
    verificationUrl: null,
  });
  const restored = new CodexSignIn(store, connect);
  cleanups.push(() => restored.close());
  expect(restored.status().state).toBe('expired');
  await restored.start({ key });
  expect(connect).toHaveBeenCalledOnce();
  expect(store.runs()).toHaveLength(0);
});

it('sign-in refuses account replacement and unsafe redirects, handles early completion and allows explicit cancellation', async () => {
  const client = new LoginProvider();
  let login = new CodexSignIn(store, async () => client);
  cleanups.push(() => login.close());
  client.signedIn = true;
  await expect(login.start({ key: randomUUID() })).rejects.toThrow('already has an account');
  expect(client.request.mock.calls.map(([method]) => method)).toEqual(['account/read']);
  const unsafe = new LoginProvider();
  unsafe.badUrl = true;
  login = new CodexSignIn(store, async () => unsafe);
  await expect(login.start({ key: randomUUID() })).rejects.toThrow('could not open');
  expect(unsafe.close).toHaveBeenCalledOnce();
  expect(login.status().verificationUrl).toBeNull();
  const early = new LoginProvider();
  early.early = true;
  login = new CodexSignIn(store, async () => early);
  expect((await login.start({ key: randomUUID() })).state).toBe('completed');
  expect(early.close).toHaveBeenCalledOnce();
  const cancelled = new LoginProvider();
  login = new CodexSignIn(store, async () => cancelled);
  const key = randomUUID();
  await login.start({ key });
  await login.cancel({ key });
  expect(login.status().state).toBe('expired');
  expect(cancelled.close).toHaveBeenCalledOnce();
});

it('a native sign-in expires and cancels only its own bounded login', async () => {
  vi.useFakeTimers();
  const client = new LoginProvider();
  const login = new CodexSignIn(store, async () => client);
  cleanups.push(() => login.close());
  await login.start({ key: randomUUID() });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(login.status().state).toBe('expired');
  expect(client.request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'native-login' });
  expect(client.close).toHaveBeenCalledOnce();
});
it('provider loss removes a pending sign-in code without reporting success or replaying authorization', async () => {
  const client = new LoginProvider(),
    connect = vi.fn(async () => client);
  const login = new CodexSignIn(store, connect);
  cleanups.push(() => login.close());
  const key = randomUUID();
  await login.start({ key });
  client.emit('unavailable', new Error('private transport details'));
  expect(login.status()).toMatchObject({ state: 'failed', userCode: null, verificationUrl: null });
  await login.start({ key });
  expect(connect).toHaveBeenCalledOnce();
});

it('a new app starts with shared pacing enabled and retains an explicit later choice', () => {
  initializeScheduling(store);
  const scheduler = new Pulsar(store, () => null);
  expect(scheduler.policy().enabled).toBe(true);
  expect(store.projects()).toHaveLength(0);
  expect(store.runs()).toHaveLength(0);
  scheduler.savePolicy({ key: randomUUID(), policy: { ...scheduler.policy(), enabled: false } });
  const previous = JSON.stringify(store.getSetting('pulsar:policy'));
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  initializeScheduling(store);
  expect(JSON.stringify(store.getSetting('pulsar:policy'))).toBe(previous);
});

it('default initialization preserves older workspaces and already configured model policies', () => {
  const settings = structuredClone(defaultModelPolicy);
  store.setSetting('model-policy', settings);
  initializeScheduling(store);
  expect(store.getSetting('pulsar:policy')).toBeNull();
  store.db.prepare('DELETE FROM settings WHERE key=?').run('model-policy');
  store.register(join(root, 'existing'), 'Existing project', '');
  initializeScheduling(store);
  expect(store.getSetting('pulsar:policy')).toBeNull();
});
