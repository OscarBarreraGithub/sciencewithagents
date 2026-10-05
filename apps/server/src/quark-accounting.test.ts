import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobEstimateSchema } from '@dock/shared';
import { Store } from './store.js';
import { Quark } from './quark.js';
import { Pulsar } from './pulsar.js';
import { parseCapacity } from './capacity.js';
import { recordClaudeUsage, recordCodexUsage } from './usage.js';

let root: string, store: Store, quark: Quark;
const start = Date.parse('2026-10-01T12:00:00Z');
const reset = start + 7 * 86400_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  root = mkdtempSync(join(tmpdir(), 'quark-accounting-'));
  store = new Store(join(root, 'dock.sqlite'));
  quark = new Quark(store, new Pulsar(store, () => null));
  reading('claude', 80);
  reading('codex', 80);
  quark.sync();
});
afterEach(() => {
  vi.useRealTimers();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function reading(
  provider: 'codex' | 'claude',
  usedPercent: number,
  windowMinutes = 10080,
  resetsAt: string | null = new Date(reset).toISOString(),
) {
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
            secondary: { usedPercent, windowMinutes, resetsAt },
          },
        },
      ],
      Date.now(),
    ),
  );
}
function work(name: string, provider: 'codex' | 'claude' = 'claude') {
  const project = store.register(join(root, name), name, '');
  const task = store.addTask(project.id, {
    title: name,
    goal: 'Work',
    acceptance: 'Evidence',
    parentId: null,
    scheduling: jobEstimateSchema.parse({
      expectedTokens: 1000,
      expectedSeconds: 60,
      quotaPercent: 1,
    }),
  });
  const agent = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: task.id,
    role: 'researcher',
    name,
    cwd: root,
    provider,
  });
  const run = store.enqueue(
    agent.id,
    randomUUID(),
    'Bounded fixture',
    'delegation',
    project.managerId,
  );
  quark.begin(store.run(run.id));
  store.updateRun(run.id, { status: 'running', turnId: run.id });
  store.updateAgent(agent.id, { status: 'running', turnId: run.id, threadId: randomUUID() });
  return { project, task, agent, run };
}
function tokens(f: ReturnType<typeof work>, input: number, output = 0, cached = 0, writes = 0) {
  const threadId = store.agent(f.agent.id).threadId;
  if (f.agent.provider === 'claude')
    recordClaudeUsage(store, f.agent.id, {
      sessionId: threadId,
      deliveryId: f.run.id,
      resultId: randomUUID(),
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: cached,
        cacheCreationInputTokens: writes,
      },
    });
  else
    recordCodexUsage(store, f.agent.id, {
      threadId,
      turnId: f.run.id,
      tokenUsage: {
        total: {
          totalTokens: input + output,
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
          cacheWriteInputTokens: writes,
          reasoningOutputTokens: output,
        },
        last: {
          totalTokens: input + output,
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
          cacheWriteInputTokens: writes,
          reasoningOutputTokens: output,
        },
      },
    });
}
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
function rate(f: ReturnType<typeof work>) {
  return quark
    .projectRates()
    .rates.find((r) => r.projectId === f.project.id && r.provider === f.agent.provider)!;
}

it.each([
  ['claude', 300_000],
  ['codex', 180_000],
] as const)(
  'attributes completed %s work until the next valid provider report, including after restart',
  (provider, interval) => {
    const f = work('Finished', provider);
    const cap = quark.saveBudget({
      key: randomUUID(),
      projectId: f.project.id,
      taskId: f.task.id,
      provider,
      windowId: 'secondary',
      limitPercent: 10,
    });
    tokens(f, 100);
    advance(1000);
    store.updateRun(f.run.id, { status: 'completed' });
    quark.sync();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    quark = new Quark(store, new Pulsar(store, () => null));
    advance(interval - 1000);
    reading(provider, 82);
    quark.sync();
    expect(quark.budgetStatus(cap).spentPercent).toBeCloseTo(2);
    expect(quark.budgetStatus(cap).reservedPercent).toBe(0);
    expect(quark.status().windows.find((w) => w.provider === provider)?.unattributedPercent).toBe(
      0,
    );
    quark.sync();
    expect(quark.budgetStatus(cap).spentPercent).toBeCloseTo(2);
    advance(interval);
    reading(provider, 83);
    quark.sync();
    expect(quark.budgetStatus(cap).spentPercent).toBeCloseTo(2);
    expect(quark.status().windows.find((w) => w.provider === provider)?.unattributedPercent).toBe(
      1,
    );
  },
);

it('uses exact wall milliseconds and full-window points, with no rate before five minutes', () => {
  const f = work('Rate');
  tokens(f, 100);
  quark.sync();
  advance(299_999);
  reading('claude', 80);
  quark.sync();
  expect(rate(f).estimatedPercentPerHour).toBeNull();
  advance(1001);
  reading('claude', 82);
  quark.sync();
  expect(rate(f).estimatedPercent).toBeCloseTo(2);
  expect(rate(f).estimatedPercentPerHour).toBeCloseTo((2 * 3600_000) / 301_000);
  expect(rate(f).estimatedPercentPerHour).not.toBeCloseTo((10 * 3600_000) / 301_000);
});

it.each([120, 300, 4320, 10080])(
  'keeps the %/h denominator independent of a %s-minute allowance',
  (minutes) => {
    reading('claude', 80, minutes);
    const f = work('Variable');
    tokens(f, 100);
    quark.sync();
    advance(300_000);
    reading('claude', 82, minutes);
    quark.sync();
    expect(rate(f).estimatedPercentPerHour).toBeCloseTo(24);
  },
);

it.each(['claude', 'codex'] as const)(
  'splits overlapping projects by %s cache/output evidence, without adding reasoning again',
  (provider) => {
    const a = work('Cache', provider),
      b = work('Output', provider);
    // Both providers yield 225 weighted units for A and 400 for B.
    tokens(a, provider === 'codex' ? 1100 : 0, 0, 1000, 100);
    tokens(b, 0, 100);
    quark.sync();
    advance(60_000);
    reading(provider, 90);
    quark.sync();
    const projects = quark.status().windows.find((w) => w.provider === provider)!.projects;
    expect(projects.find((p) => p.projectId === a.project.id)?.estimatedPercent).toBeCloseTo(
      (10 * 225) / 625,
    );
    expect(projects.find((p) => p.projectId === b.project.id)?.estimatedPercent).toBeCloseTo(
      (10 * 400) / 625,
    );
    expect(projects.reduce((n, p) => n + p.estimatedPercent, 0)).toBeCloseTo(10);
  },
);

it('retains background spending under both project and task caps when the project is paused and pacing is off', () => {
  const f = work('Background');
  store.setSetting('pulsar:policy', { enabled: false });
  store.setSetting(`quark:project:${f.project.id}`, { paused: true, priority: 'background' });
  const projectCap = quark.saveBudget({
    key: randomUUID(),
    projectId: f.project.id,
    taskId: null,
    provider: 'claude',
    windowId: 'secondary',
    limitPercent: 10,
  });
  const taskCap = quark.saveBudget({
    key: randomUUID(),
    projectId: f.project.id,
    taskId: f.task.id,
    provider: 'claude',
    windowId: 'secondary',
    limitPercent: 5,
  });
  tokens(f, 100);
  quark.sync();
  advance(60_000);
  reading('claude', 82);
  quark.sync();
  expect(quark.budgetStatus(projectCap).spentPercent).toBeCloseTo(2);
  expect(quark.budgetStatus(taskCap).spentPercent).toBeCloseTo(2);
  expect(quark.reason(store.run(f.run.id))).toContain('project is paused');
  expect(quark.status().windows.find((w) => w.provider === 'codex')?.projects).toEqual([]);
});

it.each([
  ['claude', 360_001],
  ['codex', 180_001],
] as const)(
  'keeps completed %s work unattributed beyond its report lifetime',
  (provider, interval) => {
    const f = work('Gap', provider);
    tokens(f, 100);
    advance(1000);
    store.updateRun(f.run.id, { status: 'completed' });
    quark.sync();
    advance(interval - 1000);
    reading(provider, 85);
    quark.sync();
    const window = quark.status().windows.find((w) => w.provider === provider)!;
    expect(window.unattributedPercent).toBe(5);
    expect(window.projects).toEqual([]);
  },
);

it('uses fractional elapsed work when counters are missing without inventing measured tokens', () => {
  const a = work('Unknown A');
  advance(500);
  const b = work('Unknown B');
  advance(500);
  reading('claude', 83);
  quark.sync();
  const projects = quark.status().windows.find((w) => w.provider === 'claude')!.projects;
  expect(projects.find((p) => p.projectId === a.project.id)?.estimatedPercent).toBeCloseTo(2);
  expect(projects.find((p) => p.projectId === b.project.id)?.estimatedPercent).toBeCloseTo(1);
  expect(quark.runs().every((r) => r.tokens.totalTokens === null && r.basis === 'unknown')).toBe(
    true,
  );
});

it('keeps completed projects and their overlapping task/project caps separate in one provider interval', () => {
  const a = work('A'),
    b = work('B');
  const caps = [a, b].flatMap((f) =>
    [null, f.task.id].map((taskId) =>
      quark.saveBudget({
        key: randomUUID(),
        projectId: f.project.id,
        taskId,
        provider: 'claude',
        windowId: 'secondary',
        limitPercent: 10,
      }),
    ),
  );
  tokens(a, 100);
  tokens(b, 300);
  advance(1000);
  for (const f of [a, b]) store.updateRun(f.run.id, { status: 'completed' });
  quark.sync();
  advance(299_000);
  reading('claude', 84);
  quark.sync();
  caps.forEach((cap, index) =>
    expect(quark.budgetStatus(cap).spentPercent).toBeCloseTo(index < 2 ? 1 : 3),
  );
});

it.each([new Date(reset).toISOString(), null])(
  'starts a new rate sample when usage regresses with reset %s',
  (resetsAt) => {
    advance(1);
    reading('claude', 80, 10080, resetsAt);
    quark.sync();
    const f = work('Regression');
    const cap = quark.saveBudget({
      key: randomUUID(),
      projectId: f.project.id,
      taskId: f.task.id,
      provider: 'claude',
      windowId: 'secondary',
      limitPercent: 10,
    });
    tokens(f, 100);
    quark.sync();
    advance(300_000);
    reading('claude', 82, 10080, resetsAt);
    quark.sync();
    expect(rate(f).estimatedPercentPerHour).toBeCloseTo(24);
    advance(60_000);
    reading('claude', 1, 10080, resetsAt);
    quark.sync();
    expect(quark.status().windows.find((w) => w.provider === 'claude')?.deltaPercent).toBe(0);
    expect(rate(f).estimatedPercentPerHour).toBeNull();
    expect(rate(f).estimatedPercent).toBe(0);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    quark = new Quark(store, new Pulsar(store, () => null));
    quark.sync();
    expect(rate(f).estimatedPercentPerHour).toBeNull();
    expect(quark.budgetStatus(cap).spentPercent).toBeCloseTo(2);
  },
);

it('forecasts account-wide reserve and exhaustion separately and compares the actual reset', () => {
  const f = work('Forecast');
  tokens(f, 100);
  quark.sync();
  advance(300_000);
  reading('claude', 82, 300);
  quark.sync();
  const rates = quark.projectRates();
  const account = rates.accounts.find((a) => a.provider === 'claude')!;
  expect(account.estimatedPercentPerHour).toBeCloseTo(24);
  expect(account.savedReservePercent).toBe(20);
  expect(account.reserveAt).toBe(account.observedAt); //18% remaining is already below20%
  expect(Date.parse(account.exhaustionAt!) - Date.parse(account.observedAt!)).toBeCloseTo(
    (18 / 24) * 3600_000,
  );
  expect(account.resetBeforeReserve).toBe(false);
  expect(
    rates.rates.find((r) => r.projectId === f.project.id && r.provider === 'claude')!.history,
  ).toHaveLength(24);
});
