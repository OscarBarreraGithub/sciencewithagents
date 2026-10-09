import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupAction } from '@dock/shared/dist/group-actions.js';
import { groupEventIdSchema, type GroupContext } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { GroupEventRepository } from './group-events.js';
import { createGroupHostNativeConnector } from './group-native-host-runtime.js';
import { modelFixture } from './model-policy.fixture.js';
import { createProductionGroupHost } from './group-host-bootstrap.js';
import { privateGroupFile } from './group-host-storage.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function fixture(readEvidence?: (context: GroupContext) => Promise<string>) {
  const directory = mkdtempSync(join(tmpdir(), 'groups-host-native-'));
  mkdirSync(join(directory, 'groups'), { mode: 0o700 });
  const store = new Store(join(directory, 'dock.sqlite'));
  modelFixture(store);
  const provider = vi.fn(async () => {
    throw Error('No provider/model allowed in unit checks.');
  });
  const runtime = new Runtime(store, directory, 'UNUSED', provider);
  const kick = vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  const eventsPath = join(directory, 'groups/events.sqlite');
  privateGroupFile(eventsPath);
  const events = new GroupEventRepository(eventsPath);
  const group = events.createGroup('Unit');
  const shared = events.createContext({
    groupId: group.groupId,
    memberId: group.memberId,
    installationId: group.installationId,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const privateContext = events.createContext({
    groupId: group.groupId,
    memberId: group.memberId,
    installationId: group.installationId,
    visibility: 'private',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  const enrollmentHandle = randomUUID();
  let connector = createGroupHostNativeConnector(runtime, {
    directory: join(directory, 'groups'),
    events,
  });
  const wire = () => {
    connector.evidence(
      readEvidence ??
        (async (c) =>
          JSON.stringify({
            shared: ['shared source'],
            private: c.visibility === 'private' ? ['own aside'] : [],
          })),
    );
    connector.revalidate(async () => {});
  };
  wire();
  const input = (context = shared, intent: 'ask' | 'work' = 'ask') => ({
    requestId: randomUUID(),
    key: randomUUID(),
    enrollmentHandle,
    context,
    text: 'Exact owner input',
    intent,
  });
  const scope = (context: GroupContext) =>
    ({
      handle: randomUUID(),
      enrollmentHandle,
      context,
      enrollment: { ...group, state: 'active', displayName: 'Unit' },
      revalidate: vi.fn(async () => {}),
      readShared: vi.fn(),
      original: vi.fn(),
    }) as unknown as Parameters<NonNullable<typeof connector.owner>['control']>[0];
  const control = async (
    s: ReturnType<typeof scope>,
    action: 'prepare' | 'continue' | 'reject',
    request?: ReturnType<typeof input>,
  ) =>
    connector.owner!.control(
      s,
      {
        action,
        handle: s.handle,
        key: randomUUID(),
        ...(request ? { requestId: request.requestId } : {}),
      },
      true,
      request,
    );
  cleanup.push(async () => {
    await connector.close!();
    await runtime.close();
    events.close();
    expect(provider).not.toHaveBeenCalled();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    runtime,
    kick,
    events,
    group,
    shared,
    privateContext,
    input,
    scope,
    control,
    get connector() {
      return connector;
    },
    async restart() {
      await connector.close!();
      connector = createGroupHostNativeConnector(runtime, {
        directory: join(directory, 'groups'),
        events,
      });
      wire();
    },
  };
}
it('retains an unstarted request across enable/restart and enqueues exact UUID once', async () => {
  const f = fixture(),
    input = f.input(),
    scope = f.scope(f.shared);
  expect(await f.connector.submit(input)).toMatchObject({ state: 'pending-consent' });
  expect(f.store.runs()).toHaveLength(0);
  await f.restart();
  await f.control(scope, 'prepare');
  expect(f.store.runs()).toHaveLength(0);
  await f.control(scope, 'continue', input);
  await f.control(scope, 'continue', input);
  expect(f.store.runs()).toHaveLength(1);
  const binding = f.connector.context(input.requestId)!;
  expect(f.store.run(binding.runId!).key).toBe(input.requestId);
  await expect(f.connector.submit({ ...input, text: 'changed' })).rejects.toThrow(/retry changed/);
  await f.restart();
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'queued',
  });
  expect(f.store.runs()).toHaveLength(1);
});
it('separates shared/private native agents and only supplies their exact bounded evidence', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const a = f.input(),
    b = f.input(f.privateContext);
  await f.connector.submit(a);
  await f.connector.submit(b);
  const one = f.connector.context(a.requestId)!,
    two = f.connector.context(b.requestId)!;
  expect(one.context.sessionId).not.toBe(two.context.sessionId);
  expect(one.context.nativeSessionId).not.toBe(two.context.nativeSessionId);
  expect(one.agentId).not.toBe(two.agentId);
  expect(one.projectId).not.toBe(two.projectId);
  expect(f.store.run(one.runId!).text).not.toContain('own aside');
  expect(f.store.run(two.runId!).text).toContain('own aside');
  expect(f.runtime.context(f.store.agent(one.agentId))).not.toContain('personal');
  await expect(f.connector.submit(f.input(f.privateContext, 'work'))).rejects.toThrow(/Ask only/);
});
it('retains exact completed native result/source through lost ACK and restart without resending', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!,
    run = f.store.run(bound.runId!);
  f.store.entry({
    id: randomUUID(),
    agentId: bound.agentId,
    runId: run.id,
    kind: 'assistant',
    title: 'Response',
    text: 'Exact reply',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(run.id, { status: 'completed' });
  const result = await f.connector.inspect({ requestId: input.requestId });
  expect(result).toMatchObject({
    state: 'completed',
    result: { text: 'Exact reply', context: bound.context, source: { messageId: input.requestId } },
  });
  await f.restart();
  expect(await f.connector.submit(input)).toEqual(result);
  expect(f.store.runs()).toHaveLength(1);
});
it('cancel before native start remains terminal; no implicit migration or retry of old isolated IDs', async () => {
  const f = fixture(),
    input = f.input(),
    scope = f.scope(f.shared);
  await f.connector.submit(input);
  await f.control(scope, 'reject', input);
  await f.control(scope, 'prepare');
  // Exact Continue must not revive a cancelled unstarted request.
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'blocked',
  });
  await f.control(scope, 'continue', input);
  expect(await f.connector.inspect({ requestId: randomUUID() })).toMatchObject({
    state: 'unknown',
  });
  expect(f.store.runs()).toHaveLength(0);
});
it('fresh helper is separately bound; admission rechecks authority and Ask cannot delegate app work', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input();
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!;
  const helper = f.store.addAgent({
    projectId: bound.projectId,
    parentId: null,
    taskId: null,
    name: 'Summary',
    role: 'researcher',
    cwd: bound.cwd,
    provider: bound.provider,
  });
  const run = f.store.enqueue(helper.id, randomUUID(), 'summary');
  f.connector.registerHelper(helper.id, f.shared, bound.enrollmentHandle, run.id, randomUUID());
  expect(f.store.getSetting(`group:host-native-agent:${helper.id}`)).toMatchObject({
    context: bound.context,
  });
  expect(helper.id).not.toBe(bound.agentId);
  await f.runtime.groupHostNativeAdmission!(helper.id, run.id);
  f.events.revokeMember(f.group.groupId, f.group.memberId);
  await expect(f.runtime.groupHostNativeAdmission!(helper.id, run.id)).rejects.toThrow();
  await expect(f.runtime.tool(bound.agentId, randomUUID(), 'dock_delegate', {})).rejects.toThrow(
    /Ask is read-only/,
  );
});

it('applies per-run native Ask/Work policy on one retained thread immediately before provider input', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const ask = f.input(),
    work = f.input(f.shared, 'work');
  await f.connector.submit(ask);
  await f.connector.submit(work);
  const bound = f.connector.context(ask.requestId)!,
    first = f.store.run(bound.runId!),
    second = f.store.run(f.connector.context(work.requestId)!.runId!);
  const request = vi.fn(async (_method: string, _raw?: unknown) => ({
    turn: { id: randomUUID(), status: 'inProgress' },
  }));
  vi.spyOn(f.runtime, 'attach').mockResolvedValue({
    client: { request } as never,
    threadId: 'same-thread',
  });
  vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
  vi.spyOn(f.runtime.quark, 'managerLeaseReason').mockReturnValue(null);
  const start = (run: typeof first) =>
    (f.runtime as unknown as { startRun(run: typeof first): Promise<void> }).startRun(run);
  await start(first);
  expect(request.mock.calls[0][1]).toMatchObject({
    threadId: 'same-thread',
    sandboxPolicy: { type: 'readOnly', networkAccess: true },
  });
  f.store.updateRun(first.id, { status: 'completed' });
  f.store.updateAgent(bound.agentId, { status: 'idle', turnId: null });
  await start(second);
  expect(request.mock.calls[1][1]).toMatchObject({
    threadId: 'same-thread',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  expect(f.store.agent(bound.agentId).permission).toBe('workspace-write');
});

it('normal production bootstrap selects host mode without reading legacy route or launching providers', async () => {
  const f = fixture();
  await f.connector.close!();
  f.store.setSetting('group:native-route', { legacy: 'retained' });
  const host = createProductionGroupHost(dirname(f.store.path), f.runtime);
  try {
    expect(await host.native.availability()).toMatchObject({
      executionMode: 'host',
      available: true,
      productionReady: true,
      authState: 'inherited',
    });
    expect(f.store.getSetting('group:native-route')).toEqual({ legacy: 'retained' });
    expect(f.store.runs()).toHaveLength(0);
  } finally {
    await host.close();
  }
});

it('Work delegates with exact lineage, waits for its report and retains only the final manager reply', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!,
    root = f.store.run(bound.runId!);
  f.store.updateRun(root.id, { status: 'running', turnId: root.id });
  f.store.updateAgent(bound.agentId, { status: 'running', permission: 'workspace-write' });
  vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
  vi.spyOn(f.runtime.quark, 'requireManagerLease').mockReturnValue({
    id: randomUUID(),
    runId: root.id,
  } as never);
  vi.spyOn(f.runtime.modelPolicy, 'catalog').mockResolvedValue([
    { id: 'demo', label: 'Fixture model', isDefault: true, efforts: ['medium', 'high', 'xhigh'] },
  ]);
  const task = f.store.addTask(bound.projectId, {
    title: 'Research',
    goal: 'Read supplied evidence',
    acceptance: 'Bounded answer',
    parentId: null,
  });
  const worker = (await f.runtime.tool(bound.agentId, randomUUID(), 'dock_delegate', {
    taskId: task.id,
    role: 'researcher',
    name: 'Reader',
    instruction: 'Return a bounded answer',
  })) as { id: string };
  const delegated = f.store.runs().find((run) => run.agentId === worker.id)!;
  expect(f.store.getSetting(`group:host-native-run:${delegated.id}`)).toMatchObject({
    requestId: input.requestId,
    originRunId: root.id,
    permission: 'read-only',
  });
  await f.runtime.groupHostNativeAdmission!(worker.id, delegated.id);
  f.store.entry({
    id: randomUUID(),
    agentId: bound.agentId,
    runId: root.id,
    kind: 'assistant',
    title: 'Dispatch',
    text: 'I delegated the work.',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  f.store.updateRun(root.id, { status: 'completed' });
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'running',
  });
  const nativeRequest = vi.fn(async () => ({ turn: { id: delegated.id, status: 'inProgress' } }));
  vi.spyOn(f.runtime, 'attach').mockResolvedValue({
    client: { request: nativeRequest } as never,
    threadId: 'worker-thread',
  });
  await (f.runtime as unknown as { startRun(value: typeof delegated): Promise<void> }).startRun(
    delegated,
  );
  expect(f.store.agent(worker.id).permission).toBe('read-only');
  expect(nativeRequest).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ sandboxPolicy: { type: 'readOnly', networkAccess: true } }),
  );
  f.store.entry({
    id: randomUUID(),
    agentId: worker.id,
    runId: delegated.id,
    kind: 'assistant',
    title: 'Evidence',
    text: 'Worker evidence',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  await (
    f.runtime as unknown as { finish(id: string, turn: string, status: string): Promise<void> }
  ).finish(worker.id, delegated.id, 'completed');
  const report = f.store.runs().find((run) => run.key === `report:${delegated.id}`)!;
  expect(f.store.getSetting(`group:host-native-run:${report.id}`)).toMatchObject({
    requestId: input.requestId,
    originRunId: root.id,
    parentRunId: delegated.id,
  });
  await f.runtime.groupHostNativeAdmission!(bound.agentId, report.id);
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'running',
  });
  f.store.entry({
    id: randomUUID(),
    agentId: bound.agentId,
    runId: report.id,
    kind: 'assistant',
    title: 'Final',
    text: 'Final reviewed answer.',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  f.store.updateRun(report.id, { status: 'completed' });
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'completed',
    result: { text: 'Final reviewed answer.' },
  });
  await f.restart();
  expect(await f.connector.submit(input)).toMatchObject({
    state: 'completed',
    result: { text: 'Final reviewed answer.' },
  });
  expect(f.store.runs()).toHaveLength(3);
});

it('stops the saved Work family after its first turn completes without cancelling another request', async () => {
  const f = fixture();
  const scope = f.scope(f.shared);
  await f.control(scope, 'prepare');
  const input = f.input(f.shared, 'work'),
    unrelated = f.input(f.shared, 'work');
  await f.connector.submit(input);
  await f.connector.submit(unrelated);
  const bound = f.connector.context(input.requestId)!,
    root = f.store.run(bound.runId!);
  const worker = f.store.addAgent({
    projectId: bound.projectId,
    parentId: bound.agentId,
    taskId: null,
    name: 'Worker',
    role: 'researcher',
    provider: bound.provider,
    cwd: bound.cwd,
  });
  const child = f.store.enqueue(worker.id, randomUUID(), 'Work', 'delegation', bound.agentId);
  const { inheritGroupHostWork } = await import('./group-host-work-continuation.js');
  inheritGroupHostWork(f.store, root, child);
  f.store.updateRun(root.id, { status: 'completed' });
  f.store.updateRun(child.id, { status: 'running' });
  const interrupt = vi.spyOn(f.runtime, 'interrupt').mockImplementation(async (_id, options) => {
    f.store.updateRun(options!.runId, { status: 'interrupted' });
  });
  await f.control(scope, 'reject', input);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(worker.id, {
    preserveQueued: true,
    runId: child.id,
  });
  expect(f.store.run(f.connector.context(unrelated.requestId)!.runId!).status).toBe('queued');
  expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
    state: 'blocked',
  });
  await expect(f.runtime.groupHostNativeAdmission!(worker.id, child.id)).rejects.toThrow(
    /authority changed/,
  );
  const late = f.store.enqueue(worker.id, randomUUID(), 'Late', 'message', bound.agentId);
  expect(() => inheritGroupHostWork(f.store, root, late)).toThrow(/original local Work/);
});

it('does not submit provider input after owner cancellation during the final asynchronous admission', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input();
  await f.connector.submit(input);
  const bound = f.connector.context(input.requestId)!,
    run = f.store.run(bound.runId!);
  const request = vi.fn();
  vi.spyOn(f.runtime, 'attach').mockResolvedValue({
    client: { request } as never,
    threadId: 'no-input',
  });
  vi.spyOn(f.runtime.quark, 'sync').mockImplementation(() => {});
  vi.spyOn(f.runtime.quark, 'managerLeaseReason').mockReturnValue(null);
  let count = 0;
  f.runtime.groupHostNativeAdmission = async () => {
    if (++count === 2) f.store.updateRun(run.id, { status: 'cancelled' });
  };
  await (f.runtime as unknown as { startRun(value: typeof run): Promise<void> }).startRun(run);
  expect(count).toBe(2);
  expect(request).not.toHaveBeenCalled();
});

it.each(['provision', 'evidence'] as const)(
  'retains a definitely-unsubmitted %s failure and explicitly continues the same input after restart',
  async (phase) => {
    const evidence = vi.fn(async () => 'Current scoped evidence');
    if (phase === 'evidence')
      evidence.mockRejectedValueOnce(new Error('Temporary evidence outage'));
    const f = fixture(evidence),
      input = f.input(),
      scope = f.scope(f.shared);
    await f.control(scope, 'prepare');
    const providerChoice = vi.spyOn(f.store, 'defaultProvider');
    if (phase === 'provision')
      providerChoice.mockImplementationOnce(() => {
        throw new Error('Temporary model configuration outage');
      });
    await expect(f.connector.submit(input)).rejects.toThrow(/Temporary/);
    expect(f.store.runs()).toHaveLength(0);
    await f.restart();
    expect(await f.connector.inspect({ requestId: input.requestId })).toMatchObject({
      state: 'pending-consent',
    });
    await expect(f.connector.submit({ ...input, text: 'different' })).rejects.toThrow(
      /retry changed/,
    );
    expect(await f.connector.submit(input)).toMatchObject({ state: 'pending-consent' });
    expect(f.store.runs()).toHaveLength(0); // inspect/retry never performs preflight or submits
    await expect(f.control(f.scope(f.privateContext), 'continue', input)).rejects.toThrow(
      /Exact saved owner/,
    );
    await f.control(scope, 'continue', input);
    await f.control(scope, 'continue', input);
    const bound = f.connector.context(input.requestId)!;
    expect(f.store.run(bound.runId!).key).toBe(input.requestId);
    expect(f.store.runs()).toHaveLength(1);
    expect(await f.connector.inspect({ requestId: randomUUID() })).toMatchObject({
      state: 'unknown',
    });
  },
);

it('retains an explicit capacity refusal without submitting a 65th native input or losing its receipt', async () => {
  const f = fixture(),
    scope = f.scope(f.shared);
  await f.control(scope, 'prepare');
  for (let n = 0; n < 64; n++) await f.connector.submit(f.input());
  const input = f.input();
  const refusal = await f.connector.submit(input);
  expect(refusal).toMatchObject({
    state: 'blocked',
    message: expect.stringContaining('Too many outstanding'),
  });
  await f.restart();
  expect(await f.connector.inspect({ requestId: input.requestId })).toEqual(refusal);
  await f.control(scope, 'continue', input);
  expect(f.store.runs()).toHaveLength(64);
});

it('cancellation during the pre-input hook cannot enqueue the saved request afterwards', async () => {
  const f = fixture(),
    scope = f.scope(f.shared);
  await f.control(scope, 'prepare');
  const input = f.input();
  f.connector.beforeTurn(async () => {
    await f.control(scope, 'reject', input);
  });
  expect(await f.connector.submit(input)).toMatchObject({ state: 'blocked' });
  expect(f.store.runs()).toHaveLength(0);
  await f.control(scope, 'continue', input);
  expect(f.store.runs()).toHaveLength(0);
});

it('captures exact live Work before next workspace preparation or input; restart never reopens old files', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = vi.fn(async () => held);
  const beforeTurn = vi.fn(async () => {});
  f.connector.completed(capture);
  f.connector.beforeTurn(beforeTurn);
  await f.control(f.scope(f.shared), 'prepare');
  const work = f.input(f.shared, 'work');
  await f.connector.submit(work);
  const binding = f.connector.context(work.requestId)!;
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: binding.runId!,
    kind: 'assistant',
    title: 'Response',
    text: '[Report](report.tex)',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(binding.runId!, { status: 'completed' });
  await expect.poll(() => capture.mock.calls.length).toBe(1);
  expect(capture).toHaveBeenCalledWith({
    request: work,
    result: expect.objectContaining({
      text: '[Report](report.tex)',
      context: binding.context,
      source: expect.objectContaining({ messageId: work.requestId }),
    }),
    runId: binding.runId,
    cwd: binding.cwd,
  });
  const next = f.input(f.shared, 'work');
  let submitted = false;
  const submitting = f.connector.submit(next).then(() => {
    submitted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(submitted).toBe(false);
  expect(beforeTurn).toHaveBeenCalledTimes(1);
  expect(f.connector.context(next.requestId)!.runId).toBeNull();
  release();
  await submitting;
  expect(beforeTurn).toHaveBeenCalledTimes(2);
  const nextRun = f.connector.context(next.requestId)!.runId!;
  await f.runtime.groupHostNativeAdmission!(binding.agentId, nextRun);
  await f.restart();
  const afterRestart = vi.fn(async () => {});
  f.connector.completed(afterRestart);
  expect(await f.connector.inspect({ requestId: work.requestId })).toMatchObject({
    state: 'completed',
  });
  expect(afterRestart).not.toHaveBeenCalled();
});

it('synthetic action controls cannot authorize capture or become the final report manager reply', async () => {
  const f = fixture();
  await f.control(f.scope(f.shared), 'prepare');
  const work = f.input(f.shared, 'work');
  await f.connector.submit(work);
  const binding = f.connector.context(work.requestId)!;
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: binding.runId!,
    kind: 'assistant',
    title: 'Response',
    text: '[Original](report.tex)',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(binding.runId!, { status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  // The original live boundary was missed; enabling capture later cannot repair it.
  const capture = vi.fn(async () => {});
  f.connector.completed(capture);
  const control = f.store.enqueue(binding.agentId, randomUUID(), 'Synthetic control');
  f.store.setSetting(`group:host-native-run:${control.id}`, {
    requestId: work.requestId,
    intent: 'work',
    context: binding.context,
    originRunId: binding.runId,
    parentRunId: binding.runId,
  });
  f.store.setSetting(`group:native-control:${control.id}`, { actionId: randomUUID() });
  f.store.entry({
    id: randomUUID(),
    agentId: binding.agentId,
    runId: control.id,
    kind: 'assistant',
    title: 'Response',
    text: 'Synthetic control response',
    status: 'complete',
    createdAt: new Date().toISOString(),
    phase: 'final',
  });
  f.store.updateRun(control.id, { status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(capture).not.toHaveBeenCalled();
  expect(await f.connector.inspect({ requestId: work.requestId })).toMatchObject({
    state: 'completed',
    result: { text: '[Original](report.tex)' },
  });
});

async function coordinationTask(f: ReturnType<typeof fixture>) {
  await f.control(f.scope(f.shared), 'prepare');
  const input = f.input(f.shared, 'work');
  await f.connector.submit(input);
  const binding = f.connector.context(input.requestId)!;
  f.store.setSetting('pulsar:policy', { enabled: false });
  f.store.updateRun(binding.runId!, { status: 'running' });
  f.store.updateAgent(binding.agentId, { status: 'running', permission: 'workspace-write' });
  const task = f.store.addTask(binding.projectId, {
    title: 'Native shared task',
    goal: 'One bounded file change',
    acceptance: 'Independent review',
    managerId: binding.agentId,
    parentId: null,
  });
  const goal = groupEventIdSchema.parse(randomUUID());
  f.connector.coordination.bindTask!(binding.context, task.id, goal);
  f.store.updateRun(binding.runId!, { status: 'completed' });
  f.store.updateAgent(binding.agentId, { status: 'idle' });
  const action = (id: string): GroupAction => {
    const owner = { ...binding.context, displayName: 'Unit' };
    const origin = { kind: 'instruction' as const, eventId: goal };
    const work = {
      workId: randomUUID(),
      title: task.title,
      taskId: task.id,
      managerId: binding.agentId,
      sharedGoalId: goal,
      owner,
      revision: 1,
      desired: 'start' as const,
      availability: 'available' as const,
      latest: { actionId: id, actor: owner, at: new Date().toISOString(), origin },
    };
    return {
      actionId: id,
      revision: 1,
      state: 'dispatching',
      outcome: null,
      humanConfirmation: null,
      proposal: {
        proposalId: randomUUID(),
        workId: work.workId,
        kind: 'start',
        origin,
        actor: owner,
        at: new Date().toISOString(),
        observed: work,
        overrideRequired: false,
      },
    };
  };
  return { input, binding, task, action };
}
it('host action delegates once through ordinary model policy and task worktrees, retaining exact request across restart', async () => {
  const f = fixture(),
    { input, binding, task, action } = await coordinationTask(f);
  const policy = vi.spyOn(f.runtime.modelPolicy, 'resolveWorker').mockResolvedValue({
    provider: 'codex',
    model: 'demo',
    effort: 'high',
    difficulty: 'high',
    source: 'model_policy',
    reason: 'Controlled native policy',
    policyRevision: '1',
    tier: 'grad',
    taskClass: 'reasoning',
  });
  const actionId = randomUUID(),
    assignment = {
      taskId: task.id,
      role: 'implementer' as const,
      name: 'Native task worker',
      instruction: 'One file change',
    };
  const dispatch = () =>
    f.runtime.withGroupCoordinationControl(binding.agentId, actionId, () =>
      f.connector.coordination.delegate(binding.context, actionId, assignment, action(actionId)),
    );
  const originalDelegate = f.runtime.delegateGroupHostCoordinationWorker.bind(f.runtime);
  vi.spyOn(f.runtime, 'delegateGroupHostCoordinationWorker').mockImplementationOnce(
    async (...args) => {
      await originalDelegate(...args);
      throw new Error('Lost queued action acknowledgement');
    },
  );
  await expect(dispatch()).rejects.toThrow(/Lost queued/);
  const first = f.connector.coordination.inspect(binding.context, actionId)!;
  expect(await dispatch()).toEqual(first);
  expect(policy).toHaveBeenCalledOnce();
  expect(f.store.agent(first.workerId)).toMatchObject({
    parentId: binding.agentId,
    taskId: task.id,
    provider: 'codex',
    role: 'implementer',
    cwd: f.store.task(task.id).worktree,
  });
  expect(f.store.task(task.id).worktree).toContain(task.id);
  const { groupHostWorkFamily } = await import('./group-host-work-continuation.js');
  expect(groupHostWorkFamily(f.store, f.store.run(binding.runId!)).map((run) => run.id)).toContain(
    first.runId,
  );
  expect(f.store.run(first.runId)).toMatchObject({ status: 'queued', sourceId: binding.agentId });
  expect(f.store.getSetting(`group:host-native-run:${first.runId}`)).toMatchObject({
    requestId: input.requestId,
    intent: 'work',
    context: binding.context,
    originRunId: binding.runId,
  });
  expect(f.store.getSetting(`group:native-auth-agent:${first.workerId}`)).toBeNull();
  const activity = f.store.db
    .prepare('SELECT body FROM group_native_activity')
    .all()
    .map((r) => JSON.parse(String(r.body)))
    .filter((r) => r.runId === first.runId);
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({
    requestId: input.requestId,
    rootRunId: binding.runId,
    managerId: binding.agentId,
    workerId: first.workerId,
    taskId: task.id,
    workId: expect.any(String),
    origin: { kind: 'instruction' },
    detail: { producer: 'job', jobId: first.runId, state: 'queued' },
  });
  await f.restart();
  expect(f.connector.coordination.inspect(binding.context, actionId)).toEqual(first);
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, actionId, () =>
      f.connector.coordination.delegate(
        binding.context,
        actionId,
        {
          ...assignment,
          instruction: 'Changed',
        },
        action(actionId),
      ),
    ),
  ).rejects.toThrow(/different input/);
  // Stop works while admission is held and targets only the retained run.
  f.store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await f.runtime.withGroupCoordinationStopControl(binding.agentId, () =>
    f.runtime.stopGroupCoordinationWorker(first.workerId, first.runId, 'Exact owner stop'),
  );
  expect(f.store.run(first.runId).status).toBe('cancelled');
  const later = f.store.enqueue(first.workerId, randomUUID(), 'Later explicit turn');
  await f.runtime.stopGroupCoordinationWorker(first.workerId, first.runId, 'Retry original stop');
  expect(f.store.run(later.id).status).toBe('queued');
});
it('host action never borrows Ask or a stopped original Work grant', async () => {
  const f = fixture(),
    { input, binding, task, action } = await coordinationTask(f);
  const ask = f.input(f.shared, 'ask');
  await f.connector.submit(ask);
  const askBinding = f.connector.context(ask.requestId)!;
  const askRun = f.store.run(askBinding.runId!);
  f.runtime.quark.sync();
  f.runtime.pulsar.reserve(askRun, new Set());
  f.runtime.quark.issueManagerLease(askRun);
  f.runtime.quark.begin(askRun);
  f.store.updateRun(askRun.id, { status: 'running' });
  const assignment = {
    taskId: task.id,
    role: 'researcher' as const,
    name: 'No worker',
    instruction: 'Do not execute',
  };
  const rejectedId = randomUUID();
  expect(f.connector.coordination.identity(binding.context).requestId).toBeNull();
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, randomUUID(), () =>
      f.connector.coordination.delegate(
        binding.context,
        rejectedId,
        assignment,
        action(rejectedId),
      ),
    ),
  ).rejects.toThrow(/Ask cannot authorize/);
  f.store.updateRun(askBinding.runId!, { status: 'completed' });
  f.store.updateAgent(binding.agentId, { status: 'idle' });
  const { groupHostStopKey } = await import('./group-host-work-continuation.js');
  f.store.setSetting(groupHostStopKey(input.requestId), true);
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, randomUUID(), () =>
      f.connector.coordination.delegate(
        binding.context,
        rejectedId,
        assignment,
        action(rejectedId),
      ),
    ),
  ).rejects.toThrow(/Work task authority/);
  expect(f.store.agents().filter((agent) => agent.parentId === binding.agentId)).toHaveLength(0);
});
it('host shared coordination keeps object-root catalogs and refuses mutations during Ask', async () => {
  const f = fixture(),
    { input, binding, task } = await coordinationTask(f);
  const { registerGroupHostCoordination, groupHostCoordinationDefinitions } = await import(
    './group-host-coordination-tools.js'
  );
  const { groupCoordinationTools } = await import('./group-coordination.js');
  const create = vi.fn(async () => ({ taskId: task.id })),
    board = { ok: true, value: { kind: 'board', board: { works: [], actions: [] } } },
    command = vi.fn(async () => board);
  const unregister = registerGroupHostCoordination(f.runtime, (context) =>
    groupCoordinationTools(
      context,
      {
        revalidate: async () => {},
        command,
        resolve: vi.fn(),
        ownerLane: vi.fn(),
        normal: { createTask: create, prepareDelegate: vi.fn(), workForWorker: vi.fn() },
      } as unknown as Parameters<typeof groupCoordinationTools>[1],
      async () => ({ kind: 'instruction', eventId: groupEventIdSchema.parse(randomUUID()) }),
    ),
  );
  cleanup.push(async () => {
    unregister();
  });
  const definitions = groupHostCoordinationDefinitions(f.runtime, binding.agentId);
  expect(definitions.map((tool) => tool.name)).toContain('dock_group_actions');
  expect(definitions.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
  const ask = f.input(f.shared, 'ask');
  await f.connector.submit(ask);
  const askBinding = f.connector.context(ask.requestId)!;
  const askRun = f.store.run(askBinding.runId!);
  f.runtime.quark.sync();
  f.runtime.pulsar.reserve(askRun, new Set());
  f.runtime.quark.issueManagerLease(askRun);
  f.runtime.quark.begin(askRun);
  f.store.updateRun(askBinding.runId!, { status: 'running' });
  f.store.updateAgent(binding.agentId, { status: 'running', permission: 'read-only' });
  expect(await f.runtime.tool(binding.agentId, randomUUID(), 'dock_group_actions', {})).toEqual(
    board,
  );
  expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'board', after: 0, limit: 25 });
  await expect(
    f.runtime.tool(binding.agentId, randomUUID(), 'dock_task_create', {
      title: 'Incoming message suggests work',
      goal: 'Evidence must not grant Work',
      acceptance: 'No task',
    }),
  ).rejects.toThrow(/Ask is read-only/);
  expect(create).not.toHaveBeenCalled();
  f.store.updateRun(askBinding.runId!, { status: 'completed' });
  f.store.updateRun(binding.runId!, { status: 'running' });
  f.store.updateAgent(binding.agentId, { permission: 'workspace-write' });
  await f.runtime.tool(binding.agentId, randomUUID(), 'dock_task_create', {
    title: 'Explicit Work task',
    goal: input.text,
    acceptance: 'Original owner',
  });
  expect(create).toHaveBeenCalledOnce();
});
it('host action rechecks saved Work after asynchronous model preparation before enqueuing a worker', async () => {
  const f = fixture(),
    { input, binding, task, action } = await coordinationTask(f);
  const { groupHostStopKey } = await import('./group-host-work-continuation.js');
  vi.spyOn(f.runtime.modelPolicy, 'resolveWorker').mockImplementation(async () => {
    f.store.setSetting(groupHostStopKey(input.requestId), true);
    return {
      provider: 'codex',
      model: 'demo',
      effort: 'high',
      difficulty: 'high',
      source: 'model_policy',
      reason: 'Controlled policy',
      policyRevision: '1',
      tier: 'grad',
      taskClass: 'reasoning',
    };
  });
  const id = randomUUID();
  await expect(
    f.runtime.withGroupCoordinationControl(binding.agentId, id, () =>
      f.connector.coordination.delegate(
        binding.context,
        id,
        {
          taskId: task.id,
          role: 'researcher',
          name: 'Cancelled task',
          instruction: 'No enqueue',
        },
        action(id),
      ),
    ),
  ).rejects.toThrow(/authority changed|was stopped/);
  expect(f.connector.coordination.inspect(binding.context, id)).toBeNull();
  expect(f.store.agents().filter((agent) => agent.parentId === binding.agentId)).toHaveLength(0);
});
