import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { publishingAccountsSchema } from '@dock/shared';
import { Store } from './store.js';
import { repoRoot } from './paths.js';
import { proxyPath } from './hosts.js';
import {
  PublishingAccounts,
  registerPublishingAccountRoutes,
  type AccountProbe,
} from './publishing-accounts.js';

let root: string, store: Store;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/publishing-accounts-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
type Reply = { stdout?: string; stderr?: string; fail?: boolean };
/** Scripted CLI replies; records each invocation without running a real account tool. */
function probe(replies: Record<string, Reply>, installed = ['gh', 'wrangler']) {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const value: AccountProbe = {
    binary: (name) => (installed.includes(name) ? `/fixture/bin/${name}` : null),
    async run(binary, args, env) {
      calls.push({ binary, args, env });
      await new Promise((done) => setTimeout(done, 5));
      const reply = replies[`${binary.split('/').pop()} ${args.join(' ')}`] ?? { fail: true };
      const output = { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
      if (reply.fail) throw Object.assign(new Error('Command failed'), output);
      return output;
    },
  };
  return { value, calls };
}
const states = (status: { accounts: { id: string; state: string; identity: string | null }[] }) =>
  status.accounts.map(({ id, state, identity }) => [id, state, identity]);

it('confirms sign-in only from successful account reads and keeps private details out', async () => {
  const connected = probe({
    'gh api --hostname github.com user': { stdout: '{"login":"octo-lab","id":7,"email":"x@y.z"}' },
    'wrangler whoami --json': {
      stdout: '{"loggedIn":true,"authType":"OAuth Token","email":"private@example.com"}',
    },
  });
  let now = Date.parse('2026-10-05T10:00:00Z');
  const accounts = new PublishingAccounts(store, connected.value, () => now);
  expect(states(accounts.status())).toEqual([
    ['github', 'unchecked', null],
    ['cloudflare', 'unchecked', null],
  ]);
  // Concurrent page loads share one bounded check.
  const [first, second] = await Promise.all([accounts.check({}), accounts.check({})]);
  expect(second).toEqual(first);
  expect(states(first)).toEqual([
    ['github', 'connected', 'octo-lab'],
    ['cloudflare', 'connected', null],
  ]);
  expect(JSON.stringify(first)).not.toMatch(/@example|x@y/);
  expect(connected.calls.map((call) => call.args.join(' '))).toEqual([
    'api --hostname github.com user',
    'whoami --json',
  ]);
  expect(connected.calls[0]!.env).toMatchObject({ GH_PROMPT_DISABLED: '1' });
  expect(connected.calls[1]!.env).toMatchObject({ WRANGLER_SEND_METRICS: 'false' });
  // Automatic checks reuse a result for ten minutes; explicit ones wait 15 seconds.
  now += 5 * 60_000;
  await accounts.check({});
  expect(connected.calls).toHaveLength(2);
  await accounts.check({ force: true });
  await accounts.check({ force: true });
  expect(connected.calls).toHaveLength(4);
  now += 11 * 60_000;
  await accounts.check({});
  expect(connected.calls).toHaveLength(6);
  // The verified result survives a restart without rerunning a check.
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(states(new PublishingAccounts(store, probe({}).value).status())).toEqual(states(first));
});

it('explains missing tools, signed-out sessions, unreachable services and older Wrangler', async () => {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const missing = new PublishingAccounts(store, probe({}, []).value, () => now);
  const absent = await missing.check({ force: true });
  expect(states(absent)).toEqual([
    ['github', 'missing', null],
    ['cloudflare', 'missing', null],
  ]);
  expect(absent.accounts[1]!.message).toContain('even if you signed in with npx');

  now += 20_000;
  const signedOut = new PublishingAccounts(
    store,
    probe({
      'gh api --hostname github.com user': {
        fail: true,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      },
      // A cloudflared certificate or Wrangler config file is never consulted.
      'wrangler whoami --json': { fail: true, stdout: '{\n  "loggedIn": false\n}' },
    }).value,
    () => now,
  );
  expect(states(await signedOut.check({ force: true }))).toEqual([
    ['github', 'signed_out', null],
    ['cloudflare', 'signed_out', null],
  ]);

  now += 20_000;
  const offline = new PublishingAccounts(
    store,
    probe({
      'gh api --hostname github.com user': {
        fail: true,
        stderr: 'error connecting to api.github.com',
      },
    }).value,
    () => now,
  );
  const unreachable = await offline.check({ force: true });
  expect(states(unreachable)).toEqual([
    ['github', 'unavailable', null],
    ['cloudflare', 'unavailable', null],
  ]);
  expect(unreachable.accounts[0]!.message).toContain('Nothing was changed');

  now += 20_000;
  const older = probe({
    'gh api --hostname github.com user': { stdout: '{"login":"octo-lab"}' },
    'wrangler whoami --json': { fail: true, stderr: 'Unknown arguments: json' },
    'wrangler whoami': {
      stdout: 'You are logged in with an OAuth Token, associated with the email a@b.c.',
    },
  });
  const legacy = await new PublishingAccounts(store, older.value, () => now).check({ force: true });
  expect(states(legacy)[1]).toEqual(['cloudflare', 'connected', null]);
  expect(older.calls.some((call) => call.args.includes('login'))).toBe(false);
});

it('serves an explicit off state where checks are disabled and follows the selected computer', async () => {
  const app = Fastify();
  registerPublishingAccountRoutes(app, undefined);
  const status = publishingAccountsSchema.parse(
    (
      await app.inject({ method: 'POST', url: '/api/publishing-accounts/check', payload: {} })
    ).json(),
  );
  expect(status.available).toBe(false);
  expect(status.accounts.map((a) => a.state)).toEqual(['unchecked', 'unchecked']);
  await app.close();
  expect(proxyPath('GET', '/publishing-accounts')).toBe('/api/publishing-accounts');
  expect(proxyPath('POST', '/publishing-accounts/check')).toBe('/api/publishing-accounts/check');
  expect(proxyPath('POST', '/publishing-accounts/login')).toBeNull();
});
