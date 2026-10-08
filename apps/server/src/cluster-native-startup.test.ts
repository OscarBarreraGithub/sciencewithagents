import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { CodexRpc } from './codex.js';
import { modelFixture } from './model-policy.fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function slowNative(cluster: boolean) {
  vi.useFakeTimers();
  const pending = new Map<CodexRpc, () => void>();
  const starts = vi.spyOn(CodexRpc.prototype, 'start').mockImplementation(function () {
    const timing = (this as unknown as { socketTiming: { openingMs: number } }).socketTiming;
    return new Promise<void>((resolve, reject) => {
      // Actual native evidence became ready at 33.99s, after the ordinary 20s bound.
      const ready = setTimeout(() => {
        clearTimeout(timeout);
        pending.delete(this);
        this.ready = true;
        resolve();
      }, 33_990);
      const timeout = setTimeout(() => {
        clearTimeout(ready);
        pending.delete(this);
        reject(new Error('Native socket opening deadline expired'));
      }, timing.openingMs);
      pending.set(this, () => {
        clearTimeout(ready);
        clearTimeout(timeout);
        pending.delete(this);
        reject(new Error('Owned native startup cancelled'));
      });
    });
  });
  vi.spyOn(CodexRpc.prototype, 'close').mockImplementation(async function () {
    pending.get(this)?.();
    this.ready = false;
  });
  const requests = vi.spyOn(CodexRpc.prototype, 'request').mockImplementation(async (method) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'account/rateLimits/read') return { accountId: 'private-fixture-account' };
    throw new Error('No turn or other native method is authorized by this fixture');
  });
  const root = mkdtempSync(join(tmpdir(), 'swa-cluster-native-start-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Owned startup fixture', '', 'codex');
  const runtime = new Runtime(
    store,
    root,
    'never-launch-real-native-provider',
    undefined,
    undefined,
    undefined,
    cluster
      ? async () => {
          throw new Error('No SSH is authorized');
        }
      : undefined,
  );
  cleanups.push(async () => {
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { runtime, manager: store.agent(project.managerId), starts, requests };
}

it.each(['manager', 'metadata'] as const)(
  'allows the measured slow cluster %s startup once while retaining the ordinary 20s boundary',
  async (kind) => {
    for (const cluster of [false, true]) {
      const { runtime, manager, starts, requests } = slowNative(cluster);
      const start = () =>
        kind === 'manager' ? runtime.client(manager) : runtime.clusterCodexAccountLimits();
      const first = start(),
        second = start();
      const outcome = Promise.all([first, second]);
      const expected = cluster
        ? expect(outcome).resolves.toHaveLength(2)
        : expect(outcome).rejects.toThrow('deadline');
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toHaveBeenCalledTimes(1);
      expect(
        (starts.mock.instances[0] as unknown as { captureIdleIdentity: boolean })
          .captureIdleIdentity,
      ).toBe(cluster && kind === 'manager');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(requests).not.toHaveBeenCalled();
      if (cluster) await vi.advanceTimersByTimeAsync(13_990);
      await expected;
      expect(starts).toHaveBeenCalledTimes(1);
      expect(requests.mock.calls.map(([method]) => method)).toEqual(
        cluster && kind === 'metadata' ? ['account/read', 'account/rateLimits/read'] : [],
      );
      await cleanups.pop()!();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  },
);

it('closes the one owned metadata startup on shutdown without waiting for 65s or requesting native input', async () => {
  const { runtime, starts, requests } = slowNative(true);
  const reading = expect(runtime.clusterCodexAccountLimits()).rejects.toThrow('cancelled');
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toHaveBeenCalledOnce();
  await runtime.close();
  await reading;
  expect(requests).not.toHaveBeenCalled();
});
