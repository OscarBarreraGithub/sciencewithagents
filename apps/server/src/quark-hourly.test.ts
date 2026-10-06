import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobEstimateSchema, quarkStatusSchema } from '@dock/shared';
import { Store } from './store.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { parseCapacity } from './capacity.js';

let root: string, store: Store, pulsar: Pulsar, quark: Quark;
const start = Date.parse('2026-10-05T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  root = mkdtempSync(join(tmpdir(), 'quark-hourly-'));
  reopen();
  usage(10);
  quark.sync();
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function reopen() {
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  pulsar.allowanceDecision = (run) => quark.reason(run, run.status === 'queued');
}
function usage(percent: number, reset = start + 7 * 86400_000) {
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
                usedPercent: percent,
                windowMinutes: 10080,
                resetsAt: new Date(reset).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
}
function project() {
  return store.register(join(root, randomUUID()), 'Hourly fixture', '');
}
function work(
  p: ReturnType<typeof project>,
  provider: 'codex' | 'claude' = 'claude',
  parentId: string | null = null,
) {
  const task = store.addTask(p.id, {
    title: 'Bounded work',
    goal: 'Work',
    acceptance: 'Evidence',
    parentId,
    scheduling: jobEstimateSchema.parse({
      quotaPercent: 1,
      expectedTokens: 1000,
      expectedSeconds: 60,
    }),
  });
  const agent = store.addAgent({
    projectId: p.id,
    parentId: p.managerId,
    taskId: task.id,
    provider,
    role: 'researcher',
    name: 'Worker',
    cwd: root,
  });
  return {
    task,
    agent,
    run: store.enqueue(agent.id, randomUUID(), 'Work', 'delegation', p.managerId),
  };
}
function limit(p: ReturnType<typeof project>, percent = 3, taskId: string | null = null) {
  return quark.saveBudget({
    key: randomUUID(),
    projectId: p.id,
    taskId,
    provider: 'claude',
    windowId: 'secondary',
    period: 'hour',
    limitPercent: percent,
  });
}
function launch(w: ReturnType<typeof work>) {
  expect(pulsar.reserve(w.run, new Set())).toBe(true);
  quark.begin(w.run);
  store.updateRun(w.run.id, { status: 'running' });
}
function finish(w: ReturnType<typeof work>) {
  store.updateRun(w.run.id, { status: 'completed' });
  quark.sync();
  pulsar.settle(w.run.id);
}
function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

it('shares project hourly reservations across tasks and pending jobs, independently by provider, with pacing off', () => {
  const p = project(),
    cap = limit(p);
  const a = work(p),
    b = work(p),
    c = work(p),
    codex = work(p, 'codex');
  expect(pulsar.policy().enabled).toBe(false);
  // No provider startup/QUARK run yet: both reservations still consume the shared project limit.
  expect(pulsar.reserve(a.run, new Set())).toBe(true);
  expect(pulsar.reserve(a.run, new Set())).toBe(true);
  expect(pulsar.reserve(b.run, new Set())).toBe(true);
  expect(quark.budgetStatus(cap).reservedPercent).toBe(2);
  expect(pulsar.reserve(c.run, new Set())).toBe(false);
  expect(quark.block(c.run, true)?.cause).toBe('hourly');
  expect(pulsar.reserve(codex.run, new Set())).toBe(true);
  store.setSetting(`pulsar:override:${c.run.id}`, true);
  expect(pulsar.reserve(c.run, new Set())).toBe(false);
  store.close();
  reopen();
  expect(quark.budgetStatus(cap).reservedPercent).toBe(2);
  expect(pulsar.reserve(c.run, new Set())).toBe(false);
  quark.begin(a.run);
  expect(quark.budgetStatus(cap).reservedPercent).toBe(2); // not counted twice
});

it('replaces finished reservations with delayed attribution and keeps the last hour across resets/restarts', () => {
  const p = project(),
    cap = limit(p),
    a = work(p),
    b = work(p);
  launch(a);
  advance(60_000);
  finish(a);
  advance(120_000);
  expect(quark.budgetStatus(cap).reservedPercent).toBe(1); // Claude poll can lag >90s
  usage(12);
  quark.sync();
  expect(quark.budgetStatus(cap)).toMatchObject({ spentPercent: 2, reservedPercent: 0 });
  expect(pulsar.reserve(b.run, new Set())).toBe(false);
  advance(60_000);
  usage(0, start + 14 * 86400_000);
  quark.sync();
  expect(quark.budgetStatus(cap).spentPercent).toBe(2);
  store.close();
  reopen();
  expect(pulsar.reserve(b.run, new Set())).toBe(false);
  advance(3600_001);
  usage(0, start + 14 * 86400_000);
  quark.sync();
  expect(quark.budgetStatus(cap).spentPercent).toBe(0);
  expect(pulsar.reserve(b.run, new Set())).toBe(true);
});

it('retains uncertain completed estimates through missing readings and a reset instead of inventing spend', () => {
  const p = project(),
    cap = limit(p),
    a = work(p);
  launch(a);
  advance(60_000);
  finish(a);
  advance(600_000);
  usage(0, start + 14 * 86400_000);
  quark.sync();
  expect(quark.budgetStatus(cap)).toMatchObject({ spentPercent: 0, reservedPercent: 1 });
  store.close();
  reopen();
  expect(quark.budgetStatus(cap).reservedPercent).toBe(1);
  advance(3000_001);
  usage(0, start + 14 * 86400_000);
  quark.sync();
  expect(quark.budgetStatus(cap).reservedPercent).toBe(0);
});

it('enforces task ancestry and window caps together without letting edits, retries or managers reset the hour', () => {
  const p = project(),
    parent = work(p),
    cap = limit(p, 1.5, parent.task.id);
  const child = work(p, 'claude', parent.task.id),
    sibling = work(p);
  launch(child);
  expect(pulsar.reserve(parent.run, new Set())).toBe(false);
  expect(pulsar.reserve(sibling.run, new Set())).toBe(true);
  const request = {
    key: randomUUID(),
    id: cap.id,
    expectedRevision: cap.revision,
    projectId: p.id,
    taskId: cap.taskId,
    provider: cap.provider,
    windowId: cap.windowId,
    period: cap.period,
    limitPercent: 2,
  };
  const saved = quark.saveBudget(request);
  expect(quark.saveBudget(request)).toEqual(saved);
  expect(quark.budgetStatus(saved).reservedPercent).toBe(1);
  expect(() =>
    quark.saveBudget(
      { ...request, key: randomUUID(), expectedRevision: saved.revision, enabled: false },
      'manager',
    ),
  ).toThrow('Only the owner');
  expect(() =>
    quark.saveBudget({ ...request, key: randomUUID(), expectedRevision: cap.revision }),
  ).toThrow('changed');
  const disabled = quark.saveBudget({
    ...request,
    key: randomUUID(),
    expectedRevision: saved.revision,
    enabled: false,
  });
  expect(quark.budgetStatus(disabled).cause).toBeNull();
  quark.saveBudget({
    key: randomUUID(),
    projectId: p.id,
    provider: 'claude',
    windowId: 'secondary',
    limitPercent: 1,
  });
  expect(quark.block(parent.run, true)?.cause).toBe('budget');
});

it('stops an hourly overrun independently and recovers only after a confirmed stop and fresh capacity', () => {
  const p = project(),
    cap = limit(p),
    a = work(p);
  launch(a);
  advance(60_000);
  usage(12.6);
  quark.sync();
  expect(quark.block(store.run(a.run.id))?.cause).toBe('hourly');
  quark.hold(store.run(a.run.id), quark.reason(store.run(a.run.id))!, false, 'hourly');
  expect(store.getSetting(`quark:budget-paused:${cap.id}`)).toBeNull();
  store.updateRun(a.run.id, { status: 'interrupted' });
  quark.sync();
  pulsar.settle(a.run.id);
  advance(3600_001);
  usage(12.6);
  quark.sync();
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
  quark.acknowledgeStop(a.run.id);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
  expect(store.runs(['queued']).filter((r) => r.agentId === a.agent.id)).toHaveLength(1);
  expect(store.runs(['queued']).find((r) => r.agentId === a.agent.id)?.text).toContain(
    'Inspect retained progress',
  );
  expect(() => quarkStatusSchema.parse(quark.status())).not.toThrow();
});

it('bounds hourly attribution reads to the admitted run as historical intervals accumulate', () => {
  const p = project(),
    cap = limit(p),
    a = work(p);
  launch(a);
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO quark_intervals(receipt,body) VALUES(?,?)');
    for (let n = 0; n < 10_000; n++)
      insert.run(
        `old:${n}`,
        JSON.stringify({
          provider: 'claude',
          windowId: 'secondary',
          label: 'Weekly',
          resetsAt: null,
          observedAt: new Date(start - 180 * 86400_000 - (n + 1) * 60_000).toISOString(),
          delta: 1,
          unattributed: 0,
          allocations: [{ runId: a.run.id, projectId: p.id, taskIds: [a.task.id], percent: 1 }],
        }),
      );
  });
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT body FROM quark_intervals INDEXED BY quark_intervals_window_observed WHERE json_extract(body,'$.provider')=? AND json_extract(body,'$.windowId')=? AND json_extract(body,'$.observedAt')>=? AND id>? ORDER BY id",
    )
    .all('claude', 'secondary', new Date(start).toISOString(), 0);
  expect(plan.some((row) => String(row.detail).includes('quark_intervals_window_observed'))).toBe(
    true,
  );
  expect(quark.budgetStatus(cap).reservedPercent).toBe(1);
  expect(quark.budgetStatus(cap).reservedPercent).toBe(1);
  advance(60_000);
  usage(10.5);
  quark.sync();
  expect(quark.budgetStatus(cap)).toMatchObject({ spentPercent: 0.5, reservedPercent: 0.5 });
  expect(quark.budgetStatus(cap)).toMatchObject({ spentPercent: 0.5, reservedPercent: 0.5 });
});

it('zero pauses only the chosen project provider, survives retry/restart and preserves independent holds on raise', () => {
  const p = project(),
    a = work(p),
    c = work(p, 'codex');
  launch(a);
  const request = {
    key: randomUUID(),
    projectId: p.id,
    provider: 'claude',
    windowId: 'secondary',
    period: 'hour',
    limitPercent: 0,
  };
  const paused = quark.saveBudget(request);
  expect(quark.saveBudget(request)).toEqual(paused);
  expect(quark.block(store.run(a.run.id))?.reason).toContain('rate is 0%/hour');
  expect(pulsar.reserve(c.run, new Set())).toBe(true);
  const waiting = work(p);
  expect(pulsar.reserve(waiting.run, new Set())).toBe(false);
  quark.hold(store.run(a.run.id), quark.reason(store.run(a.run.id))!, false, 'hourly');
  store.updateRun(a.run.id, { status: 'interrupted' });
  quark.sync();
  pulsar.settle(a.run.id);
  store.close();
  reopen();
  expect(pulsar.reserve(waiting.run, new Set())).toBe(false);
  quark.saveBudget({
    ...request,
    key: randomUUID(),
    id: paused.id,
    expectedRevision: paused.revision,
    limitPercent: 5,
  });
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1); // no stop confirmation
  quark.acknowledgeStop(a.run.id);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1); // no new reading
  advance(60_000);
  usage(10);
  quark.sync();
  store.setSetting(`pulsar:held-task:${a.task.id}`, true);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
  store.setSetting(`pulsar:held-task:${a.task.id}`, false);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
  const continuation = store.runs(['queued']).filter((r) => r.agentId === a.agent.id);
  expect(continuation).toHaveLength(1);
  expect(continuation[0]!.text).toContain('Inspect retained progress');
  quark.recoverTransient(new Set());
  expect(store.runs(['queued']).filter((r) => r.agentId === a.agent.id)).toHaveLength(1);
  expect(() => quark.saveBudget({ ...request, key: randomUUID(), period: 'window' })).toThrow(
    'Only hourly',
  );
});

it('lowering a rate keeps consumed usage and reservations; raising fromzero cannot bypass window caps', () => {
  const p = project(),
    a = work(p),
    cap = limit(p, 10);
  launch(a);
  advance(60_000);
  usage(12);
  quark.sync();
  const fields = {
    id: cap.id,
    projectId: p.id,
    provider: cap.provider,
    windowId: cap.windowId,
    period: cap.period,
    taskId: cap.taskId,
  };
  const lower = quark.saveBudget({
    ...fields,
    key: randomUUID(),
    expectedRevision: cap.revision,
    limitPercent: 1,
  });
  expect(quark.budgetStatus(lower)).toMatchObject({ spentPercent: 2, cause: 'hourly' });
  const paused = quark.saveBudget({
    ...fields,
    key: randomUUID(),
    expectedRevision: lower.revision,
    limitPercent: 0,
  });
  const total = quark.saveBudget({
    key: randomUUID(),
    projectId: p.id,
    provider: 'claude',
    windowId: 'secondary',
    limitPercent: 0.5,
  });
  quark.hold(store.run(a.run.id), 'Saved rate zero', false, 'hourly');
  store.updateRun(a.run.id, { status: 'interrupted' });
  quark.sync();
  pulsar.settle(a.run.id);
  quark.acknowledgeStop(a.run.id);
  quark.saveBudget({
    ...fields,
    key: randomUUID(),
    expectedRevision: paused.revision,
    limitPercent: 10,
  });
  advance(60_000);
  usage(12.5);
  quark.sync();
  quark.recoverTransient(new Set());
  expect(quark.holds()[0]?.cause).toBe('budget');
  expect(quark.budgetStatus(total).cause).toBe('budget');
  expect(store.runs(['queued']).filter((r) => r.agentId === a.agent.id)).toHaveLength(0);
});

it('paces admission by weighted demand share only while a window runs fast, without startup deadlock', () => {
  const p1 = project(),
    a = work(p1);
  launch(a);
  for (let i = 1; i <= 10; i++) {
    advance(60_000);
    usage(10 + 0.2 * i);
    quark.sync();
  }
  const b = work(p1);
  // Pacing off keeps the existing queue behavior.
  expect(quark.block(store.run(b.run.id), true)).toBeNull();
  store.setSetting('pulsar:policy', { enabled: true, reservePercent: 5 });
  expect(quark.utilization().find((w) => w.provider === 'claude')?.state).toBe('fast');
  const share = (projectId: string) =>
    quark.projectRates().rates.find((r) => r.projectId === projectId && r.provider === 'claude')!
      .adaptive!;
  const alone = share(p1.id);
  expect(alone).toMatchObject({ state: 'ready', demandProjects: 1 });
  expect(alone.reason).toContain('admission currently follows this share');
  // About 2% of rolling attributed use exceeds a ~0.49%/hour share of the weekly headroom.
  const paced = quark.block(store.run(b.run.id), true);
  expect(paced).toMatchObject({ cause: 'headroom' });
  expect(paced?.reason).toContain('Pacing');
  expect(paced?.reason).toContain('no cap was saved');
  expect(quark.budgets()).toHaveLength(0);
  // Running work, owner messages and explicit per-job overrides are never paced.
  expect(quark.block(store.run(a.run.id))).toBeNull();
  const owner = store.enqueue(p1.managerId, randomUUID(), 'Owner question');
  expect(quark.block(owner, true)?.cause).not.toBe('headroom');
  store.setSetting(`pulsar:override:${b.run.id}`, true);
  expect(quark.block(store.run(b.run.id), true)).toBeNull();
  store.setSetting(`pulsar:override:${b.run.id}`, false);
  // A second project with no recent use can start one turn although 1% exceeds its share.
  const p2 = project(),
    c = work(p2);
  const shared = share(p1.id);
  expect(shared.demandProjects).toBe(2);
  expect(shared.percentPerHour!).toBeCloseTo(alone.percentPerHour! / 2, 2);
  expect(share(p2.id).percentPerHour!).toBeLessThan(1);
  expect(quark.block(store.run(c.run.id), true)).toBeNull();
  // A calmer reading ends pacing; no timer or model call is involved.
  finish(a);
  for (let i = 1; i <= 61; i++) {
    advance(60_000);
    usage(12);
    quark.sync();
  }
  expect(quark.utilization().find((w) => w.provider === 'claude')?.state).not.toBe('fast');
  expect(quark.block(store.run(b.run.id), true)).toBeNull();
});
