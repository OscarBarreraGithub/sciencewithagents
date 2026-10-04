import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { BugReports, registerBugReportRoutes } from './bug-reports.js';
import { Store } from './store.js';
import { WorkItems } from './work-items.js';
import { Pulsar } from './pulsar.js';
import { modelFixture } from './model-policy.fixture.js';

let root: string, store: Store, items: WorkItems, reports: BugReports;
function open() {
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  items = new WorkItems(store);
  reports = new BugReports(store, root, join(root, 'source'), items, new Pulsar(store, () => null));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-reports-'));
  open();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const input = () => ({
  key: randomUUID(),
  description: 'Worker is stuck\nExpected it to start with spare allowance.',
  page: '#/work',
});

it('saves a private report, internal to-do and one queued manager turn without needing a provider', () => {
  const existing = store.register(join(root, 'source'), 'My existing repo manager', '');
  const oldAgent = store.agent(existing.managerId);
  const report = reports.submit(input());
  expect(report.fileSaved).toBe(true);
  expect(items.get(report.workItemId)).toMatchObject({
    kind: 'internal',
    managerId: report.managerId,
    status: 'open',
  });
  expect(store.agent(report.managerId)).toMatchObject({
    name: 'sciencewithagents maintenance',
    role: 'manager',
    provider: store.defaultProvider('manager'),
    cwd: join(root, 'source'),
  });
  expect(store.agent(existing.managerId)).toEqual(oldAgent);
  expect(report.managerId).not.toBe(existing.managerId);
  expect(store.runs()).toHaveLength(1);
  expect(store.run(report.runId)).toMatchObject({ status: 'queued', kind: 'user' });
  expect(store.run(report.runId).text).toContain('independent review');
  expect(readFileSync(join(root, report.folder, 'report.md'), 'utf8')).toContain(
    report.description,
  );
  expect(items.notes(existing.id).text).toBe('');
  expect(reports.submit(input()).managerId).toBe(report.managerId);
  expect(store.agents().filter((a) => a.name === 'sciencewithagents maintenance')).toHaveLength(1);
});

it('survives restart and a lost response without duplicating the manager, report or work', () => {
  const request = input(),
    first = reports.submit(request);
  const head = store.head;
  store.close();
  open();
  const retry = reports.submit(request);
  expect(retry.id).toBe(first.id);
  expect(retry.runId).toBe(first.runId);
  expect(store.runs()).toHaveLength(1);
  expect(items.list().items).toHaveLength(1);
  expect(store.head).toBe(head);
  expect(() => reports.submit({ ...request, description: 'Different report' })).toThrow(
    'different input',
  );
  const item = items.get(first.workItemId);
  items.saveForManager(first.managerId, {
    key: randomUUID(),
    id: item.id,
    expectedRevision: item.revision,
    status: 'done',
  });
  expect(reports.list().items[0]).toMatchObject({
    status: 'done',
    message: 'Marked resolved by the maintenance manager.',
  });
});

it('retains the durable report if its folder fails, then repairs only the file on retry', () => {
  writeFileSync(join(root, 'bug-reports'), 'Cannot create a directory here');
  const request = input(),
    report = reports.submit(request);
  expect(report.fileSaved).toBe(false);
  expect(store.run(report.runId).text).toContain(request.description);
  rmSync(join(root, 'bug-reports'));
  expect(reports.submit(request).fileSaved).toBe(true);
  expect(store.runs()).toHaveLength(1);
  expect(items.list().items).toHaveLength(1);
});

it('refuses symlink folder destinations and caller-selected filesystem paths', () => {
  const outside = join(root, 'elsewhere');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'bug-reports'));
  expect(reports.submit(input()).fileSaved).toBe(false);
  expect(() => reports.submit({ ...input(), folder: outside })).toThrow();
  expect(() =>
    reports.submit({ ...input(), page: 'https://external.invalid/?secret=value' }),
  ).toThrow();
});

it('routes submissions into the existing dispatcher and returns reports for the selected host', async () => {
  const app = Fastify(),
    kick = vi.fn();
  registerBugReportRoutes(app, reports, kick);
  try {
    const request = input();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bug-reports',
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(kick).toHaveBeenCalledOnce();
    const list = await app.inject('/api/bug-reports');
    expect(list.json().items[0].id).toBe(request.key);
  } finally {
    await app.close();
  }
});

it('uses the central scheduled provider for pick-as-I-go reports and retains archived report receipts', () => {
  const policy = store.getSetting('model-policy') as Record<string, unknown>;
  store.setSetting('model-policy', {
    ...policy,
    preset: 'pick',
    scheduledProvider: 'claude',
    enabledProviders: ['claude'],
    providers: { ...(policy.providers as object), manager: 'preset' },
  });
  const request = input(),
    report = reports.submit(request);
  expect(store.agent(report.managerId).provider).toBe('claude');
  store.updateAgent(report.managerId, { archivedAt: new Date().toISOString() });
  expect(reports.submit(request).runId).toBe(report.runId);
  expect(store.runs()).toHaveLength(1);
});
