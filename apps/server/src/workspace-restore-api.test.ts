import { modelFixture } from './model-policy.fixture.js';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceRestoreResultsSchema } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { WorkspaceState } from './workspace-state.js';

it('retries five saved contexts after a partial provider failure without replaying interrupted work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dock-workspace-retry-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Five saved conversations', '');
  const agents = [
    store.agent(project.managerId),
    ...Array.from({ length: 4 }, (_, index) =>
      store.addManager(project.id, `Module ${index + 1}`, ''),
    ),
  ];
  const threadIds = agents.map(() => randomUUID());
  for (const [index, agent] of agents.entries()) {
    const run = store.enqueue(
      agent.id,
      randomUUID(),
      'Inspect this uncertain outcome before continuing',
    );
    store.updateRun(run.id, { status: 'running', turnId: randomUUID() });
    store.updateAgent(agent.id, { threadId: threadIds[index], status: 'running' });
  }
  store.addApproval(agents[0].id, {
    requestId: 'original-before-restart',
    kind: 'command',
    title: 'Earlier permission',
    details: 'The original provider request is gone',
    questions: [],
    params: {},
  });
  const workspace = new WorkspaceState(store);
  let saved = workspace.register({ key: randomUUID(), label: 'Saved desktop' });
  for (const agent of agents)
    saved = workspace.update(saved.client.id, {
      key: randomUUID(),
      hostId: saved.hostId,
      revision: saved.client.revision,
      action: { kind: 'open', agentId: agent.id },
    }).state;
  let failFirst = true;
  const calls: { method: string; params: unknown }[] = [];
  const runtime = new Runtime(store, root, 'codex', async (agent) => {
    const provider = new DemoProvider();
    const request = provider.request.bind(provider);
    vi.spyOn(provider, 'request').mockImplementation(async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/resume' && agent.id === agents[0].id && failFirst)
        throw new Error('Temporary reconnect failure');
      return request(method, params);
    });
    return provider;
  });
  const app = await createServer(store, runtime, { port: 4979, ownsRuntime: false });
  try {
    await runtime.initialize();
    const beforeRuns = store.runs();
    const restore = (hostId = saved.hostId) =>
      app.inject({
        method: 'POST',
        url: `/api/workspace/${saved.client.id}/restore`,
        headers: { host: '127.0.0.1:4979', origin: 'http://127.0.0.1:4979' },
        payload: { hostId },
      });
    const first = await restore();
    expect(first.statusCode).toBe(200);
    expect(workspaceRestoreResultsSchema.parse(first.json()).map((result) => result.state)).toEqual(
      ['unavailable', 'inspect', 'inspect', 'inspect', 'inspect'],
    );
    failFirst = false;
    const retried = await restore();
    expect(retried.statusCode).toBe(200);
    expect(
      workspaceRestoreResultsSchema.parse(retried.json()).map((result) => result.state),
    ).toEqual(Array(5).fill('inspect'));
    expect(store.agents().map((agent) => agent.threadId)).toEqual(threadIds);
    expect(store.agents().every((agent) => agent.status === 'interrupted')).toBe(true);
    expect(store.runs()).toEqual(beforeRuns);
    expect(store.runs().every((run) => run.status === 'interrupted')).toBe(true);
    expect(store.approvals()[0].status).toBe('expired');
    expect(workspace.snapshot(saved.client.id)).toEqual(saved);
    expect(
      calls.some((call) => ['thread/start', 'turn/start', 'turn/steer'].includes(call.method)),
    ).toBe(false);
    const count = calls.length;
    expect((await restore(randomUUID())).statusCode).toBe(409);
    expect(calls).toHaveLength(count);
  } finally {
    await app.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
