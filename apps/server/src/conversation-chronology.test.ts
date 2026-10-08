import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareConversationActivity, latestConversationActivity, type Entry } from '@dock/shared';
import { Store } from './store.js';

let store: Store | undefined;
let root: string | undefined;
afterEach(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('sorts actual instants newest first and keeps undated/equal conversations deterministic', () => {
  const rows = [
    { id: 'undated-b' },
    { id: 'old', at: '2026-10-01T15:00:00Z' },
    { id: 'equal-b', at: '2026-10-02T10:00:00-04:00' },
    { id: 'undated-a' },
    { id: 'equal-a', at: '2026-10-02T14:00:00Z' },
  ];
  const sorted = () =>
    rows.sort((a, b) => compareConversationActivity(a.at, b.at, a.id, b.id)).map((row) => row.id);
  expect(sorted()).toEqual(['equal-a', 'equal-b', 'old', 'undated-a', 'undated-b']);
  rows.reverse();
  expect(sorted()).toEqual(['equal-a', 'equal-b', 'old', 'undated-a', 'undated-b']);
  expect(
    latestConversationActivity([1760000000, 1760000000000, '2026-10-01T10:00:00-04:00', 'invalid']),
  ).toBe('2026-10-01T14:00:00.000Z');
  expect(latestConversationActivity([undefined, null, 'invalid', Infinity])).toBeUndefined();
});

it('derives managed chat recency from retained message time across imports, acknowledgement, status and restart', () => {
  root = mkdtempSync(join(tmpdir(), 'swa-chat-chronology-'));
  store = new Store(join(root, 'dock.sqlite'));
  const manager = store.register(root, 'Chronology fixture', '').managerId;
  const entry = (createdAt: string, kind: Entry['kind'] = 'assistant', title = 'Reply'): Entry => ({
    id: randomUUID(),
    agentId: manager,
    runId: null,
    kind,
    title,
    text: 'Retained evidence',
    status: 'complete',
    createdAt,
  });
  const activity = vi.spyOn(store, 'conversationActivityAt');
  expect(store.agents().find((agent) => agent.id === manager)!.lastActivityAt).toBeUndefined();
  expect(activity).not.toHaveBeenCalled();
  const at = () => store!.agents(true).find((agent) => agent.id === manager)!.lastActivityAt;
  expect(at()).toBe(store.agent(manager).createdAt);
  const newest = entry('2026-10-03T14:00:00.000Z');
  store.entry(newest);
  store.entry(entry('2026-10-01T14:00:00.000Z'));
  store.entry(entry('2026-10-09T14:00:00.000Z', 'tool'));
  store.updateAgent(manager, { status: 'running', name: 'Renamed while working' });
  store.entry({ ...newest, text: 'Acknowledged/streamed text keeps its original message time' });
  expect(at()).toBe(newest.createdAt);
  const owner = entry('2026-10-04T10:00:00-04:00', 'user', 'You');
  store.entry(owner);
  expect(at()).toBe('2026-10-04T14:00:00.000Z');
  store.entry(entry('2026-10-04T13:30:00Z'));
  expect(at()).toBe('2026-10-04T14:00:00.000Z');
  const steering = entry('2026-10-05T14:00:00.000Z', 'system', 'Owner steering');
  store.entry(steering);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(at()).toBe(steering.createdAt);
});
