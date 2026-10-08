import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseCapacity } from './capacity.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { repoRoot } from './paths.js';
import { chatBypassRun } from './quark-chat.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { Store, type PrivateRun } from './store.js';

class Controlled extends DemoProvider {
  starts = 0;
  stops = 0;
  override async request(method: string, raw?: unknown): Promise<unknown> {
    if (method === 'turn/start') {
      this.starts++;
      return { turn: { id: randomUUID(), status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      this.stops++;
      const params = raw as { threadId: string; turnId: string };
      this.emit('notification', 'turn/completed', {
        threadId: params.threadId,
        turn: { id: params.turnId, status: 'interrupted' },
      });
      return {};
    }
    return super.request(method, raw);
  }
}
let root: string, store: Store, runtime: Runtime, projectId: string, manager: string;
let app: FastifyInstance | undefined, providerError: string | undefined;
let providers: Map<string, Controlled>;
let fixtureNow: number;
beforeEach(() => {
  fixtureNow = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => fixtureNow);
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/quark-chat-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Chat fixture', '', 'codex');
  projectId = project.id;
  manager = project.managerId;
  providers = new Map();
  providerError = undefined;
  runtime = new Runtime(store, root, 'never-launch-real-provider', async (agent) => {
    if (providerError) throw new Error(providerError);
    const provider = new Controlled();
    providers.set(agent.id, provider);
    return provider;
  });
  vi.spyOn(runtime.coordinator, 'tick').mockImplementation(() => {});
  vi.spyOn(runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'demo', label: 'Demo · no model calls', isDefault: true, efforts: ['medium'] },
  ]);
  vi.spyOn(runtime.capacity, 'status').mockImplementation(() => ({
    providers: [],
    refreshing: false,
    refreshSeconds: 60,
    notice: 'Fixture only.',
    machine: {
      observedAt: new Date().toISOString(),
      cpuCount: 8,
      cpuUsedPercent: 10,
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryAvailableBytes: 16 * 1024 ** 3,
      diskAvailableBytes: 100 * 1024 ** 3,
      loadPerCore: 0.2,
    },
  }));
  runtime.pulsar.savePolicy({
    key: randomUUID(),
    policy: { ...runtime.pulsar.policy(), enabled: true },
  });
  usage(95);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await runtime.close();
  vi.restoreAllMocks();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function usage(used: number) {
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
            primary: {
              usedPercent: used,
              windowMinutes: 300,
              resetsAt: new Date(Date.now() + 86400_000).toISOString(),
            },
          },
        },
      ],
      Date.now(),
    ),
  );
}
function enable(enabled = true) {
  return runtime.quark.saveChatPolicy(manager, {
    key: randomUUID(),
    enabled,
    expectedRevision: runtime.quark.chatPolicy(manager).revision,
  });
}
function owner(text = 'Answer this direct owner question') {
  const run = store.enqueue(manager, randomUUID(), text);
  runtime.quark.captureOwnerChat(store.run(run.id));
  return store.run(run.id);
}
async function start(): Promise<PrivateRun> {
  enable();
  const run = owner();
  runtime.kick();
  await vi.waitFor(() => expect(store.agent(manager).turnId).toBeTruthy());
  return store.run(run.id);
}
const taskInput = { title: 'Bounded result', goal: 'Read evidence', acceptance: 'Report evidence' };
function worker() {
  const task = store.addTask(projectId, { ...taskInput, parentId: null });
  const agent = store.addAgent({
    projectId,
    parentId: manager,
    taskId: task.id,
    role: 'researcher',
    name: 'Worker',
    provider: 'codex',
    cwd: root,
  });
  return { task, agent };
}

it('defaults off and retains policy receipts and frozen message scope through retries and reload', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  const post = (path: string, payload: unknown) =>
    app!.inject({
      method: 'POST',
      url: `/api/agents/${manager}/${path}`,
      payload,
      headers: { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' },
    });
  expect(runtime.quark.chatPolicy(manager)).toMatchObject({ enabled: false, revision: 0 });
  const firstMessage = { key: randomUUID(), text: 'Retain this ordinary message' };
  const ordinary = (await post('messages', firstMessage)).json();
  store.updateRun(ordinary.id, { status: 'completed' });
  const preference = { key: randomUUID(), enabled: true, expectedRevision: 0 };
  const saved = await post('chat-quark', preference);
  expect(saved.statusCode).toBe(200);
  expect((await post('chat-quark', preference)).json()).toEqual(saved.json());
  expect((await post('chat-quark', { ...preference, key: randomUUID() })).statusCode).toBe(409);
  expect((await post('messages', firstMessage)).json().id).toBe(ordinary.id);
  expect(chatBypassRun(store, store.run(ordinary.id))).toBe(false);
  const message = { key: randomUUID(), text: 'Retain this bypassed message' };
  const captured = (await post('messages', message)).json();
  expect(chatBypassRun(store, store.run(captured.id))).toBe(true);
  store.updateRun(captured.id, { status: 'running' });
  enable(false);
  expect((await post('messages', message)).json().id).toBe(captured.id);
  expect(chatBypassRun(store, store.run(captured.id))).toBe(true);
  expect(store.runs().filter((run) => run.agentId === manager)).toHaveLength(2);
  const reopened = new Store(join(root, 'dock.sqlite'));
  try {
    expect(reopened.getSetting(`quark:chat-policy:${manager}`)).toMatchObject({
      enabled: false,
      revision: 2,
    });
    expect(chatBypassRun(reopened, reopened.run(captured.id))).toBe(true);
  } finally {
    reopened.close();
  }
});

it('explicit owner saves update queued direct replies while receipt retries and held jobs stay unchanged', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  const run = owner();
  const held = owner('Keep this held reply');
  store.setSetting(`pulsar:held:${held.id}`, true);
  const automated = store.run(
    store.enqueue(manager, randomUUID(), 'Automated work', 'message', manager).id,
  );
  const synthetic = store.run(
    store.enqueue(manager, `task:${randomUUID()}`, 'Synthetic task turn').id,
  );
  const legacyOwner = store.run(
    store.enqueue(manager, randomUUID(), 'Queued before this preference existed').id,
  );
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
  const preference = { key: randomUUID(), enabled: true, expectedRevision: 0 };
  runtime.quark.saveChatPolicy(manager, preference);
  expect(chatBypassRun(store, run)).toBe(true);
  expect(runtime.pulsar.decision(run).eligible).toBe(true);
  expect(runtime.pulsar.decision(held).eligible).toBe(false);
  expect(chatBypassRun(store, automated)).toBe(false);
  expect(chatBypassRun(store, synthetic)).toBe(false);
  expect(chatBypassRun(store, legacyOwner)).toBe(true);
  const events = store.head;
  runtime.quark.saveChatPolicy(manager, preference);
  expect(store.head).toBe(events);
  enable(false);
  expect(chatBypassRun(store, run)).toBe(false);
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
  expect(store.getSetting(`pulsar:held:${held.id}`)).toBe(true);
  expect(runtime.pulsar.decision(held).eligible).toBe(false);
  enable();
  runtime.quark.hold(run, 'Owner manually paused this conversation', false, 'manual');
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
});

it('answers under reserve with a signed conversation lease but denies protected task and worker paths', async () => {
  const run = await start();
  expect(providers.get(manager)!.starts).toBe(1);
  expect(runtime.context(store.agent(manager))).toContain(
    'Answer the owner and retain source-linked asks',
  );
  expect(runtime.quark.managerLeaseStatus(run)).toMatchObject({
    state: 'active',
    lease: { scope: 'conversation' },
  });
  expect(runtime.quark.block(run)).toBeNull();
  expect(runtime.pulsar.decision(run).eligible).toBe(true);
  expect(runtime.pulsar.decision(run, new Set(), false, true).eligible).toBe(false);
  const { agent, task } = worker();
  const before = store.runs().length;
  for (const [name, input] of [
    ['dock_task_create', taskInput],
    [
      'dock_delegate',
      { taskId: task.id, role: 'researcher', name: 'Denied worker', instruction: 'Read' },
    ],
    ['dock_message', { agentId: agent.id, message: 'Do this work' }],
  ] as const) {
    await expect(runtime.tool(manager, randomUUID(), name, input)).rejects.toThrow(
      'does not authorize protected work',
    );
  }
  expect(store.tasks()).toHaveLength(1);
  expect(store.agents()).toHaveLength(2);
  expect(store.runs()).toHaveLength(before);
  expect(
    await runtime.tool(manager, randomUUID(), 'dock_inspect', { ownerRequests: {} }),
  ).toHaveProperty('notice');
  expect(
    await runtime.tool(manager, randomUUID(), 'dock_checkpoint', {
      summary: 'The owner question is retained; delegated work remains blocked.',
    }),
  ).toEqual({
    saved: true,
    coverage: {
      openWorkItems: 0,
      ownerRequestsAwaitingTriage: 1,
      notice: expect.stringMatching(
        /Saving a checkpoint resolves no work item or owner request.*Reconcile open items.*before claiming all requests are complete/,
      ),
    },
  });
  const backlog = await runtime.tool(manager, randomUUID(), 'dock_work_item', {
    kind: 'internal',
    title: 'Retain this new owner ask',
    sourceMessages: [{ agentId: manager, entryId: run.id }],
    sourceDisposition: 'Retained this ask; implementation waits for ordinary allowance.',
  });
  expect(backlog).toMatchObject({
    kind: 'internal',
    sourceMessages: [{ agentId: manager, entryId: run.id }],
  });
  await expect(
    runtime.tool(manager, randomUUID(), 'dock_work_item', {
      title: 'Do not impersonate owner replies',
      humanReply: 'Start work now',
    }),
  ).rejects.toThrow();
  expect(store.runs()).toHaveLength(before);
});

it('allows ordinary coordination after fresh headroom returns and never lends bypass to its worker', async () => {
  const run = await start();
  usage(10);
  const lease = runtime.quark.requireManagerLease(run);
  expect(lease.scope).toBe('orchestration');
  const { task } = worker();
  const dispatch = {
    taskId: task.id,
    role: 'researcher',
    name: 'Ordinary worker',
    instruction: 'Read evidence',
  };
  const key = randomUUID();
  const response = (await runtime.tool(manager, key, 'dock_delegate', dispatch)) as {
    agentId: string;
    runId: string;
  };
  expect(await runtime.tool(manager, key, 'dock_delegate', dispatch)).toEqual(response);
  const childRun = store
    .runs()
    .find((candidate) => candidate.agentId !== manager && candidate.kind === 'delegation')!;
  expect(chatBypassRun(store, childRun)).toBe(false);
  usage(95);
  expect(runtime.pulsar.decision(childRun).eligible).toBe(false);
  expect(runtime.quark.managerLeaseStatus(run).state).toBe('active');
  expect(() => runtime.quark.requireManagerLease(run)).toThrow('does not authorize protected work');
});

it('renews direct chat on host heartbeat and still stops it for a manual hold with queued input retained', async () => {
  const run = await start();
  const lease = runtime.quark.managerLeaseStatus(run).lease!;
  fixtureNow += 20_000;
  expect(runtime.quark.renewManagerLease(run)).toBeNull();
  expect(Date.parse(runtime.quark.managerLeaseStatus(run).lease!.expiresAt)).toBeGreaterThan(
    Date.parse(lease.expiresAt),
  );
  const queued = owner('Keep this follow-up');
  runtime.quark.hold(run, 'Owner manually stopped this reply', false, 'manual');
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('interrupted'));
  expect(store.run(queued.id).status).toBe('queued');
  expect(providers.get(manager)!.stops).toBe(1);
  expect(runtime.pulsar.decision(store.run(queued.id)).eligible).toBe(false);
});

it('does not override host pause, saved project pause or a manually held job', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  enable();
  const run = owner();
  runtime.kick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(store.run(run.id).status).toBe('queued');
  expect(providers.size).toBe(0);
  store.setSetting(`pulsar:held:${run.id}`, true);
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
  store.setSetting(`pulsar:held:${run.id}`, false);
  store.setSetting(`quark:project:${projectId}`, { paused: true });
  expect(runtime.quark.block(run)?.cause).toBe('project');
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
});

it('bypasses saved allowance caps and stale readings only for the captured owner conversation', () => {
  usage(10);
  enable();
  const run = owner();
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId,
    taskId: null,
    provider: 'codex',
    windowId: 'primary',
    period: 'hour',
    limitPercent: 0,
  });
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId,
    taskId: null,
    provider: 'codex',
    windowId: 'primary',
    period: 'window',
    limitPercent: 0.5,
  });
  runtime.quark.hold(run, 'This project reached its saved cap', false, 'budget');
  expect(runtime.quark.block(run)).toBeNull();
  expect(runtime.pulsar.decision(run).eligible).toBe(true);
  expect(runtime.pulsar.decision(run, new Set(), false, true).eligible).toBe(false);
  const { agent } = worker();
  const child = store.run(store.enqueue(agent.id, randomUUID(), 'Worker question').id);
  expect(runtime.quark.block(child, true)?.cause).toBe('hourly');
  store.setSetting('capacity:v1:codex', null);
  expect(runtime.pulsar.decision(run).eligible).toBe(true);
  expect(runtime.pulsar.decision(child).eligible).toBe(false);
});

it('limits the preference to app-managed owner turns and excludes automated or worker input', () => {
  enable();
  const ordinary = owner();
  const message = store.enqueue(manager, randomUUID(), 'Automated input', 'message', manager);
  runtime.quark.captureOwnerChat(store.run(message.id));
  expect(chatBypassRun(store, store.run(message.id))).toBe(false);
  const { agent } = worker();
  expect(() =>
    runtime.quark.saveChatPolicy(agent.id, {
      key: randomUUID(),
      enabled: true,
      expectedRevision: 0,
    }),
  ).toThrow('not workers');
  const child = store.enqueue(agent.id, randomUUID(), 'Direct worker input');
  store.setSetting(`quark:chat-bypass-run:${child.id}`, true);
  expect(chatBypassRun(store, store.run(child.id))).toBe(false);
  store.updateAgent(manager, { surface: 'terminal' });
  expect(chatBypassRun(store, ordinary)).toBe(false);
  expect(() => enable()).toThrow('not workers or native sessions');
});

it('does not turn a native provider authentication failure into a successful bypass', async () => {
  providerError = 'Provider sign-in is required';
  enable();
  const run = owner();
  runtime.kick();
  await vi.waitFor(() => expect(store.run(run.id).status).toBe('failed'));
  expect(store.entries(manager)).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining(providerError) }),
  );
  expect(providers.size).toBe(0);
});

it('rejects a modified conversation lease rather than granting protected authority', async () => {
  const run = await start();
  const saved = store.getSetting(`quark:manager-lease:${run.id}`) as {
    lease: Record<string, unknown>;
    signature: string;
  };
  store.setSetting(`quark:manager-lease:${run.id}`, {
    ...saved,
    lease: { ...saved.lease, scope: 'orchestration' },
  });
  usage(10);
  expect(() => runtime.quark.requireManagerLease(run)).toThrow('signed');
});

it('upgrades an opted-in conversation when ordinary headroom permits an observed helper family', async () => {
  const run = await start();
  const child = store.addAgent({
    projectId,
    parentId: manager,
    taskId: null,
    role: 'researcher',
    name: 'Observed native helper',
    provider: 'codex',
    cwd: root,
  });
  store.updateAgent(child.id, { nativeRootId: manager, status: 'running' });
  expect(runtime.quark.block(run)?.cause).toBe('headroom');
  usage(10);
  expect(runtime.quark.requireManagerLease(run).scope).toBe('orchestration');
  expect(runtime.quark.block(run)).toBeNull();
});

function followProject(enabled: boolean) {
  return runtime.quark.saveProjectPolicy(projectId, {
    key: randomUUID(),
    enabled,
    expectedRevision: runtime.quark.projectPolicy(projectId).revision,
  });
}

it('project switch releases managers and workers, retains accounting, and restores saved caps immediately', () => {
  usage(10);
  const run = owner();
  const { agent } = worker();
  const child = store.run(
    store.enqueue(agent.id, randomUUID(), 'Do the delegated work', 'delegation', manager).id,
  );
  runtime.quark.saveBudget({
    key: randomUUID(),
    projectId,
    taskId: null,
    provider: 'codex',
    windowId: 'primary',
    period: 'hour',
    limitPercent: 0,
  });
  const caps = runtime.quark.budgets();
  expect(runtime.quark.projectPolicy(projectId)).toMatchObject({ enabled: true, revision: 0 });
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
  expect(runtime.pulsar.decision(child).eligible).toBe(false);
  enable(); // A previous reply-only exception must not defeat an explicit project On.
  followProject(false);
  expect(runtime.pulsar.decision(run, new Set(), false, true).eligible).toBe(true);
  expect(runtime.pulsar.decision(child).eligible).toBe(true);
  expect(runtime.pulsar.reserve(run, new Set())).toBeTruthy();
  runtime.quark.issueManagerLease(run);
  store.updateRun(run.id, { status: 'running' });
  expect(runtime.quark.requireManagerLease(store.run(run.id)).scope).not.toBe('conversation');
  expect(runtime.quark.renewManagerLease(store.run(run.id))).toBeNull();
  expect(runtime.pulsar.leases().some((l) => l.runId === run.id)).toBe(true);
  const other = store.register(join(root, 'other'), 'Other project', '', 'codex');
  const unrelated = store.run(
    store.enqueue(other.managerId, randomUUID(), 'Unrelated owner request').id,
  );
  usage(95);
  expect(runtime.pulsar.decision(child).eligible).toBe(true);
  expect(runtime.pulsar.decision(unrelated).eligible).toBe(false);
  followProject(true);
  expect(runtime.quark.block(store.run(run.id))).not.toBeNull();
  expect(runtime.pulsar.decision(child).eligible).toBe(false);
  expect(runtime.quark.budgets()).toEqual(caps);
});

it('project scheduler API retains exact retries, rejects stale changes and persists across reopening', async () => {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 2 });
  app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  const url = `/api/projects/${projectId}/quark-scheduler`;
  const headers = { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' };
  const send = (payload: unknown) => app!.inject({ method: 'POST', url, headers, payload });
  const input = { key: randomUUID(), enabled: false, expectedRevision: 0 };
  const first = await send(input);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ projectId, enabled: false, revision: 1 });
  expect((await send(input)).json()).toEqual(first.json());
  expect((await send({ ...input, key: randomUUID(), enabled: true })).statusCode).toBe(409);
  const on = await send({ key: randomUUID(), enabled: true, expectedRevision: 1 });
  expect(on.statusCode).toBe(200);
  expect((await send(input)).json()).toEqual(first.json());
  expect((await app.inject({ url, headers })).json()).toMatchObject({ enabled: true, revision: 2 });
  const reopened = new Store(join(root, 'dock.sqlite'));
  try {
    expect(reopened.getSetting(`quark:project-scheduler:${projectId}`)).toMatchObject({
      enabled: true,
      revision: 2,
    });
  } finally {
    reopened.close();
  }
});

it('project opt-out respects editing holds, manual pauses, and a native rate-limit rejection', () => {
  const run = owner();
  followProject(false);
  store.setSetting(`pulsar:held:${run.id}`, true);
  expect(runtime.pulsar.decision(run).eligible).toBe(false);
  store.setSetting(`pulsar:held:${run.id}`, false);
  store.setSetting(`quark:project:${projectId}`, { paused: true });
  expect(runtime.quark.block(run)).toBeNull();
  followProject(true);
  expect(runtime.quark.block(run)?.cause).toBe('project');
  followProject(false);
  store.setSetting(`quark:project:${projectId}`, { paused: false });
  runtime.quark.hold(run, 'Explicit Stop', false, 'manual');
  expect(runtime.quark.block(run)?.cause).toBe('manual');
  const { agent: nativeAgent } = worker();
  const native = store.run(
    store.enqueue(nativeAgent.id, randomUUID(), 'Native provider rejected this turn').id,
  );
  store.updateRun(native.id, { status: 'running' });
  runtime.quark.nativeExhaustion(store.run(native.id), {
    sessionId: randomUUID(),
    rateLimitType: 'five_hour',
    resetsAtSeconds: Math.floor(Date.now() / 1000) + 3600,
  });
  expect(runtime.quark.block(store.run(native.id))?.cause).toBe('reset');
});

it('project opt-out resumes an acknowledged scheduler stop once but not manual or native holds', () => {
  const { agent } = worker();
  const run = store.run(store.enqueue(agent.id, randomUUID(), 'Work', 'delegation', manager).id);
  runtime.quark.hold(run, 'Scheduler budget pause', false, 'budget');
  store.updateRun(run.id, { status: 'interrupted' });
  store.updateAgent(agent.id, { status: 'waiting', turnId: null });
  followProject(false);
  runtime.quark.recoverTransient(new Set());
  expect(store.runs().filter((r) => r.kind === 'resume')).toHaveLength(0);
  runtime.quark.acknowledgeStop(run.id);
  runtime.quark.recoverTransient(new Set());
  runtime.quark.recoverTransient(new Set());
  expect(store.agent(agent.id).status).toBe('queued');
  expect(store.runs().filter((r) => r.kind === 'resume')).toHaveLength(1);
  expect(runtime.quark.holds()).toHaveLength(0);
});
