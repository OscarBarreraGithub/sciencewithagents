import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupEventRepository } from './group-events.js';
import { GroupNativeJournal } from './group-native.js';
import { GroupNativeIntents } from './group-native-production.js';
import { createGroupNativeConnector } from './group-native-connector.js';
import { GroupDockerEngine } from './group-container.js';
import type { GroupNativeExecution } from './group-native-execution.js';
import type { Runtime } from './runtime.js';
import { Store } from './store.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function fixture(submitted = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'native-consent-recovery-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const events = new GroupEventRepository(join(root, 'events.sqlite'));
  cleanup.push(() => events.close());
  const group = events.createGroup('Restart fixture');
  const anchor = events.createContext({ groupId: group.groupId, memberId: group.memberId, installationId: group.installationId, visibility: 'private', provider: 'owner', nativeSessionId: randomUUID() });
  const directory = join(root, 'native'); mkdirSync(directory);
  const path = join(directory, 'native-identities.sqlite');
  let journal = new GroupNativeJournal(path, events);
  const agentId = randomUUID();
  const handle = journal.issue(anchor, agentId, 'codex');
  const nativeContext = journal.resolve(handle).context;
  const input = { requestId: randomUUID(), key: randomUUID(), context: anchor, enrollmentHandle: randomUUID(), text: 'Retain exactly this original pending request.' };
  const volume = `swa-group-${randomUUID()}`, name = `swa-group-${randomUUID()}`;
  journal.runtimeEvent(handle, 'container-reserved', { volume, name, manifest: '{}' });
  journal.beginRequest(handle, input.requestId, input.text);
  journal.requestEvent(handle, input.requestId, { state: 'admitted' });
  journal.requestEvent(handle, input.requestId, { state: 'pending-consent' });
  if (submitted) journal.requestEvent(handle, input.requestId, { state: 'write-intent' });
  journal.requestEvent(handle, input.requestId, { state: 'unknown', reconciled: true });
  journal.close();
  journal = new GroupNativeJournal(path, events);
  cleanup.push(() => journal.close());
  const reopened = journal.reopen(nativeContext.sessionId);
  const intents = new GroupNativeIntents(join(directory, 'native-intents.sqlite'));
  intents.bind(input, nativeContext.sessionId); intents.claim(input, nativeContext.sessionId); intents.close();
  const store = new Store(join(root, 'host.sqlite')); cleanup.push(() => store.close());
  mkdirSync(join(root, 'workspace'));
  const project = store.register(join(root, 'workspace'), 'Fixture', '');
  store.setSetting('group:native-route', { projectId: project.id, provider: 'codex', image: `sha256:${'3'.repeat(64)}`, resources: { workspace: null, stateBase: root, readResources: [], forbiddenPaths: [join(root, 'host.sqlite')], outbound: [] } });
  const configured = store.getSetting('group:native-route') as { image: string; resources: unknown };
  store.setSetting(`group:native-resources:${agentId}`, { image: configured.image, resources: configured.resources });
  let resolve!: (execution: GroupNativeExecution) => void;
  let reject!: (error: Error) => void;
  const admitted = new Promise<GroupNativeExecution>((yes, no) => { resolve = yes; reject = no; });
  const queue = vi.fn(() => ({ runId: randomUUID(), admitted }));
  const runtime = { store, modelPolicy: {}, quark: {}, queueGroupNativeRequest: queue, interrupt: vi.fn(async () => {}) } as unknown as Runtime;
  vi.spyOn(GroupDockerEngine.prototype, 'availability').mockResolvedValue({ state: 'ready', runtimeSignature: 'a'.repeat(64), cpuCores: 1, memoryMb: 2048, nativeDesktop: 'Linux guest only; macOS native app control is unavailable' });
  vi.spyOn(GroupNativeJournal.prototype, 'artifactReady').mockReturnValue(true);
  const connector = createGroupNativeConnector(runtime, { directory, events });
  cleanup.push(() => connector.close());
  let close!: () => void;
  const execution = Object.assign(new EventEmitter(), {
    provider: 'codex', admissionId: randomUUID(), closed: new Promise<void>((yes) => { close = yes; }),
    authentication: vi.fn(async () => 'signed-out'), turn: vi.fn(), reconcile: vi.fn(),
    close: vi.fn(async () => close()),
  }) as unknown as GroupNativeExecution;
  return { connector, journal, reopened, input, queue, resolve, reject, execution, volume, nativeContext, events, directory, store, agentId };
}

it('reopens only a proved pending-consent request after restart, preserving context, original input and volume without a model or sign-in call', async () => {
  const f = fixture();
  expect(f.connector.canRecoverPendingConsent(f.input.requestId)).toBe(true);
  expect((await f.connector.inspect({ requestId: f.input.requestId })).state).toBe('unknown');
  expect(f.queue).not.toHaveBeenCalled(); // Inspection cannot restart the consent guest.
  await f.connector.recoverPendingConsent(f.input);
  await f.connector.recoverPendingConsent(f.input); // In-flight exact retry.
  expect(f.queue).toHaveBeenCalledTimes(1);
  expect(f.store.getSetting(`group:native-request:${f.queue.mock.results[0].value.runId}`)).toBe(f.input.requestId);
  expect(f.connector.ownerExecution(f.input.requestId)).toBeNull();
  f.resolve(f.execution); // Existing bridge's admitted preparation/verified-stop boundary.
  await Promise.resolve(); await Promise.resolve();
  expect(f.connector.ownerExecution(f.input.requestId)).toBe(f.execution);
  expect(f.journal.request(f.reopened, f.input.requestId)?.state).toBe('pending-consent');
  expect(f.journal.request(f.reopened, f.input.requestId)?.reconciled).toBeUndefined();
  expect(f.journal.resolve(f.reopened).context).toEqual(f.nativeContext);
  expect(f.journal.savedContainer(f.reopened)?.volume).toBe(f.volume);
  expect(f.execution.turn).not.toHaveBeenCalled();
  expect(f.execution.authentication).not.toHaveBeenCalled();
  expect(f.execution.reconcile).not.toHaveBeenCalled();
  expect(f.connector.canRecoverPendingConsent(f.input.requestId)).toBe(false);
});

it('rejects changed original input and any historical write intent before re-admission', async () => {
  const f = fixture();
  await expect(f.connector.recoverPendingConsent({ ...f.input, text: 'changed' })).rejects.toThrow('idempotency');
  expect(f.queue).not.toHaveBeenCalled();
  const written = fixture(true);
  expect(written.connector.canRecoverPendingConsent(written.input.requestId)).toBe(false);
  await expect(written.connector.recoverPendingConsent(written.input)).rejects.toThrow('proved unsubmitted');
  expect(written.queue).not.toHaveBeenCalled();
  expect(() => written.journal.restorePendingConsent(written.reopened, written.input.requestId, written.input.text, randomUUID())).toThrow('proved unsubmitted');
});

it('failed owned preparation cannot restore consent authority or original pending input', async () => {
  const f = fixture();
  await f.connector.recoverPendingConsent(f.input);
  f.reject(new Error('Owned namespace stop could not be verified'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.connector.ownerExecution(f.input.requestId)).toBeNull();
  expect(f.journal.request(f.reopened, f.input.requestId)?.state).toBe('unknown');
  await expect(f.connector.continueAfterConsent(f.input.requestId)).rejects.toThrow('unsubmitted');
  expect(f.execution.turn).not.toHaveBeenCalled();
});

it('actual connector fresh submit provisions distinct native IDs from a full saved owner context before any model turn', async () => {
  const f = fixture();
  const { sessionId, ...anchor } = f.input.context;
  const context = f.events.createContext({ ...anchor, nativeSessionId: randomUUID() });
  const input = { ...f.input, requestId: randomUUID(), key: randomUUID(), context };
  expect((await f.connector.submit(input)).state).toBe('queued');
  const intents = new GroupNativeIntents(join(f.directory, 'native-intents.sqlite'));
  const id = intents.find(input.requestId)!; intents.close();
  const native = f.journal.resolve(f.journal.reopen(id)).context;
  expect(native.sessionId).not.toBe(context.sessionId);
  expect(native.nativeSessionId).not.toBe(context.nativeSessionId);
  expect(native.provider).toBe('codex');
  f.resolve(f.execution);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect((await f.connector.inspect({ requestId: input.requestId })).state).toBe('pending-consent');
  expect(f.execution.turn).not.toHaveBeenCalled();
});

it('only later explicit Continue delivers the exact retained text once, then write intent permanently denies recovery', async () => {
  const f = fixture();
  await f.connector.recoverPendingConsent(f.input);
  f.resolve(f.execution);
  await Promise.resolve(); await Promise.resolve();
  vi.mocked(f.execution.authentication).mockResolvedValue('authenticated');
  vi.mocked(f.execution.turn).mockImplementation(async (text, requestId) => {
    expect(text).toBe(f.input.text);
    expect(requestId).toBe(f.input.requestId);
    f.journal.requestEvent(f.reopened, f.input.requestId, { state: 'write-intent' });
    return { text: 'fixture completion', nativeToolItems: 0 };
  });
  await f.connector.continueAfterConsent(f.input.requestId);
  await expect(f.connector.continueAfterConsent(f.input.requestId)).rejects.toThrow('unsubmitted');
  await Promise.resolve(); await Promise.resolve();
  expect(f.execution.turn).toHaveBeenCalledExactlyOnceWith(f.input.text, f.input.requestId);
  expect(f.connector.canRecoverPendingConsent(f.input.requestId)).toBe(false);
});

it('refuses unknown or changed retained resource grants without creating or replacing a grant', async () => {
  const missing = fixture();
  missing.store.setSetting(`group:native-resources:${missing.agentId}`, null);
  await expect(missing.connector.recoverPendingConsent(missing.input)).rejects.toThrow('missing or changed');
  expect(missing.queue).not.toHaveBeenCalled();
  expect(missing.store.getSetting(`group:native-resources:${missing.agentId}`)).toBeNull();
  const changed = fixture();
  const pin = { image: `sha256:${'4'.repeat(64)}`, resources: {} };
  changed.store.setSetting(`group:native-resources:${changed.agentId}`, pin);
  await expect(changed.connector.recoverPendingConsent(changed.input)).rejects.toThrow('missing or changed');
  expect(changed.queue).not.toHaveBeenCalled();
  expect(changed.store.getSetting(`group:native-resources:${changed.agentId}`)).toEqual(pin);
});
