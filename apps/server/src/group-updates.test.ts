import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('../../web/src/api', () => ({
  apiScope: () => 'local',
  apiUrl: (path: string) => `/api${path}`,
}));
import {
  receiveGroupUpdate,
  resetGroupUpdates,
  groupPollingUpdates,
  observeGroupUpdates,
} from '../../web/src/groups/group-updates';
afterEach(() => vi.unstubAllGlobals());

it('ephemeral Group invalidations match exact host/member/enrollment and stale transport cannot retain connected cadence', () => {
  const identity = { groupId: randomUUID(), memberId: randomUUID(), installationId: randomUUID() };
  const updates = groupPollingUpdates(identity),
    refresh = vi.fn();
  const off = updates.subscribe(refresh);
  const value = { ...identity, connected: true, changed: true };
  receiveGroupUpdate(value, 'other-host');
  receiveGroupUpdate({ ...value, memberId: randomUUID() });
  receiveGroupUpdate({ ...value, installationId: randomUUID() });
  receiveGroupUpdate({ ...value, original: 'Forbidden body' });
  expect(updates.connected()).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  receiveGroupUpdate(value);
  expect(updates.connected()).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  resetGroupUpdates();
  expect(updates.connected()).toBe(false);
  expect(refresh).toHaveBeenCalledTimes(2);
  receiveGroupUpdate({ ...value, connected: false, changed: false });
  expect(updates.connected()).toBe(false);
  off();
  receiveGroupUpdate(value);
  expect(refresh).toHaveBeenCalledTimes(3);
});

it('normal Groups owns one existing authenticated event reader and closes stale metadata on error or unmount', () => {
  const sources: {
    url: string;
    read?: (event: MessageEvent<string>) => void;
    onerror?: () => void;
    closed: boolean;
  }[] = [];
  vi.stubGlobal(
    'EventSource',
    class {
      readonly closed = false;
      onerror?: () => void;
      read?: (event: MessageEvent<string>) => void;
      constructor(readonly url: string) {
        sources.push(this);
      }
      addEventListener(kind: string, read: (event: MessageEvent<string>) => void) {
        expect(kind).toBe('group');
        this.read = read;
      }
      close() {
        Object.assign(this, { closed: true });
      }
    },
  );
  const identity = { groupId: randomUUID(), memberId: randomUUID(), installationId: randomUUID() };
  const updates = groupPollingUpdates(identity);
  const refresh = vi.fn(),
    off = updates.subscribe(refresh),
    close = observeGroupUpdates();
  expect(sources).toHaveLength(1);
  expect(sources[0].url).toBe(`/api/events?after=${Number.MAX_SAFE_INTEGER}`);
  const data = JSON.stringify({ ...identity, connected: true, changed: true });
  sources[0].read!({ data: 'x'.repeat(2048) } as MessageEvent<string>);
  expect(updates.connected()).toBe(false);
  sources[0].read!({ data } as MessageEvent<string>);
  expect(updates.connected()).toBe(true);
  sources[0].onerror!();
  expect(updates.connected()).toBe(false);
  close();
  expect(sources[0].closed).toBe(true);
  sources[0].read!({ data } as MessageEvent<string>);
  expect(updates.connected()).toBe(false);
  expect(refresh).toHaveBeenCalledTimes(2);
  off();
});
