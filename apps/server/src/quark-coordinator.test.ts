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
