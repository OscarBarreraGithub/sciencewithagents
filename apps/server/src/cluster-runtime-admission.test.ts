import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { projectSchedulerKey } from './quark-project.js';

let root: string, store: Store, runtime: Runtime, manager: string;
let calls: string[];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-compute-admission-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Owned cluster fixture', '');
  manager = project.managerId;
  store.setSetting(projectSchedulerKey(project.id), {
    projectId: project.id,
    enabled: false,
    revision: 1,
  });
  calls = [];
  const provider = new DemoProvider(root);
  const request = provider.request.bind(provider);
  vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
    calls.push(method);
    return method === 'turn/start'
      ? { turn: { id: randomUUID(), status: 'inProgress' } }
      : request(method, params);
  });
  runtime = new Runtime(store, root, '/unused-cli', async () => provider, undefined, {
    workspace: root,
  });
  await runtime.initialize();
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const drain = () => (runtime as unknown as { drain(): Promise<void> }).drain();
it('prepares a project with QUARK off but does not send before its exact native admission', async () => {
  let admitted = false;
  runtime.nativeAdmissionReason = () =>
    admitted ? null : 'Waiting for the verified native account.';
  runtime.nativeAdmissionConsume = () => admitted;
  runtime.nativeAdmissionVerify = async () => {
    calls.push('verified');
  };
  const run = store.enqueue(manager, randomUUID(), 'Preserve this one owner input');
  await vi.waitFor(() => expect(runtime.preparedForRemoteAdmission(run.id)).toBe(true));
  await drain();
  expect(calls).not.toContain('turn/start');
  expect(store.run(run.id).status).toBe('queued');
  admitted = true;
  runtime.kick();
  await vi.waitFor(() => expect(calls.filter((method) => method === 'turn/start')).toHaveLength(1));
  expect(calls.indexOf('verified')).toBeLessThan(calls.indexOf('turn/start'));
  expect(store.run(run.id).status).toBe('running');
});
it('rolls back the local reservation and grant consumption together if admission changes', async () => {
  runtime.nativeAdmissionConsume = () => {
    store.setSetting('fixture:consumed', true);
    return false;
  };
  const run = store.enqueue(manager, randomUUID(), 'Do not duplicate this input');
  await vi.waitFor(() => expect(runtime.preparedForRemoteAdmission(run.id)).toBe(true));
  await drain();
  expect(runtime.pulsar.lease(run.id)).toBeNull();
  expect(store.getSetting('fixture:consumed')).toBeNull();
  expect(store.run(run.id).status).toBe('queued');
  expect(calls).not.toContain('turn/start');
});
it('refuses provider input if final native account verification fails', async () => {
  runtime.nativeAdmissionVerify = async () => {
    throw new Error('The native account changed.');
  };
  const run = store.enqueue(manager, randomUUID(), 'Retain the original request');
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('failed'));
  expect(calls).not.toContain('turn/start');
  expect(store.runs().filter((item) => item.id === run.id)).toHaveLength(1);
  expect(store.run(run.id).text).toBe('Retain the original request');
});
