import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  groupContextSchema,
  groupEventIdSchema,
  groupEntityIdSchema,
  groupOperationIdSchema,
  localResourcesSchema,
  type GroupEvent,
  type GroupScope,
} from '@dock/shared';
import {
  groupNativeActivitySchema,
  groupNativeActivityFacts,
  type GroupNativeActivity,
} from '@dock/shared/dist/group-native-activity.js';
import type { GroupAction } from '@dock/shared/dist/group-actions.js';
import { Store } from './store.js';
import {
  initializeGroupActivity,
  captureGroupRunTransition,
  captureGroupQuarkTransition,
  captureGroupManagerAction,
  captureGroupNativeFinal,
} from './group-native-activity-producers.js';
import { captureGroupFileCheckpoint } from './group-native-activity-files.js';
import { GroupHostNativeActivity } from './group-native-activity.js';
import { inheritGroupHostWork } from './group-host-work-continuation.js';
import { GroupEventRepository } from './group-events.js';
import { GroupEvidenceIndex } from './group-evidence.js';
import { groupFeatureEvidence } from './group-feature-evidence.js';
import type { GroupHost } from './group-host.js';
import type { GroupCatchupReader } from './group-catchup-context.js';
import { git } from './workspaces.js';
import { LocalJobs } from './local-jobs.js';
import { Runtime } from './runtime.js';
import type { ClaudeEvent } from './claude-session.js';

let root: string, store: Store;
let runtimes: Runtime[];
beforeEach(() => {
  runtimes = [];
  root = mkdtempSync(join(tmpdir(), 'group-activity-'));
  store = new Store(join(root, 'dock.sqlite'));
  initializeGroupActivity(store);
});
afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture(intent: 'ask' | 'work' = 'work', visibility: 'shared' | 'private' = 'shared') {
  const cwd = join(root, randomUUID());
  mkdirSync(cwd);
  const project = store.register(cwd, 'Group producer', ''),
    manager = store.agent(project.managerId),
    context = groupContextSchema.parse({
      groupId: randomUUID(),
      memberId: randomUUID(),
      installationId: randomUUID(),
      sessionId: randomUUID(),
      nativeSessionId: randomUUID(),
      provider: 'codex',
      visibility,
    }),
    requestId = randomUUID(),
    enrollment = randomUUID(),
    run = store.enqueue(manager.id, requestId, 'Owner supplied exact input');
  store.setSetting(`group:host-native-agent:${manager.id}`, {
    context,
    anchor: context,
    enrollmentHandle: enrollment,
  });
  store.setSetting(`group:host-native-run:${run.id}`, { requestId, intent, context });
  return { cwd, project, manager, context, requestId, enrollment, run };
}
const receipts = () =>
  store.db
    .prepare('SELECT body FROM group_native_activity ORDER BY rowid')
    .all()
    .map((r) => groupNativeActivitySchema.parse(JSON.parse(String(r.body))));
function worker(
  f: ReturnType<typeof fixture>,
  provider: 'codex' | 'claude' = 'codex',
  inherit = true,
) {
  const task = store.addTask(f.project.id, {
      title: 'Bounded task',
      goal: 'Shared work',
      acceptance: 'Exact result',
      managerId: f.manager.id,
      parentId: null,
    }),
    agent = store.addAgent({
      projectId: f.project.id,
      parentId: f.manager.id,
      taskId: task.id,
      name: 'Worker',
      role: 'implementer',
      provider,
      cwd: f.cwd,
    }),
    run = store.enqueue(agent.id, randomUUID(), 'Assigned work', 'delegation', f.manager.id);
  if (inherit) inheritGroupHostWork(store, store.run(f.run.id), store.run(run.id));
  return { task, agent, run };
}
function nativeRuntime(w: ReturnType<typeof worker>, provider: 'codex' | 'claude' = 'codex') {
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  store.setSetting('pulsar:policy', { enabled: false });
  const launch = vi.fn(async () => {
      throw new Error('No provider launch authorized.');
    }),
    runtime = new Runtime(store, root, 'never-native', launch),
    turnId = provider === 'claude' ? w.run.id : randomUUID(),
    threadId = randomUUID();
  runtimes.push(runtime);
  store.updateAgent(w.agent.id, {
    role: 'researcher',
    provider,
    threadId,
    turnId,
    status: 'running',
  });
  store.updateRun(w.run.id, { status: 'running', turnId });
  const events = runtime as unknown as {
    notification(agentId: string, method: string, raw: unknown): Promise<void>;
    claudeEvent(agentId: string, event: ClaudeEvent, runId: string): Promise<void>;
  };
  return {
    runtime,
    launch,
    turnId,
    threadId,
    notify: (method: string, raw: unknown) => events.notification(w.agent.id, method, raw),
    claude: (event: ClaudeEvent) => events.claudeEvent(w.agent.id, event, w.run.id),
  };
}
it.each([
  ['ask', 'shared'],
  ['work', 'private'],
] as const)(
  'excludes %s/%s before retaining content, QUARK reasons or receipts',
  (intent, visibility) => {
    const f = fixture(intent, visibility);
    store.entry({
      id: randomUUID(),
      agentId: f.manager.id,
      runId: f.run.id,
      kind: 'assistant',
      title: 'Private',
      text: 'secret draft and account usage',
      status: 'complete',
      phase: 'final',
      createdAt: new Date().toISOString(),
    });
    captureGroupRunTransition(store, f.run.id, `run:${f.run.id}:queued`);
    const e = store.event('quark.paused', f.project.id, f.manager.id, {
      runId: f.run.id,
      cause: 'budget',
      reason: 'Account usage 99%, token secret',
    });
    captureGroupQuarkTransition(store, f.run.id, `quark:${e.id}`, 'held', 'budget');
    store.updateRun(f.run.id, { status: 'completed' });
    const excluded = worker(f, 'codex', false);
    store.setSetting(`group:host-native-agent:${excluded.agent.id}`, {
      context: f.context,
      enrollmentHandle: f.enrollment,
    });
    store.setSetting(`group:host-native-run:${excluded.run.id}`, {
      context: f.context,
      intent,
      requestId: f.requestId,
      originRunId: f.run.id,
    });
    store.updateRun(excluded.run.id, { status: 'running' });
    captureGroupNativeFinal(
      store,
      excluded.run.id,
      `${excluded.agent.id}:final`,
      'PRIVATE RAW CANARY',
    );
    store.updateRun(excluded.run.id, { status: 'completed' });
    expect(receipts()).toEqual([]);
    expect(store.db.prepare('SELECT count(*) n FROM group_native_activity_finals').get()!.n).toBe(
      0,
    );
  },
);
it('real run transitions snapshot only the exact worker final reply; restart and repeated status do not duplicate it', () => {
  const f = fixture(),
    w = worker(f),
    other = store.enqueue(w.agent.id, randomUUID(), 'Different private history');
  store.entry({
    id: randomUUID(),
    agentId: w.agent.id,
    runId: other.id,
    kind: 'assistant',
    title: 'Private',
    text: 'UNRELATED PRIVATE',
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  const text = 'Exact shared finding 🧬\nSecond line.';
  store.entry({
    id: randomUUID(),
    agentId: w.agent.id,
    runId: w.run.id,
    kind: 'assistant',
    title: 'Result',
    text,
    status: 'complete',
    phase: 'final',
    createdAt: new Date().toISOString(),
  });
  store.entry({
    id: randomUUID(),
    agentId: w.agent.id,
    runId: w.run.id,
    kind: 'assistant',
    title: 'Progress',
    text: 'Routine commentary',
    status: 'complete',
    phase: 'commentary',
    createdAt: new Date().toISOString(),
  });
  store.updateRun(w.run.id, { status: 'running' });
  captureGroupNativeFinal(store, w.run.id, `${w.agent.id}:provider-final`, text);
  store.updateRun(w.run.id, { status: 'completed' });
  store.updateRun(w.run.id, { status: 'completed' });
  const result = receipts().filter((r) => r.detail.producer === 'worker');
  expect(result).toHaveLength(1);
  expect(result[0]!.detail).toMatchObject({
    result: {
      availability: 'complete',
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
    },
  });
  expect(JSON.stringify(receipts())).not.toMatch(/UNRELATED PRIVATE|Routine commentary/);
  const exact = receipts();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(receipts()).toEqual(exact);
  expect(() => store.db.prepare('UPDATE group_native_activity SET body=?').run('{}')).toThrow(
    /immutable/,
  );
});
it('actual Runtime item completion preserves composite identity and raw final text before the display limit', async () => {
  const f = fixture(),
    w = worker(f),
    r = nativeRuntime(w),
    providerId = 'provider-item:final/42',
    entryId = `${w.agent.id}:${providerId}`,
    text = 'Exact raw final 🧬\n'.repeat(14000);
  expect(text.length).toBeGreaterThan(200000);
  await r.notify('item/started', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: { id: providerId, type: 'agentMessage', phase: 'final_answer', text: '' },
  });
  await r.notify('item/agentMessage/delta', {
    threadId: r.threadId,
    turnId: r.turnId,
    itemId: providerId,
    delta: 'Streaming display only',
  });
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: { id: providerId, type: 'agentMessage', phase: 'final_answer', text },
  });
  await r.notify('turn/completed', {
    threadId: r.threadId,
    turn: { id: r.turnId, status: 'completed' },
  });
  const display = store.savedEntry(w.agent.id, entryId)!;
  expect(display.text).toContain('[Display limit reached;');
  expect(display.text.length).toBeLessThan(text.length);
  expect(receipts().find((x) => x.detail.producer === 'worker')!.detail).toMatchObject({
    result: {
      text,
      availability: 'complete',
      reason: null,
      entryIds: [entryId],
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  });
  expect(store.run(w.run.id).status).toBe('completed');
  expect(
    store.db
      .prepare(
        "SELECT count(*) n FROM events WHERE type='run.completed' AND json_extract(data,'$.id')=?",
      )
      .get(w.run.id)!.n,
  ).toBe(1);
  expect(r.launch).not.toHaveBeenCalled();
});
it('actual Runtime accepts an oversized native ID while activity records unavailable proof and native terminal events remain committed', async () => {
  const f = fixture(),
    w = worker(f),
    r = nativeRuntime(w),
    providerId = 'provider:'.repeat(100),
    events: string[] = [];
  store.on('event', (e) => {
    if (e.agentId === w.agent.id) events.push(e.type);
  });
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: {
      id: providerId,
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'Valid native result',
    },
  });
  await r.notify('turn/completed', {
    threadId: r.threadId,
    turn: { id: r.turnId, status: 'completed' },
  });
  await Promise.resolve();
  expect(store.savedEntry(w.agent.id, `${w.agent.id}:${providerId}`)!.status).toBe('complete');
  expect(store.run(w.run.id).status).toBe('completed');
  expect(events.filter((x) => x === 'run.completed')).toEqual(['run.completed']);
  expect(
    store.db
      .prepare(
        "SELECT count(*) n FROM events WHERE type='run.completed' AND json_extract(data,'$.id')=?",
      )
      .get(w.run.id)!.n,
  ).toBe(1);
  expect(receipts().find((x) => x.detail.producer === 'worker')!.detail).toMatchObject({
    result: {
      availability: 'unavailable',
      reason: 'unsupported-source',
      text: null,
      sha256: null,
      bytes: null,
      entryIds: [],
    },
  });
  expect(
    store.db
      .prepare('SELECT reason,count FROM group_native_activity_gaps WHERE enrollment=?')
      .all(f.enrollment),
  ).toEqual([{ reason: 'unsupported-source', count: 1 }]);
  expect(r.launch).not.toHaveBeenCalled();
});
it('ordinary unbound native work completes without activity originals or gaps', async () => {
  const f = fixture(),
    w = worker(f, 'codex', false),
    r = nativeRuntime(w);
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: {
      id: 'personal-final',
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'PERSONAL RAW CANARY',
    },
  });
  await r.notify('turn/completed', {
    threadId: r.threadId,
    turn: { id: r.turnId, status: 'completed' },
  });
  expect(store.run(w.run.id).status).toBe('completed');
  expect(receipts()).toEqual([]);
  expect(store.db.prepare('SELECT count(*) n FROM group_native_activity_finals').get()!.n).toBe(0);
  expect(store.db.prepare('SELECT count(*) n FROM group_native_activity_gaps').get()!.n).toBe(0);
  expect(r.launch).not.toHaveBeenCalled();
});
it.each([
  ['streaming', 'completed', 'missing-final'],
  ['unknown', 'completed', 'missing-final'],
  ['absent', 'completed', 'missing-final'],
  ['final', 'interrupted', 'not-completed'],
  ['streaming', 'interrupted', 'not-completed'],
] as const)(
  'actual Runtime %s output followed by %s never claims a complete final',
  async (mode, status, reason) => {
    const f = fixture(),
      w = worker(f),
      r = nativeRuntime(w),
      id = 'unproven-item';
    if (mode !== 'absent') {
      await r.notify('item/started', {
        threadId: r.threadId,
        turnId: r.turnId,
        item: { id, type: 'agentMessage', text: 'Draft canary' },
      });
      await r.notify('item/agentMessage/delta', {
        threadId: r.threadId,
        turnId: r.turnId,
        itemId: id,
        delta: 'Streaming canary',
      });
      if (mode !== 'streaming')
        await r.notify('item/completed', {
          threadId: r.threadId,
          turnId: r.turnId,
          item: {
            id,
            type: 'agentMessage',
            ...(mode === 'final' ? { phase: 'final_answer' } : {}),
            text: 'Raw message canary',
          },
        });
    }
    await r.notify('turn/completed', { threadId: r.threadId, turn: { id: r.turnId, status } });
    expect(store.run(w.run.id).status).toBe(status);
    expect(receipts().find((x) => x.detail.producer === 'worker')!.detail).toMatchObject({
      result: { availability: 'unavailable', reason, text: null, sha256: null, bytes: null },
    });
    expect(JSON.stringify(receipts())).not.toContain('canary');
    expect(r.launch).not.toHaveBeenCalled();
  },
);
it('actual Claude result retains raw completed text while its message display is truncated; late or interrupted results cannot prove final output', async () => {
  const f = fixture(),
    w = worker(f, 'claude'),
    r = nativeRuntime(w, 'claude'),
    text = 'Claude complete final 🧬\n'.repeat(12000),
    id = 'claude-item';
  await r.claude({ type: 'message', id, role: 'assistant', text });
  expect(store.savedEntry(w.agent.id, `${w.agent.id}:claude:${id}`)!.text).toContain(
    '[Display limit reached;',
  );
  await r.claude({
    type: 'result',
    id: 'late',
    sessionId: r.threadId,
    deliveryId: randomUUID(),
    status: 'completed',
    text: 'LATE CANARY',
    usage: null,
  });
  expect(store.run(w.run.id).status).toBe('running');
  await r.claude({
    type: 'result',
    id: 'raw-result',
    sessionId: r.threadId,
    deliveryId: w.run.id,
    status: 'completed',
    text,
    usage: null,
  });
  expect(store.run(w.run.id).status).toBe('completed');
  expect(receipts().find((x) => x.detail.producer === 'worker')!.detail).toMatchObject({
    result: {
      text,
      availability: 'complete',
      reason: null,
      entryIds: [`${w.agent.id}:claude:result:raw-result`],
    },
  });
  const second = worker(f, 'claude'),
    interrupted = nativeRuntime(second, 'claude');
  await interrupted.claude({
    type: 'result',
    id: 'interrupted-result',
    sessionId: interrupted.threadId,
    deliveryId: second.run.id,
    status: 'interrupted',
    text: 'INCOMPLETE CANARY',
    usage: null,
  });
  expect(
    receipts().find((x) => x.detail.producer === 'worker' && x.runId === second.run.id)!.detail,
  ).toMatchObject({ result: { text: null, availability: 'unavailable', reason: 'not-completed' } });
  expect(JSON.stringify(receipts())).not.toMatch(/LATE CANARY|INCOMPLETE CANARY/);
  expect(r.launch).not.toHaveBeenCalled();
  expect(interrupted.launch).not.toHaveBeenCalled();
});
it('capture insertion failure does not roll back actual Runtime terminal status or publish an uncommitted terminal event', async () => {
  const f = fixture(),
    w = worker(f),
    r = nativeRuntime(w),
    events: string[] = [];
  store.on('event', (e) => {
    if (e.agentId === w.agent.id) events.push(e.type);
  });
  store.db.exec(
    "CREATE TRIGGER fixture_capture_failure BEFORE INSERT ON group_native_activity WHEN json_extract(NEW.body,'$.detail.state')='completed' BEGIN SELECT RAISE(ABORT,'capture unavailable'); END",
  );
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: { id: 'exact-final', type: 'agentMessage', phase: 'final_answer', text: 'Raw final' },
  });
  await r.notify('turn/completed', {
    threadId: r.threadId,
    turn: { id: r.turnId, status: 'completed' },
  });
  await Promise.resolve();
  expect(store.run(w.run.id).status).toBe('completed');
  expect(events.filter((x) => x === 'run.completed')).toEqual(['run.completed']);
  expect(
    store.db
      .prepare(
        "SELECT count(*) n FROM events WHERE type='run.completed' AND json_extract(data,'$.id')=?",
      )
      .get(w.run.id)!.n,
  ).toBe(1);
  expect(
    store.db
      .prepare('SELECT reason,count FROM group_native_activity_gaps WHERE enrollment=?')
      .all(f.enrollment),
  ).toEqual([{ reason: 'capture-failed', count: 1 }]);
  expect(receipts().filter((x) => x.runId === w.run.id && x.detail.producer === 'worker')).toEqual(
    [],
  );
  expect(r.launch).not.toHaveBeenCalled();
});
it('raw original capacity leaves an explicit unavailable result and scoped gap while actual Runtime completes', async () => {
  const f = fixture(),
    w = worker(f),
    r = nativeRuntime(w);
  store.db
    .prepare('INSERT INTO group_native_activity_bodies VALUES(?,?,?,?,?)')
    .run(randomUUID(), f.enrollment, 64 * 1024 * 1024, 'a'.repeat(64), Buffer.alloc(0));
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: {
      id: 'capacity-final',
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'Full body cannot be retained',
    },
  });
  await r.notify('turn/completed', {
    threadId: r.threadId,
    turn: { id: r.turnId, status: 'completed' },
  });
  expect(store.run(w.run.id).status).toBe('completed');
  expect(receipts().find((x) => x.detail.producer === 'worker')!.detail).toMatchObject({
    result: {
      availability: 'unavailable',
      reason: 'original-capacity',
      text: null,
      sha256: null,
      bytes: null,
    },
  });
  expect(
    store.db
      .prepare('SELECT reason,count FROM group_native_activity_gaps WHERE enrollment=?')
      .all(f.enrollment),
  ).toEqual([{ reason: 'original-capacity', count: 1 }]);
  expect(r.launch).not.toHaveBeenCalled();
});
it('exhausted raw-proof gap metadata stays bounded and cannot turn unsupported output into a complete claim', async () => {
  const f = fixture(),
    w = worker(f),
    r = nativeRuntime(w);
  store.db
    .prepare(
      "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<8192) INSERT INTO group_native_activity_final_gaps SELECT 'capacity:'||x,?,'unsupported-source' FROM seq",
    )
    .run(f.enrollment);
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: { id: 'supported', type: 'agentMessage', phase: 'final_answer', text: 'First raw final' },
  });
  await r.notify('item/completed', {
    threadId: r.threadId,
    turnId: r.turnId,
    item: {
      id: 'oversized:'.repeat(100),
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'Later unsupported final',
    },
  });
  await r.notify('turn/completed', {
    threadId: r.threadId,
    turn: { id: r.turnId, status: 'completed' },
  });
  expect(store.run(w.run.id).status).toBe('completed');
  expect(store.db.prepare('SELECT count(*) n FROM group_native_activity_final_gaps').get()!.n).toBe(
    8192,
  );
  expect(receipts().find((x) => x.detail.producer === 'worker')!.detail).toMatchObject({
    result: {
      availability: 'unavailable',
      reason: 'original-capacity',
      sha256: null,
      bytes: null,
      text: null,
    },
  });
  expect(
    store.db
      .prepare('SELECT reason,count FROM group_native_activity_gaps WHERE enrollment=?')
      .all(f.enrollment),
  ).toEqual([{ reason: 'original-capacity', count: 1 }]);
  expect(r.launch).not.toHaveBeenCalled();
});
it('rejects orphan lineage and synthetic controls, and QUARK copies only an exact durable state/cause receipt', () => {
  const f = fixture();
  store.setSetting(`group:native-control:${f.run.id}`, { actionId: randomUUID() });
  store.updateRun(f.run.id, { status: 'running' });
  expect(receipts()).toHaveLength(0);
  store.setSetting(`group:native-control:${f.run.id}`, null);
  captureGroupQuarkTransition(store, f.run.id, 'quark:999999', 'held', 'budget');
  expect(receipts()).toHaveLength(0);
  const e = store.event('quark.paused', f.project.id, f.manager.id, {
    runId: f.run.id,
    cause: 'budget',
    reason: 'SECRET account amount 98.76',
  });
  captureGroupQuarkTransition(store, f.run.id, `quark:${e.id}`, 'held', 'budget');
  captureGroupQuarkTransition(store, f.run.id, `quark:${e.id}`, 'held', 'budget');
  expect(receipts()).toHaveLength(1);
  expect(receipts()[0]!.detail).toEqual({ producer: 'quark', state: 'held', cause: 'budget' });
  expect(JSON.stringify(receipts())).not.toMatch(/SECRET|98.76|reason/);
  const orphan = store.enqueue(f.manager.id, randomUUID(), 'Unbound');
  store.setSetting(`group:host-native-run:${orphan.id}`, {
    requestId: f.requestId,
    intent: 'work',
    context: f.context,
    originRunId: randomUUID(),
  });
  store.updateRun(orphan.id, { status: 'completed' });
  expect(receipts()).toHaveLength(1);
});
it('manager facts require the saved exact outcome and preserve autonomous origin without inventing an instruction', async () => {
  const f = fixture(),
    w = worker(f),
    goal = groupEventIdSchema.parse(randomUUID()),
    owner = {
      groupId: f.context.groupId,
      memberId: f.context.memberId,
      installationId: f.context.installationId,
      displayName: 'Owner',
    },
    origin = {
      kind: 'autonomous' as const,
      eventId: groupEventIdSchema.parse(randomUUID()),
      sharedGoalId: goal,
      managerId: f.manager.id,
    },
    work = {
      workId: randomUUID(),
      title: 'Work',
      owner,
      taskId: w.task.id,
      managerId: f.manager.id,
      sharedGoalId: goal,
      revision: 1,
      desired: 'start' as const,
      availability: 'available' as const,
      latest: { actionId: null, actor: owner, origin, at: new Date().toISOString() },
    },
    action: GroupAction = {
      actionId: randomUUID(),
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
    },
    outcome = {
      taskId: w.task.id,
      workerId: w.agent.id,
      outcomeId: randomUUID(),
      jobId: w.run.id,
      status: 'started' as const,
      message: 'Exact worker queued',
    };
  captureGroupManagerAction(store, f.run.id, action, outcome);
  expect(receipts().filter((r) => r.detail.producer === 'manager')).toHaveLength(0);
  store.setSetting(`group:coordination:${f.context.sessionId}:action:${action.actionId}`, {
    kind: 'start',
    taskId: w.task.id,
    causal: action,
    outcome,
  });
  captureGroupManagerAction(store, f.run.id, action, outcome);
  const source = receipts().find((r) => r.detail.producer === 'manager')!;
  const goalReader = vi.fn(async () => goal),
    published: GroupNativeActivity[] = [];
  const lane = new GroupHostNativeActivity(store, {
    sharedGoalForRequest: goalReader,
    publishNativeActivity: async (_e, r) => {
      published.push(r);
      return { state: 'committed', eventId: groupEventIdSchema.parse(randomUUID()) };
    },
  });
  await lane.pass();
  await lane.close();
  const projected = published.find((r) => r.receiptId === source.receiptId)!;
  expect(projected.instructionEventId).toBeNull();
  const facts = groupNativeActivityFacts(projected);
  expect(facts.autonomous).toBe(true);
  expect(facts.instructionIds).toEqual([]);
  expect(facts.originalIds).toMatchObject({
    actionId: action.actionId,
    taskId: w.task.id,
    managerId: f.manager.id,
    workerId: w.agent.id,
    jobId: w.run.id,
    outcomeId: outcome.outcomeId,
  });
  expect(facts.edges).toContainEqual({
    fromId: action.actionId,
    toId: outcome.outcomeId,
    relation: 'outcome',
  });
  const uncertain = { ...action, actionId: randomUUID() };
  store.setSetting(`group:coordination:${f.context.sessionId}:action:${uncertain.actionId}`, {
    kind: 'start',
    taskId: w.task.id,
    causal: uncertain,
  });
  captureGroupManagerAction(store, f.run.id, uncertain, null);
  store.setSetting(`group:coordination:${f.context.sessionId}:action:${uncertain.actionId}`, {
    kind: 'start',
    taskId: w.task.id,
    causal: uncertain,
    outcome,
  });
  captureGroupManagerAction(store, f.run.id, uncertain, outcome);
  const states = receipts().filter(
    (r) => r.detail.producer === 'manager' && r.detail.actionId === uncertain.actionId,
  );
  expect(states.map((r) => r.detail.producer === 'manager' && r.detail.state)).toEqual([
    'uncertain',
    'started',
  ]);
  expect(states.map((r) => groupNativeActivityFacts(r).sourceId)).toEqual([
    groupNativeActivityFacts(states[0]!).sourceId,
    groupNativeActivityFacts(states[0]!).sourceId,
  ]);
  const blocked = { ...action, actionId: randomUUID() },
    blockedOutcome = {
      taskId: w.task.id,
      workerId: null,
      outcomeId: randomUUID(),
      status: 'blocked' as const,
      message: 'Private account detail must stay local.',
    };
  store.operation(`group:activity-blocked:${blocked.actionId}`, { action: blocked }, () => ({
    taskId: w.task.id,
    causal: blocked,
    outcome: blockedOutcome,
  }));
  captureGroupManagerAction(store, f.run.id, blocked, blockedOutcome);
  const blockedSource = receipts().find(
    (r) => r.detail.producer === 'manager' && r.detail.actionId === blocked.actionId,
  )!;
  expect(blockedSource.detail).toMatchObject({ state: 'blocked', jobId: null });
  expect(groupNativeActivityFacts(blockedSource).unresolved).toBe(true);
  expect(JSON.stringify(blockedSource)).not.toContain(blockedOutcome.message);
});
it('file producer reads the exact commit and omits private paths and later working files', async () => {
  const f = fixture(),
    w = worker(f);
  await git(f.cwd, ['init', '--initial-branch=main']);
  await git(f.cwd, ['config', 'user.name', 'Fixture']);
  await git(f.cwd, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(f.cwd, 'shared.txt'), 'Shared change');
  writeFileSync(join(f.cwd, '.env'), 'PRIVATE');
  writeFileSync(join(f.cwd, 'secrets.json'), 'PRIVATE');
  mkdirSync(join(f.cwd, 'data'));
  mkdirSync(join(f.cwd, 'nested', 'data'), { recursive: true });
  mkdirSync(join(f.cwd, 'drafts'));
  writeFileSync(join(f.cwd, 'data', 'runtime-canary.txt'), 'PRIVATE');
  writeFileSync(join(f.cwd, 'nested', 'data', 'runtime-canary.txt'), 'PRIVATE');
  writeFileSync(join(f.cwd, 'drafts', 'draft-canary.txt'), 'PRIVATE');
  await git(f.cwd, ['add', '.']);
  await git(f.cwd, ['commit', '-m', 'Exact checkpoint']);
  const commit = await git(f.cwd, ['rev-parse', 'HEAD']);
  store.updateTask(w.task.id, { worktree: f.cwd });
  writeFileSync(join(f.cwd, 'later.txt'), 'Later unsaved content');
  await captureGroupFileCheckpoint(store, w.run.id, w.task.id, commit);
  const source = receipts().find((r) => r.detail.producer === 'file')!;
  expect(source.detail).toEqual({ producer: 'file', commit, paths: ['shared.txt'], omitted: true });
  expect(JSON.stringify(source)).not.toMatch(
    /\.env|secrets.json|later.txt|PRIVATE|runtime-canary|draft-canary|nested|data|drafts/,
  );
});
it('local job transitions require the exact Work dispatch and publish no URL, phase, resource or account details', async () => {
  const f = fixture(),
    ask = fixture('ask'),
    jobs = new LocalJobs(store, root, {
      process: () => {
        throw new Error('No native process is authorized by this fixture.');
      },
    }),
    request = () => ({
      key: randomUUID(),
      url: 'https://youtu.be/abcdefghijk',
      resources: localResourcesSchema.parse({}),
    });
  try {
    jobs.create(request(), f.manager);
    jobs.create(request(), ask.manager, ask.run.id);
    expect(receipts()).toHaveLength(0);
    const input = request(),
      job = jobs.create(input, f.manager, f.run.id);
    expect(jobs.create(input, f.manager, f.run.id).id).toBe(job.id);
    await jobs.control({ key: randomUUID(), jobId: job.id, action: 'pause' });
    await jobs.control({ key: randomUUID(), jobId: job.id, action: 'cancel' });
    const shared = receipts();
    expect(shared.map((r) => r.detail)).toEqual(
      ['queued', 'paused', 'cancelled'].map((state) => ({ producer: 'job', jobId: job.id, state })),
    );
    expect(
      shared.every(
        (r) => r.runId === f.run.id && r.requestId === f.requestId && r.managerId === f.manager.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(shared)).not.toMatch(
      /youtube|abcdefghijk|resources|phase|Waiting|account|cpuCores/,
    );
    expect(groupNativeActivityFacts(shared[1]!).unresolved).toBe(true);
    expect(groupNativeActivityFacts(shared[2]!).originalIds.jobId).toBe(job.id);
  } finally {
    await jobs.close();
  }
});
it('job binding capacity records a scoped receipt gap and still creates the ordinary queued job', async () => {
  const f = fixture(),
    jobs = new LocalJobs(store, root, {
      process: () => {
        throw new Error('No native process authorized.');
      },
    });
  store.db
    .prepare(
      "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<8192) INSERT INTO group_native_activity_jobs SELECT 'capacity:'||x,?,? FROM seq",
    )
    .run(f.run.id, f.manager.id);
  try {
    const job = jobs.create(
      {
        key: randomUUID(),
        url: 'https://youtu.be/abcdefghijk',
        resources: localResourcesSchema.parse({}),
      },
      f.manager,
      f.run.id,
    );
    expect(job.status).toBe('queued');
    expect(jobs.get(job.id).status).toBe('queued');
    expect(store.db.prepare('SELECT count(*) n FROM group_native_activity_jobs').get()!.n).toBe(
      8192,
    );
    expect(
      store.db
        .prepare('SELECT reason,count FROM group_native_activity_gaps WHERE enrollment=?')
        .all(f.enrollment),
    ).toEqual([{ reason: 'receipt-capacity', count: 1 }]);
    expect(
      store.db
        .prepare('SELECT count(*) n FROM group_native_activity_gaps WHERE enrollment=?')
        .get(randomUUID())!.n,
    ).toBe(0);
    expect(receipts()).toEqual([]);
  } finally {
    await jobs.close();
  }
});
it('large final outputs remain complete and overflow uses an immutable bounded owner reader across restart', async () => {
  const f = fixture(),
    first = worker(f),
    second = worker(f),
    chunked = '🧬 Shared final output.\n'.repeat(4000),
    overflow = `${'🧬'.repeat(135000)}\n\n${'🧬'.repeat(135000)}`;
  for (const [w, text] of [
    [first, chunked],
    [second, overflow],
  ] as const) {
    store.updateRun(w.run.id, { status: 'running' });
    for (const [index, part] of (w === second ? text.split('\n\n') : [text]).entries())
      captureGroupNativeFinal(store, w.run.id, `${w.agent.id}:raw-final:${index}`, part);
    store.entry({
      id: randomUUID(),
      agentId: w.agent.id,
      runId: w.run.id,
      kind: 'assistant',
      title: 'Result',
      text,
      status: 'complete',
      phase: 'final',
      createdAt: new Date().toISOString(),
    });
    store.updateRun(w.run.id, { status: 'completed' });
  }
  const sources = receipts().filter((r) => r.detail.producer === 'worker');
  expect(sources[0]!.detail).toMatchObject({
    result: { text: chunked, availability: 'complete', bytes: Buffer.byteLength(chunked) },
  });
  expect(sources[1]!.detail).toMatchObject({
    result: { text: null, availability: 'local-only', bytes: Buffer.byteLength(overflow) },
  });
  const id = sources[1]!.receiptId;
  expect(() =>
    store.db
      .prepare('UPDATE group_native_activity_finals SET body=? WHERE run_id=?')
      .run(Buffer.from('replacement'), second.run.id),
  ).toThrow('immutable');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  const activity = new GroupHostNativeActivity(store, {
      sharedGoalForRequest: async () => {
        throw new Error('No instruction lookup in this fixture.');
      },
      publishNativeActivity: async () => {
        throw new Error('No publish in original read fixture.');
      },
    }),
    actor = { enrollmentHandle: f.enrollment, revalidate: async () => {} },
    host = { authenticatedContext: async () => actor } as unknown as GroupHost;
  try {
    const parts: Buffer[] = [];
    let start: number | null = 0;
    while (start !== null) {
      const page = await activity.original(host, {
        handle: randomUUID(),
        receiptId: id,
        start,
        count: 16,
      });
      parts.push(Buffer.from(page.data, 'base64'));
      start = page.next;
      expect(page.sha256).toBe(createHash('sha256').update(overflow).digest('hex'));
    }
    expect(Buffer.concat(parts).toString('utf8')).toBe(overflow);
    await expect(
      activity.original(host, { handle: randomUUID(), receiptId: id, count: 17 }),
    ).rejects.toThrow();
    await expect(
      activity.original(
        {
          ...host,
          authenticatedContext: async () => ({ ...actor, enrollmentHandle: randomUUID() }),
        } as unknown as GroupHost,
        { handle: randomUUID(), receiptId: id },
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      activity.original(
        {
          ...host,
          authenticatedContext: async () => ({
            ...actor,
            revalidate: async () => {
              throw new Error('Revoked');
            },
          }),
        } as unknown as GroupHost,
        { handle: randomUUID(), receiptId: id },
      ),
    ).rejects.toThrow('Revoked');
  } finally {
    await activity.close();
  }
});
it('receipt capture exhaustion is exposed as a scoped gap while existing identities and native run state remain intact', async () => {
  const f = fixture();
  store.db
    .prepare(
      "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<8192) INSERT INTO group_native_activity SELECT 'capacity:'||x,?, '{}' FROM seq",
    )
    .run(f.enrollment);
  captureGroupRunTransition(store, f.run.id, `run:${f.run.id}:queued`);
  const activity = new GroupHostNativeActivity(store, {
      sharedGoalForRequest: async () => {
        throw new Error('No instruction lookup in this fixture.');
      },
      publishNativeActivity: async () => {
        throw new Error('No publication authorized.');
      },
    }),
    actor = { enrollmentHandle: f.enrollment, revalidate: async () => {} },
    host = { authenticatedContext: async () => actor } as unknown as GroupHost;
  try {
    expect(await activity.status(host, { handle: randomUUID() })).toMatchObject({
      gaps: [{ reason: 'receipt-capacity', count: 1 }],
    });
    expect(
      await activity.status(
        {
          ...host,
          authenticatedContext: async () => ({ ...actor, enrollmentHandle: randomUUID() }),
        } as unknown as GroupHost,
        { handle: randomUUID() },
      ),
    ).toMatchObject({ gaps: [] });
    expect(store.run(f.run.id).status).toBe('queued');
    expect(store.db.prepare('SELECT count(*) n FROM group_native_activity').get()!.n).toBe(8192);
  } finally {
    await activity.close();
  }
});
it('lost publication acknowledgement and restart retry the exact saved projection without another summary/model launch', async () => {
  const f = fixture(),
    goal = groupEventIdSchema.parse(randomUUID());
  captureGroupRunTransition(store, f.run.id, `run:${f.run.id}:queued`);
  const sharedGoalForRequest = vi.fn(async () => goal),
    seen: GroupNativeActivity[] = [],
    publishNativeActivity = vi.fn(async (_e: string, r: GroupNativeActivity) => {
      seen.push(r);
      if (seen.length === 1) throw new Error('Lost ACK');
      return { state: 'committed' as const, eventId: groupEventIdSchema.parse(randomUUID()) };
    });
  const first = new GroupHostNativeActivity(store, { sharedGoalForRequest, publishNativeActivity });
  await first.pass();
  await first.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  const restored = new GroupHostNativeActivity(store, {
    sharedGoalForRequest,
    publishNativeActivity,
  });
  await restored.pass();
  await restored.pass();
  await restored.close();
  expect(seen).toHaveLength(2);
  expect(seen[1]).toEqual(seen[0]);
  expect(sharedGoalForRequest).toHaveBeenCalledOnce();
  expect(store.runs()).toHaveLength(1);
});
it('verified native producer originals answer causal, stopped, file and autonomous queries without treating copied prose as facts', async () => {
  const f = fixture(),
    repo = new GroupEventRepository(join(root, 'events.sqlite')),
    group = repo.createGroup('Evidence'),
    context = repo.createContext({
      groupId: group.groupId,
      memberId: group.memberId,
      installationId: group.installationId,
      visibility: 'shared',
      provider: 'codex',
      nativeSessionId: randomUUID(),
    });
  f.context = context;
  store.setSetting(`group:host-native-agent:${f.manager.id}`, {
    context,
    anchor: context,
    enrollmentHandle: f.enrollment,
  });
  store.setSetting(`group:host-native-run:${f.run.id}`, {
    requestId: f.requestId,
    intent: 'work',
    context,
  });
  const scope = (messageId: string, refs: GroupEvent['eventId'][] = []): GroupScope => ({
    groupId: context.groupId,
    memberId: context.memberId,
    installationId: context.installationId,
    visibility: 'shared',
    source: {
      sessionId: context.sessionId,
      provider: context.provider,
      nativeSessionId: context.nativeSessionId,
      messageId,
    },
    causalRefs: refs,
  });
  const append = (
    text: string,
    id = randomUUID(),
    refs: GroupEvent['eventId'][] = [],
    category: GroupEvent['category'] = 'Action',
  ) =>
    repo.append(repo.trustedHostScope(scope(id, refs)), {
      operationId: groupOperationIdSchema.parse(id),
      entityId: groupEntityIdSchema.parse(id),
      expectedRevision: 0,
      category,
      condensedText: 'Exact shared producer',
      original: { kind: 'inline', text },
      evidenceRefs: refs,
      corrects: null,
    }).event;
  const instruction = append('Explicit Work instruction', randomUUID(), [], 'Instruction');
  captureGroupRunTransition(store, f.run.id, `run:${f.run.id}:queued`);
  const raw = receipts()[0]!,
    base = { ...raw, instructionEventId: instruction.eventId, sharedGoalId: instruction.eventId },
    held = {
      ...base,
      receiptId: randomUUID(),
      detail: { producer: 'quark' as const, state: 'held' as const, cause: 'budget' as const },
    },
    resumed = {
      ...base,
      receiptId: randomUUID(),
      detail: { producer: 'quark' as const, state: 'resumed' as const, cause: 'budget' as const },
    },
    file = {
      ...base,
      receiptId: randomUUID(),
      detail: {
        producer: 'file' as const,
        commit: 'a'.repeat(40),
        paths: ['src/shared.ts'],
        omitted: false,
      },
    },
    actionId = randomUUID(),
    autonomous = {
      ...base,
      receiptId: randomUUID(),
      instructionEventId: null,
      origin: {
        kind: 'autonomous' as const,
        eventId: instruction.eventId,
        sharedGoalId: instruction.eventId,
        managerId: f.manager.id,
      },
      detail: {
        producer: 'manager' as const,
        actionId,
        proposalId: randomUUID(),
        outcomeId: randomUUID(),
        state: 'blocked' as const,
        jobId: null,
        origin: {
          kind: 'autonomous' as const,
          eventId: instruction.eventId,
          sharedGoalId: instruction.eventId,
          managerId: f.manager.id,
        },
      },
    };
  const heldEvent = append(JSON.stringify(held), held.receiptId, [instruction.eventId]),
    resumedEvent = append(JSON.stringify(resumed), resumed.receiptId, [instruction.eventId]),
    fileEvent = append(JSON.stringify(file), file.receiptId, [instruction.eventId]),
    decision = append(JSON.stringify(autonomous), autonomous.receiptId, [instruction.eventId]),
    copied = append(JSON.stringify(file), randomUUID(), [instruction.eventId]);
  const reader: GroupCatchupReader = {
    context,
    enrollmentHandle: f.enrollment,
    revalidate: async () => {},
    readShared: async (q) => repo.feed(repo.trustedHostScope(scope(randomUUID())), q),
    original: async (id) => ({
      eventId: id,
      text: repo.expand(repo.trustedHostScope(scope(randomUUID())), id).original,
    }),
  };
  const source = groupFeatureEvidence({
      sharedEvidenceHeader: async (_e: string, id: GroupEvent['eventId']) => {
        const expanded = repo.expand(repo.trustedHostScope(scope(randomUUID())), id);
        return { event: expanded.event, compactOriginal: expanded.original, origin: null };
      },
    } as unknown as GroupHost),
    index = new GroupEvidenceIndex(join(root, 'evidence.sqlite'), source);
  try {
    expect((await source.readVerifiedShared(reader, copied.eventId)).facts).toBeNull();
    await index.refreshShared(reader, randomUUID());
    const query = (q: Parameters<GroupEvidenceIndex['query']>[1]) =>
      index.query(reader, q, 8, null, { acknowledged: async () => 0 }, randomUUID());
    expect(
      (await query({ type: 'file_changes', path: 'src/shared.ts' })).records.map(
        (r) => r.event.eventId,
      ),
    ).toEqual([fileEvent.eventId]);
    expect(
      (await query({ type: 'autonomous_decisions' })).records.map((r) => r.event.eventId),
    ).toEqual([decision.eventId]);
    const causal = await query({
      type: 'instruction_actions',
      instructionEventId: instruction.eventId,
    });
    expect(causal.records.map((r) => r.event.eventId)).toContain(fileEvent.eventId);
    expect(causal.records.map((r) => r.event.eventId)).not.toContain(decision.eventId);
    const stopped = await query({ type: 'why_stopped', subjectId: f.run.id });
    expect(stopped.records.map((r) => r.event.eventId)).toContain(heldEvent.eventId);
    expect(stopped.records.map((r) => r.event.eventId)).toContain(resumedEvent.eventId);
    expect((await query({ type: 'unresolved' })).records.map((r) => r.event.eventId)).toEqual([
      decision.eventId,
    ]);
  } finally {
    index.close();
    repo.close();
  }
});
