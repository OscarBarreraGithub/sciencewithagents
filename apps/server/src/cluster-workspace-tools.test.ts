import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { managerTool } from './manager-lease.fixture.js';

let root: string, store: Store, runtime: Runtime, manager: string;
let launch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-workspace-tools-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Workspace fixture', '').managerId;
  launch = vi.fn(async () => new DemoProvider(root));
  runtime = new Runtime(store, root, '/unused-cli', launch);
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it('reads saved cluster state without a turn, SSH, or model call', async () => {
  const status = runtime.clusterWorkspace!.status();
  expect(
    await runtime.tool(manager, randomUUID(), 'dock_cluster_workspace', { action: 'inspect' }),
  ).toEqual(status);
  expect(launch).not.toHaveBeenCalled();
  expect(store.runs()).toHaveLength(0);
});
it('requires an admitted writing manager before changing the connection lease', async () => {
  const control = vi
    .spyOn(runtime.clusterWorkspace!, 'control')
    .mockResolvedValue(runtime.clusterWorkspace!.status());
  const args = [
    manager,
    randomUUID(),
    'dock_cluster_workspace',
    { action: 'renew', hours: 3 },
  ] as const;
  await expect(runtime.tool(...args)).rejects.toThrow('admitted turn');
  store.updateAgent(manager, { permission: 'read-only' });
  await expect(managerTool(runtime, ...args)).rejects.toThrow('Read-only');
  store.updateAgent(manager, { permission: 'workspace-write' });
  await managerTool(runtime, ...args);
  expect(control).toHaveBeenCalledTimes(1);
  expect(control).toHaveBeenCalledWith(expect.any(String), { action: 'renew', hours: 3 });
  expect(launch).not.toHaveBeenCalled();
});
it('does not expose connection control to workers or accept commands as coordination input', async () => {
  await expect(
    runtime.tool(manager, randomUUID(), 'dock_cluster_workspace', {
      action: 'inspect',
      command: 'ssh',
    }),
  ).rejects.toThrow();
  store.updateAgent(manager, { role: 'implementer' });
  await expect(
    runtime.tool(manager, randomUUID(), 'dock_cluster_workspace', { action: 'inspect' }),
  ).rejects.toThrow('no cluster workspace');
  expect(launch).not.toHaveBeenCalled();
});
