import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { groupContextSchema } from '@dock/shared';
import { GroupHost } from './group-host.js';
import type { GroupNativeConnector } from './group-host-native.js';
import { repoRoot } from './paths.js';

type Status = Awaited<ReturnType<GroupNativeConnector['availability']>>;
const denied: Status = {
  available: false,
  productionReady: false,
  authState: 'unavailable',
  message: 'Isolated execution is unavailable.',
};
const ready: Status = {
  available: true,
  productionReady: true,
  authState: 'ready',
  message: 'Verified isolated execution is ready.',
};
function deferred() {
  let resolve!: (status: Status) => void;
  const promise = new Promise<Status>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
function fixture(availability: GroupNativeConnector['availability']) {
  const base = join(repoRoot, 'data', 'group-host-availability');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(base, 'test-'));
  const submit = vi.fn<GroupNativeConnector['submit']>(async (input) => ({
    requestId: input.requestId,
    state: 'blocked',
    message: 'Controlled adapter refused execution.',
  }));
  const host = new GroupHost(directory, {
    native: {
      availability,
      submit,
      inspect: async () => {
        throw new Error('No native execution to inspect');
      },
    },
  });
  cleanup.push(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const context = groupContextSchema.parse({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    sessionId: randomUUID(),
    visibility: 'private',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const slot = { handle: randomUUID(), context, createdAt: new Date().toISOString() };
  const value = {
    handle: randomUUID(),
    name: 'Availability seam',
    shared: slot,
    private: slot,
    identity: { ...context, displayName: 'Owner', state: 'active' },
  };
  // Scope/membership lookup is already authorized for this unit fixture. Keep the
  // real public methods and durable native request journal; start no service/provider.
  Object.defineProperties(host, {
    active: { value: async () => value },
    resolve: { value: async () => ({ value, slot }) },
    membership: { value: async () => ({ kind: 'members', entries: [] }) },
  });
  const request = { handle: slot.handle, key: randomUUID(), text: 'Readiness first' };
  return { host, submit, value, request };
}

it('awaits asynchronous native status in both list and open responses', async () => {
  const first = deferred(),
    second = deferred();
  const availability = vi
    .fn<GroupNativeConnector['availability']>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const { host, value } = fixture(availability);
  let listed = false;
  const list = host.list().then((result) => {
    listed = true;
    return result;
  });
  await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(1));
  expect(listed).toBe(false);
  first.resolve(denied);
  expect((await list).native).toEqual(denied);
  let opened = false;
  const open = host.open({ handle: value.handle }).then((result) => {
    opened = true;
    return result;
  });
  await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(2));
  expect(opened).toBe(false);
  second.resolve(ready);
  expect((await open).native).toEqual(ready);
});

it('awaits initial unavailable admission without preparing or submitting a native request', async () => {
  const gate = deferred(),
    availability = vi.fn(() => gate.promise);
  const { host, submit, request } = fixture(availability);
  const pending = expect(host.requestAgent(request)).rejects.toMatchObject({
    status: 503,
    code: 'GROUP_NATIVE_SETUP_REQUIRED',
  });
  await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(1));
  expect(host.nativeJournal.get(request.handle, request.key)).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  gate.resolve(denied);
  await pending;
  expect(host.nativeJournal.get(request.handle, request.key)).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

it('awaits readiness again before handoff and retains the prepared request for exact retry', async () => {
  const handoff = deferred(),
    retry = deferred();
  const availability = vi
    .fn<GroupNativeConnector['availability']>()
    .mockResolvedValueOnce(ready)
    .mockReturnValueOnce(handoff.promise)
    .mockReturnValueOnce(retry.promise);
  const { host, submit, request } = fixture(availability);
  const first = expect(host.requestAgent(request)).rejects.toMatchObject({
    status: 503,
    code: 'GROUP_NATIVE_SETUP_REQUIRED',
  });
  await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(2));
  const prepared = host.nativeJournal.get(request.handle, request.key)!;
  expect(prepared.receipt.state).toBe('prepared');
  expect(submit).not.toHaveBeenCalled();
  handoff.resolve(denied);
  await first;
  const next = expect(host.requestAgent(request)).rejects.toMatchObject({
    status: 503,
    code: 'GROUP_NATIVE_BLOCKED',
  });
  await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(3));
  expect(submit).not.toHaveBeenCalled();
  retry.resolve(ready);
  await next;
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][0].requestId).toBe(prepared.request.requestId);
});

it('fails closed on rejected async readiness without leaking diagnostics or submitting work', async () => {
  const availability = vi.fn(async () => {
    throw new Error('Private native diagnostic');
  });
  const { host, submit, request, value } = fixture(availability);
  for (const result of [await host.list(), await host.open({ handle: value.handle })]) {
    expect(result.native).toMatchObject({ available: false, productionReady: false });
    expect(result.native.message).not.toContain('Private native diagnostic');
  }
  await expect(host.requestAgent(request)).rejects.toMatchObject({
    status: 503,
    code: 'GROUP_NATIVE_SETUP_REQUIRED',
  });
  expect(submit).not.toHaveBeenCalled();
  expect(host.nativeJournal.get(request.handle, request.key)).toBeNull();
});
