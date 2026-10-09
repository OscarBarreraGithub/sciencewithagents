import { it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupEventRepository } from './group-events.js';
import { GroupFeaturePromotion } from './group-feature-promotion.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostUpdate } from '@dock/shared/dist/group-updates.js';

it('optional writer idle reads reconcile slowly, wake from scoped hints and pause while hidden without lease/model effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'group-promotion-cadence-')),
    db = new DatabaseSync(':memory:'),
    events = new GroupEventRepository(join(directory, 'events.sqlite'));
  const handle = randomUUID(),
    identity = { groupId: randomUUID(), memberId: randomUUID(), installationId: randomUUID() };
  db.exec(
    'CREATE TABLE gh_groups(handle TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE gh_sends(handle TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(handle,key))',
  );
  db.prepare('INSERT INTO gh_groups VALUES(?,?)').run(handle, JSON.stringify({ identity }));
  let connected = false,
    visible = true,
    changed: ((update: GroupHostUpdate) => void) | undefined;
  const command = vi.fn(async (_command: { kind: string }) => ({
    ok: true,
    value: {
      kind: 'pending',
      source: null,
      displayName: null,
      position: 0,
      retained: 0,
      pending: 0,
      capacity: 0,
    },
  }));
  const host = {
    directory,
    db,
    events,
    localVisible: () => visible,
    localContributing: () => true,
    promotionContext: async () => ({ command }),
    updates: {
      connected: () => connected,
      subscribe: (listener: typeof changed) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    },
  } as unknown as GroupHost;
  const service = new GroupFeaturePromotion(host);
  db.prepare("INSERT INTO gh_promotion_writers VALUES(?,1,0,'ready')").run(handle);
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  try {
    service.start();
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(1);
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60000);
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(2);
    connected = true;
    vi.setSystemTime(Date.now() + 60000);
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 240000);
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(3);
    changed!({ ...identity, connected: true, changed: true });
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(4);
    visible = false;
    changed!({ ...identity, connected: true, changed: true });
    await service.pass(false);
    expect(command).toHaveBeenCalledTimes(4);
    expect(
      command.mock.calls.every(([value]) => (value as { kind: string }).kind === 'pending'),
    ).toBe(true);
  } finally {
    await service.close();
    vi.useRealTimers();
    events.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
