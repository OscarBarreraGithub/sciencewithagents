import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourceSampleSchema } from '@dock/shared';
import { CodexRpc } from './codex.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { createServer } from './server.js';
import { ClaudeSession, claudeArguments, parseClaudeIdentity } from './claude-session.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dock-resource-runtime-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store, 'demo', 'sonnet-fixture');
  store.setSetting(
    'resources:latest',
    resourceSampleSchema.parse({
      observedAt: new Date().toISOString(),
      machine: {
        observedAt: new Date().toISOString(),
        cpuCount: 8,
        cpuUsedPercent: 10,
        memoryTotalBytes: 16e9,
        memoryAvailableBytes: 8e9,
        diskAvailableBytes: 100e9,
        loadPerCore: 0.2,
      },
      hottestCorePercent: 30,
      memoryPressure: 'normal',
      compressedBytes: null,
      swapUsedBytes: 0,
      swapOutBytesPerSecond: 0,
      diskTotalBytes: 200e9,
      groups: [],
      processCount: 100,
      unavailable: [],
    }),
  );
  cleanups.push(async () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
}

it('delivers native Codex launch and turn settings only to requested resource assistance', async () => {
  const { store, root } = fixture();
  // Exercise Runtime's real CodexRpc construction without launching an account's CLI.
  const start = vi.spyOn(CodexRpc.prototype, 'start').mockImplementation(async function () {
    this.ready = true;
  });
  const demos = new WeakMap<CodexRpc, DemoProvider>();
  const request = vi
    .spyOn(CodexRpc.prototype, 'request')
    .mockImplementation(async function (method, raw) {
      let demo = demos.get(this);
      if (!demo) demos.set(this, (demo = new DemoProvider()));
      if (method === 'turn/start') return { turn: { id: randomUUID(), status: 'running' } };
      return demo.request(method, raw);
    });
  vi.spyOn(CodexRpc.prototype, 'close').mockImplementation(async function () {
    this.ready = false;
  });
  const runtime = new Runtime(store, root, 'never-launch-real-codex');
  cleanups.push(() => runtime.close());
  const asked = (await runtime.resources.ask({ key: randomUUID(), provider: 'codex' })).checks[0]!;
  request.mockClear();
  runtime.kick();
  await vi.waitFor(() =>
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true),
  );
  const native = runtime.clients.get(asked.agentId) as CodexRpc;
  expect(start.mock.instances).toContain(native);
  expect(native.inheritNative).toBe(true);
  const thread = request.mock.calls.find(([method]) => method === 'thread/start')![1] as Record<
    string,
    unknown
  >;
  expect(thread).toMatchObject({
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    model: 'demo',
    cwd: join(root, 'managers', asked.agentId),
    config: { 'sandbox_workspace_write.network_access': true, model_reasoning_effort: 'medium' },
  });
  expect(thread.config).toEqual({
    'sandbox_workspace_write.network_access': true,
    model_reasoning_effort: 'medium',
  });
  expect(thread.developerInstructions).toContain('using your native tools');
  expect(thread.developerInstructions).toContain('does not prove a service is responsive');
  expect(thread.developerInstructions).not.toContain('You have no execution');
  expect(
    request.mock.calls.some(([method]) => ['config/read', 'mcpServerStatus/list'].includes(method)),
  ).toBe(false);
  const turn = request.mock.calls.find(([method]) => method === 'turn/start')![1] as Record<
    string,
    unknown
  >;
  expect(turn).toMatchObject({ model: 'demo', effort: 'medium' });
  expect(turn).not.toHaveProperty('sandboxPolicy');
  await runtime.interrupt(asked.agentId);
  native.emit('notification', 'turn/completed', {
    threadId: store.agent(asked.agentId).threadId,
    turn: { id: store.run(asked.runId).turnId, status: 'interrupted' },
  });
  await vi.waitFor(() => expect(store.run(asked.runId).status).toBe('interrupted'));

  runtime.resources.save({ key: randomUUID(), settings: { automatic: true } });
  const automatic = (await runtime.resources.ask({ key: randomUUID() }, 'checkpoint')).checks[0]!;
  request.mockClear();
  const attached = await runtime.attach(automatic.agentId);
  const bounded = attached.client as CodexRpc;
  expect(bounded.inheritNative).toBe(false);
  expect(bounded.manager).toBe(true);
  const snapshot = request.mock.calls.find(([method]) => method === 'thread/start')![1] as Record<
    string,
    unknown
  >;
  expect(snapshot).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' });
  expect(snapshot.developerInstructions).toContain(
    'You have no execution, filesystem, network or process-control tools',
  );
  expect(snapshot.config).toMatchObject({
    web_search: 'disabled',
    features: { multi_agent: false },
  });
  expect(snapshot.config).not.toHaveProperty('sandbox_workspace_write.network_access');
  expect((snapshot.dynamicTools as { name: string }[]).map((tool) => tool.name)).toEqual([
    'dock_inspect',
    'dock_escalate',
  ]);
});

it('uses Claude native workspace controls for requested assistance and snapshot-only launch for automatic checks', async () => {
  const { store, root } = fixture();
  const identity = parseClaudeIdentity({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'fixture@example.invalid',
    orgId: 'fixture',
  });
  class FixtureSession extends ClaudeSession {
    override close = vi.fn(async () => {});
  }
  const runtime = new Runtime(
    store,
    root,
    'never-launch-real-codex',
    async () => new DemoProvider(),
    {
      identity: async () => identity,
      inspect: async () => ({
        identity,
        models: [
          {
            value: 'sonnet-fixture',
            displayName: 'Sonnet fixture',
            description: '',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high'],
          },
        ],
      }),
      session: (options) => new FixtureSession(options),
    },
  );
  cleanups.push(() => runtime.close());
  // A Claude project manager receives the same charter, including the token report directive.
  const managed = store.register(join(root, 'claude-project'), 'Claude project', '', 'claude');
  store.updateAgent(managed.managerId, { model: 'sonnet-fixture', effort: 'low' });
  expect((await runtime.claude.prepare(store.agent(managed.managerId))).options.charter).toContain(
    'Token report: the host automatically tracks Codex and Claude separately',
  );
  const asked = (await runtime.resources.ask({ key: randomUUID(), provider: 'claude' })).checks[0]!;
  const interactive = await runtime.claude.prepare(store.agent(asked.agentId));
  expect(interactive.options).toMatchObject({
    inheritNative: true,
    unattended: true,
    role: 'implementer',
    model: 'sonnet-fixture',
    effort: 'low',
    cwd: join(root, 'managers', asked.agentId),
  });
  const args = claudeArguments(interactive.options);
  expect(args).toContain('bypassPermissions');
  for (const restricted of [
    '--restricted',
    '--tools',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ])
    expect(args).not.toContain(restricted);
  // Full native access for the requested assistant; no project folder is added.
  expect(args).not.toContain('--settings');
  store.updateRun(asked.runId, { status: 'completed' });
  store.updateAgent(asked.agentId, { status: 'idle' });
  runtime.resources.save({ key: randomUUID(), settings: { automatic: true } });
  const check = (await runtime.resources.ask({ key: randomUUID(), provider: 'claude' }, 'pressure'))
    .checks[0]!;
  const automatic = await runtime.claude.prepare(store.agent(check.agentId));
  expect(automatic.options).toMatchObject({ inheritNative: false, role: 'manager' });
  const boundedArgs = claudeArguments(automatic.options);
  expect(boundedArgs).toContain('--restricted');
  expect(boundedArgs[boundedArgs.indexOf('--tools') + 1]).toBe('');
  expect(automatic.options.tools.map((tool) => tool.name)).toEqual([
    'dock_inspect',
    'dock_escalate',
  ]);
  expect(automatic.options.charter).toContain('You have no execution');
});

it('closes a legacy requested snapshot runtime and resumes its same history with native settings', async () => {
  const { store, root } = fixture();
  const runtime = new Runtime(store, root, 'never-real', async () => new DemoProvider());
  cleanups.push(() => runtime.close());
  const first = (await runtime.resources.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(first.runId, { status: 'completed' });
  store.updateAgent(first.agentId, {
    status: 'idle',
    permission: 'read-only',
    toolPolicy: 'restricted',
    resourceAssistant: { mode: 'snapshot', reason: 'asked' },
  });
  const old = await runtime.attach(first.agentId);
  const close = vi.spyOn(old.client, 'close');
  const next = (
    await runtime.resources.ask({
      key: randomUUID(),
      agentId: first.agentId,
      question: 'Inspect the service using the available native tools.',
    })
  ).checks[0]!;
  expect(next.agentId).toBe(first.agentId);
  expect(close).toHaveBeenCalledOnce();
  expect(old.client.ready).toBe(false);
  expect(store.agent(first.agentId).threadId).toBe(old.threadId);
  const client = await runtime.client(store.agent(first.agentId));
  expect(client).not.toBe(old.client);
  const request = vi.spyOn(client, 'request');
  const resumed = await runtime.attach(first.agentId);
  expect(resumed.threadId).toBe(old.threadId);
  const params = request.mock.calls.find(([method]) => method === 'thread/resume')![1] as Record<
    string,
    unknown
  >;
  expect(params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' });
  expect(params.developerInstructions).toContain('using your native tools');
  expect(params.config).not.toHaveProperty('mcp_servers');
  expect(params.config).not.toHaveProperty('web_search');
  expect(store.runs()).toHaveLength(2);
  expect(store.entries(first.agentId).filter((entry) => entry.kind === 'user')).toHaveLength(2);
});

it('guards automatic models, permissions and direct controls while allowing interactive settings and follow-ups', async () => {
  const { store, root } = fixture();
  const runtime = new Runtime(store, root, 'never-real', async () => new DemoProvider());
  const app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  cleanups.push(async () => {
    await app.close();
    await runtime.close();
  });
  const headers = { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' };
  const asked = (await runtime.resources.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(asked.runId, { status: 'completed' });
  store.updateAgent(asked.agentId, { status: 'idle' });
  runtime.resources.save({ key: randomUUID(), settings: { automatic: true } });
  const automatic = (await runtime.resources.ask({ key: randomUUID() }, 'checkpoint')).checks[0]!;
  store.updateRun(automatic.runId, { status: 'completed' });
  store.updateAgent(automatic.agentId, { status: 'idle' });
  const settings = {
    model: 'demo',
    effort: 'medium',
    permission: 'workspace-write',
    toolPolicy: 'native',
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${asked.agentId}/settings`,
        headers,
        payload: settings,
      })
    ).statusCode,
  ).toBe(200);
  for (const payload of [settings, { ...settings, permission: 'read-only', model: null }]) {
    const result = await app.inject({
      method: 'POST',
      url: `/api/agents/${automatic.agentId}/settings`,
      headers,
      payload,
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toContain('bounded snapshot');
  }
  for (const command of ['resume', 'new', 'compact'])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/agents/${automatic.agentId}/commands`,
          headers,
          payload: { command, key: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${automatic.agentId}/messages`,
        headers,
        payload: { key: randomUUID(), text: 'Continue with native tools.' },
      })
    ).statusCode,
  ).toBe(409);
  expect(() => runtime.prepareNativeContext(automatic.agentId, 'config/batchWrite', {})).toThrow(
    'bounded snapshot',
  );
  expect(() => runtime.requireDirectControl(asked.agentId)).not.toThrow();
  const ordinary = store.addManager(
    runtime.resources.projectId()!,
    'Ordinary manager',
    '',
    'codex',
  );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${ordinary.id}/settings`,
        headers,
        payload: settings,
      })
    ).statusCode,
  ).toBe(200);
  const snapshot = (await app.inject({ url: '/api/snapshot', headers })).json();
  expect(
    snapshot.agents.find((agent: { id: string }) => agent.id === automatic.agentId),
  ).toMatchObject({
    resourceAssistant: { mode: 'snapshot', reason: 'checkpoint' },
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${asked.agentId}/messages`,
        headers,
        payload: { key: randomUUID(), text: 'Inspect the service state.' },
      })
    ).statusCode,
  ).toBe(202);
  await expect(runtime.tool(asked.agentId, randomUUID(), 'dock_task_create', {})).rejects.toThrow(
    'Project coordination',
  );
});

it.each(['asked', 'pressure'] as const)(
  'starts a %s diagnosis alongside a full work queue without interrupting the ongoing project',
  async (reason) => {
    const { store, root } = fixture();
    class BusyProvider extends DemoProvider {
      override async request(method: string, raw?: unknown): Promise<unknown> {
        if (method === 'turn/start') return { turn: { id: randomUUID(), status: 'inProgress' } };
        return super.request(method, raw);
      }
    }
    const runtime = new Runtime(store, root, 'unused', async () => new BusyProvider());
    cleanups.push(() => runtime.close());
    store.setSetting('scheduler:settings', { paused: false, maxConcurrent: 1 });
    const project = store.register(join(root, 'ongoing'), 'Ongoing project', '', 'codex');
    const work = store.enqueue(project.managerId, randomUUID(), 'Existing work');
    runtime.kick();
    await vi.waitFor(() => expect(store.run(work.id).status).toBe('running'));
    const other = store.register(join(root, 'other'), 'Other project', '', 'codex');
    const waiting = store.enqueue(other.managerId, randomUUID(), 'Wait for a normal slot');
    runtime.resources.save({ key: randomUUID(), settings: { automatic: true } });
    const check = (
      await runtime.resources.ask(
        {
          key: randomUUID(),
          provider: 'codex',
          question: 'Why is it slow?',
        },
        reason,
      )
    ).checks[0]!;
    runtime.kick();
    await vi.waitFor(() => expect(store.run(check.runId).status).toBe('running'));
    expect(store.run(work.id).status).toBe('running');
    expect(store.run(waiting.id).status).toBe('queued');
  },
);

it.each(['interactive', 'snapshot'] as const)(
  'uses a stronger selected model in the same %s resource conversation',
  async (mode) => {
    const { store, root } = fixture();
    const runtime = new Runtime(store, root, 'unused', async () => new DemoProvider());
    const app = await createServer(store, runtime, { port: 4999, ownsRuntime: false });
    cleanups.push(async () => {
      await app.close();
      await runtime.close();
    });
    vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue([
      { id: 'demo', label: 'Routine model', isDefault: true, efforts: ['medium'] },
      { id: 'sol-fixture', label: 'Stronger model', isDefault: false, efforts: ['high'] },
    ]);
    const first = (await runtime.resources.ask({ key: randomUUID(), provider: 'codex' }))
      .checks[0]!;
    store.updateRun(first.runId, { status: 'completed' });
    store.updateAgent(first.agentId, { status: 'idle' });
    const { threadId } = await runtime.attach(first.agentId);
    if (mode === 'snapshot')
      store.updateAgent(first.agentId, {
        resourceAssistant: { mode: 'snapshot', reason: 'checkpoint' },
        permission: 'read-only',
        toolPolicy: 'restricted',
      });
    const history = store.entries(first.agentId);
    const saved = await app.inject({
      method: 'POST',
      url: `/api/agents/${first.agentId}/settings`,
      headers: { host: '127.0.0.1:4999', origin: 'http://127.0.0.1:4999' },
      payload: {
        model: 'sol-fixture',
        effort: 'high',
        permission: mode === 'snapshot' ? 'read-only' : 'workspace-write',
        toolPolicy: mode === 'snapshot' ? 'restricted' : 'native',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(store.agent(first.agentId)).toMatchObject({
      threadId,
      model: 'sol-fixture',
      effort: 'high',
    });
    expect(store.entries(first.agentId)).toEqual(history);
    if (mode === 'snapshot') expect(store.agent(first.agentId).permission).toBe('read-only');
    const next = (
      await runtime.resources.ask({
        key: randomUUID(),
        agentId: first.agentId,
        question: 'Look more closely.',
      })
    ).checks[0]!;
    expect(next).toMatchObject({ agentId: first.agentId, model: 'sol-fixture' });
    expect(store.agent(first.agentId)).toMatchObject({
      threadId,
      resourceAssistant: { mode: 'interactive', reason: 'asked' },
      toolPolicy: 'native',
    });
  },
);

it('lets resource checks inspect current evidence linked to named QUARK work without enabling project or process control', async () => {
  const { store, root } = fixture();
  const runtime = new Runtime(store, root, 'unused', async () => new DemoProvider());
  cleanups.push(() => runtime.close());
  const project = store.register(
    join(root, 'simulation'),
    'Simulation',
    'Numerical parameter sweep',
    'codex',
  );
  store.updateAgent(project.managerId, { scope: 'Run a numerical parameter sweep' });
  const work = store.enqueue(project.managerId, randomUUID(), 'Run the simulation');
  const asked = (await runtime.resources.ask({ key: randomUUID() })).checks[0]!;
  const evidence = (await runtime.tool(asked.agentId, randomUUID(), 'dock_inspect', {
    resources: true,
  })) as { quark: { jobs: unknown[] } };
  expect(evidence.quark.jobs).toContainEqual(
    expect.objectContaining({
      runId: work.id,
      agentId: project.managerId,
      projectId: project.id,
      project: 'Simulation',
      scope: 'Run a numerical parameter sweep',
    }),
  );
  await expect(
    runtime.tool(asked.agentId, randomUUID(), 'dock_inspect', { agentId: project.managerId }),
  ).rejects.toThrow();
  await expect(runtime.tool(asked.agentId, randomUUID(), 'dock_task_create', {})).rejects.toThrow(
    'coordination',
  );
});
