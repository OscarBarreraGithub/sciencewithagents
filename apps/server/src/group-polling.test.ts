import { afterEach, expect, it, vi } from 'vitest';
import {
  GROUP_POLLING,
  startGroupPolling,
  type GroupPollEnvironment,
} from '../../web/src/groups/group-polling.js';

afterEach(() => vi.useRealTimers());
function clock() {
  vi.useFakeTimers();
  let visible = true;
  const listeners = new Set<() => void>();
  const environment: GroupPollEnvironment = {
    visible: () => visible,
    now: () => Date.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const wake = () => listeners.forEach((listener) => listener());
  return {
    environment,
    wake,
    visibility: (next: boolean) => {
      visible = next;
      wake();
    },
  };
}

it('idle Groups reads use the complete chat/feed/roster budget and hidden views make no reads', async () => {
  const c = clock();
  const chat = vi.fn(async () => false),
    feed = vi.fn(async () => false),
    roster = vi.fn(async () => {});
  const stops = [
    startGroupPolling(chat, {}, c.environment),
    startGroupPolling(feed, {}, c.environment),
    startGroupPolling(roster, { idleMs: GROUP_POLLING.rosterMs, immediate: false }, c.environment),
  ];
  await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
  // Chat costs one RPC, an empty feed and roster each cost two. These are
  // source-derived idle reads, including initial chat/feed, not platform quotas.
  expect(chat).toHaveBeenCalledTimes(481);
  expect(feed).toHaveBeenCalledTimes(481);
  expect(roster).toHaveBeenCalledTimes(96);
  expect(chat.mock.calls.length + 2 * feed.mock.calls.length + 2 * roster.mock.calls.length).toBe(
    1635,
  );
  c.visibility(false);
  await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
  expect(chat).toHaveBeenCalledTimes(481);
  expect(feed).toHaveBeenCalledTimes(481);
  expect(roster).toHaveBeenCalledTimes(96);
  c.visibility(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(chat).toHaveBeenCalledTimes(482);
  expect(feed).toHaveBeenCalledTimes(482);
  expect(roster).toHaveBeenCalledTimes(97);
  stops.forEach((stop) => stop());
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(chat).toHaveBeenCalledTimes(482);
});

it('changed or pending work uses a bounded fast period then returns to idle; focus refreshes immediately', async () => {
  const c = clock();
  let first = true;
  const read = vi.fn(async () => {
    const changed = first;
    first = false;
    return changed;
  });
  const stop = startGroupPolling(read, {}, c.environment);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(7);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(read).toHaveBeenCalledTimes(7);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(8);
  c.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(9);
  stop();
});

it('held reads never overlap and a stopped or hidden in-flight read cannot restart polling', async () => {
  const c = clock();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const read = vi.fn(() => held);
  const stop = startGroupPolling(read, {}, c.environment);
  c.wake();
  c.wake();
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(read).toHaveBeenCalledTimes(1);
  c.visibility(false);
  finish();
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
  c.visibility(true);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(read).toHaveBeenCalledTimes(1);
});

it('a failed read retains idle retry cadence without unhandled rejection or immediate replay', async () => {
  const c = clock();
  const read = vi.fn(async () => {
    throw new Error('Offline read');
  });
  const stop = startGroupPolling(read, {}, c.environment);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});

it('connected invalidations replace active change polling; unfinished own receipts retain fast reconciliation', async () => {
  const c = clock();
  let connected = true,
    pending = false;
  let hint!: () => void;
  const updates = {
    connected: () => connected,
    subscribe: (refresh: () => void) => {
      hint = refresh;
      return () => {};
    },
  };
  const read = vi.fn(async () => ({ changed: true, pending }));
  const stop = startGroupPolling(read, { updates }, c.environment);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(read).toHaveBeenCalledTimes(1);
  hint();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  pending = true;
  stop.refresh();
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(4);
  pending = false;
  stop.refresh();
  await vi.advanceTimersByTimeAsync(299_999);
  expect(read).toHaveBeenCalledTimes(5);
  c.visibility(false);
  hint();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(read).toHaveBeenCalledTimes(5);
  connected = false;
  c.visibility(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(7);
  stop();
});

it('connected idle chat/feed/roster use483 RPCs per8h including startup, before producer and background reads', async () => {
  const c = clock();
  const updates = { connected: () => true, subscribe: () => () => {} };
  const chat = vi.fn(async () => false),
    feed = vi.fn(async () => false),
    roster = vi.fn(async () => {});
  const stops = [
    startGroupPolling(chat, { updates }, c.environment),
    startGroupPolling(feed, { updates }, c.environment),
    startGroupPolling(
      roster,
      { updates, idleMs: GROUP_POLLING.rosterMs, immediate: false },
      c.environment,
    ),
  ];
  await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
  expect(chat.mock.calls.length + 2 * feed.mock.calls.length + 2 * roster.mock.calls.length).toBe(
    483,
  );
  stops.forEach((stop) => stop());
});

it('a failed connected receipt read stops fast retries until a fresh hint or periodic reconciliation', async () => {
  const c = clock();
  const updates = { connected: () => true, subscribe: () => () => {} };
  let fail = false;
  const read = vi.fn(async () => {
    if (fail) throw new Error('Read unavailable');
    return { changed: false, pending: true };
  });
  const stop = startGroupPolling(read, { updates }, c.environment);
  await vi.advanceTimersByTimeAsync(0);
  fail = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  stop();
});
