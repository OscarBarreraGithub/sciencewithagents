import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claudeSignInCommand } from './claude-sign-in.js';
import { readClaudeAccountState } from './claude-session.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { proxyPath } from './hosts.js';

let root: string, store: Store;
const close: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-claude-login-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const headers = { host: '127.0.0.1:4998', origin: 'http://127.0.0.1:4998' };
const url = '/api/setup/claude-sign-in';
const signedIn = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'private@example.invalid',
  orgId: 'private-org',
};

it('native status accepts signed-out exit 1, distinguishes custom auth and sanitizes failed command output', async () => {
  const binary = join(root, 'fixture-claude');
  const fixture = (output: string, code: number) =>
    writeFileSync(
      binary,
      `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]') process.exit(99);\nprocess.stdout.write(${JSON.stringify(output)}); process.exit(${code});\n`,
      { mode: 0o700 },
    );
  fixture('{"loggedIn":false}', 1);
  expect(await readClaudeAccountState(binary)).toBe('sign-in');
  fixture(JSON.stringify(signedIn), 0);
  expect(await readClaudeAccountState(binary)).toBe('signed-in');
  fixture(JSON.stringify({ ...signedIn, authMethod: 'api_key' }), 0);
  expect(await readClaudeAccountState(binary)).toBe('custom');
  for (const [output, code] of [
    ['private-secret malformed', 0],
    ['private-secret malformed', 1],
    ['{"loggedIn":false}', 2],
    [JSON.stringify(signedIn), 1],
  ] as const) {
    fixture(output, code);
    await expect(readClaudeAccountState(binary)).rejects.toThrow(
      /^Claude sign-in status could not be verified/,
    );
  }
});

it('native sign-in quotes the selected executable/config without interpreting shell characters', async () => {
  const binary = join(root, "claude with 'quotes' $HOME `id`"),
    output = join(root, 'args.json'),
    configDir = join(root, "config ' $HOME `id` ; untouched");
  writeFileSync(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR}));\n`,
    { mode: 0o700 },
  );
  await promisify(execFile)('/bin/sh', ['-c', claudeSignInCommand(binary, configDir)]);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
    args: ['auth', 'login', '--claudeai'],
    config: configDir,
  });
  expect(() => claudeSignInCommand('relative')).toThrow('valid host executable');
});

it('protected native opening persists its receipt across restart and never turns a read/retry into another login', async () => {
  const openSignIn = vi.fn(async () => {}),
    account = vi.fn(async () => 'sign-in' as const);
  let runtime = new Runtime(store, root, 'unused', async () => new DemoProvider(), {
    account,
    openSignIn,
  });
  let app = await createServer(store, runtime, { port: 4998 });
  close.push(() => app.close());
  const input = { key: randomUUID() };
  expect((await app.inject({ url, headers })).json()).toEqual({ available: true, attempt: null });
  expect(account).not.toHaveBeenCalled();
  expect(openSignIn).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, origin: 'https://wrong.invalid' },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: 'POST', url, headers, payload: { ...input, command: 'no' } }))
      .statusCode,
  ).toBe(400);
  const one = await app.inject({ method: 'POST', url, headers, payload: input });
  expect(one.statusCode).toBe(200);
  expect(one.json()).toMatchObject({ attempt: { key: input.key, state: 'opened' } });
  await app.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, 'unused', async () => new DemoProvider(), {
    account,
    openSignIn,
  });
  app = await createServer(store, runtime, { port: 4998 });
  const retry = await app.inject({ method: 'POST', url, headers, payload: input });
  expect(retry.json()).toEqual(one.json());
  expect(openSignIn).toHaveBeenCalledOnce();
  expect(account).toHaveBeenCalledOnce();
  expect(store.agents()).toHaveLength(0);
  expect(store.runs()).toHaveLength(0);
  expect(proxyPath('GET', '/setup/claude-sign-in')).toBe(url);
  expect(proxyPath('POST', '/setup/claude-sign-in')).toBe(url);
});

it('uncertain native opening remains visible after restart, never silently replayed', async () => {
  const openSignIn = vi.fn(async () => {
    throw new Error('Native window acknowledgement lost');
  });
  let runtime = new Runtime(store, root, 'unused', async () => new DemoProvider(), {
    account: async () => 'sign-in',
    openSignIn,
  });
  close.push(() => runtime.close());
  const input = { key: randomUUID() };
  await expect(runtime.claude.signIn(input)).rejects.toThrow('acknowledgement lost');
  await runtime.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, 'unused', async () => new DemoProvider(), {
    account: async () => 'sign-in',
    openSignIn,
  });
  expect(runtime.claude.signInStatus().attempt).toMatchObject({
    key: input.key,
    state: 'uncertain',
  });
  await expect(runtime.claude.signIn(input)).rejects.toThrow('uncertain or failed');
  expect(openSignIn).toHaveBeenCalledOnce();
});

it('existing/custom accounts and failed readiness never open authentication or rewrite saved routing', async () => {
  const openSignIn = vi.fn(async () => {});
  let state: 'signed-in' | 'custom' | 'unavailable' = 'signed-in';
  const runtime = new Runtime(store, root, 'unused', async () => new DemoProvider(), {
    account: async () => {
      if (state === 'unavailable') throw new Error('Could not check');
      return state;
    },
    openSignIn,
  });
  close.push(() => runtime.close());
  const original = store.getSetting('model-policy');
  for (const next of ['signed-in', 'custom', 'unavailable'] as const) {
    state = next;
    await expect(runtime.claude.signIn({ key: randomUUID() })).rejects.toThrow();
  }
  expect(openSignIn).not.toHaveBeenCalled();
  expect(runtime.claude.signInStatus().attempt).toBeNull();
  expect(store.getSetting('model-policy')).toEqual(original);
});

it('the demonstration server cannot open native authentication', async () => {
  const openSignIn = vi.fn(async () => {});
  const runtime = new Runtime(store, root, 'unused', async () => new DemoProvider(), {
    account: async () => 'sign-in',
    openSignIn,
  });
  const app = await createServer(store, runtime, { port: 4998, demo: true });
  close.push(() => app.close());
  expect((await app.inject({ url, headers })).json().available).toBe(false);
  expect(
    (await app.inject({ url, headers, method: 'POST', payload: { key: randomUUID() } })).statusCode,
  ).toBe(409);
  expect(openSignIn).not.toHaveBeenCalled();
});
