import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { parseCapacity } from './capacity.js';
import { agentClientCommand, prepareAgentClient, readAgentClient } from './agent-client.js';
import { proxyPath } from './hosts.js';

let root: string, store: Store, runtime: Runtime;
let app: Awaited<ReturnType<typeof createServer>>;
let config: ReturnType<typeof prepareAgentClient>;
let provider: ReturnType<typeof vi.fn>;
const port = 4398;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'swa-agent-client-'));
  store = new Store(join(root, 'dock.sqlite'));
  provider = vi.fn(async (agent) => new DemoProvider(agent.cwd));
  runtime = new Runtime(store, root, 'missing-cli', provider);
  config = prepareAgentClient(root, port);
  app = await createServer(store, runtime, { port, demo: true, agentClient: config });
  // Keep admission stopped; exercise HTTP + actual durable queue/QUARK decisions.
  vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  capacity();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await app.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function capacity() {
  for (const p of ['codex', 'claude'] as const)
    store.setSetting(
      `capacity:v1:${p}`,
      parseCapacity(
        p,
        [
          {
            provider: p,
            source: 'oauth',
            usage: {
              updatedAt: new Date().toISOString(),
              secondary: {
                usedPercent: 6,
                windowMinutes: 10080,
                resetsAt: new Date(Date.now() + 86400_000).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
}
function request() {
  const project = store.register(join(root, randomUUID()), 'Research project', '');
  return {
    key: randomUUID(),
    projectId: project.id,
    task: {
      title: 'Check a result',
      goal: 'Verify the result and explain discrepancies',
      acceptance: 'An independent review with reproducible evidence',
    },
    allowances: [{ provider: 'codex', windowId: 'secondary', limitPercent: 10 }],
  };
}
function send(value: unknown, authorization = `Bearer ${config.secret}`) {
  return app.inject({
    method: 'POST',
    url: '/api/agent-client/tasks',
    headers: { host: `127.0.0.1:${port}`, origin: config.origin, authorization },
    payload: value,
  });
}
function read(path: string, authorization?: string) {
  return app.inject({
    url: `/api/agent-client/${path}`,
    headers: { host: `127.0.0.1:${port}`, ...(authorization ? { authorization } : {}) },
  });
}

it('protects every client operation, rejects foreign origins, and exposes no provider credential', async () => {
  const input = request();
  for (const path of ['projects', 'usage', 'resources', 'jobs']) {
    expect((await read(path)).statusCode).toBe(401);
    expect((await read(path, 'Bearer ' + '0'.repeat(64))).statusCode).toBe(401);
    const result = await read(path, `Bearer ${config.secret}`);
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain(config.secret);
  }
  expect((await send(input, '')).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agent-client/tasks',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: 'http://elsewhere',
          authorization: `Bearer ${config.secret}`,
        },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  expect(store.tasks()).toHaveLength(0);
  expect(provider).not.toHaveBeenCalled();
  expect(proxyPath('POST', '/agent-client/tasks')).toBeNull();
});

it('records caps and the first manager task binding atomically, retaining one exact receipt after reopening', async () => {
  const input = request();
  const response = await send(input);
  expect(response.statusCode).toBe(201);
  const result = response.json();
  expect(result.allowances).toMatchObject([
    {
      taskId: result.task.id,
      projectId: input.projectId,
      source: 'agent-client',
      limitPercent: 10,
    },
  ]);
  expect(result.task.scheduling.priority).toBe('background');
  const run = store.run(result.runId);
  expect(runtime.pulsar.taskId(run)).toBe(result.task.id);
  expect(runtime.quark.reason(run, true)).toBeNull();
  // Cap still binds with optional priority/resource pacing disabled.
  expect(runtime.pulsar.policy().enabled).toBe(false);
  expect((await send(input)).json()).toEqual(result);
  expect(
    (await send({ ...input, allowances: [{ ...input.allowances[0], limitPercent: 20 }] }))
      .statusCode,
  ).toBe(409);
  expect(store.tasks()).toHaveLength(1);
  expect(store.runs()).toHaveLength(1);
  await app.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, 'missing-cli', provider);
  vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  app = await createServer(store, runtime, {
    port,
    demo: true,
    agentClient: prepareAgentClient(root, port),
  });
  expect((await send(input)).json()).toEqual(result);
  expect(store.tasks()).toHaveLength(1);
  expect(provider).not.toHaveBeenCalled();
});

it('rolls back the task, all caps, events and enqueue if any requested window is missing or stale', async () => {
  const input = request();
  const before = store.events(0).length;
  const notices: { type: string }[] = [];
  store.on('event', (event) => notices.push(event));
  const invalid = {
    ...input,
    allowances: [
      ...input.allowances,
      { provider: 'claude', windowId: 'invented-week', limitPercent: 12 },
    ],
  };
  const result = await send(invalid);
  expect(result.statusCode).toBe(409);
  expect(result.body).toContain('No weekly allowance is invented');
  expect(store.tasks()).toHaveLength(0);
  expect(store.runs()).toHaveLength(0);
  expect(runtime.quark.budgets()).toHaveLength(0);
  expect(
    notices.filter((e) => ['quark.budget', 'task.created', 'run.queued'].includes(e.type)),
  ).toHaveLength(0);
  // sync can record fresh usage, but rolled-back task/budget events cannot escape persistence.
  expect(
    store
      .events(0)
      .slice(before)
      .filter((e) => e.type === 'quark.budget' || e.type === 'task.created'),
  ).toHaveLength(0);
  const old = store.getSetting('capacity:v1:codex') as Record<string, unknown>;
  store.setSetting('capacity:v1:codex', {
    ...old,
    observedAt: new Date(Date.now() - 3600_000).toISOString(),
  });
  expect((await send(input)).statusCode).toBe(409);
  expect(store.tasks()).toHaveLength(0);
  capacity();
  expect((await send(input)).statusCode).toBe(201);
});

it('rejects cross-project ownership, invalid caps, private assistants and budget-update instructions', async () => {
  const input = request(),
    other = request();
  const parent = store.addTask(other.projectId, { ...other.task, parentId: null });
  for (const payload of [
    { ...input, task: { ...input.task, parentId: parent.id } },
    { ...input, managerId: store.project(other.projectId).managerId },
  ])
    expect((await send(payload)).statusCode).toBe(409);
  for (const allowances of [
    [],
    [{ ...input.allowances[0], limitPercent: 0 }],
    [{ ...input.allowances[0], limitPercent: 101 }],
    [input.allowances[0], input.allowances[0]],
    [{ ...input.allowances[0], id: randomUUID() }],
  ])
    expect((await send({ ...input, allowances })).statusCode).toBe(400);
  expect((await send({ ...input, action: 'override' })).statusCode).toBe(400);
  vi.spyOn(runtime.resources, 'projectId').mockReturnValue(input.projectId);
  expect((await send(input)).statusCode).toBe(409);
  expect(
    (await read('projects', `Bearer ${config.secret}`))
      .json()
      .some((p: { id: string }) => p.id === input.projectId),
  ).toBe(false);
  expect(store.tasks()).toHaveLength(1);
  expect(store.runs()).toHaveLength(0);
});

it('retains a private host capability through restart/port change and refuses shared files or links', () => {
  expect(statSync(join(root, 'agent-client.json')).mode & 0o777).toBe(0o600);
  expect(prepareAgentClient(root, port)).toEqual(config);
  expect(prepareAgentClient(root, 4399).secret).toBe(config.secret);
  expect(readAgentClient(root).origin).toBe('http://127.0.0.1:4399');
  chmodSync(join(root, 'agent-client.json'), 0o644);
  expect(() => prepareAgentClient(root, port)).toThrow(/private/);
  chmodSync(join(root, 'agent-client.json'), 0o600);
  const copy = join(root, 'saved.json');
  writeFileSync(copy, readFileSync(join(root, 'agent-client.json')));
  unlinkSync(join(root, 'agent-client.json'));
  symlinkSync(copy, join(root, 'agent-client.json'));
  expect(() => prepareAgentClient(root, port)).toThrow();
});

it('client uses the configured loopback entry, returns remaining readings, and retries the same dispatch receipt', async () => {
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const target = new URL(url);
    expect(target.origin).toBe(config.origin);
    expect(init.redirect).toBe('error');
    const result = await app.inject({
      method: init.method as 'GET' | 'POST',
      url: target.pathname + target.search,
      headers: { ...init.headers, host: target.host },
      ...(init.body ? { payload: init.body as string } : {}),
    });
    return new Response(result.body, { status: result.statusCode });
  });
  vi.stubGlobal('fetch', transport);
  const usage = (await agentClientCommand(root, 'usage', [])) as {
    providers: { windows: { remainingPercent: number }[] }[];
  };
  expect(usage.providers[0]!.windows[0]!.remainingPercent).toBe(94);
  const input = request(),
    path = join(root, 'request.json');
  writeFileSync(path, JSON.stringify(input));
  const result = await agentClientCommand(root, 'dispatch', [path]);
  expect(await agentClientCommand(root, 'dispatch', [path])).toEqual(result);
  expect(store.tasks()).toHaveLength(1);
  expect(await agentClientCommand(root, 'jobs', [input.projectId])).toHaveProperty('accounting');
  await expect(agentClientCommand(root, 'usage', ['unexpected'])).rejects.toThrow();
  await expect(agentClientCommand(root, 'delete', [])).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network');
    }),
  );
  await expect(agentClientCommand(root, 'dispatch', [path])).rejects.toThrow('same file and UUID');
  expect(provider).not.toHaveBeenCalled();
});

it('does not expose the client capability when the entry has not enabled it', async () => {
  const disabled = await createServer(store, runtime, { port, ownsRuntime: false });
  try {
    expect(
      (
        await disabled.inject({
          url: '/api/agent-client/usage',
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${config.secret}` },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await disabled.close();
  }
});

it('new client grants constrain the first manager and descendants and cannot be increased by a manager', async () => {
  const input = request();
  const response = (
    await send({ ...input, allowances: [{ ...input.allowances[0], limitPercent: 1 }] })
  ).json();
  const run = store.run(response.runId);
  expect(runtime.quark.reason(run, true)).toMatch(/budget|allowance/i);
  const child = store.addTask(input.projectId, {
    title: 'Follow-up',
    goal: 'Check detail',
    acceptance: 'Evidence',
    parentId: response.task.id,
  });
  const worker = store.addAgent({
    projectId: input.projectId,
    parentId: run.agentId,
    taskId: child.id,
    name: 'Reviewer',
    role: 'reviewer',
    cwd: root,
    provider: 'codex',
  });
  const work = store.enqueue(worker.id, randomUUID(), 'Review', 'delegation', run.agentId);
  expect(runtime.quark.reason(store.run(work.id), true)).toMatch(/budget|allowance/i);
  const cap = response.allowances[0];
  expect(() =>
    runtime.quark.saveBudget(
      {
        key: randomUUID(),
        id: cap.id,
        expectedRevision: cap.revision,
        projectId: input.projectId,
        taskId: response.task.id,
        provider: 'codex',
        windowId: 'secondary',
        limitPercent: 20,
      },
      'manager',
    ),
  ).toThrow('Only the owner');
  expect(runtime.quark.budgets()[0]!.limitPercent).toBe(1);
  expect(provider).not.toHaveBeenCalled();
});
