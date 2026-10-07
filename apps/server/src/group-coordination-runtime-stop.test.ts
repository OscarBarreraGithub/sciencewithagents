import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GroupContainer, GroupDockerEngine, type GroupContainerPlan } from './group-container.js';
it('shared HOME container lifetimes stop only their own namespace and retain the other live child', async () => {
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/group-shared-home-'));
  const children: GroupContainer[] = [],
    live = new Set<string>();
  const process = () =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
  const engine = new GroupDockerEngine('/var/run/docker.sock');
  let number = 0;
  const create = vi.spyOn(engine, 'create').mockImplementation(async () => {
    const id = (++number).toString(16).repeat(64);
    live.add(id);
    return id;
  });
  vi.spyOn(engine, 'inspect').mockImplementation(
    async (id) =>
      ({
        State: {
          Running: live.has(id),
          Status: live.has(id) ? 'running' : 'exited',
          Pid: live.has(id) ? 123 : 0,
        },
      }) as never,
  );
  vi.spyOn(engine, 'attach').mockImplementation(() => {
    const child = process();
    setImmediate(() =>
      child.stdout!.emit(
        'data',
        Buffer.from('{"type":"ready","pid":1,"uid":0,"network":"none"}\n'),
      ),
    );
    return child;
  });
  vi.spyOn(engine, 'exec').mockImplementation(() => process());
  const stop = vi.spyOn(engine, 'stop').mockImplementation(async (id) => {
    live.delete(id);
  });
  const sharedVolume = `swa-group-${randomUUID()}`,
    scope = randomUUID();
  const plan: GroupContainerPlan = {
    context: {
      contextId: scope,
      groupId: randomUUID(),
      memberId: randomUUID(),
      installationId: randomUUID(),
      visibility: 'shared',
    },
    image: 'sha256:' + 'a'.repeat(64),
    workspace: null,
    reads: [],
    expiresAt: Date.now() + 20000,
    cpuCores: 1,
    memoryMb: 512,
    outbound: [],
  };
  try {
    for (let i = 0; i < 2; i++) {
      const state = join(root, String(i));
      mkdirSync(state, { mode: 0o700 });
      const c = new GroupContainer(
        engine,
        plan,
        () => {},
        state,
        () => {},
        sharedVolume,
      );
      children.push(c);
      await c.start();
    }
    const [manager, child] = children;
    expect(
      create.mock.calls.every(([, volume, , retained]) => volume === sharedVolume && retained),
    ).toBe(true);
    await manager.close();
    expect(stop.mock.calls).toEqual([[manager.id, scope]]);
    expect(live.has(child.id)).toBe(true);
    child.spawn(['python3', '-c', 'print(1)'], `/workspace/tasks/${randomUUID()}`);
    await child.close();
    expect(live.size).toBe(0);
    expect(stop.mock.calls[1]).toEqual([child.id, scope]);
    expect(manager.id).not.toBe(child.id);
    expect(manager.name).not.toBe(child.name);
  } finally {
    await Promise.allSettled(children.map((c) => c.close()));
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
