import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createProductionGroupHost } from './group-host-bootstrap.js';
import { configureGroupNativeRoute, createGroupNativeConnector } from './group-native-connector.js';
import type { GroupNativeExecution } from './group-native-execution.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';

vi.mock('./group-native-connector.js', async (original) => {
  const actual = await original<typeof import('./group-native-connector.js')>();
  return { ...actual, createGroupNativeConnector: vi.fn(actual.createGroupNativeConnector) };
});

it('composed owner acceptance retains native tools without collecting unrelated work capabilities', async () => {
  mkdirSync('data/tests', { recursive: true });
  const root = mkdtempSync('data/tests/native-acceptance-capabilities-');
  const store = new Store(join(root, 'dock.sqlite'));
  const provider = vi.fn(async () => {
    throw new Error('No provider launch in the acceptance admission boundary check');
  });
  const runtime = new Runtime(store, root, 'never-native', provider);
  // Stop at the actual admission boundary: no Docker, sign-in, model turn or fake readiness.
  const queue = vi.spyOn(runtime, 'queueGroupExecutionProbe').mockImplementation(() => ({
    runId: randomUUID(),
    admitted: new Promise<GroupNativeExecution>(() => {}),
  }));
  const host = createProductionGroupHost(root, runtime);
  const connector = vi.mocked(createGroupNativeConnector).mock.results.at(-1)!.value as ReturnType<
    typeof createGroupNativeConnector
  >;
  try {
    const project = store.register(root, 'Owned acceptance boundary', '');
    configureGroupNativeRoute(runtime, {
      projectId: project.id,
      provider: 'codex',
      image: 'sha256:' + 'a'.repeat(64),
      resources: {
        workspace: null,
        stateBase: join(root, 'state'),
        readResources: [],
        forbiddenPaths: [store.path],
        outbound: [],
      },
    });
    const member = host.events.createGroup('Acceptance boundary');
    for (const visibility of ['shared', 'private'] as const) {
      const context = host.events.createContext({
        groupId: member.groupId,
        memberId: member.memberId,
        installationId: member.installationId,
        visibility,
        provider: 'owner',
        nativeSessionId: randomUUID(),
      });
      const accepted = connector.ownerAcceptance({ context, enrollmentHandle: randomUUID() });
      expect(accepted.context).toMatchObject({ visibility, provider: 'codex' });
      const [bridge, handle, resources] = queue.mock.calls.at(-1)!;
      const agent = store.agent(bridge.journal.resolve(handle).agentId);
      expect(agent).toMatchObject({ role: 'implementer', toolPolicy: 'native', threadId: null });
      expect(resources.tools).toEqual([]);
      expect(resources.workspace).toBeNull();
      if (visibility === 'shared')
        expect(() => connector.coordination!.identity(accepted.context)).toThrow(
          'no original group manager binding',
        );
    }
    expect(queue).toHaveBeenCalledTimes(2);
    expect(store.runs()).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    await host.close();
    await runtime.close();
    store.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
