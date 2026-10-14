import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { Store } from './store.js';
import { AppSourceUpdates, registerAppSourceUpdateRoutes } from './app-source-updates.js';
import { inspectAppSource } from './app-source-check.js';
import { appSourceUpdatePrompt } from '@dock/shared/dist/app-source-updates.js';
const roots: string[] = [];
const close: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const done of close.splice(0).reverse()) await done();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'swa-source-update-'));
  roots.push(root);
  return root;
}
it('checks only the fixed distribution branch while preserving dirty files, branch and HEAD', async () => {
  const root = directory();
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  git('init', '-b', 'main');
  writeFileSync(join(root, 'source'), 'main');
  git('add', 'source');
  git('commit', '-m', 'main');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'groups-only');
  writeFileSync(join(root, 'source'), 'groups');
  git('commit', '-am', 'groups');
  const groups = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'installed', main);
  writeFileSync(join(root, 'local-private'), 'keep');
  const available = await inspectAppSource(root, root, 'groups-only');
  expect(available).toMatchObject({
    head: main,
    target: groups,
    current: false,
    localChanges: true,
  });
  expect(await inspectAppSource(root, root, 'main')).toMatchObject({ target: main, current: true });
  expect(git('branch', '--show-current')).toBe('installed');
  expect(git('rev-parse', 'HEAD')).toBe(main);
  expect(git('status', '--porcelain')).toContain('local-private');
  await expect(inspectAppSource(root, root, 'evil' as 'main')).rejects.toThrow();
  await expect(inspectAppSource(root, join(root, 'offline'), 'groups-only')).rejects.toThrow();
});
it('deduplicates checks, throttles reads, caches through restart and retries offline without models', async () => {
  const root = directory(),
    store = new Store(join(root, 'dock.sqlite'));
  close.push(() => store.close());
  let now = Date.parse('2026-10-14T00:00:00Z'),
    offline = false,
    current = false;
  const inspect = vi.fn(async () => {
    if (offline) throw new Error('secret path');
    return { head: 'a'.repeat(40), target: 'b'.repeat(40), current, localChanges: true };
  });
  const service = new AppSourceUpdates(store, 'groups-only', root, inspect, () => now);
  close.push(() => service.close());
  const [first, same] = await Promise.all([service.check(), service.check()]);
  expect(first).toEqual(same);
  expect(first.check?.state).toBe('available');
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(first.check).not.toHaveProperty('target');
  await service.check();
  expect(inspect).toHaveBeenCalledTimes(1);
  const restarted = new AppSourceUpdates(store, 'groups-only', root, inspect, () => now);
  close.push(() => restarted.close());
  expect(await restarted.check()).toEqual(first);
  expect(inspect).toHaveBeenCalledTimes(1);
  now += 6 * 60 * 60 * 1000;
  offline = true;
  const failed = await service.check();
  expect(failed.check?.state).toBe('error');
  expect(failed.lastSuccessful?.state).toBe('available');
  expect(JSON.stringify(failed)).not.toContain('secret');
  await service.check();
  expect(inspect).toHaveBeenCalledTimes(2);
  now += 15 * 60 * 1000;
  offline = false;
  current = true;
  expect((await service.check()).check?.state).toBe('current');
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(store.runs()).toHaveLength(0);
  expect(store.agents()).toHaveLength(0);
  expect(appSourceUpdatePrompt('groups-only')).toContain('Keep tracking groups-only');
});
it('requires existing scoped authentication and serves cached metadata without a POST or check', async () => {
  const root = directory(),
    store = new Store(join(root, 'dock.sqlite'));
  close.push(() => store.close());
  const inspect = vi.fn(async () => ({
    head: 'a'.repeat(40),
    target: 'b'.repeat(40),
    current: false,
    localChanges: false,
  }));
  const service = new AppSourceUpdates(store, 'groups-only', root, inspect);
  close.push(() => service.close());
  const app = Fastify();
  close.push(() => app.close());
  registerAppSourceUpdateRoutes(
    app,
    service,
    (request) => request.headers.authorization === 'fixture-scoped-owner',
  );
  expect((await app.inject('/api/groups/app-updates')).statusCode).toBe(401);
  const result = await app.inject({
    url: '/api/groups/app-updates',
    headers: { authorization: 'fixture-scoped-owner' },
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ branch: 'groups-only', check: null });
  expect(
    (await app.inject({ method: 'POST', url: '/api/groups/app-updates', payload: {} })).statusCode,
  ).toBe(404);
  expect(inspect).not.toHaveBeenCalled();
  expect(store.runs()).toHaveLength(0);
});

it('ignores corrupt optional cache and contains detached store write rejection', async () => {
  const root = directory(),
    store = new Store(join(root, 'dock.sqlite'));
  close.push(() => store.close());
  store.setSetting('app-source-updates:groups-only', { broken: true });
  const service = new AppSourceUpdates(store, 'groups-only', root, async () => ({
    head: 'a'.repeat(40),
    target: 'a'.repeat(40),
    current: true,
    localChanges: false,
  }));
  expect(service.status().check).toBeNull();
  const write = vi.spyOn(store, 'setSetting').mockImplementation(() => {
    throw new Error('controlled write refusal');
  });
  service.start();
  await expect(service.check()).rejects.toThrow('controlled write refusal');
  expect((await service.check()).check?.state).toBe('current');
  expect(write).toHaveBeenCalledOnce();
  await service.close();
  write.mockRestore();
});
