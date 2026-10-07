import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupEventIdSchema, type GroupContext } from '@dock/shared';
import type { GroupAction, GroupActionWork } from '@dock/shared/dist/group-actions.js';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import {
  createGroupCoordinationRuntime,
  type GroupCoordinationNativePort,
  type GroupCoordinationHostPort,
} from './group-coordination-runtime.js';
import { GroupEventRepository } from './group-events.js';
import { GroupNativeJournal } from './group-native.js';
import { groupNativeChildScope } from './group-native-coordination-scope.js';
import { GroupDockerEngine } from './group-container.js';
let root: string, store: Store, runtime: Runtime, managerId: string, context: GroupContext;
const provider = vi.fn(async () => new DemoProvider());
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = mkdtempSync('data/tests/group-coordination-');
  mkdirSync(join(root, 'workspace'));
  store = new Store(join(root, 'host.sqlite'));
  modelFixture(store);
  const project = store.register(join(root, 'workspace'), 'Controlled group', '');
  const a = store.addAgent({
    projectId: project.id,
    parentId: null,
    taskId: null,
    name: 'Actual group manager',
    role: 'manager',
    cwd: join(root, 'workspace'),
    provider: 'codex',
  });
  managerId = a.id;
  store.updateAgent(a.id, { model: 'demo', effort: 'high', toolPolicy: 'native', status: 'idle' });
  store.setSetting('pulsar:policy', { enabled: false });
  context = {
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    sessionId: randomUUID(),
    nativeSessionId: randomUUID(),
    provider: 'codex',
    visibility: 'shared',
  } as GroupContext;
  store.setSetting(`group:native-auth-agent:${a.id}`, { contextId: context.sessionId });
  runtime = new Runtime(store, root, 'UNUSED', provider, undefined, {
    workspace: join(root, 'workspace'),
  });
  provider.mockClear();
});
afterEach(async () => {
  await runtime?.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const admitted = async <T>(body: () => Promise<T>) =>
  runtime.withGroupCoordinationControl(managerId, randomUUID(), body);
function setup() {
  const owner = {
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      displayName: 'Owner',
    },
    goal = groupEventIdSchema.parse(randomUUID()),
    works = new Map<string, GroupActionWork>();
  const children = new Map<string, { workerId: string; runId: string }>();
  const native: GroupCoordinationNativePort = {
    identity: () => ({ managerId, agentId: managerId, requestId: randomUUID() }),
    inspect: (_context, id) => children.get(id) ?? null,
    delegate: vi.fn(async (_c, id, input) => {
      const active = store.runs(['running']).find((r) => r.agentId === managerId);
      expect(runtime.quark.requireManagerLease(active).managerId).toBe(managerId);
      const child = { workerId: randomUUID(), runId: randomUUID() };
      children.set(id, child);
      expect(input.taskId).toBeTruthy();
      return child;
    }),
  };
  let loseAck = false;
  const publish = vi.fn(
    async (..._args: Parameters<GroupCoordinationHostPort['publishOwnedTask']>) => ({
      eventId: groupEventIdSchema.parse(randomUUID()),
    }),
  );
  const command = vi.fn(
    async (
      command: Parameters<ReturnType<typeof createGroupCoordinationRuntime>['command']>[0],
    ) => {
      if (command.kind === 'register-work') {
        const work: GroupActionWork = {
          workId: randomUUID(),
          title: command.title,
          taskId: command.taskId,
          managerId: command.managerId,
          sharedGoalId: command.sharedGoalId,
          revision: 0,
          desired: 'stop',
          owner,
          latest: {
            actionId: null,
            actor: owner,
            at: new Date().toISOString(),
            origin: command.origin,
          },
        };
        works.set(work.workId, work);
        return { ok: true, value: { kind: 'work', work } } as const;
      }
      if (command.kind === 'work') {
        const work = works.get(command.workId);
        if (!work) return { ok: false, error: 'denied' } as const;
        return { ok: true, value: { kind: 'work', work } } as const;
      }
      if (command.kind === 'board')
        return {
          ok: true,
          value: {
            kind: 'board',
            board: {
              works: [...works.values()],
              instructions: [],
              proposals: [],
              actions: [],
              notices: [],
              after: 0,
              continuation: null,
            },
          },
        } as const;
      throw new Error('Unused command');
    },
  );
  const ports = createGroupCoordinationRuntime(runtime, native, context, {
    owner,
    revalidate: async () => {},
    command,
    publishOwnedTask: async (...args) => {
      const result = await publish(...args);
      if (loseAck) {
        loseAck = false;
        throw new Error('lost publication acknowledgement');
      }
      return result;
    },
  });
  const origin = { kind: 'autonomous', eventId: goal, sharedGoalId: goal, managerId } as const;
  return {
    ports,
    native,
    origin,
    publish,
    works,
    lose: () => {
      loseAck = true;
    },
  };
}
it('idle online owner Start obtains its own model-free signed lease and retry dispatches once', async () => {
  const f = setup(),
    task = await admitted(() =>
      f.ports.normal.createTask(
        randomUUID(),
        { title: 'One task', goal: 'One isolated result', acceptance: 'One retained result' },
        f.origin,
      ),
    );
  expect(store.agent(managerId).status).toBe('idle');
  expect(store.runs(['running'])).toHaveLength(0);
  const input = {
    taskId: task.taskId,
    role: 'implementer',
    name: 'One worker',
    instruction: 'Implement bounded result',
  } as const;
  const work = await admitted(() => f.ports.normal.prepareDelegate(randomUUID(), input, f.origin));
  const actionId = randomUUID();
  const action = {
    actionId,
    revision: 0,
    state: 'dispatching',
    outcome: null,
    proposal: {
      proposalId: randomUUID(),
      workId: work.workId,
      kind: 'start',
      origin: f.origin,
      actor: work.owner,
      at: new Date().toISOString(),
      observed: work,
      overrideRequired: false,
    },
  } satisfies GroupAction;
  const lane = await f.ports.ownerLane(work.owner);
  expect(lane).not.toBeNull();
  const outcome = await lane!.delegate(actionId, input, action);
  expect(outcome.status).toBe('started');
  expect(await lane!.delegate(actionId, input, action)).toEqual(outcome);
  expect(nativeCalls(f.native)).toBe(1);
  expect(provider).not.toHaveBeenCalled();
  expect(store.runs(['running'])).toHaveLength(0);
  await expect(
    lane!.delegate(actionId, { ...input, instruction: 'Changed' }, action),
  ).rejects.toThrow(/retry changed/);
  expect((await lane!.inspect(actionId)).state).toBe('completed');
});
const nativeCalls = (n: GroupCoordinationNativePort) => vi.mocked(n.delegate).mock.calls.length;
it('publication failure retries the same task and never uses the primary manager', async () => {
  const f = setup(),
    key = randomUUID(),
    input = { title: 'Retained task', goal: 'Retained goal', acceptance: 'Retained check' };
  f.lose();
  await expect(admitted(() => f.ports.normal.createTask(key, input, f.origin))).rejects.toThrow(
    /lost publication/,
  );
  const work = await admitted(() => f.ports.normal.createTask(key, input, f.origin));
  expect(store.tasks()).toHaveLength(1);
  expect(work.managerId).toBe(managerId);
  expect(f.publish.mock.calls[0][0]).toBe(f.publish.mock.calls[1][0]);
  expect(f.publish.mock.calls[0][1]).toMatchObject({
    managerId,
    taskId: work.taskId,
    kind: 'group-owned-task',
  });
});
it('private tools and saved scheduler pause cannot coordinate or launch fallback', async () => {
  const f = setup();
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  await expect(admitted(async () => true)).rejects.toThrow(/held/);
  expect(provider).not.toHaveBeenCalled();
  const privatePorts = createGroupCoordinationRuntime(
    runtime,
    f.native,
    { ...context, visibility: 'private' },
    {
      owner: {
        groupId: context.groupId,
        memberId: context.memberId,
        installationId: context.installationId,
        displayName: 'Owner',
      },
      command: f.ports.command,
      revalidate: async () => {},
      publishOwnedTask: async () => ({ eventId: f.origin.eventId }),
    },
  );
  await expect(
    privatePorts.normal.createTask(
      randomUUID(),
      { title: 'No', goal: 'No', acceptance: 'No' },
      f.origin,
    ),
  ).rejects.toThrow(/read-only/);
});
it('native child shares only exact shared account scope and receives a concrete task directory', () => {
  const events = new GroupEventRepository(join(root, 'events.sqlite')),
    journal = new GroupNativeJournal(join(root, 'native.sqlite'), events);
  try {
    const group = events.createGroup('Scope');
    const parent = journal.issue(
      {
        groupId: group.groupId,
        memberId: group.memberId,
        installationId: group.installationId,
        visibility: 'shared',
      },
      managerId,
      'codex',
    );
    const parentContext = journal.resolve(parent).context;
    const task = store.addTask(store.agent(managerId).projectId, {
      title: 'Scope task',
      goal: 'Scope',
      acceptance: 'Scope',
      parentId: null,
      managerId,
    });
    const worker = store.addAgent({
      projectId: task.projectId,
      parentId: managerId,
      taskId: task.id,
      role: 'implementer',
      name: 'Scoped child',
      cwd: join(root, 'workspace'),
      provider: 'codex',
    });
    const child = journal.issue(parentContext, worker.id, 'codex'),
      childContext = journal.resolve(child).context;
    const volume = `swa-group-${randomUUID()}`;
    journal.runtimeEvent(parent, 'container-reserved', {
      volume,
      name: `swa-group-${randomUUID()}`,
      manifest: '{}',
    });
    const resources = {
      workspace: null,
      stateBase: root,
      readResources: [],
      forbiddenPaths: [join(root, 'host.sqlite')],
      outbound: [],
    };
    const marker = {
      contextId: childContext.sessionId,
      sharedContextId: parentContext.sessionId,
      managerId,
      taskId: task.id,
      managerRunId: randomUUID(),
      leaseId: randomUUID(),
      volume,
      image: 'sha256:' + 'a'.repeat(64),
      resources,
    };
    store.setSetting(`group:native-child:${worker.id}`, marker);
    const plan = { ...resources, image: marker.image, expiresAt: Date.now() + 10000 };
    expect(groupNativeChildScope(store, journal, child, plan)).toMatchObject({
      volume,
      workspace: `/workspace/tasks/${task.id}`,
      context: parentContext,
    });
    expect(() =>
      groupNativeChildScope(store, journal, child, {
        ...plan,
        readResources: ['/synthetic/widened'],
      }),
    ).toThrow(/binding changed/);
    const privateParent = journal.issue(
      {
        groupId: group.groupId,
        memberId: group.memberId,
        installationId: group.installationId,
        visibility: 'private',
      },
      managerId,
      'codex',
    );
    store.setSetting(`group:native-child:${worker.id}`, {
      ...marker,
      sharedContextId: journal.resolve(privateParent).context.sessionId,
    });
    expect(() => groupNativeChildScope(store, journal, child, plan)).toThrow(/binding changed/);
  } finally {
    journal.close();
    events.close();
  }
});
it('Engine process cwd is an explicit task directory and arbitrary host paths fail closed', () => {
  const engine = new GroupDockerEngine('/var/run/docker.sock');
  const call = vi
    .spyOn(
      engine as unknown as { execHost(args: readonly string[], config: string): never },
      'execHost',
    )
    .mockReturnValue(undefined as never);
  const cwd = `/workspace/tasks/${randomUUID()}`;
  engine.exec('a'.repeat(64), ['/usr/local/bin/claude'], 'owned-public-config', true, cwd);
  expect(call.mock.calls[0][0]).toContain(cwd);
  expect(() =>
    engine.exec(
      'a'.repeat(64),
      ['/usr/local/bin/claude'],
      'owned-public-config',
      true,
      '/Users/synthetic',
    ),
  ).toThrow(/task workspace/);
});
it('actual connector delegates through permanent native queue with separate child identity and inherited account grant', async () => {
  const { createGroupNativeConnector, configureGroupNativeRoute } = await import(
    './group-native-connector.js'
  );
  const events = new GroupEventRepository(join(root, 'connector-events.sqlite')),
    directory = join(root, 'connector');
  mkdirSync(directory, { mode: 0o700 });
  const connector = createGroupNativeConnector(runtime, { directory, events }),
    journal = new GroupNativeJournal(join(directory, 'native-identities.sqlite'), events);
  try {
    const group = events.createGroup('Actual owner binding'),
      parent = journal.issue(
        {
          groupId: group.groupId,
          memberId: group.memberId,
          installationId: group.installationId,
          visibility: 'shared',
        },
        managerId,
        'codex',
      ),
      nativeContext = journal.resolve(parent).context;
    const volume = `swa-group-${randomUUID()}`;
    journal.runtimeEvent(parent, 'container-reserved', {
      volume,
      name: `swa-group-${randomUUID()}`,
      manifest: '{}',
    });
    const state = join(root, 'native-state');
    configureGroupNativeRoute(runtime, {
      projectId: store.agent(managerId).projectId,
      provider: 'codex',
      image: 'sha256:' + 'a'.repeat(64),
      resources: {
        workspace: null,
        stateBase: state,
        readResources: [],
        forbiddenPaths: [join(root, 'host.sqlite')],
        outbound: [],
      },
    });
    const route = store.getSetting('group:native-route') as { image: string; resources: unknown };
    store.setSetting(`group:native-resources:${managerId}`, {
      image: route.image,
      resources: route.resources,
    });
    store.setSetting(`group:native-auth-agent:${managerId}`, {
      contextId: nativeContext.sessionId,
    });
    const task = store.addTask(store.agent(managerId).projectId, {
      title: 'Actual task',
      goal: 'Actual isolated task',
      acceptance: 'Native queue',
      parentId: null,
      managerId,
    });
    const policy = vi.spyOn(runtime.modelPolicy, 'resolveWorker').mockResolvedValue({
      provider: 'codex',
      model: 'demo',
      effort: 'high',
      difficulty: 'high',
      source: 'model_policy',
      reason: 'Controlled policy result',
      policyRevision: '1',
      tier: 'grad',
      taskClass: 'reasoning',
    });
    const action = randomUUID(),
      input = {
        taskId: task.id,
        role: 'implementer',
        name: 'Native child',
        instruction: 'One native isolated result',
      } as const;
    const result = await admitted(() =>
      connector.coordination!.delegate(nativeContext, action, input),
    );
    expect(store.agent(result.workerId)).toMatchObject({
      parentId: managerId,
      taskId: task.id,
      role: 'implementer',
      provider: 'codex',
    });
    const marker = store.getSetting(`group:native-child:${result.workerId}`) as {
      contextId: string;
      sharedContextId: string;
      volume: string;
    };
    expect(marker).toMatchObject({ sharedContextId: nativeContext.sessionId, volume });
    expect(marker.contextId).not.toBe(nativeContext.sessionId);
    expect(store.getSetting(`group:native-auth-agent:${result.workerId}`)).toEqual({
      contextId: marker.contextId,
    });
    expect(store.run(result.runId).status).toBe('queued');
    expect(connector.coordination!.inspect(nativeContext, action)).toEqual(result);
    expect(
      await admitted(() => connector.coordination!.delegate(nativeContext, action, input)),
    ).toEqual(result);
    expect(policy).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
    await runtime.stopGroupCoordinationWorker(
      result.workerId,
      result.runId,
      'Controlled exact queued stop',
    );
    expect(store.run(result.runId).status).toBe('cancelled');
    expect(store.getSetting(`group:native-auth-agent:${managerId}`)).toEqual({
      contextId: nativeContext.sessionId,
    });
  } finally {
    await runtime.close();
    await connector.close();
    journal.close();
    events.close();
  }
});
it('authoritative no-effect failure retries the same action; delegate input reuse is immutable', async () => {
  const f = setup(),
    task = await admitted(() =>
      f.ports.normal.createTask(
        randomUUID(),
        { title: 'Retry task', goal: 'Retained result', acceptance: 'One result' },
        f.origin,
      ),
    );
  const key = randomUUID(),
    input = {
      taskId: task.taskId,
      role: 'implementer',
      name: 'Retry worker',
      instruction: 'Exact input',
    } as const;
  const work = await admitted(() => f.ports.normal.prepareDelegate(key, input, f.origin));
  await expect(
    admitted(() =>
      f.ports.normal.prepareDelegate(key, { ...input, instruction: 'Changed input' }, f.origin),
    ),
  ).rejects.toThrow(/different input/);
  const actionId = randomUUID(),
    action = {
      actionId,
      revision: 0,
      state: 'dispatching',
      outcome: null,
      proposal: {
        proposalId: randomUUID(),
        workId: work.workId,
        kind: 'start',
        origin: f.origin,
        actor: work.owner,
        at: new Date().toISOString(),
        observed: work,
        overrideRequired: false,
      },
    } satisfies GroupAction;
  const lane = (await f.ports.ownerLane(work.owner))!;
  vi.mocked(f.native.delegate).mockRejectedValueOnce(new Error('No enqueue effect'));
  await expect(lane.delegate(actionId, input, action)).rejects.toThrow(/No enqueue/);
  expect(await lane.inspect(actionId)).toEqual({ state: 'absent' });
  expect((await lane.delegate(actionId, input, action)).status).toBe('started');
  expect(nativeCalls(f.native)).toBe(2);
  expect(provider).not.toHaveBeenCalled();
});
it('lost stop acknowledgement reconciles original run and never stops a later worker turn', async () => {
  const f = setup(),
    work = await admitted(() =>
      f.ports.normal.createTask(
        randomUUID(),
        { title: 'Stop task', goal: 'Retained stop', acceptance: 'Original turn only' },
        f.origin,
      ),
    );
  const worker = store.addAgent({
    projectId: store.agent(managerId).projectId,
    parentId: managerId,
    taskId: work.taskId,
    role: 'implementer',
    name: 'Retained worker',
    cwd: join(root, 'workspace'),
    provider: 'codex',
  });
  const original = store.enqueue(worker.id, randomUUID(), 'Original worker turn');
  store.updateRun(original.id, { status: 'cancelled' });
  const next = store.enqueue(worker.id, randomUUID(), 'Later worker turn'),
    actionId = randomUUID();
  store.setSetting(`group:coordination:${context.sessionId}:action:${actionId}`, {
    kind: 'stop',
    input: 'retained exact target',
    taskId: work.taskId,
    workerId: worker.id,
    runId: original.id,
  });
  const lane = (await f.ports.ownerLane(work.owner))!,
    result = await lane.inspect(actionId);
  expect(result).toMatchObject({
    state: 'completed',
    outcome: { status: 'stopped', jobId: original.id, workerId: worker.id },
  });
  expect(store.run(next.id).status).toBe('queued');
  expect(provider).not.toHaveBeenCalled();
});
it.each(['idle', 'interrupted', 'waiting'] as const)(
  'owner Stop cancels exact native worker with paused scheduler, exhausted admission and %s manager',
  async (status) => {
    const f = setup(),
      work = await admitted(() =>
        f.ports.normal.createTask(
          randomUUID(),
          { title: 'Stop held work', goal: 'Exact cleanup', acceptance: 'No admission needed' },
          f.origin,
        ),
      );
    const worker = store.addAgent({
      projectId: store.agent(managerId).projectId,
      parentId: managerId,
      taskId: work.taskId,
      name: 'Owned native worker',
      role: 'implementer',
      provider: 'codex',
      cwd: join(root, 'workspace'),
    });
    store.setSetting(`group:native-child:${worker.id}`, { managerId, taskId: work.taskId });
    store.setSetting(`group:native-auth-agent:${worker.id}`, { contextId: randomUUID() });
    const run = store.enqueue(worker.id, randomUUID(), 'Exact queued worker'),
      pending = store.enqueue(managerId, randomUUID(), 'Pending owner input');
    store.updateAgent(managerId, { status });
    store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
    const reserve = vi.spyOn(runtime.pulsar, 'reserve').mockReturnValue(false),
      reason = vi.spyOn(runtime.quark, 'reason').mockReturnValue('Allowance budget exhausted'),
      control = vi.spyOn(runtime, 'withGroupCoordinationControl'),
      actionId = randomUUID(),
      action = {
        actionId,
        revision: work.revision,
        state: 'dispatching',
        outcome: null,
        proposal: {
          proposalId: randomUUID(),
          workId: work.workId,
          kind: 'stop',
          origin: f.origin,
          actor: work.owner,
          at: new Date().toISOString(),
          observed: work,
          overrideRequired: false,
        },
      } satisfies GroupAction;
    const lane = (await f.ports.ownerLane(work.owner))!,
      input = { agentId: worker.id, reason: 'Owner requests exact Stop' },
      outcome = await lane.pauseWorker(actionId, input, action);
    expect(outcome).toMatchObject({ status: 'stopped', workerId: worker.id, jobId: run.id });
    expect(await lane.pauseWorker(actionId, input, action)).toEqual(outcome);
    expect(store.run(run.id).status).toBe('cancelled');
    expect(store.run(pending.id).status).toBe('queued');
    expect(store.agent(managerId).status).toBe(status);
    expect(reserve).not.toHaveBeenCalled();
    expect(reason).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  },
);
it('resolves an owned work beyond the first fifty board rows using exact current authority', async () => {
  const f = setup();
  const task = store.addTask(store.agent(managerId).projectId, {
    title: 'Last owned task',
    goal: 'Resolve exact work',
    acceptance: 'Current revision',
    parentId: null,
    managerId,
  });
  const owner = {
    groupId: context.groupId,
    memberId: context.memberId,
    installationId: context.installationId,
    displayName: 'Owner',
  };
  const work: GroupActionWork = {
    workId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    title: task.title,
    taskId: task.id,
    managerId,
    sharedGoalId: f.origin.sharedGoalId,
    owner,
    revision: 7,
    desired: 'stop',
    latest: { actionId: null, actor: owner, origin: f.origin, at: new Date().toISOString() },
  };
  for (let i = 0; i < 71; i++) {
    const item = { ...work, workId: randomUUID() };
    f.works.set(item.workId, item);
  }
  f.works.set(work.workId, work);
  store.setSetting(`group:coordination:${context.sessionId}:work:${work.workId}`, {
    work: { ...work, revision: 0 },
    owner,
    start: { taskId: task.id, role: 'implementer', name: 'Worker', instruction: 'Exact task' },
    stop: { agentId: managerId, reason: 'Owner stop' },
  });
  expect((await f.ports.resolve(work.workId)).work.revision).toBe(7);
});
