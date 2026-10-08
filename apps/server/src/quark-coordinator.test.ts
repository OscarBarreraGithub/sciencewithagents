import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { ModelPolicy } from './model-policy.js';
import { QuarkCoordinator } from './quark-coordinator.js';
import { parseCapacity } from './capacity.js';
let root: string,
  store: Store,
  pulsar: Pulsar,
  quark: Quark,
  coordinator: QuarkCoordinator,
  models: ModelPolicy;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T16:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'quark-coordinator-'));
  store = new Store(join(root, 'db.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  pulsar.allowanceDecision = (r) => quark.reason(r, r.status === 'queued');
  models = new ModelPolicy(store, async (provider) => [
    {
      id: provider === 'claude' ? 'opus' : 'sol',
      label: provider === 'claude' ? 'Opus 5.5' : 'Sol 6',
      isDefault: true,
      efforts: ['high', 'medium'],
    },
  ]);
  coordinator = new QuarkCoordinator(store, root, quark, pulsar, models);
  for (const provider of ['codex', 'claude'] as const)
    store.setSetting(
      `capacity:v1:${provider}`,
      parseCapacity(
        provider,
        [
          {
            provider,
            source: 'oauth',
            usage: {
              updatedAt: new Date().toISOString(),
              secondary: {
                usedPercent: 10,
                windowMinutes: 10080,
                resetsAt: new Date(Date.now() + 86400_000).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
});
afterEach(() => {
  vi.useRealTimers();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
async function active(kind: 'user' | 'report' = 'user') {
  const s = await coordinator.start({ key: randomUUID() });
  const agent = store.agent(s.agentId!);
  const pending = store.enqueue(agent.id, randomUUID(), 'Pause A and give B 20% weekly.', kind);
  expect(pulsar.reserve(pending, new Set())).toBe(true);
  quark.issueManagerLease(pending);
  quark.begin(pending);
  store.updateRun(pending.id, { status: 'running' });
  return { agent, run: store.run(pending.id) };
}
it('creates an isolated current-Opus coordinator once and retains its identity and casebook after restart', async () => {
  const s = await coordinator.start({ key: randomUUID() });
  expect(store.agent(s.agentId!).model).toBe('opus');
  expect(store.agent(s.agentId!).assignment?.taskClass).toBe('orchestration');
  expect(store.runs()).toHaveLength(0);
  expect(s.projects).toHaveLength(0);
  expect(
    readFileSync(join(store.project(s.projectId!).root, 'TIMING_EXAMPLES.md'), 'utf8'),
  ).toContain('Parallel turns overlap');
  expect((await coordinator.start({ key: randomUUID() })).agentId).toBe(s.agentId);
  store.close();
  store = new Store(join(root, 'db.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  models = new ModelPolicy(store, async () => []);
  coordinator = new QuarkCoordinator(store, root, quark, pulsar, models);
  expect(coordinator.status().agentId).toBe(s.agentId);
});
it('records owner input, pauses every project job, orders equal-priority work by weight and rejects stale edits', async () => {
  const a = store.register(join(root, 'A'), 'A', '');
  const b = store.register(join(root, 'B'), 'B', '');
  const ra = store.enqueue(a.managerId, randomUUID(), 'A');
  const rb = store.enqueue(b.managerId, randomUUID(), 'B');
  const { agent, run } = await active();
  const key = randomUUID();
  const pause = {
    action: 'project',
    projectId: a.id,
    expectedRevision: 0,
    paused: true,
    reason: 'Owner asked to pause A.',
  };
  coordinator.tool(agent.id, key, 'dock_quark_control', pause, run);
  expect(quark.block(ra, true)?.cause).toBe('project');
  expect(quark.block({ ...ra, status: 'running' })?.cause).toBe('project');
  expect(coordinator.tool(agent.id, key, 'dock_quark_control', pause, run)).toMatchObject({
    saved: true,
  });
  expect(coordinator.status().decisions[0]?.instruction).toContain('give B');
  expect(() =>
    coordinator.tool(
      agent.id,
      randomUUID(),
      'dock_quark_control',
      { ...pause, paused: false },
      run,
    ),
  ).toThrow(/changed/);
  coordinator.tool(
    agent.id,
    randomUUID(),
    'dock_quark_control',
    { action: 'project', projectId: b.id, expectedRevision: 0, weight: 8, reason: 'B first.' },
    run,
  );
  expect(pulsar.ordered([ra, rb])[0]?.id).toBe(rb.id);
  pulsar.savePolicy({ key: randomUUID(), policy: { ...pulsar.policy(), enabled: true } });
  expect(pulsar.ordered([ra, rb])[0]?.id).toBe(rb.id);
});
it('automatic messages cannot increase caps, lower the reserve, or resume an owner pause', async () => {
  const p = store.register(join(root, 'A'), 'A', '');
  const { agent, run } = await active('report');
  expect(() =>
    coordinator.tool(
      agent.id,
      randomUUID(),
      'dock_quark_control',
      { action: 'reserve', reservePercent: 5, reason: 'More room.' },
      run,
    ),
  ).toThrow(/owner/);
  expect(() =>
    coordinator.tool(
      agent.id,
      randomUUID(),
      'dock_quark_control',
      { action: 'project', projectId: p.id, expectedRevision: 0, paused: false, reason: 'Resume.' },
      run,
    ),
  ).toThrow(/Automatic/);
  for (const priority of ['high', null])
    expect(() =>
      coordinator.tool(
        agent.id,
        randomUUID(),
        'dock_quark_control',
        {
          action: 'project',
          projectId: p.id,
          expectedRevision: 0,
          paused: true,
          priority,
          reason: 'Automatic priority change.',
        },
        run,
      ),
    ).toThrow(/Automatic/);
  const window = coordinator.status().capacity[0]!.windows[0]!;
  expect(() =>
    coordinator.tool(
      agent.id,
      randomUUID(),
      'dock_quark_control',
      {
        action: 'budget',
        projectId: p.id,
        provider: 'codex',
        windowId: window.id,
        expectedRevision: 0,
        limitPercent: 20,
        reason: 'More room.',
      },
      run,
    ),
  ).toThrow(/owner/);
  expect(() => coordinator.tool(p.managerId, randomUUID(), 'dock_quark_inspect', {}, run)).toThrow(
    /own active/,
  );
});
it('owner reserve tools accept zero independently, retain pacing and replay the same decision', async () => {
  const { agent, run } = await active();
  const before = pulsar.policy();
  expect(before.enabled).toBe(false);
  const action = {
    action: 'reserve',
    provider: 'codex',
    reservePercent: 0,
    reason: 'Owner chose zero for Codex.',
  };
  const key = randomUUID();
  const result = coordinator.tool(agent.id, key, 'dock_quark_control', action, run);
  expect(pulsar.policy()).toMatchObject({
    enabled: false,
    revision: before.revision + 1,
    providerReserves: {
      codex: { reservePercent: 0 },
      claude: { reservePercent: before.providerReserves.claude.reservePercent },
    },
  });
  expect(coordinator.tool(agent.id, key, 'dock_quark_control', action, run)).toEqual(result);
  expect(pulsar.policy().revision).toBe(before.revision + 1);
  coordinator.tool(
    agent.id,
    randomUUID(),
    'dock_quark_control',
    {
      action: 'reserve',
      provider: 'claude',
      reservePercent: 0,
      releaseEnabled: true,
      releaseBeforeResetMinutes: 45,
      reason: 'Owner chose Claude reserve and release.',
    },
    run,
  );
  expect(pulsar.policy().providerReserves.claude).toEqual({
    reservePercent: 0,
    releaseEnabled: true,
    releaseBeforeResetMinutes: 45,
  });
  expect(coordinator.context().providerReserves).toEqual(pulsar.policy().providerReserves);
});
it('keeps the default context small and pages full saved instructions beyond the recent preview', async () => {
  await coordinator.start({ key: randomUUID() });
  for (let i = 0; i < 36; i++) {
    const project = store.register(join(root, `Project${i}`), `Project ${i}`, '');
    store.setSetting(`quark:project:${project.id}`, {
      instruction: 'Detailed owner policy '.repeat(80),
    });
    store.enqueue(project.managerId, randomUUID(), 'Saved task', 'report');
    const key = `context-fixture-${i}`;
    store.setSetting(`quark:decision:${key}`, {
      key,
      at: new Date().toISOString(),
      source: 'owner',
      instruction: 'Original owner instruction '.repeat(150),
      action: {
        action: 'project',
        projectId: project.id,
        expectedRevision: 0,
        reason: 'Full saved reasoning '.repeat(70),
      },
    });
  }
  const status = coordinator.status();
  const old = {
    settings: status.settings,
    projects: status.projects.slice(0, 40),
    jobs: status.queue.jobs.slice(0, 40),
    budgets: status.accounting.budgets.slice(0, 40),
    holds: status.accounting.holds.slice(0, 20),
    capacity: status.capacity,
    utilization: status.utilization,
    decisions: status.decisions.slice(0, 12),
    examples: pulsar.examples(),
  };
  const compact = coordinator.context();
  const before = Buffer.byteLength(JSON.stringify(old));
  const after = Buffer.byteLength(JSON.stringify(compact));
  expect(after).toBeLessThan(before / 3);
  expect(compact.jobs).toHaveLength(8);
  expect(compact.omitted.jobs).toBe(28);
  expect(compact.decisions[0]?.truncated).toBe(true);
  expect(compact).not.toHaveProperty('examples');
  const page = coordinator.inspect({ view: 'decisions', offset: 30, limit: 6 }) as {
    total: number;
    items: { instruction: string }[];
    nextOffset: number | null;
  };
  expect(page.total).toBe(36);
  expect(page.items).toHaveLength(6);
  expect(page.items[0]?.instruction).toBe('Original owner instruction '.repeat(150));
  expect(page.nextOffset).toBeNull();
  console.info(`QUARK context bytes: ${before} -> ${after}`);
});
it('preserves cluster freshness with compact counts and retains full cached details on request', async () => {
  const cached = {
    connection: { state: 'connected', checkedAt: new Date().toISOString(), message: 'cached' },
    stale: true,
    queueObservedAt: '2026-09-29T14:00:00Z',
    jobs: { running: 3, pending: 2, recentFailures: 1, pendingReasons: ['Resources'] },
  };
  coordinator = new QuarkCoordinator(
    store,
    root,
    quark,
    pulsar,
    models,
    Date.now,
    () => [],
    () => cached,
  );
  expect(coordinator.context().cluster).toEqual({
    connection: { state: 'connected', checkedAt: cached.connection.checkedAt },
    stale: true,
    queueObservedAt: cached.queueObservedAt,
    jobs: { running: 3, pending: 2, recentFailures: 1 },
  });
  expect(coordinator.inspect({ view: 'cluster' })).toEqual(cached);
});
it('retrieves its own retained conversation on demand, paging replies without tool blobs or another agent’s evidence', async () => {
  const id = (await coordinator.start({ key: randomUUID() })).agentId!;
  const oldText = 'Original detailed explanation. '.repeat(500);
  const replyId = randomUUID();
  store.entry({
    id: replyId,
    agentId: id,
    runId: null,
    kind: 'assistant',
    title: 'Assistant',
    text: oldText,
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  store.entry({
    id: randomUUID(),
    agentId: id,
    runId: null,
    kind: 'tool',
    title: 'Large tool',
    text: 'Omitted tool data',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  const question = store.enqueue(id, randomUUID(), 'Why did you say that?');
  const page = coordinator.inspect({ view: 'conversation', limit: 1 }) as {
    items: { id: string; text: string; truncated: boolean }[];
    total: number;
    nextOffset: number | null;
  };
  expect(page).toMatchObject({
    total: 2,
    nextOffset: 1,
    items: [{ id: question.id, text: 'Why did you say that?' }],
  });
  const older = coordinator.inspect({ view: 'conversation', offset: 1, limit: 1 }) as typeof page;
  expect(older.items[0]).toMatchObject({
    id: replyId,
    text: oldText.slice(0, 1000),
    truncated: true,
  });
  const chunk = coordinator.inspect({
    view: 'conversation',
    entryId: replyId,
    textOffset: 3000,
    textLimit: 8000,
  });
  expect(chunk).toMatchObject({
    text: oldText.slice(3000, 11000),
    nextTextOffset: 11000,
    totalCharacters: oldText.length,
  });
  expect(
    coordinator.inspect({
      view: 'conversation',
      entryId: replyId,
      textOffset: 11000,
      textLimit: 8000,
    }),
  ).toMatchObject({ text: oldText.slice(11000), nextTextOffset: null });
  const foreign = store.register(join(root, 'foreign'), 'Other', '');
  const foreignEntry = randomUUID();
  store.entry({
    id: foreignEntry,
    agentId: foreign.managerId,
    runId: null,
    kind: 'assistant',
    title: '',
    text: 'Other conversation',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  expect(() => coordinator.inspect({ view: 'conversation', entryId: foreignEntry })).toThrow(
    'saved entry',
  );
  expect(coordinator.context()).not.toHaveProperty('conversation');
});
it('renews automatic context only at an idle turn boundary and ages owner activity independently', async () => {
  const id = (await coordinator.start({ key: randomUUID() })).agentId!;
  store.updateAgent(id, { threadId: 'retained-native-thread' });
  const first = store.enqueue(id, randomUUID(), 'Owner question');
  store.updateRun(first.id, { status: 'completed' });
  vi.advanceTimersByTime(59 * 60_000);
  const automatic = store.enqueue(id, randomUUID(), 'Scheduled check', 'report');
  expect(coordinator.startsFresh(automatic)).toBe(true);
  store.updateRun(automatic.id, { status: 'completed' });
  const recent = store.enqueue(id, randomUUID(), 'Within the hour');
  expect(coordinator.startsFresh(recent)).toBe(false);
  store.updateRun(recent.id, { status: 'completed' });
  vi.advanceTimersByTime(60 * 60_000);
  const next = store.enqueue(id, randomUUID(), 'Owner returned');
  expect(coordinator.startsFresh(next)).toBe(true);
  expect(coordinator.startsFresh(automatic)).toBe(false); // Retain the queued owner's context.
  store.entry({
    id: randomUUID(),
    agentId: id,
    runId: recent.id,
    kind: 'message',
    title: 'Owner steering',
    text: 'A recent owner correction',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  expect(coordinator.startsFresh(next)).toBe(false);
  expect(
    coordinator.startsFresh({
      ...next,
      agentId: store.register(join(root, 'ordinary'), 'Ordinary', '').managerId,
    }),
  ).toBe(false);
});
it('owner allocation edits retain the original accounting baseline and prevent stale writes', async () => {
  const p = store.register(join(root, 'A'), 'A', '');
  const { agent, run } = await active();
  const window = coordinator.status().capacity[0]!.windows[0]!;
  const action = {
    action: 'budget',
    projectId: p.id,
    provider: 'codex',
    windowId: window.id,
    expectedRevision: 0,
    limitPercent: 10,
    reason: 'Owner allocation.',
  };
  coordinator.tool(agent.id, randomUUID(), 'dock_quark_control', action, run);
  const budget = quark.budgets()[0]!;
  coordinator.tool(
    agent.id,
    randomUUID(),
    'dock_quark_control',
    { ...action, expectedRevision: budget.revision, limitPercent: 20 },
    run,
  );
  expect(quark.budgets()[0]).toMatchObject({
    id: budget.id,
    startSequence: budget.startSequence,
    limitPercent: 20,
  });
  expect(() => coordinator.tool(agent.id, randomUUID(), 'dock_quark_control', action, run)).toThrow(
    /changed/,
  );
});
it('coalesces automatic wakes durably and never wakes an idle queue', async () => {
  const s = await coordinator.start({ key: randomUUID() });
  coordinator.tick();
  expect(store.runs()).toHaveLength(0);
  const p = store.register(join(root, 'A'), 'A', '');
  store.enqueue(p.managerId, randomUUID(), 'Work');
  vi.advanceTimersByTime(31_000);
  coordinator.tick();
  const wakes = store.runs().filter((r) => r.agentId === s.agentId);
  expect(wakes).toHaveLength(1);
  store.updateRun(wakes[0]!.id, { status: 'completed' });
  store.updateAgent(s.agentId!, { status: 'idle' });
  coordinator = new QuarkCoordinator(store, root, quark, pulsar, models);
  vi.advanceTimersByTime(6 * 60_000);
  coordinator.tick();
  expect(store.runs().filter((r) => r.agentId === s.agentId)).toHaveLength(1);
});
it('excludes projects with Follow QUARK off from automatic demand until restored', async () => {
  const s = await coordinator.start({ key: randomUUID() });
  const p = store.register(join(root, 'Independent'), 'Independent', '');
  const work = store.enqueue(p.managerId, randomUUID(), 'Saved project work');
  quark.saveProjectPolicy(p.id, { key: randomUUID(), enabled: false, expectedRevision: 0 });
  coordinator.tick();
  expect(store.runs().filter((r) => r.agentId === s.agentId)).toHaveLength(0);
  expect(store.run(work.id).status).toBe('queued');
  quark.saveProjectPolicy(p.id, { key: randomUUID(), enabled: true, expectedRevision: 1 });
  vi.advanceTimersByTime(31_000);
  coordinator.tick();
  expect(store.runs().filter((r) => r.agentId === s.agentId)).toHaveLength(1);
});
function zeroRate(projectId: string, provider: 'codex' | 'claude') {
  quark.saveBudget({
    key: randomUUID(),
    projectId,
    provider,
    windowId: 'secondary',
    period: 'hour',
    limitPercent: 0,
  });
}
function notify(agentId: string, run: ReturnType<typeof store.run>, projectId: string) {
  return coordinator.tool(
    agentId,
    randomUUID(),
    'dock_quark_control',
    { action: 'notify', projectId, reason: 'Spare Claude capacity.' },
    run,
  );
}
it('refuses automatic pause and advice for an opted-out project while retaining owner control', async () => {
  const p = store.register(join(root, 'Independent'), 'Independent', '');
  store.enqueue(p.managerId, randomUUID(), 'Saved project work');
  quark.saveProjectPolicy(p.id, { key: randomUUID(), enabled: false, expectedRevision: 0 });
  const { agent, run } = await active('report');
  const pause = {
    action: 'project' as const,
    projectId: p.id,
    expectedRevision: 0,
    paused: true,
    reason: 'Automatic slowdown',
  };
  expect(() => coordinator.tool(agent.id, randomUUID(), 'dock_quark_control', pause, run)).toThrow(
    /scheduling is off/,
  );
  expect(() => notify(agent.id, run, p.id)).toThrow(/scheduling is off/);
  expect(coordinator.projectPolicy(p.id).revision).toBe(0);
  expect(store.runs(['queued']).filter((r) => r.agentId === p.managerId)).toHaveLength(1);
  expect(coordinator.updateProjectPolicy(pause, true)).toMatchObject({ paused: true, revision: 1 });
});
it('never wakes or notifies a finished zero-limit project for its own pending notices', async () => {
  const s = await coordinator.start({ key: randomUUID() });
  const p = store.register(join(root, 'Thermal'), 'Thermal', '', 'codex');
  zeroRate(p.id, 'codex');
  zeroRate(p.id, 'claude');
  for (let i = 0; i < 3; i++)
    store.enqueue(p.managerId, randomUUID(), 'QUARK scheduling update', 'report', s.agentId);
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(31 * 60_000);
    coordinator.tick();
  }
  expect(store.runs().filter((r) => r.agentId === s.agentId)).toHaveLength(0);
  // Owner queue items are retained, never deleted or archived.
  expect(store.runs(['queued']).filter((r) => r.agentId === p.managerId)).toHaveLength(3);
  const { agent, run } = await active('report');
  expect(() => notify(agent.id, run, p.id)).toThrow(/Only the owner/);
});
it('rejects a notice when the manager provider is owner-blocked even with other provider work', async () => {
  const p = store.register(join(root, 'Mixed'), 'Mixed', '', 'codex');
  zeroRate(p.id, 'codex');
  const worker = store.addAgent({
    projectId: p.id,
    parentId: p.managerId,
    taskId: null,
    provider: 'claude',
    role: 'researcher',
    name: 'Worker',
    cwd: root,
  });
  store.enqueue(worker.id, randomUUID(), 'Useful Claude work');
  const { agent, run } = await active('report');
  expect(() => notify(agent.id, run, p.id)).toThrow(/Only the owner/);
  expect(store.runs(['queued']).filter((r) => r.agentId === p.managerId)).toHaveLength(0);
});
it('wakes on new material work only, coalesces pending notices and keeps owner notices', async () => {
  const s = await coordinator.start({ key: randomUUID() });
  const p = store.register(join(root, 'A'), 'A', '', 'codex');
  store.enqueue(p.managerId, randomUUID(), 'Work');
  vi.advanceTimersByTime(31_000);
  coordinator.tick();
  const wakes = () => store.runs().filter((r) => r.agentId === s.agentId);
  expect(wakes()).toHaveLength(1);
  expect(wakes()[0]!.text).toContain('Material change: 1 new unfinished work item');
  store.updateRun(wakes()[0]!.id, { status: 'completed' });
  store.updateAgent(s.agentId!, { status: 'idle' });
  // Elapsed reset-clock buckets and changed live percentages are not material.
  for (const used of [20, 35]) {
    vi.advanceTimersByTime(31 * 60_000);
    for (const provider of ['codex', 'claude'] as const)
      store.setSetting(
        `capacity:v1:${provider}`,
        parseCapacity(
          provider,
          [
            {
              provider,
              source: 'oauth',
              usage: {
                updatedAt: new Date().toISOString(),
                secondary: {
                  usedPercent: used,
                  windowMinutes: 10080,
                  resetsAt: new Date('2026-09-30T16:00:00Z').toISOString(),
                },
              },
            },
          ],
          Date.now(),
        ),
      );
    coordinator.tick();
  }
  expect(wakes()).toHaveLength(1);
  const { agent, run } = await active('report');
  notify(agent.id, run, p.id);
  expect(() => notify(agent.id, run, p.id)).toThrow(/still waiting/);
  store.updateRun(run.id, { status: 'completed' });
  store.updateAgent(agent.id, { status: 'idle' });
  vi.advanceTimersByTime(6 * 60_000);
  coordinator.tick();
  expect(wakes().filter((r) => r.kind === 'report' && r.status === 'queued')).toHaveLength(0);
  const owner = await active('user');
  expect(notify(owner.agent.id, owner.run, p.id)).toMatchObject({ saved: true });
  expect(
    store.runs(['queued']).filter((r) => r.agentId === p.managerId && r.kind === 'report'),
  ).toHaveLength(2);
});
