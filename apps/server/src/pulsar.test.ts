import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  jobEstimateSchema,
  pulsarPolicySchema,
  localJobSchema,
  type MachineCapacity,
} from '@dock/shared';
import { Store } from './store.js';
import { Pulsar } from './pulsar.js';
import { capacityMaxAge, parseCapacity } from './capacity.js';

let root: string, store: Store, pulsar: Pulsar, clock: number, machine: MachineCapacity;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-pulsar-'));
  store = new Store(join(root, 'dock.sqlite'));
  clock = Date.parse('2026-09-24T06:00:00Z');
  machine = {
    observedAt: new Date(clock).toISOString(),
    cpuCount: 8,
    cpuUsedPercent: 15,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryAvailableBytes: 16 * 1024 ** 3,
    diskAvailableBytes: 100 * 1024 ** 3,
    loadPerCore: 0.2,
  };
  pulsar = new Pulsar(
    store,
    () => machine,
    () => clock,
  );
  pulsar.savePolicy({
    key: randomUUID(),
    policy: pulsarPolicySchema.parse({ enabled: true, claudeConcurrent: 2 }),
  });
  usage(10);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it('keeps repeated queue reads and events bounded as completed history grows', () => {
  const old = job('History fixture');
  expect(pulsar.reserve(old.run)).toBe(true);
  store.updateRun(old.run.id, { status: 'completed' });
  pulsar.settle(old.run.id);
  const template = JSON.parse(
    String(store.db.prepare('SELECT body FROM pulsar_leases WHERE run_id=?').get(old.run.id)!.body),
  );
  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const run = store.enqueue(old.worker.id, randomUUID(), `Historic ${i}`);
    store.updateRun(run.id, { status: 'completed' });
    store.db
      .prepare('INSERT INTO pulsar_leases(run_id,body) VALUES(?,?)')
      .run(run.id, JSON.stringify({ ...template, runId: run.id, tokenBasis: 'measured' }));
    ids.push(run.id);
  }
  const estimate = vi.spyOn(pulsar, 'estimate');
  expect(pulsar.wantsForeground(new Set())).toBe(false);
  expect(estimate).not.toHaveBeenCalled();
  const settle = vi.spyOn(pulsar, 'settle');
  pulsar.reconcile(old.worker.id);
  expect(settle).toHaveBeenCalledTimes(1); // the original estimated lease, not 1000 settled ones
  const status = pulsar.status(old.project.id);
  expect(status.jobs).toEqual([]);
  expect(status.history.map((run) => run.runId)).toEqual(ids.slice(-30).reverse());
  expect(estimate).toHaveBeenCalledTimes(30);
});
function usage(percent: number, reset = clock + 300 * 60_000) {
  machine.observedAt = new Date(clock).toISOString();
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
              updatedAt: new Date(clock).toISOString(),
              primary: {
                usedPercent: percent,
                windowMinutes: 300,
                resetsAt: new Date(reset).toISOString(),
              },
            },
          },
        ],
        clock,
      ),
    );
}
function job(
  name: string,
  priority: 'normal' | 'background' | 'interactive' = 'normal',
  percent = 3,
) {
  const project = store.register(join(root, name), name, '');
  const task = store.addTask(project.id, {
    title: name,
    goal: 'Bounded work',
    acceptance: 'Observed result',
    parentId: null,
    scheduling: jobEstimateSchema.parse({ priority, quotaPercent: percent }),
  });
  const worker = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: task.id,
    role: 'researcher',
    name,
    cwd: root,
    provider: 'claude',
  });
  const queued = store.enqueue(
    worker.id,
    randomUUID(),
    'Investigate',
    'delegation',
    project.managerId,
  );
  return { run: store.run(queued.id), worker, task, project };
}
it('reserves shared provider headroom across managers before async starts and persists the reservation', () => {
  usage(70);
  const first = job('First', 'normal', 6),
    second = job('Second', 'normal', 6);
  expect(pulsar.reserve(first.run, new Set())).toBe(true);
  store.updateRun(first.run.id, { status: 'running' });
  expect(pulsar.decision(second.run).reason).toContain('reserved');
  expect(pulsar.reserve(second.run, new Set())).toBe(false);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(
    store,
    () => machine,
    () => clock,
  );
  expect(pulsar.reserve(second.run, new Set())).toBe(false);
});
it('finished work keeps its allowance reservation until a fresh delayed usage observation', () => {
  usage(70);
  const first = job('First', 'normal', 6),
    second = job('Second', 'normal', 6);
  pulsar.reserve(first.run, new Set());
  store.updateRun(first.run.id, { status: 'completed' });
  pulsar.settle(first.run.id);
  expect(pulsar.decision(second.run).eligible).toBe(false);
  clock += 60_000;
  usage(70);
  expect(pulsar.decision(second.run).eligible).toBe(true);
});
it('orders urgent work first, backgrounds yield and manager turns are fair at equal priority', () => {
  const background = job('Background', 'background'),
    normal = job('Normal'),
    urgent = job('Urgent', 'interactive');
  expect(pulsar.ordered([background.run, normal.run, urgent.run]).map((r) => r.id)).toEqual([
    urgent.run.id,
    normal.run.id,
    background.run.id,
  ]);
  expect(pulsar.decision(background.run).reason).toContain('yielding');
  const peer = job('Peer');
  pulsar.reserve(normal.run, new Set());
  expect(pulsar.ordered([normal.run, peer.run])[0]!.id).toBe(peer.run.id);
});
it('uses project priority for queued automatic work, retaining per-run choices and interactive owner turns', () => {
  const background = job('Project background'),
    normal = job('Project normal'),
    high = job('Project high');
  store.setSetting(`quark:project:${background.project.id}`, { priority: 'background' });
  store.setSetting(`quark:project:${high.project.id}`, { priority: 'high' });
  expect(pulsar.ordered([background.run, normal.run, high.run]).map((run) => run.id)).toEqual([
    high.run.id,
    normal.run.id,
    background.run.id,
  ]);
  expect(pulsar.decision(background.run).reason).toContain('yielding');
  const report = store.enqueue(
    background.project.managerId,
    randomUUID(),
    'Automatic continuation',
    'report',
  );
  expect(pulsar.estimate(report).priority).toBe('background');
  for (const kind of ['user', 'resume'] as const) {
    const direct = store.enqueue(background.project.managerId, randomUUID(), 'Owner request', kind);
    expect(pulsar.estimate(direct).priority).toBe('interactive');
  }
  pulsar.control({
    key: randomUUID(),
    runId: background.run.id,
    action: 'configure',
    estimate: jobEstimateSchema.parse({ priority: 'high', quotaPercent: 2 }),
  });
  expect(pulsar.estimate(background.run)).toMatchObject({ priority: 'high', quotaPercent: 2 });
  store.setSetting(`quark:project:${background.project.id}`, { priority: null });
  expect(pulsar.estimate(report).priority).toBe('normal');
  pulsar.savePolicy({ key: randomUUID(), policy: { ...pulsar.policy(), enabled: false } });
  expect(pulsar.ordered([normal.run, high.run])[0]!.id).toBe(high.run.id);
  expect(pulsar.policy().enabled).toBe(false);
});
it('keeps admitted estimates stable while the next turn inherits a changed project priority', () => {
  const value = job('Admitted');
  expect(pulsar.reserve(value.run, new Set())).toBe(true);
  store.updateRun(value.run.id, { status: 'running' });
  const before = store.db.prepare('SELECT body FROM pulsar_leases').all();
  store.setSetting(`quark:project:${value.project.id}`, { priority: 'background' });
  expect(pulsar.estimate(store.run(value.run.id)).priority).toBe('normal');
  expect(store.db.prepare('SELECT body FROM pulsar_leases').all()).toEqual(before);
  const followup = store.enqueue(
    value.worker.id,
    randomUUID(),
    'Next part',
    'message',
    value.project.managerId,
  );
  expect(pulsar.estimate(followup).priority).toBe('background');
});
it('applies background project policy to agent-dispatched local jobs while preserving owner interactive work', () => {
  const foreground = job('Foreground'),
    background = job('Local background project');
  store.updateRun(background.run.id, { status: 'completed' });
  store.setSetting(`quark:project:${background.project.id}`, { priority: 'background' });
  const local = localJobSchema.parse({
    id: randomUUID(),
    kind: 'youtube-transcription',
    projectId: background.project.id,
    taskId: null,
    requestedBy: background.project.managerId,
    url: 'https://youtu.be/abcdefghijk',
    resources: {},
    status: 'queued',
    phase: 'waiting',
    message: '',
    createdAt: new Date(clock).toISOString(),
    startedAt: null,
    finishedAt: null,
    autoPaused: false,
    attempt: 1,
    transcriptAvailable: false,
    expectedFinishAt: null,
  });
  expect(pulsar.localDecision(local, new Set()).reason).toContain('yielding');
  expect(pulsar.localDecision({ ...local, requestedBy: null }, new Set()).eligible).toBe(true);
  pulsar.control({ key: randomUUID(), runId: foreground.run.id, action: 'hold' });
  expect(pulsar.localDecision(local, new Set()).eligible).toBe(true);
});
it('waits on stale data and elapsed resets, then admits the same queued job after a verified reset', () => {
  const value = job('Patient');
  usage(98, clock + 60_000);
  expect(pulsar.decision(value.run).eligible).toBe(false);
  clock += 61_000;
  machine.observedAt = new Date(clock).toISOString();
  expect(pulsar.decision(value.run).reason).toContain('reset time has passed');
  usage(0);
  expect(pulsar.decision(value.run).eligible).toBe(true);
  clock += capacityMaxAge('claude') + 1;
  machine.observedAt = new Date(clock).toISOString();
  expect(pulsar.decision(value.run).reason).toContain('fresh shared usage');
  expect(store.runs()).toHaveLength(1);
});
it('does not let an unknown-usage override bypass a known exhausted or elapsed window', () => {
  const value = job('Known limit');
  pulsar.control({ key: randomUUID(), runId: value.run.id, action: 'override' });
  usage(100);
  clock += capacityMaxAge('claude') + 1;
  machine.observedAt = new Date(clock).toISOString();
  expect(pulsar.decision(value.run).reason).toContain('exhausted');

  usage(5, clock + 60_000);
  clock += 60_001;
  machine.observedAt = new Date(clock).toISOString();
  expect(pulsar.decision(value.run).reason).toContain('reset time has passed');

  store.setSetting('capacity:v1:claude', null);
  expect(pulsar.decision(value.run).eligible).toBe(true);
});
it('paces background five-hour consumption and keeps the owner reserve available to interactive work', () => {
  usage(20);
  const value = job('Slow', 'background', 4);
  expect(pulsar.decision(value.run).eligible).toBe(false);
  store.setSetting(
    `pulsar:estimate:${value.run.id}`,
    jobEstimateSchema.parse({ priority: 'interactive', quotaPercent: 4 }),
  );
  expect(pulsar.decision(value.run).eligible).toBe(true);
  usage(100);
  pulsar.control({ key: randomUUID(), runId: value.run.id, action: 'override' });
  expect(pulsar.decision(value.run).reason).toContain('cannot be overridden');
});
it('accounts for external CPU, memory and disk pressure and allows an explicit queued owner override', () => {
  const value = job('Resources');
  machine.cpuUsedPercent = 99;
  expect(pulsar.decision(value.run).reason).toContain('CPU');
  machine.cpuUsedPercent = 10;
  machine.memoryAvailableBytes = 128 * 1024 ** 2;
  expect(pulsar.decision(value.run).reason).toContain('memory');
  machine.memoryAvailableBytes = 16 * 1024 ** 3;
  machine.diskAvailableBytes = 0;
  expect(pulsar.decision(value.run).reason).toContain('disk');
  pulsar.control({ key: randomUUID(), runId: value.run.id, action: 'override' });
  expect(pulsar.decision(value.run).eligible).toBe(true);
});
it('holds task continuations at turn boundaries and does not cancel an already running turn', () => {
  const value = job('Paused');
  pulsar.reserve(value.run, new Set());
  store.updateRun(value.run.id, { status: 'running' });
  const input = { key: randomUUID(), runId: value.run.id, action: 'hold' };
  pulsar.control(input);
  const head = store.head;
  pulsar.control(input);
  expect(store.head).toBe(head);
  expect(store.run(value.run.id).status).toBe('running');
  expect(() =>
    pulsar.control({ key: randomUUID(), runId: value.run.id, action: 'cancel' }),
  ).toThrow('started');
  const followup = store.enqueue(
    value.worker.id,
    randomUUID(),
    'Next piece',
    'message',
    value.project.managerId,
  );
  expect(pulsar.decision(store.run(followup.id)).reason).toContain('Paused');
  pulsar.control({ key: randomUUID(), runId: followup.id, action: 'release' });
  expect(pulsar.decision(store.run(followup.id)).eligible).toBe(true);
});
it('retains conservative token accounting without blocking work on legacy token estimates across restart', () => {
  const value = job('Budget');
  store.updateTask(value.task.id, {
    scheduling: jobEstimateSchema.parse({ expectedTokens: 12_000, tokenBudget: 20_000 }),
  });
  pulsar.reserve(value.run, new Set());
  store.updateRun(value.run.id, { status: 'completed' });
  pulsar.settle(value.run.id);
  const followup = store.enqueue(
    value.worker.id,
    randomUUID(),
    'Next piece',
    'message',
    value.project.managerId,
  );
  expect(pulsar.decision(store.run(followup.id)).eligible).toBe(true);
  expect(pulsar.status().jobs[0]!.runId).toBe(followup.id);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(
    store,
    () => machine,
    () => clock,
  );
  expect(pulsar.decision(store.run(followup.id)).eligible).toBe(true);
  expect(pulsar.status().history.find((j) => j.runId === value.run.id)?.tokensCharged).toBe(12000);
});
it('attributes worker completion reports without blocking them on a raw-token estimate', () => {
  const value = job('Report budget');
  store.updateTask(value.task.id, {
    scheduling: jobEstimateSchema.parse({ expectedTokens: 12000, tokenBudget: 20000 }),
  });
  pulsar.reserve(value.run, new Set());
  store.updateRun(value.run.id, { status: 'completed' });
  pulsar.settle(value.run.id);
  const report = store.enqueue(
    value.project.managerId,
    randomUUID(),
    'Worker finished',
    'report',
    value.worker.id,
  );
  expect(pulsar.decision(store.run(report.id)).eligible).toBe(true);
  pulsar.control({
    key: randomUUID(),
    runId: report.id,
    action: 'configure',
    estimate: jobEstimateSchema.parse({ tokenBudget: 40000 }),
  });
  expect(store.task(value.task.id).scheduling.tokenBudget).toBe(40000);
  expect(pulsar.reserve(store.run(report.id), new Set())).toBe(true);
  expect(pulsar.status().jobs.find((j) => j.runId === report.id)?.taskId).toBe(value.task.id);
});
it('uses both general and Fable limits without blocking a different model on Fable alone', () => {
  const value = job('Fable');
  store.updateAgent(value.worker.id, { model: 'fable' });
  const report = parseCapacity(
    'claude',
    [
      {
        provider: 'claude',
        source: 'oauth',
        usage: {
          updatedAt: new Date(clock).toISOString(),
          primary: { usedPercent: 5, windowMinutes: 300 },
          extraRateWindows: [
            {
              id: 'fable',
              title: 'Fable weekly',
              window: { usedPercent: 99, windowMinutes: 10080 },
            },
          ],
        },
      },
    ],
    clock,
  );
  store.setSetting('capacity:v1:claude', report);
  expect(pulsar.decision(value.run).reason).toContain('Fable weekly');
  store.updateAgent(value.worker.id, { model: 'sonnet' });
  expect(pulsar.decision(value.run).eligible).toBe(true);
  store.setSetting('capacity:v1:claude', {
    ...report,
    windows: report.windows.map((w) => (w.scope === 'general' ? { ...w, usedPercent: 100 } : w)),
  });
  expect(pulsar.decision(value.run).reason).toContain('exhausted');
});
it('backfills around a held foreground job and requests preemption when CPU is occupied', () => {
  const slow = job('Backfill', 'background'),
    urgent = job('Urgent preemption', 'interactive');
  pulsar.control({ key: randomUUID(), runId: urgent.run.id, action: 'hold' });
  expect(pulsar.decision(slow.run).eligible).toBe(true);
  expect(pulsar.wantsForeground(new Set())).toBe(false);
  pulsar.control({ key: randomUUID(), runId: urgent.run.id, action: 'release' });
  machine.cpuUsedPercent = 99;
  expect(pulsar.decision(urgent.run).eligible).toBe(false);
  expect(pulsar.wantsForeground(new Set())).toBe(true);
  expect(pulsar.decision(slow.run).reason).toContain('yielding');
});

function diagnostic(name = 'Owner diagnosis') {
  const project = store.register(join(root, name), name, '', 'claude');
  store.updateAgent(project.managerId, {
    resourceAssistant: { mode: 'interactive', reason: 'asked' },
  });
  const queued = store.enqueue(project.managerId, randomUUID(), 'Why is my computer busy?');
  store.setSetting(
    `pulsar:estimate:${queued.id}`,
    jobEstimateSchema.parse({
      priority: 'interactive',
      cpuCores: 0.1,
      memoryMb: 256,
      quotaPercent: 1,
      expectedTokens: 6000,
      tokenBudget: 12000,
    }),
  );
  return store.run(queued.id);
}
it('admits one direct diagnosis despite busy CPU and occupied provider slots, without bypassing budgets or memory', () => {
  for (const name of ['one', 'two']) {
    const work = job(name);
    expect(pulsar.reserve(work.run, new Set())).toBe(true);
    store.updateRun(work.run.id, { status: 'running' });
  }
  machine.cpuUsedPercent = 99;
  const question = diagnostic();
  const ordinary = job('later', 'interactive');
  expect(pulsar.ordered([ordinary.run, question])[0]!.id).toBe(question.id);
  expect(pulsar.decision(ordinary.run).eligible).toBe(false);
  expect(pulsar.decision(question).eligible).toBe(true);
  machine.memoryAvailableBytes = 64 * 1024 ** 2;
  expect(pulsar.decision(question).reason).toContain('memory');
  machine.memoryAvailableBytes = 16 * 1024 ** 3;
  pulsar.allowanceDecision = () => 'The saved allowance cap is reached.';
  expect(pulsar.decision(question).eligible).toBe(false);
  pulsar.allowanceDecision = () => null;
  expect(pulsar.reserve(question, new Set())).toBe(true);
  store.updateRun(question.id, { status: 'running' });
  expect(pulsar.decision(diagnostic('Second question')).eligible).toBe(false);
});

it('admits an incident check alongside busy projects while checkpoints stay in the background', () => {
  for (const name of ['one', 'two']) {
    const work = job(name);
    expect(pulsar.reserve(work.run, new Set())).toBe(true);
    store.updateRun(work.run.id, { status: 'running' });
  }
  machine.cpuUsedPercent = 99;
  const check = diagnostic('Incident check');
  store.updateAgent(check.agentId, { resourceAssistant: { mode: 'snapshot', reason: 'pressure' } });
  store.setSetting(
    `pulsar:estimate:${check.id}`,
    jobEstimateSchema.parse({ priority: 'high', cpuCores: 0.1, memoryMb: 256, quotaPercent: 1 }),
  );
  expect(pulsar.decision(check).eligible).toBe(true);
  store.updateAgent(check.agentId, {
    resourceAssistant: { mode: 'snapshot', reason: 'checkpoint' },
  });
  expect(pulsar.decision(check).eligible).toBe(false);
});
