import { managerTool } from './manager-lease.fixture.js';
import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, publicTask } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { git, checkpointWorktree, integrate, checkCheckpointFiles } from './workspaces.js';
import { repoRoot } from './paths.js';
import { parseCapacity } from './capacity.js';
import { projectToolsSchema, workerToolsSchema } from '@dock/shared';

let root: string,
  projectRoot: string,
  store: Store,
  runtime: Runtime,
  manager: string,
  project: string;
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/runtime-'));
  projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Dock Test']);
  await git(projectRoot, ['config', 'user.email', 'dock@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# Fixture\n');
  await git(projectRoot, ['add', '.']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const p = store.register(projectRoot, 'Fixture', '');
  manager = p.managerId;
  // This suite also protects saved pre-migration contexts. Native inheritance
  // has separate checks below; omitted legacy settings must remain restrictive.
  store.updateAgent(manager, { toolPolicy: undefined });
  project = p.id;
  runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const task = async () =>
  (await managerTool(runtime, manager, randomUUID(), 'dock_task_create', {
    title: 'One result',
    goal: 'Implement one result',
    acceptance: 'The fixture has one new result',
  })) as { id: string };

it('gives managers a compact shared-budget view while retaining full task evidence on demand', async () => {
  const t = await task();
  const original = store.task(t.id);
  store.setSetting(
    'capacity:v1:codex',
    parseCapacity(
      'codex',
      [
        {
          provider: 'codex',
          source: 'oauth',
          usage: {
            updatedAt: new Date().toISOString(),
            secondary: {
              usedPercent: 6,
              windowMinutes: 10080,
              resetsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
            },
          },
        },
      ],
      Date.now(),
    ),
  );
  const cap = runtime.quark.saveBudget({
    key: randomUUID(),
    projectId: project,
    taskId: t.id,
    provider: 'codex',
    windowId: 'secondary',
    limitPercent: 10,
  });
  const context = JSON.parse(runtime.context(store.agent(manager)).split('\n').slice(1).join('\n'));
  expect(context.quark.budgets).toEqual([
    expect.objectContaining({ taskId: t.id, limitPercent: 10 }),
  ]);
  expect(context.quark.omitted).toEqual({ jobs: 0, budgets: 0, holds: 0 });
  expect(context.tasks.find((value: { id: string }) => value.id === t.id)).not.toHaveProperty(
    'acceptance',
  );
  expect(context).not.toHaveProperty('recent');
  expect(context.execution).not.toHaveProperty('models');
  expect(context.workerModelDefaults).toBeNull();
  store.setSetting(`project-workflow:${project}`, {
    providerMix: 'codex-heavy',
    spending: 'light',
    overrides: { review: { provider: 'claude', family: 'opus', model: 'opus', effort: 'high' } },
  });
  const configured = JSON.parse(
    runtime.context(store.agent(manager)).split('\n').slice(1).join('\n'),
  );
  expect(configured.workerModelDefaults).toMatchObject({
    research: { provider: 'codex', family: 'terra', model: null },
    review: { provider: 'claude', family: 'opus', model: 'opus', effort: 'high' },
    bulk: { provider: 'codex', family: 'luna', model: null },
  });
  expect(configured.execution.model).toBe(store.agent(manager).model);
  await expect(
    managerTool(runtime, manager, randomUUID(), 'dock_inspect', { taskId: t.id }),
  ).resolves.toMatchObject({ task: { acceptance: original.acceptance, goal: original.goal } });
  expect(runtime.quark.budgets().find((saved) => saved.id === cap.id)).toMatchObject({
    limitPercent: 10,
  });
});

it('native Codex inheritance avoids capability probes and keeps original manager permission requests', async () => {
  store.updateAgent(manager, { toolPolicy: 'native' });
  const client = await runtime.client(store.agent(manager));
  const request = vi.spyOn(client, 'request');
  const { threadId } = await runtime.attach(manager);
  const start = request.mock.calls.find(([method]) => method === 'thread/start')![1] as Record<
    string,
    unknown
  >;
  expect(start.config).toEqual({
    model_reasoning_effort: store.agent(manager).effort,
    'sandbox_workspace_write.network_access': true,
  });
  expect(start).toHaveProperty('approvalPolicy', 'never');
  expect(start).toHaveProperty('threadSource', 'sciencewithagents');
  expect(store.getSetting(`codex:owned:${threadId}`)).toBe(manager);
  expect(
    request.mock.calls.some(([method]) => ['config/read', 'mcpServerStatus/list'].includes(method)),
  ).toBe(false);
  const respond = vi.spyOn(client, 'respond');
  client.emit('request', 'original-native-request', 'item/commandExecution/requestApproval', {
    threadId,
    turnId: 'native-turn',
    itemId: 'native-item',
    command: 'inspect fixture',
  });
  await vi.waitFor(() => expect(store.approvals()).toHaveLength(1));
  const approval = store.approvals()[0]!;
  expect(approval.requestId).toBe('original-native-request');
  expect(respond).not.toHaveBeenCalled();
  await runtime.approve(approval.id, 'decline');
  expect(respond).toHaveBeenCalledWith('original-native-request', { decision: 'decline' });
});

it.each(['native', 'restricted'] as const)(
  '%s read-only turns preserve writes policy while native turns allow network access',
  async (toolPolicy) => {
    store.updateAgent(manager, { toolPolicy });
    const client = await runtime.client(store.agent(manager));
    const request = vi.spyOn(client, 'request');
    store.transaction(() => store.enqueue(manager, randomUUID(), 'Read the project status.'));
    runtime.kick();
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true),
    );
    const params = request.mock.calls.find(([method]) => method === 'turn/start')![1] as Record<
      string,
      unknown
    >;
    expect(params.sandboxPolicy).toEqual(
      toolPolicy === 'native' ? { type: 'readOnly', networkAccess: true } : undefined,
    );
    expect(store.agent(manager).permission).toBe('read-only');
  },
);

it('new Codex delegations inherit native settings while saved restrictions survive later creation', async () => {
  const t = await task();
  const worker = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
    taskId: t.id,
    role: 'researcher',
    name: 'Native researcher',
    instruction: 'Read evidence.',
    execution: { provider: 'codex' },
  })) as { id: string };
  expect(store.agent(worker.id).toolPolicy).toBe('native');
  store.setSetting(`worker-tools:${project}`, projectToolsSchema.parse({ revision: 1 }));
  const other = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
    taskId: t.id,
    role: 'researcher',
    name: 'Restricted researcher',
    instruction: 'Read evidence.',
    execution: { provider: 'codex' },
  })) as { id: string };
  expect(store.agent(other.id).toolPolicy).toBe('restricted');
  expect(store.agent(worker.id).toolPolicy).toBe('native');
  store.setSetting(
    `worker-tools:${project}`,
    projectToolsSchema.parse({ revision: 2, toolPolicy: 'native' }),
  );
  const restored = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
    taskId: t.id,
    role: 'researcher',
    name: 'Restored native researcher',
    instruction: 'Read evidence.',
    execution: { provider: 'codex' },
  })) as { id: string };
  expect(store.agent(restored.id).toolPolicy).toBe('native');
  expect(store.agent(other.id).toolPolicy).toBe('restricted');
});

it('reads only catalog names in a disposable client without changing a Claude manager', async () => {
  await runtime.close();
  const provider = new DemoProvider();
  const factory = vi.fn(async () => provider);
  runtime = new Runtime(store, root, 'codex', factory);
  store.updateAgent(manager, { provider: 'claude' });
  const before = store.agent(manager);
  const request = vi.spyOn(provider, 'request').mockResolvedValue({
    config: {
      mcp_servers: { research: { command: 'private-command', env: { SECRET: 'private-token' } } },
    },
  });
  expect(await runtime.projectMcpCatalog(project)).toEqual([{ name: 'research' }]);
  expect(request.mock.calls).toEqual([['config/read', { includeLayers: false }]]);
  expect(provider.ready).toBe(false);
  expect(runtime.clients.size).toBe(0);
  expect(store.agent(manager)).toEqual(before);
  expect(store.runs()).toEqual([]);
  provider.ready = true;
  request.mockResolvedValue({ config: { mcp_servers: 'invalid private-token' } });
  await expect(runtime.projectMcpCatalog(project)).rejects.toThrow('unsupported MCP configuration');
  expect(provider.ready).toBe(false);
});

it('delegates only owner-granted tools, retains the receipt and passes the selection to native Codex with approvals', async () => {
  const t = await task();
  const input = {
    taskId: t.id,
    role: 'researcher',
    name: 'Evidence reader',
    instruction: 'Read the configured evidence.',
    tools: {
      mcpServers: ['demo_docs'],
      webSearch: 'live',
      pluginsEnabled: true,
      imageGeneration: true,
    },
  };
  await expect(managerTool(runtime, manager, randomUUID(), 'dock_delegate', input)).rejects.toThrow(
    'allowance',
  );
  expect(store.agents()).toHaveLength(1);
  const policy = projectToolsSchema.parse({ revision: 1, codex: input.tools });
  store.setSetting(`worker-tools:${project}`, policy);
  expect(
    JSON.parse(runtime.context(store.agent(manager)).split('\n').slice(1).join('\n')).workerTools,
  ).toEqual(policy);
  const key = randomUUID();
  const worker = (await managerTool(runtime, manager, key, 'dock_delegate', input)) as {
    id: string;
  };
  expect(store.agent(worker.id)).toMatchObject(input.tools);
  expect(store.agent(worker.id).permission).toBe('read-only');
  expect(store.getSetting(`worker-tools:grant:${worker.id}`)).toEqual({
    projectId: project,
    revision: 1,
    tools: input.tools,
  });
  const client = await runtime.client(store.agent(worker.id));
  const request = vi.spyOn(client, 'request');
  await runtime.attach(worker.id);
  expect(request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      config: expect.objectContaining({
        web_search: 'live',
        features: expect.objectContaining({ image_generation: true }),
        mcp_servers: {
          demo_docs: expect.objectContaining({
            enabled: true,
            default_tools_approval_mode: 'prompt',
          }),
        },
      }),
    }),
  );
  expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  store.setSetting(`worker-tools:${project}`, projectToolsSchema.parse({ revision: 2 }));
  expect(await managerTool(runtime, manager, key, 'dock_delegate', input)).toEqual(worker);
  await expect(managerTool(runtime, manager, randomUUID(), 'dock_delegate', input)).rejects.toThrow(
    'allowance',
  );
  expect(store.agent(worker.id)).toMatchObject(input.tools);
  const plain = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
    ...input,
    tools: undefined,
  })) as { id: string };
  expect(store.agent(plain.id)).toMatchObject(workerToolsSchema.parse({}));
});

it('rechecks the allowance after worktree preparation and never silently routes Claude tool requests', async () => {
  const t = await task();
  const input = {
    taskId: t.id,
    role: 'researcher',
    name: 'Reader',
    instruction: 'Read the source.',
    tools: { webSearch: 'live' },
  };
  const granted = projectToolsSchema.parse({ codex: input.tools });
  store.setSetting(`worker-tools:${project}`, granted);
  const resolve = vi.spyOn(runtime.modelPolicy, 'resolve');
  const assignment = await runtime.modelPolicy.resolve('reasoning');
  resolve.mockResolvedValueOnce({ ...assignment, provider: 'claude' });
  await expect(managerTool(runtime, manager, randomUUID(), 'dock_delegate', input)).rejects.toThrow(
    'require a Codex',
  );
  expect(store.agents()).toHaveLength(1);
  const sync = runtime.quark.sync.bind(runtime.quark);
  vi.spyOn(runtime.quark, 'sync').mockImplementationOnce(() => {
    store.setSetting(`worker-tools:${project}`, projectToolsSchema.parse({ revision: 1 }));
    return sync();
  });
  await expect(managerTool(runtime, manager, randomUUID(), 'dock_delegate', input)).rejects.toThrow(
    'allowance',
  );
  expect(store.agents()).toHaveLength(1);
});

it('QUARK interrupts the exact active reply while preserving unsent messages and requiring explicit continuation', async () => {
  class LongProvider extends DemoProvider {
    stops: unknown[] = [];
    override async request(method: string, raw?: unknown): Promise<unknown> {
      if (method === 'turn/start') return { turn: { id: randomUUID(), status: 'inProgress' } };
      if (method === 'turn/interrupt') {
        this.stops.push(raw);
        const p = raw as { threadId: string; turnId: string };
        this.emit('notification', 'turn/completed', {
          threadId: p.threadId,
          turn: { id: p.turnId, status: 'interrupted' },
        });
        return {};
      }
      return super.request(method, raw);
    }
  }
  await runtime.close();
  const provider = new LongProvider();
  runtime = new Runtime(store, root, 'codex', async () => provider);
  const report = (usedPercent: number) =>
    store.setSetting(
      'capacity:v1:codex',
      parseCapacity(
        'codex',
        [
          {
            provider: 'codex',
            source: 'oauth',
            usage: {
              updatedAt: new Date().toISOString(),
              secondary: {
                usedPercent,
                windowMinutes: 10080,
                resetsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
  // Keep one stable reset identity while allowance usage changes.
  const reset = new Date(Date.now() + 7 * 86400_000).toISOString();
  const usage = (n: number) => {
    report(n);
    const c = store.getSetting('capacity:v1:codex') as { windows: { resetsAt: string }[] };
    c.windows[0]!.resetsAt = reset;
    store.setSetting('capacity:v1:codex', c);
  };
  usage(6);
  runtime.quark.sync();
  const budget = runtime.quark.saveBudget({
    key: randomUUID(),
    projectId: project,
    taskId: null,
    provider: 'codex',
    windowId: 'secondary',
    limitPercent: 5,
  });
  const first = store.enqueue(manager, randomUUID(), 'Start this project');
  runtime.kick();
  await vi.waitFor(() => expect(store.agent(manager).turnId).toBeTruthy());
  const exactTurn = store.agent(manager).turnId;
  const queued = store.enqueue(manager, randomUUID(), 'This message has not been sent');
  await new Promise((resolve) => setTimeout(resolve, 15));
  usage(12);
  runtime.kick();
  await vi.waitFor(() => expect(store.run(first.id).status).toBe('interrupted'));
  expect(provider.stops).toEqual([{ threadId: store.agent(manager).threadId, turnId: exactTurn }]);
  expect(store.run(queued.id).status).toBe('queued');
  expect(runtime.quark.holds()).toHaveLength(1);
  expect(() => runtime.quark.release(first.id)).toThrow('budget');
  runtime.quark.saveBudget({
    key: randomUUID(),
    id: budget.id,
    expectedRevision: budget.revision,
    projectId: project,
    taskId: null,
    provider: 'codex',
    windowId: 'secondary',
    limitPercent: 20,
  });
  expect(store.run(queued.id).status).toBe('queued');
  expect(runtime.quark.holds()).toHaveLength(1);
  runtime.quark.release(first.id);
  expect(store.runs()).toHaveLength(2);
  runtime.kick();
  await vi.waitFor(() => expect(store.run(queued.id).status).toBe('running'));
  expect(
    store
      .entries(manager)
      .filter((e) => e.kind === 'user')
      .map((e) => e.text),
  ).toEqual(['Start this project', 'This message has not been sent']);
});

it('manager allowance tools are retry-safe and cannot increase or replace an existing task cap', async () => {
  const id = (await task()).id;
  const date = Date.now();
  store.setSetting(
    'capacity:v1:codex',
    parseCapacity(
      'codex',
      [
        {
          provider: 'codex',
          source: 'oauth',
          usage: {
            updatedAt: new Date(date).toISOString(),
            secondary: {
              usedPercent: 6,
              windowMinutes: 10080,
              resetsAt: new Date(date + 7 * 86400_000).toISOString(),
            },
          },
        },
      ],
      date,
    ),
  );
  const key = randomUUID(),
    input = { taskId: id, provider: 'codex', windowId: 'secondary', limitPercent: 10 };
  const saved = await managerTool(runtime, manager, key, 'dock_budget', input);
  expect(await managerTool(runtime, manager, key, 'dock_budget', input)).toEqual(saved);
  await expect(
    managerTool(runtime, manager, randomUUID(), 'dock_budget', { ...input, limitPercent: 20 }),
  ).rejects.toThrow('Only the owner');
  await managerTool(runtime, manager, randomUUID(), 'dock_budget', { ...input, limitPercent: 8 });
  expect(runtime.quark.budgets()).toHaveLength(1);
  expect(runtime.quark.budgets()[0]!.limitPercent).toBe(8);
});

it('a cache refresh retains the chosen model and task status without generating a manager report', async () => {
  const taskId = (await task()).id;
  store.updateTask(taskId, { status: 'working' });
  const worker = store.addAgent({
    projectId: project,
    taskId,
    parentId: manager,
    provider: 'codex',
    role: 'researcher',
    name: 'Warm context',
    cwd: projectRoot,
  });
  store.updateAgent(worker.id, { model: 'demo', effort: 'medium' });
  const run = store.enqueue(
    worker.id,
    randomUUID(),
    'QUARK cache refresh only. Reply Ready.',
    'message',
  );
  store.setSetting(`quark:nudge:${run.id}`, true);
  store.setSetting(`quark:nudge-expiry:${run.id}`, new Date(Date.now() + 60000).toISOString());
  store.setSetting(`model-policy:run:${run.id}`, { cacheRefresh: true });
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('completed'));
  expect(store.agent(worker.id).model).toBe('demo');
  expect(store.task(taskId).status).toBe('working');
  expect(store.runs().filter((r) => r.agentId === worker.id)).toHaveLength(1);
  expect(store.runs().some((r) => r.kind === 'report')).toBe(false);
});

describe('manager capabilities and task convergence', () => {
  it('archives image output without exposing encoded bytes or opening supplied paths', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
    store.transaction(() =>
      runtime.hydrate(manager, [
        {
          id: 'image-turn',
          items: [
            {
              id: 'valid-image',
              type: 'imageGeneration',
              status: 'completed',
              revisedPrompt: 'One test image',
              result: png,
              savedPath: '/private/never-read.png',
              failure: null,
            },
            {
              id: 'unsafe-image',
              type: 'imageGeneration',
              status: 'completed',
              result: 'file:///private/never-read.png',
              savedPath: '/private/never-read.png',
              failure: null,
            },
            {
              id: 'failed-image',
              type: 'imageGeneration',
              status: 'failed',
              result: png,
              failure: { message: '/private/not-exposed' },
            },
            {
              id: 'cancelled-image',
              type: 'imageGeneration',
              status: 'cancelled',
              result: png,
              failure: null,
            },
          ],
        },
      ]),
    );
    const entries = store.entries(manager);
    expect(entries[0].image).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 });
    expect(store.image(manager, entries[0].image!.id)).toEqual(Buffer.from(png, 'base64'));
    expect(entries[1].image).toBeUndefined();
    expect(entries[1].text).toContain('Image not retained');
    expect(entries[2].image).toBeUndefined();
    expect(entries[2].title).toBe('Image generation failed');
    expect(entries[3].image).toBeUndefined();
    expect(entries[3].title).toBe('Image generation did not complete');
    expect(JSON.stringify(entries)).not.toContain('/private/');
    expect(JSON.stringify(store.events())).not.toContain(png);
  });

  it('uses the worker web-search choice across native contexts and keeps manager search disabled', async () => {
    const worker = store.addAgent({
      projectId: project,
      parentId: null,
      taskId: null,
      name: 'Web researcher',
      role: 'researcher',
      cwd: projectRoot,
    });
    store.updateAgent(worker.id, {
      toolPolicy: 'restricted',
      webSearch: 'indexed',
      imageGeneration: true,
    });
    const provider = new DemoProvider(),
      request = vi.spyOn(provider, 'request'),
      managerProvider = new DemoProvider(),
      managerRequest = vi.spyOn(managerProvider, 'request');
    await runtime.close();
    runtime = new Runtime(store, root, 'codex', async (agent) =>
      agent.role === 'manager' ? managerProvider : provider,
    );
    const { threadId } = await runtime.attach(worker.id);
    expect(request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'read-only',
        config: expect.objectContaining({
          web_search: 'indexed',
          features: expect.objectContaining({ image_generation: true }),
        }),
      }),
    );
    runtime.externalControl.add(worker.id);
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      const transition = runtime.prepareNativeContext(worker.id, method, {
        ...(method === 'thread/start' ? { cwd: projectRoot } : { threadId }),
        config: { web_search: 'live' },
      })!;
      expect(transition.params).toMatchObject({
        config: { web_search: 'indexed', features: { image_generation: true } },
      });
      transition.cancel();
    }
    store.updateAgent(manager, { webSearch: 'live', imageGeneration: true }); // Stale metadata cannot enable manager execution.
    const connection = await runtime.attach(manager);
    expect(
      managerRequest.mock.calls.filter(([method]) => method === 'thread/start').at(-1)?.[1],
    ).toMatchObject({ config: { web_search: 'disabled', features: { image_generation: false } } });
    runtime.externalControl.add(manager);
    const transition = runtime.prepareNativeContext(manager, 'thread/resume', {
      threadId: connection.threadId,
      config: { web_search: 'live' },
    })!;
    expect(transition.params).toMatchObject({
      config: { web_search: 'disabled', features: { image_generation: false } },
    });
    transition.cancel();
  });

  it('selects a transfer target’s historical context only through its own attached provider', async () => {
    const { client, threadId } = await runtime.attach(manager);
    store.updateAgent(manager, { threadId: 'another-current-context' });
    runtime.externalControl.add(manager);
    const request = vi.spyOn(client, 'request').mockImplementation(async (method) => {
      if (method === 'thread/resume')
        return {
          thread: {
            id: threadId,
            cwd: join(root, 'managers', manager),
            ephemeral: false,
            parentThreadId: null,
          },
        };
      return {};
    });
    await runtime.selectNativeContext(manager, threadId);
    expect(store.agent(manager).threadId).toBe(threadId);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'thread/resume',
      'thread/resume',
    ]);
    expect(store.events().some((e) => e.type === 'session.resumed')).toBe(true);
    await expect(runtime.selectNativeContext(manager, 'unregistered')).rejects.toThrow(
      'has not been imported',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('creates a native context with role tools and resumes its previous context without losing the archive', async () => {
    const { client, threadId } = await runtime.attach(manager);
    await managerTool(runtime, manager, randomUUID(), 'dock_checkpoint', {
      summary: 'Keep this handoff.',
    });
    const entries = store.entries(manager);
    runtime.externalControl.add(manager);
    const startRequests = vi.spyOn(client, 'request');
    const start = runtime.prepareNativeContext(manager, 'thread/start', {
      cwd: join(root, 'managers', manager),
      developerInstructions: 'No host role',
      dynamicTools: [{ name: 'untracked' }],
      model: 'chosen-model',
    })!;
    expect(start.params).toMatchObject({
      cwd: join(root, 'managers', manager),
      model: 'chosen-model',
      historyMode: 'legacy',
      ephemeral: false,
    });
    const params = start.params as {
      dynamicTools: { name: string }[];
      developerInstructions: string;
    };
    expect(params.developerInstructions).toContain('Use native tools to inspect and research');
    expect(params.dynamicTools.map((t) => t.name)).toContain('dock_delegate');
    expect(params.dynamicTools.map((t) => t.name)).not.toContain('untracked');
    const metadata = {
      id: 'fresh',
      cwd: join(root, 'managers', manager),
      ephemeral: false,
      parentThreadId: null,
    };
    client.emit('notification', 'thread/started', { thread: { ...metadata, source: 'cli' } });
    expect(store.agent(manager).threadId).toBe(threadId);
    await start.finish({ thread: metadata, model: 'chosen-model', reasoningEffort: 'xhigh' });
    expect(store.agent(manager)).toMatchObject({ model: 'chosen-model', effort: 'xhigh' });
    expect(
      startRequests.mock.calls.findIndex(([method]) => method === 'thread/name/set'),
    ).toBeLessThan(startRequests.mock.calls.findIndex(([method]) => method === 'thread/resume'));
    start.cancel();
    expect(store.agent(manager).threadId).toBe('fresh');
    expect(store.contextOwner(threadId)).toBe(manager);
    const request = vi.spyOn(client, 'request');
    const resume = runtime.prepareNativeContext(manager, 'thread/resume', { threadId })!;
    await resume.before!();
    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId,
      cwd: join(root, 'managers', manager),
      excludeTurns: true,
      config: {
        web_search: 'disabled',
        features: { multi_agent: false, multi_agent_v2: false, image_generation: false },
        agents: {
          enabled: false,
          max_concurrent_threads_per_session: 2,
          default_subagent_model: 'demo',
          default_subagent_reasoning_effort: 'medium',
        },
        mcp_servers: {
          demo_docs: { enabled: false, default_tools_approval_mode: 'prompt', tools: {} },
        },
      },
    });
    await resume.finish({
      thread: { ...metadata, id: threadId },
      model: 'earlier-model',
      reasoningEffort: 'high',
    });
    expect(store.agent(manager)).toMatchObject({ model: 'earlier-model', effort: 'high' });
    resume.cancel();
    expect(store.agent(manager)).toMatchObject({
      threadId,
      checkpoint: 'Keep this handoff.',
      role: 'manager',
      taskId: null,
    });
    expect(store.entries(manager).slice(0, entries.length)).toEqual(entries);
    expect(store.runs()).toHaveLength(0);
    expect(store.events().some((e) => e.type === 'terminal.session_left')).toBe(false);
    expect(
      runtime.prepareNativeContext(manager, 'thread/resume', { threadId })?.params,
    ).toMatchObject({
      config: { mcp_servers: { demo_docs: { enabled: false } } },
    });
  });
  it('retains worker task ownership on native navigation and rejects another agent’s context', async () => {
    const t = await task();
    const worker = store.addAgent({
      projectId: project,
      parentId: manager,
      taskId: t.id,
      role: 'implementer',
      name: 'Builder',
      cwd: projectRoot,
    });
    store.updateAgent(worker.id, { toolPolicy: 'restricted' });
    await runtime.attach(manager);
    const { threadId } = await runtime.attach(worker.id);
    runtime.externalControl.add(worker.id);
    expect(() =>
      runtime.prepareNativeContext(worker.id, 'thread/resume', {
        threadId: store.agent(manager).threadId,
      }),
    ).toThrow('another agent');
    const start = runtime.prepareNativeContext(worker.id, 'thread/start', { cwd: projectRoot })!;
    expect((start.params as { developerInstructions: string }).developerInstructions).toContain(
      'implementer',
    );
    expect(start.params).toMatchObject({
      config: {
        features: { multi_agent: true, multi_agent_v2: true },
        agents: {
          enabled: true,
          max_concurrent_threads_per_session: 2,
          default_subagent_model: 'demo',
          default_subagent_reasoning_effort: 'medium',
        },
      },
    });
    await start.finish({
      thread: { id: 'worker-next', cwd: projectRoot, ephemeral: false, parentThreadId: null },
    });
    start.cancel();
    expect(store.agent(worker.id)).toMatchObject({
      parentId: manager,
      taskId: t.id,
      role: 'implementer',
      permission: 'workspace-write',
      cwd: projectRoot,
    });
    expect(store.contextOwner(threadId)).toBe(worker.id);
    expect(store.contextOwner('worker-next')).toBe(worker.id);
  });
  it('retains a selected context and closes native input when its host subscription fails', async () => {
    const { client, threadId } = await runtime.attach(manager);
    store.updateAgent(manager, { threadId: 'another-current-context' });
    runtime.externalControl.add(manager);
    vi.spyOn(client, 'request').mockRejectedValue(new Error('Connection lost'));
    const resume = runtime.prepareNativeContext(manager, 'thread/resume', { threadId })!;
    await expect(resume.before!()).rejects.toThrow('Connection lost');
    resume.cancel();
    expect(store.agent(manager).threadId).toBe(threadId);
    expect(store.entries(manager).at(-1)?.title).toBe('Native context needs recovery');
    expect(store.events().some((e) => e.type === 'terminal.session_left')).toBe(true);
    expect(store.runs()).toHaveLength(0);
    client.ready = false;
    expect(() => runtime.prepareNativeContext(manager, 'thread/resume', { threadId })).toThrow(
      'host connection',
    );
  });
  it('lets module managers share evidence and messages but only change their own tasks', async () => {
    const module = store.addManager(
      project,
      'Interface manager',
      'Web interface and mobile layout',
    );
    const t = (await managerTool(runtime, module.id, randomUUID(), 'dock_task_create', {
      title: 'Module task',
      goal: 'One interface result',
      acceptance: 'One verified result',
    })) as { id: string; managerId: string };
    expect(t.managerId).toBe(module.id);
    const input = {
      taskId: t.id,
      role: 'researcher',
      name: 'Module researcher',
      instruction: 'Inspect one question',
    };
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_delegate', input),
    ).rejects.toThrow('another manager');
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_decide', {
        taskId: t.id,
        kind: 'note',
        rationale: 'This manager does not own the bounded task.',
        evidence: 'Task ownership',
      }),
    ).rejects.toThrow('another manager');
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_task_create', {
        title: 'Foreign split',
        goal: 'Cannot split another manager’s task',
        acceptance: 'Refused',
        parentId: t.id,
      }),
    ).rejects.toThrow('parent task');
    const worker = (await managerTool(
      runtime,
      module.id,
      randomUUID(),
      'dock_delegate',
      input,
    )) as {
      id: string;
    };
    expect(store.agent(worker.id).parentId).toBe(module.id);
    await managerTool(runtime, module.id, randomUUID(), 'dock_checkpoint', {
      summary: 'The interface task is delegated.',
    });
    expect(runtime.context(store.agent(manager))).toContain('The interface task is delegated.');
    expect(runtime.context(store.agent(module.id))).toContain('Web interface and mobile layout');
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_inspect', { taskId: t.id }),
    ).resolves.toMatchObject({ task: { managerId: module.id } });
    await managerTool(runtime, manager, randomUUID(), 'dock_message', {
      agentId: module.id,
      message: 'Please share the interface acceptance evidence.',
    });
    expect(store.entries(module.id).at(-1)?.title).toBe('Fixture manager');
    await runtime.initialize();
    await expect
      .poll(() =>
        store
          .runs()
          .filter((r) => r.agentId === worker.id)
          .every((r) => r.status === 'completed'),
      )
      .toBe(true);
    await expect
      .poll(() =>
        store
          .runs()
          .some((r) => r.kind === 'report' && r.sourceId === worker.id && r.agentId === module.id),
      )
      .toBe(true);
    expect(store.runs().some((r) => r.kind === 'report' && r.agentId === manager)).toBe(false);
  });
  it('retains native model changes and detects navigation away from a managed session', async () => {
    const { client, threadId } = await runtime.attach(manager);
    runtime.externalControl.add(manager);
    client.emit('notification', 'thread/settings/updated', {
      threadId,
      threadSettings: { model: 'native-model', effort: 'high' },
    });
    expect(store.agent(manager)).toMatchObject({ model: 'native-model', effort: 'high' });
    client.emit('notification', 'thread/started', {
      thread: { id: 'auxiliary-title', source: 'appServer', ephemeral: true },
    });
    expect(store.events().some((e) => e.type === 'terminal.session_left')).toBe(false);
    client.emit('notification', 'thread/started', {
      thread: { id: 'different-thread', source: 'cli' },
    });
    expect(store.events().some((e) => e.type === 'terminal.session_left')).toBe(true);
    expect(store.agent(manager).threadId).toBe(threadId);
  });
  it('adopts an idle native fork once without copying history or losing durable ownership', async () => {
    const { client, threadId } = await runtime.attach(manager);
    await managerTool(runtime, manager, randomUUID(), 'dock_checkpoint', {
      summary: 'Retain this.',
    });
    const entries = store.entries(manager);
    runtime.externalControl.add(manager);
    const thread = {
      id: 'native-fork',
      forkedFromId: threadId,
      cwd: join(root, 'managers', manager),
      // Forks inherit their source; a CLI action need not have source "cli".
      source: 'vscode',
      ephemeral: false,
      parentThreadId: null,
    };
    const request = vi.spyOn(client, 'request');
    const transition = runtime.prepareNativeContext(manager, 'thread/fork', { threadId })!;
    expect(transition.params).toMatchObject({ threadId, deferGoalContinuation: true });
    client.emit('notification', 'thread/started', { thread });
    expect(store.agent(manager).threadId).toBe(threadId);
    await transition.finish({ thread });
    transition.cancel();
    expect(request).toHaveBeenCalledWith('thread/resume', {
      threadId: thread.id,
      cwd: join(root, 'managers', manager),
      excludeTurns: true,
      config: {
        web_search: 'disabled',
        features: { multi_agent: false, multi_agent_v2: false, image_generation: false },
        agents: {
          enabled: false,
          max_concurrent_threads_per_session: 2,
          default_subagent_model: 'demo',
          default_subagent_reasoning_effort: 'medium',
        },
        mcp_servers: {
          demo_docs: { enabled: false, default_tools_approval_mode: 'prompt', tools: {} },
        },
      },
    });
    client.emit('notification', 'thread/started', { thread });
    expect(store.agent(manager)).toMatchObject({
      threadId: thread.id,
      role: 'manager',
      taskId: null,
      checkpoint: 'Retain this.',
    });
    expect(store.entries(manager).slice(0, entries.length)).toEqual(entries);
    expect(store.entries(manager)).toHaveLength(entries.length + 1);
    expect(store.getSetting(`observed:${thread.id}`)).toBe(true);
    expect(store.events().filter((e) => e.type === 'session.forked')).toHaveLength(1);
    expect(store.events().some((e) => e.type === 'terminal.session_left')).toBe(false);
    const reopened = new Store(join(root, 'dock.sqlite'));
    modelFixture(reopened);
    try {
      expect(reopened.agent(manager).threadId).toBe(thread.id);
      expect(reopened.entries(manager)).toEqual(store.entries(manager));
    } finally {
      reopened.close();
    }
  });
  it('rejects incompatible native fork requests and responses before adopting a context', async () => {
    const { threadId } = await runtime.attach(manager);
    expect(() => runtime.prepareNativeContext(manager, 'thread/fork', { threadId })).toThrow(
      'idle managed',
    );
    runtime.externalControl.add(manager);
    for (const params of [
      { threadId: 'foreign' },
      { threadId, cwd: projectRoot },
      { threadId, path: '/unregistered' },
      { threadId, ephemeral: true },
    ])
      expect(() => runtime.prepareNativeContext(manager, 'thread/fork', params)).toThrow();
    store.updateAgent(manager, { status: 'running' });
    expect(() => runtime.prepareNativeContext(manager, 'thread/fork', { threadId })).toThrow();
    store.updateAgent(manager, { status: 'idle' });
    const transition = runtime.prepareNativeContext(manager, 'thread/fork', { threadId })!;
    expect(() => runtime.prepareNativeContext(manager, 'thread/fork', { threadId })).toThrow();
    await expect(
      transition.finish({
        thread: {
          id: 'wrong-cwd',
          forkedFromId: threadId,
          cwd: projectRoot,
          ephemeral: false,
          parentThreadId: null,
        },
      }),
    ).rejects.toThrow('incompatible');
    expect(store.agent(manager).threadId).toBe(threadId);
    transition.cancel();
    const retry = runtime.prepareNativeContext(manager, 'thread/fork', { threadId })!;
    retry.cancel();
  });
  it('refuses foreign, wrong-workspace, owned or busy native forks and ignores child threads', async () => {
    const { client, threadId } = await runtime.attach(manager);
    runtime.externalControl.add(manager);
    const thread = {
      id: 'refused-fork',
      forkedFromId: threadId,
      cwd: join(root, 'managers', manager),
      source: 'vscode',
    };
    for (const patch of [{ ephemeral: true }, { parentThreadId: threadId }])
      client.emit('notification', 'thread/started', { thread: { ...thread, ...patch } });
    expect(store.events().some((e) => e.type === 'terminal.session_left')).toBe(false);
    const other = store.addManager(project, 'Other', 'Other responsibility');
    store.updateAgent(other.id, { threadId: 'owned-fork' });
    for (const patch of [
      { forkedFromId: 'foreign-context' },
      { cwd: projectRoot },
      { id: 'owned-fork' },
    ]) {
      client.emit('notification', 'thread/started', { thread: { ...thread, ...patch } });
      expect(store.agent(manager).threadId).toBe(threadId);
    }
    store.updateAgent(manager, { status: 'running' });
    client.emit('notification', 'thread/started', { thread });
    expect(store.agent(manager).threadId).toBe(threadId);
    expect(store.events().filter((e) => e.type === 'terminal.session_left')).toHaveLength(4);
    expect(store.events().some((e) => e.type === 'session.forked')).toBe(false);
  });
  it('blocks likely secrets before automatic staging without printing their values', async () => {
    writeFileSync(join(projectRoot, '.env'), 'EXAMPLE_PRIVATE_VALUE=do-not-commit\n');
    await expect(checkCheckpointFiles(projectRoot)).rejects.toThrow('credential');
    expect(await git(projectRoot, ['diff', '--cached', '--name-only'])).toBe('');
    rmSync(join(projectRoot, '.env'));
    writeFileSync(join(projectRoot, '.env.example'), 'EXAMPLE_KEY=\n');
    await expect(checkCheckpointFiles(projectRoot)).resolves.toBeUndefined();
    writeFileSync(
      join(projectRoot, 'accidental.txt'),
      ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    );
    await expect(checkCheckpointFiles(projectRoot)).rejects.toThrow('secret value');
  });
  it('delegates exactly once, creates an isolated worktree, and leaves owner changes untouched', async () => {
    const t = await task();
    writeFileSync(join(projectRoot, 'README.md'), 'Unrelated owner edit\n');
    const key = randomUUID();
    const input = {
      taskId: t.id,
      role: 'implementer',
      name: 'Builder',
      instruction: 'Implement this one task',
    };
    const first = (await managerTool(runtime, manager, key, 'dock_delegate', input)) as {
      id: string;
    };
    const second = (await managerTool(runtime, manager, key, 'dock_delegate', input)) as {
      id: string;
    };
    expect(first.id).toBe(second.id);
    expect(store.agents()).toHaveLength(2);
    expect(store.runs().filter((r) => r.agentId === first.id)).toHaveLength(1);
    const worker = store.agent(first.id);
    expect(worker.cwd).not.toBe(projectRoot);
    expect(readFileSync(join(worker.cwd, 'README.md'), 'utf8')).toBe('# Fixture\n');
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toBe('Unrelated owner edit\n');
    await expect(
      managerTool(runtime, worker.id, randomUUID(), 'dock_task_create', {
        title: 'Escape',
        goal: 'Escape',
        acceptance: 'Escape',
      }),
    ).rejects.toThrow('role');
  });
  it('requires a disposition after review rejection and caps the same task at two revisions', async () => {
    const t = await task();
    store.updateTask(t.id, { status: 'needs_decision', review: 'changes_requested' });
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
        taskId: t.id,
        role: 'planner',
        name: 'Planner',
        instruction: 'Revise again',
      }),
    ).rejects.toThrow('decision');
    for (let i = 0; i < 2; i++)
      await managerTool(runtime, manager, randomUUID(), 'dock_decide', {
        taskId: t.id,
        kind: 'revise',
        rationale: 'This concrete finding has a bounded causal correction.',
        evidence: 'The remaining assertion has been identified.',
      });
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_decide', {
        taskId: t.id,
        kind: 'revise',
        rationale: 'Try another full planning revision without any new scope.',
        evidence: 'No new evidence',
      }),
    ).rejects.toThrow('Two revisions');
    await managerTool(runtime, manager, randomUUID(), 'dock_decide', {
      taskId: t.id,
      kind: 'split',
      rationale: 'A new failure domain needs a separately bounded task.',
      evidence: 'Persistence and layout fail independently.',
    });
    expect(store.task(t.id).status).toBe('split');
    expect(store.decisions()).toHaveLength(3);
  });
  it('completes a requested read-only review without creating a code branch', async () => {
    const t = await task();
    const reviewer = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
      taskId: t.id,
      role: 'reviewer',
      name: 'Read-only reviewer',
      instruction: 'Inspect the existing fixture without changing any files.',
    })) as { id: string };
    await managerTool(runtime, reviewer.id, randomUUID(), 'dock_review', {
      verdict: 'approve',
      findings: '',
      evidence: 'The existing fixture was inspected; no file changes were required.',
    });
    // Stand in for the provider's completed read-only turn; no model is needed here.
    for (const run of store.runs().filter((run) => run.agentId === reviewer.id))
      store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(reviewer.id, { status: 'idle' });
    await managerTool(runtime, manager, randomUUID(), 'dock_decide', {
      taskId: t.id,
      kind: 'complete',
      rationale: 'The independent read-only review has provided the requested result.',
      evidence: 'Review findings are retained, with no implementation changes.',
    });
    const completed = store.task(t.id);
    expect(completed.worktree).toBeNull();
    expect(completed.baseCommit).toBeNull();
    expect(completed.reviewedCommit).toBeNull();
    expect(publicTask(completed)).toMatchObject({ status: 'done', hasReviewedChanges: false });
    expect(
      await managerTool(runtime, manager, randomUUID(), 'dock_inspect', { taskId: t.id }),
    ).toMatchObject({
      task: { hasReviewedChanges: false },
    });
  });
  it('finishes research with retained evidence, no branch and no automatic review after its worker finishes', async () => {
    const t = await task();
    const worker = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
      taskId: t.id,
      role: 'researcher',
      name: 'Research',
      instruction: 'Read the fixture and explain its purpose.',
    })) as { id: string };
    expect(store.agent(worker.id)).toMatchObject({
      cwd: projectRoot,
      permission: 'read-only',
      taskId: t.id,
    });
    expect(store.task(t.id).worktree).toBeNull();
    const input = {
      taskId: t.id,
      kind: 'complete',
      rationale: 'The requested evidence answers this bounded research question.',
      evidence: 'The fixture README and saved researcher reply.',
    };
    await expect(managerTool(runtime, manager, randomUUID(), 'dock_decide', input)).rejects.toThrow(
      'active or paused work',
    );
    for (const run of store.runs().filter((run) => run.agentId === worker.id))
      store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(worker.id, { status: 'idle' });
    const key = randomUUID();
    const first = await managerTool(runtime, manager, key, 'dock_decide', input);
    expect(await managerTool(runtime, manager, key, 'dock_decide', input)).toEqual(first);
    const reopened = new Store(join(root, 'dock.sqlite'));
    try {
      expect(reopened.task(t.id)).toMatchObject({ status: 'done', worktree: null, review: null });
      expect(reopened.decisions().filter((d) => d.taskId === t.id)).toHaveLength(1);
      expect(reopened.decisions().find((d) => d.taskId === t.id)?.evidence).toBe(input.evidence);
    } finally {
      reopened.close();
    }
    expect(await git(projectRoot, ['worktree', 'list', '--porcelain'])).not.toContain(
      'branch refs/heads/dock/',
    );
  });
  it('keeps a generic task open while its local computation is queued or paused', async () => {
    const t = await task();
    const local = runtime.localJobs.create(
      {
        key: randomUUID(),
        projectId: project,
        taskId: t.id,
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
      },
      store.agent(manager),
    );
    const input = {
      taskId: t.id,
      kind: 'complete',
      rationale: 'Do not close the task while its associated transcription still needs capacity.',
      evidence: 'The local job remains part of the same task.',
    };
    await expect(managerTool(runtime, manager, randomUUID(), 'dock_decide', input)).rejects.toThrow(
      'active or paused work',
    );
    await runtime.localJobs.control({ key: randomUUID(), jobId: local.id, action: 'pause' });
    await expect(managerTool(runtime, manager, randomUUID(), 'dock_decide', input)).rejects.toThrow(
      'active or paused work',
    );
    await runtime.localJobs.control({ key: randomUUID(), jobId: local.id, action: 'cancel' });
    await managerTool(runtime, manager, randomUUID(), 'dock_decide', {
      ...input,
      rationale: 'The cancelled computation is no longer needed for this task.',
      evidence: 'The cancellation and retained local job are recorded.',
    });
    expect(store.task(t.id)).toMatchObject({ status: 'done', worktree: null });
  });
  it('creates an isolated branch when research is followed by implementation and retains review requirements', async () => {
    const t = await task();
    const researcher = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
      taskId: t.id,
      role: 'researcher',
      name: 'Research',
      instruction: 'Inspect the original fixture.',
    })) as { id: string };
    for (const run of store.runs().filter((run) => run.agentId === researcher.id))
      store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(researcher.id, { status: 'idle' });
    const builder = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
      taskId: t.id,
      role: 'implementer',
      name: 'Builder',
      instruction: 'Implement the identified change.',
    })) as { id: string };
    expect(store.task(t.id).worktree).toBe(store.agent(builder.id).cwd);
    expect(store.agent(builder.id).cwd).not.toBe(projectRoot);
    for (const run of store.runs().filter((run) => run.agentId === builder.id))
      store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(builder.id, { status: 'idle' });
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_decide', {
        taskId: t.id,
        kind: 'complete',
        rationale: 'The implementation has finished but has not been reviewed.',
        evidence: 'Only the builder report is available.',
      }),
    ).rejects.toThrow('independent review');
  });
  it('cannot finish unreviewed work or let an implementer approve itself', async () => {
    const t = await task();
    const worker = store.addAgent({
      projectId: project,
      parentId: manager,
      taskId: t.id,
      role: 'implementer',
      name: 'Builder',
      cwd: projectRoot,
    });
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_decide', {
        taskId: t.id,
        kind: 'complete',
        rationale: 'The implementation appears complete based on its own report.',
        evidence: 'No independent review yet.',
      }),
    ).rejects.toThrow('independent review');
    await expect(
      managerTool(runtime, worker.id, randomUUID(), 'dock_review', {
        verdict: 'approve',
        findings: '',
        evidence: 'My own report.',
      }),
    ).rejects.toThrow('role');
  });
  it('records sibling messages with attribution and prevents cross-project communication', async () => {
    const a = store.addAgent({
      projectId: project,
      parentId: manager,
      taskId: null,
      role: 'researcher',
      name: 'Research',
      cwd: projectRoot,
    });
    await managerTool(runtime, manager, 'message-test', 'dock_message', {
      agentId: a.id,
      message: 'Please inspect this evidence.',
    });
    expect(store.entries(a.id)[0].title).toBe('Fixture manager');
    expect(store.runs().find((r) => r.agentId === a.id)?.sourceId).toBe(manager);
    const other = store.register(join(root, 'other'), 'Other', '');
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_message', {
        agentId: other.managerId,
        message: 'Cross-project message',
      }),
    ).rejects.toThrow('this project');
    await expect(
      managerTool(runtime, manager, randomUUID(), 'dock_inspect', { agentId: other.managerId }),
    ).rejects.toThrow('outside this project');
  });
  it('completes a queued conversation independently of a browser and resumes the same provider thread', async () => {
    const provider = await runtime.client(store.agent(manager));
    const request = provider.request.bind(provider);
    let submitted: Record<string, unknown> | undefined;
    let resumed: Record<string, unknown> | undefined;
    provider.request = async (method, params) => {
      if (method === 'turn/start') submitted = params as Record<string, unknown>;
      if (method === 'thread/resume') resumed = params as Record<string, unknown>;
      return request(method, params);
    };
    await runtime.initialize();
    const run = store.transaction(() => store.enqueue(manager, randomUUID(), 'Hello'));
    runtime.kick();
    await expect.poll(() => store.run(run.id).status).toBe('completed');
    expect(submitted?.input).toEqual([{ type: 'text', text: 'Hello', text_elements: [] }]);
    expect(submitted?.additionalContext).toMatchObject({ agent_dock_state: { kind: 'untrusted' } });
    const thread = store.agent(manager).threadId;
    expect(thread).toBeTruthy();
    expect(
      store.entries(manager).some((e) => e.kind === 'assistant' && e.text.includes('demo mode')),
    ).toBe(true);
    const again = store.transaction(() => store.enqueue(manager, randomUUID(), 'Continue'));
    runtime.kick();
    await expect.poll(() => store.run(again.id).status).toBe('completed');
    expect(store.agent(manager).threadId).toBe(thread);
    expect(resumed).toMatchObject({ threadId: thread, excludeTurns: true });
  });
  it('hydrates visible history without capturing hidden reasoning or changing attribution', async () => {
    await runtime.hydrate(manager, [
      {
        id: 'turn-1',
        items: [
          {
            id: 'input-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'Historical question' }],
          },
          { id: 'output-1', type: 'agentMessage', text: 'Historical answer' },
          { id: 'private-1', type: 'reasoning', content: ['not for the archive'] },
        ],
      },
    ]);
    expect(store.entries(manager).map((e) => e.text)).toEqual([
      'Historical question',
      'Historical answer',
    ]);
    expect(store.entries(manager).every((e) => e.runId === null)).toBe(true);
  });
  it('binds approvals to the original request and never sends a duplicate approval', async () => {
    const provider = new DemoProvider();
    const responses: unknown[] = [];
    provider.respond = (...args: unknown[]) => {
      responses.push(args);
    };
    runtime.clients.set(manager, provider);
    const approval = store.addApproval(manager, {
      requestId: 77,
      kind: 'command',
      title: 'Exact action',
      details: '{}',
      questions: [],
      params: {},
    });
    await runtime.approve(approval.id, 'accept');
    await runtime.approve(approval.id, 'accept');
    expect(responses).toEqual([[77, { decision: 'accept' }]]);
    await expect(runtime.approve(approval.id, 'decline')).rejects.toThrow('no longer pending');
  });
  it('retains and answers exact MCP tool approvals once, declining other elicitation shapes and scopes', async () => {
    const worker = store.addAgent({
      projectId: project,
      parentId: manager,
      taskId: null,
      name: 'MCP worker',
      role: 'researcher',
      cwd: projectRoot,
    });
    store.updateAgent(worker.id, { toolPolicy: 'restricted', mcpServers: ['demo_docs'] });
    const { client, threadId } = await runtime.attach(worker.id);
    const respond = vi.spyOn(client, 'respond');
    const params = {
      threadId,
      turnId: 'mcp-turn',
      serverName: 'demo_docs',
      mode: 'form',
      message: 'Allow fixture ping?',
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} },
      requestedSchema: { type: 'object', properties: {} },
    };
    client.emit('request', 80, 'mcpServer/elicitation/request', params);
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    const approval = store.approvals()[0];
    expect(approval).toMatchObject({
      requestId: 80,
      kind: 'mcp',
      status: 'pending',
      title: 'Allow fixture ping?',
    });
    expect(respond).not.toHaveBeenCalled();
    await runtime.approve(approval.id, 'accept');
    await runtime.approve(approval.id, 'accept');
    expect(respond).toHaveBeenCalledExactlyOnceWith(80, { action: 'accept', content: {} });
    client.emit('request', 81, 'mcpServer/elicitation/request', params);
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    await runtime.approve(store.approvals()[1].id, 'decline');
    expect(respond).toHaveBeenLastCalledWith(81, { action: 'decline', content: null });
    client.emit('request', 82, 'mcpServer/elicitation/request', {
      ...params,
      serverName: 'not-selected',
    });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    expect(respond).toHaveBeenLastCalledWith(82, { action: 'decline', content: null });
    client.emit('request', 83, 'mcpServer/elicitation/request', {
      ...params,
      requestedSchema: { type: 'object', properties: { password: { type: 'string' } } },
    });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({ action: 'decline', content: null });
    expect(store.approvals()).toHaveLength(2);
    client.emit('request', 84, 'mcpServer/elicitation/request', params);
    client.emit('notification', 'serverRequest/resolved', { threadId, requestId: 84 });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    await expect(runtime.approve(store.approvals()[2].id, 'accept')).rejects.toThrow(
      'no longer pending',
    );
  });
  it('enables plugins only for opted-in workers and gates native turns on refreshed original-request policy', async () => {
    const worker = store.addAgent({
      projectId: project,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'Plugin reader',
      cwd: projectRoot,
    });
    store.updateAgent(worker.id, { toolPolicy: 'restricted', pluginsEnabled: true });
    const client = await runtime.client(store.agent(worker.id));
    const request = client.request.bind(client);
    const calls = vi.spyOn(client, 'request').mockImplementation(async (method, params) =>
      method === 'mcpServerStatus/list'
        ? {
            data: [
              { name: 'plugin_docs', pluginId: 'fixture@local', tools: { read: { name: 'read' } } },
              { name: 'codex_apps', pluginId: null, tools: {} },
            ],
            nextCursor: null,
          }
        : request(method, params),
    );
    const { threadId } = await runtime.attach(worker.id);
    expect(calls).not.toHaveBeenCalledWith('experimentalFeature/enablement/set', expect.anything());
    expect(calls).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            'fixture@local': expect.objectContaining({ mcp_servers: expect.any(Object) }),
          }),
        }),
      }),
    );
    const starts = calls.mock.calls.filter(([method]) => method === 'thread/start');
    expect(starts).toHaveLength(2);
    expect(starts[0][1]).toMatchObject({ ephemeral: true, dynamicTools: [] });
    expect(calls).toHaveBeenCalledWith('thread/unsubscribe', expect.any(Object));
    runtime.externalControl.add(worker.id);
    const transition = runtime.prepareNativeContext(worker.id, 'turn/start', {
      threadId,
      input: [],
    })!;
    calls.mockClear();
    await transition.before!();
    expect(calls).toHaveBeenCalledWith(
      'mcpServerStatus/list',
      expect.objectContaining({ threadId }),
    );
    const respond = vi.spyOn(client, 'respond');
    client.emit('request', 701, 'mcpServer/elicitation/request', {
      threadId,
      turnId: 'plugin-turn',
      serverName: 'plugin_docs',
      mode: 'form',
      message: 'Allow plugin read?',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: { type: 'object', properties: {} },
    });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    expect(respond).not.toHaveBeenCalled();
    await runtime.approve(store.approvals()[0].id, 'accept');
    expect(respond).toHaveBeenCalledExactlyOnceWith(701, { action: 'accept', content: {} });
    client.emit('request', 702, 'mcpServer/elicitation/request', {
      threadId,
      turnId: 'plugin-turn',
      serverName: 'codex_apps',
      mode: 'form',
      message: 'Allow app read?',
      _meta: { codex_approval_kind: 'mcp_tool_call' },
      requestedSchema: { type: 'object', properties: {} },
    });
    await runtime.withLock(`provider:${worker.id}`, async () => {});
    expect(store.approvals()[1]).toMatchObject({ requestId: 702, status: 'pending' });
    await runtime.approve(store.approvals()[1].id, 'decline');
    expect(respond).toHaveBeenLastCalledWith(702, { action: 'decline', content: null });
    calls.mockRejectedValueOnce(new Error('private fixture diagnostic'));
    await expect(transition.before!()).rejects.toThrow(
      'Could not establish plugin approval policy',
    );
    expect(() =>
      runtime.prepareNativeContext(worker.id, 'config/batchWrite', { edits: [] }),
    ).toThrow('Stop the active turn');
    transition.cancel(); // No native input was forwarded in this policy probe.
    const mutation = runtime.prepareNativeContext(worker.id, 'config/batchWrite', { edits: [] })!;
    await mutation.finish({});
    const nextTurn = runtime.prepareNativeContext(worker.id, 'turn/start', {
      threadId,
      input: [],
    })!;
    await nextTurn.before!();
    calls.mockResolvedValueOnce({ config: { plugins: { 'fixture@local': { enabled: false } } } });
    await mutation.finish({});
    await expect(nextTurn.before!()).rejects.toThrow('Plugin configuration changed');
    nextTurn.cancel();
    const beforeReconnect = store.entries(worker.id);
    const closed = vi.spyOn(client, 'close');
    await runtime.attach(worker.id);
    expect(closed).toHaveBeenCalledOnce();
    expect(store.agent(worker.id).threadId).toBe(threadId);
    expect(store.entries(worker.id)).toEqual(beforeReconnect);
    expect(runtime.externalControl.has(worker.id)).toBe(true);
    await runtime.attach(manager);
    expect(store.agent(manager).pluginsEnabled).toBe(false);
  });
  it('integrates only the exact clean reviewed commit and rejects a stale preview', async () => {
    const t = await task();
    const worker = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
      taskId: t.id,
      role: 'implementer',
      name: 'Builder',
      instruction: 'Create the one result',
    })) as { id: string };
    const cwd = store.agent(worker.id).cwd;
    writeFileSync(join(cwd, 'result.txt'), 'A result\n');
    const commit = await checkpointWorktree(store, t.id);
    const base = store.task(t.id).baseCommit!;
    store.updateTask(t.id, { status: 'done', reviewedCommit: commit, review: 'approve' });
    expect(publicTask(store.task(t.id)).hasReviewedChanges).toBe(true);
    await expect(integrate(store, t.id, { source: base, target: base })).rejects.toThrow('stale');
    await integrate(store, t.id, { source: commit, target: base });
    expect(readFileSync(join(projectRoot, 'result.txt'), 'utf8')).toBe('A result\n');
    expect(store.task(t.id).status).toBe('integrated');
  });
});

it('continues an older streamed reply by exact entry identity after more than one page of interleaved tool activity', async () => {
  const { client, threadId } = await runtime.attach(manager);
  const itemId = randomUUID(),
    entryId = `${manager}:${itemId}`,
    turnId = randomUUID();
  client.emit('notification', 'item/agentMessage/delta', {
    threadId,
    itemId,
    turnId,
    delta: 'First part. ',
  });
  expect(store.savedEntry(manager, entryId)?.text).toBe('First part. ');
  for (let n = 0; n < 210; n++)
    store.entry({
      id: `${manager}:tool-${n}`,
      agentId: manager,
      runId: null,
      kind: 'tool',
      title: 'Tool',
      text: 'Recorded evidence',
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
  client.emit('notification', 'item/agentMessage/delta', {
    threadId,
    itemId,
    turnId,
    delta: 'Second part.',
  });
  expect(store.savedEntry(manager, entryId)?.text).toBe('First part. Second part.');
  expect(
    store
      .events()
      .filter((event) => event.type === 'entry.updated')
      .every((event) => !('text' in (event.data as object))),
  ).toBe(true);
});
it('persists manager next steps through opaque native tool receipts and prevents edits across manager scopes', async () => {
  const value = {
    title: 'Choose the export format',
    kind: 'human',
    detail: 'Which format should the report use?',
  };
  const item = (await managerTool(
    runtime,
    manager,
    'tool:native:opaque',
    'dock_work_item',
    value,
  )) as { id: string; revision: number };
  expect(
    await managerTool(runtime, manager, 'tool:native:opaque', 'dock_work_item', value),
  ).toEqual(item);
  expect(runtime.context(store.agent(manager))).toContain('Choose the export format');
  const other = store.addManager(project, 'Other', 'Other work');
  await expect(
    managerTool(runtime, other.id, 'tool:native:other', 'dock_work_item', {
      id: item.id,
      expectedRevision: item.revision,
      title: 'Hijack',
    }),
  ).rejects.toThrow();
  expect(runtime.workItems.list({ projectId: project }).items).toHaveLength(1);
});
it('lets the manager apply exact reviewed work by default and enforces the human-review project option', async () => {
  const t = await task();
  const worker = (await managerTool(runtime, manager, randomUUID(), 'dock_delegate', {
    taskId: t.id,
    role: 'implementer',
    name: 'Builder',
    instruction: 'Create one result',
  })) as { id: string };
  const cwd = store.agent(worker.id).cwd;
  writeFileSync(join(cwd, 'result.txt'), 'Reviewed result\n');
  const source = await checkpointWorktree(store, t.id),
    target = store.task(t.id).baseCommit!;
  for (const run of store.runs().filter((run) => run.agentId === worker.id))
    store.updateRun(run.id, { status: 'completed' });
  store.updateAgent(worker.id, { status: 'idle' });
  store.updateTask(t.id, { status: 'done', reviewedCommit: source, review: 'approve' });
  store.setSetting(`project-workflow:${project}`, { applyChanges: 'human' });
  await expect(
    managerTool(runtime, manager, 'apply-human', 'dock_apply', {
      taskId: t.id,
      action: 'apply',
      source,
      target,
    }),
  ).rejects.toThrow('human review');
  store.setSetting(`project-workflow:${project}`, { applyChanges: 'manager' });
  const result = await managerTool(runtime, manager, 'apply-manager', 'dock_apply', {
    taskId: t.id,
    action: 'apply',
    source,
    target,
  });
  expect(
    await managerTool(runtime, manager, 'apply-manager', 'dock_apply', {
      taskId: t.id,
      action: 'apply',
      source,
      target,
    }),
  ).toEqual(result);
  expect(store.task(t.id).status).toBe('integrated');
  expect(readFileSync(join(projectRoot, 'result.txt'), 'utf8')).toBe('Reviewed result\n');
});

it.each([true, false])('restores an archived session only when app-owned: %s', async (owned) => {
  const threadId = randomUUID();
  store.updateAgent(manager, { threadId, toolPolicy: 'native' });
  if (owned) store.setSetting(`codex:owned:${threadId}`, manager);
  const client = await runtime.client(store.agent(manager));
  const original = client.request.bind(client);
  let archived = true;
  const request = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'thread/resume' && archived)
      throw new Error(`session ${threadId} is archived. Run codex unarchive first.`);
    if (method === 'thread/unarchive') {
      archived = false;
      return {};
    }
    return original(method, params);
  });
  if (owned) {
    await expect(runtime.attach(manager)).resolves.toHaveProperty('threadId', threadId);
    expect(request).toHaveBeenCalledWith('thread/unarchive', { threadId });
  } else {
    await expect(runtime.attach(manager)).rejects.toThrow('Could not resume');
    expect(request).not.toHaveBeenCalledWith('thread/unarchive', expect.anything());
  }
  expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
});
