import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from './store.js';
import { WorkItems } from './work-items.js';
import { Pulsar } from './pulsar.js';
import { BugReports } from './bug-reports.js';
import { AppUpdates, inspectAppSource, registerAppUpdateRoutes } from './app-updates.js';
import { modelFixture } from './model-policy.fixture.js';
import { recoveryBackupsFor } from './recovery-backups.js';
import { proxyPath } from './hosts.js';

let root: string, store: Store, updates: AppUpdates, maintenance: BugReports;
let current = false,
  offline = false;
function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  maintenance = new BugReports(
    store,
    root,
    join(root, 'source'),
    new WorkItems(store),
    new Pulsar(store, () => null),
  );
  updates = new AppUpdates(store, root, join(root, 'source'), maintenance, async () => {
    if (offline) throw new Error('Private path and credential must not appear in UI');
    return { head: 'a'.repeat(40), target: 'b'.repeat(40), current, localChanges: true };
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-updates-'));
  current = false;
  offline = false;
  open();
});
afterEach(async () => {
  await recoveryBackupsFor(store, root).idle();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('checks without model work and never mistakes failed checks for available updates', async () => {
  expect(updates.status()).toEqual({ check: null, job: null });
  const available = await updates.check();
  expect(available.state).toBe('available');
  expect(available).not.toHaveProperty('target');
  expect(store.runs()).toHaveLength(0);
  offline = true;
  const failed = await updates.check();
  expect(failed.state).toBe('error');
  expect(JSON.stringify(failed)).not.toContain('credential');
  await expect(updates.start({ key: randomUUID(), checkId: available.id })).rejects.toThrow(
    'Check for updates again',
  );
  offline = false;
  current = true;
  expect((await updates.check()).state).toBe('current');
  expect(store.agents()).toHaveLength(0);
});

it('verifies a database copy before one centrally routed maintenance turn and retains existing state', async () => {
  const user = store.register(join(root, 'user-project'), 'Existing project', 'Preserve me');
  store.setSetting('private-preference', { keep: true });
  const before = store.project(user.id);
  const check = await updates.check();
  const job = await updates.start({ key: randomUUID(), checkId: check.id });
  const backup = recoveryBackupsFor(store, root).get(job.recoveryCopyId);
  expect(backup.state).toBe('verified');
  expect(backup.counts?.projects).toBe(1);
  expect(store.project(user.id)).toEqual(before);
  expect(store.getSetting('private-preference')).toEqual({ keep: true });
  expect(store.agent(job.managerId).provider).toBe(store.defaultProvider('manager'));
  expect(maintenance.items.get(job.workItemId).detail).toContain(
    'Exact checked target: ' + 'b'.repeat(40),
  );
  expect(maintenance.items.get(job.workItemId).detail).toContain('do NOT stop or restart');
  expect(maintenance.items.notes(user.id).text).toBe('');
  expect(store.runs()).toHaveLength(1);
  expect(JSON.stringify(updates.status())).not.toContain(root);
});

it('reuses the same request after a lost response and restart, and blocks competing update jobs', async () => {
  const check = await updates.check(),
    input = { key: randomUUID(), checkId: check.id };
  const first = await updates.start(input);
  store.close();
  open();
  const retried = await updates.start(input);
  expect(retried.id).toBe(first.id);
  expect(retried.runId).toBe(first.runId);
  expect(store.runs()).toHaveLength(1);
  expect(recoveryBackupsFor(store, root).status().copies).toHaveLength(1);
  await expect(updates.start({ ...input, checkId: randomUUID() })).rejects.toThrow(
    'different check',
  );
  await expect(updates.start({ ...input, key: randomUUID() })).rejects.toThrow('already assigned');
});

it('does not start an agent when recovery storage fails, and can retry explicitly after repair', async () => {
  writeFileSync(join(root, 'recovery-backups'), 'blocked');
  const check = await updates.check();
  await expect(updates.start({ key: randomUUID(), checkId: check.id })).rejects.toThrow(
    'could not be verified',
  );
  expect(store.runs()).toHaveLength(0);
  expect(store.agents()).toHaveLength(0);
  rmSync(join(root, 'recovery-backups'));
  expect((await updates.start({ key: randomUUID(), checkId: check.id })).state).toBe('queued');
});

it('shares the existing maintenance manager instead of adding a helper per request', async () => {
  const report = maintenance.submit({
    key: randomUUID(),
    description: 'Existing report',
    page: '#/home',
  });
  const check = await updates.check();
  const job = await updates.start({ key: randomUUID(), checkId: check.id });
  expect(job.managerId).toBe(report.managerId);
  expect(store.agents()).toHaveLength(1);
});

it('requires both the completed turn and work item before reporting ready, retaining failures for follow-up', async () => {
  const check = await updates.check();
  const job = await updates.start({ key: randomUUID(), checkId: check.id });
  store.updateRun(job.runId, { status: 'failed' });
  expect(updates.status().job?.state).toBe('attention');
  store.updateRun(job.runId, { status: 'completed' });
  expect(updates.status().job?.state).toBe('attention');
  const item = maintenance.items.get(job.workItemId);
  maintenance.items.saveForManager(job.managerId, {
    key: randomUUID(),
    id: item.id,
    expectedRevision: item.revision,
    status: 'done',
  });
  expect(updates.status().job?.state).toBe('ready');
  await expect(updates.start({ key: randomUUID(), checkId: check.id })).rejects.toThrow(
    'already prepared',
  );
  expect(store.runs()).toHaveLength(1);
});

it('allows only typed selected-computer routes and keeps demo checks offline', async () => {
  expect(proxyPath('GET', '/app-updates')).toBe('/api/app-updates');
  expect(proxyPath('POST', '/app-updates/start')).toBe('/api/app-updates/start');
  expect(proxyPath('POST', '/app-updates/check')).toBe('/api/app-updates/check');
  expect(proxyPath('POST', '/app-updates/execute')).toBeNull();
  const app = Fastify();
  registerAppUpdateRoutes(app, maintenance, () => {}, true);
  try {
    expect((await app.inject('/api/app-updates')).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/app-updates/start', payload: {} })).statusCode,
    ).not.toBe(200);
    expect(store.runs()).toHaveLength(0);
  } finally {
    await app.close();
  }
});

it('compares real Git history without checking out updates or touching edits, data or source', async () => {
  const upstream = join(root, 'upstream'),
    local = join(root, 'local');
  mkdirSync(upstream);
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(upstream, ['init', '-b', 'main']);
  git(upstream, ['config', 'user.email', 'fixture@example.test']);
  git(upstream, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(upstream, 'app.txt'), 'first');
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'first']);
  git(root, ['clone', upstream, local]);
  expect((await inspectAppSource(local, upstream)).current).toBe(true);
  const initial = git(local, ['rev-parse', 'HEAD']);
  writeFileSync(join(local, 'personal.txt'), 'keep this');
  writeFileSync(join(upstream, 'app.txt'), 'second');
  git(upstream, ['commit', '-am', 'second']);
  expect(await inspectAppSource(local, upstream)).toMatchObject({
    current: false,
    localChanges: true,
    head: initial,
  });
  expect(git(local, ['rev-parse', 'HEAD'])).toBe(initial);
  expect(readFileSync(join(local, 'app.txt'), 'utf8')).toBe('first');
  expect(readFileSync(join(local, 'personal.txt'), 'utf8')).toBe('keep this');
  git(local, ['merge', '--ff-only', 'refs/sciencewithagents/updates/main']);
  expect((await inspectAppSource(local, upstream)).current).toBe(true);
});
