import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobEstimateSchema, quarkStatusSchema } from '@dock/shared';
import { Store } from './store.js';
import { Quark } from './quark.js';
import { Pulsar } from './pulsar.js';
import { parseCapacity } from './capacity.js';
import {
  beginClaudeUsageSession,
  recordClaudeStepUsage,
  recordClaudeUsage,
  recordCodexUsage,
} from './usage.js';

let root: string, store: Store, quark: Quark, pulsar: Pulsar;
const start = Date.parse('2026-09-27T12:00:00Z'),
  reset = start + 7 * 86400_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  root = mkdtempSync(join(tmpdir(), 'quark-ledger-'));
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  pulsar.allowanceDecision = (run) => quark.reason(run, run.status === 'queued');
  usage(6);
  quark.sync();
});
afterEach(() => {
  vi.useRealTimers();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function usage(n: number, resets = reset) {
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
                usedPercent: n,
                windowMinutes: 10080,
                resetsAt: new Date(resets).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
}
function fixture(name = 'One', provider: 'codex' | 'claude' = 'claude') {
  const p = store.register(join(root, name), name, '');
  const task = store.addTask(p.id, {
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
    projectId: p.id,
    parentId: p.managerId,
    taskId: task.id,
    role: 'researcher',
    name,
    cwd: root,
    provider,
  });
  const run = store.enqueue(agent.id, randomUUID(), 'Do bounded work', 'delegation', p.managerId);
  return { p, task, agent, run };
}
function launch(f: ReturnType<typeof fixture>) {
  quark.begin(store.run(f.run.id));
  store.updateRun(f.run.id, { status: 'running', turnId: f.run.id });
  store.updateAgent(f.agent.id, {
    threadId: store.agent(f.agent.id).threadId ?? randomUUID(),
    turnId: f.run.id,
    status: 'running',
  });
}
function claude(f: ReturnType<typeof fixture>, input: number, output = 0) {
  return recordClaudeUsage(store, f.agent.id, {
    sessionId: store.agent(f.agent.id).threadId,
    deliveryId: f.run.id,
    resultId: randomUUID(),
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
    },
  });
}
function budget(f: ReturnType<typeof fixture>, limitPercent = 10, task = true) {
  return quark.saveBudget({
    key: randomUUID(),
    projectId: f.p.id,
    taskId: task ? f.task.id : null,
    provider: f.agent.provider,
    windowId: 'secondary',
    limitPercent,
  });
}
function advance(ms = 60000) {
  vi.setSystemTime(Date.now() + ms);
}

it('retains per-run, agent and project counters without duplicate charges after reopen', () => {
  const f = fixture();
  launch(f);
  expect(claude(f, 100, 10).status).toBe('recorded');
  quark.sync();
  expect(quark.runs()[0]).toMatchObject({
    basis: 'partial',
    tokens: {
      totalTokens: 140,
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
    },
  });
  quark.sync();
  expect(quark.status().totals.find((t) => !t.agentId)?.tokens.totalTokens).toBe(140);
  store.updateRun(f.run.id, { status: 'completed' });
  quark.sync();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  quark.sync();
  expect(quark.runs()).toHaveLength(1);
  expect(quark.status().totals.find((t) => !t.agentId)?.tokens.totalTokens).toBe(140);
  expect(() => quarkStatusSchema.parse(quark.status())).not.toThrow();
});
it('Codex cumulative reports replace a run total and preserve cache/reasoning as subsets', () => {
  const f = fixture('Codex', 'codex');
  launch(f);
  const send = (n: number) =>
    recordCodexUsage(store, f.agent.id, {
      threadId: store.agent(f.agent.id).threadId,
      turnId: f.run.id,
      tokenUsage: {
        total: {
          totalTokens: n,
          inputTokens: n - 10,
          outputTokens: 10,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 5,
        },
        last: {
          totalTokens: 50,
          inputTokens: 40,
          outputTokens: 10,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 5,
        },
      },
    });
  send(100);
  send(150);
  send(150);
  quark.sync();
  expect(quark.runs()[0]!.tokens.totalTokens).toBe(150);
  store.updateRun(f.run.id, { status: 'completed' });
  store.updateAgent(f.agent.id, { status: 'idle', turnId: null });
  const next = store.enqueue(f.agent.id, randomUUID(), 'Follow up');
  quark.begin(store.run(next.id));
  store.updateRun(next.id, { status: 'running', turnId: next.id });
  store.updateAgent(f.agent.id, { turnId: next.id });
  recordCodexUsage(store, f.agent.id, {
    threadId: store.agent(f.agent.id).threadId,
    turnId: next.id,
    tokenUsage: {
      total: {
        totalTokens: 210,
        inputTokens: 190,
        outputTokens: 20,
        cachedInputTokens: 40,
        reasoningOutputTokens: 10,
      },
      last: {
        totalTokens: 60,
        inputTokens: 50,
        outputTokens: 10,
        cachedInputTokens: 20,
        reasoningOutputTokens: 5,
      },
    },
  });
  quark.sync();
  expect(quark.runs()[1]!.tokens.totalTokens).toBe(60);
  expect(quark.status().totals.find((t) => !t.agentId)?.tokens.totalTokens).toBe(210);
});
it('native helper inherited totals yield a partial slice and cannot inflate parent project totals', () => {
  const f = fixture('Native', 'codex');
  store.updateAgent(f.agent.id, { nativeRootId: f.p.managerId, threadId: randomUUID() });
  launch(f);
  const send = (total: number) =>
    recordCodexUsage(store, f.agent.id, {
      threadId: store.agent(f.agent.id).threadId,
      turnId: f.run.id,
      tokenUsage: {
        total: {
          totalTokens: total,
          inputTokens: total - 10,
          outputTokens: 10,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 40,
          inputTokens: 30,
          outputTokens: 10,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    });
  send(1000);
  quark.sync();
  send(1030);
  quark.sync();
  expect(quark.runs()[0]).toMatchObject({ basis: 'partial', tokens: { totalTokens: 70 } });
  expect(quark.status().totals.every((t) => t.agentId !== null)).toBe(true);
});
it('allocates shared window deltas among three projects and records unexplained intervals', () => {
  advance();
  usage(7);
  quark.sync();
  expect(quark.status().windows[0]!.unattributedPercent).toBe(1);
  const a = fixture('A'),
    b = fixture('B'),
    c = fixture('C');
  for (const f of [a, b, c]) launch(f);
  claude(a, 100);
  claude(b, 200);
  claude(c, 300);
  quark.sync();
  advance();
  usage(27);
  quark.sync();
  const w = quark.status().windows.find((w) => w.provider === 'claude')!;
  expect(w.projects).toHaveLength(3);
  expect(w.projects.reduce((n, p) => n + p.estimatedPercent, 0)).toBeCloseTo(20);
  expect(w.projects.find((p) => p.projectId === c.p.id)!.estimatedPercent).toBeGreaterThan(
    w.projects.find((p) => p.projectId === a.p.id)!.estimatedPercent,
  );
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM quark_intervals').get()!.n;
  quark.sync();
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM quark_intervals').get()!.n).toBe(rows);
  expect(() => store.db.exec('DELETE FROM quark_intervals')).toThrow('append-only');
});
it('enforces task caps across descendants, ordinary overrides and disabled pacing; reset does not refill', () => {
  const f = fixture();
  const cap = budget(f, 5);
  launch(f);
  claude(f, 100);
  quark.sync();
  advance();
  usage(11);
  quark.sync();
  expect(quark.budgetStatus(cap).spentPercent).toBe(5);
  expect(quark.reason(store.run(f.run.id))).toContain('budget');
  expect(pulsar.status(f.p.id).jobs.find((job) => job.runId === f.run.id)).toMatchObject({
    eligible: false,
    reason: quark.reason(store.run(f.run.id)),
  });
  const child = store.addTask(f.p.id, {
    title: 'Child',
    goal: 'Work',
    acceptance: 'Evidence',
    parentId: f.task.id,
  });
  const worker = store.addAgent({
    projectId: f.p.id,
    taskId: child.id,
    parentId: f.p.managerId,
    role: 'researcher',
    name: 'Child',
    cwd: root,
    provider: 'claude',
  });
  const run = store.enqueue(worker.id, randomUUID(), 'Child work');
  store.setSetting(`pulsar:override:${run.id}`, true);
  expect(pulsar.decision(store.run(run.id)).eligible).toBe(false);
  advance();
  usage(0, reset + 7 * 86400_000);
  quark.sync();
  expect(quark.budgetStatus(cap).spentPercent).toBe(5);
  expect(pulsar.decision(store.run(run.id)).eligible).toBe(false);
});
it('reserves concurrent work once and keeps provider-specific budgets separate', () => {
  const f = fixture();
  budget(f, 2, false);
  launch(f);
  const worker = store.addAgent({
    projectId: f.p.id,
    parentId: f.p.managerId,
    taskId: f.task.id,
    role: 'researcher',
    name: 'Other',
    cwd: root,
    provider: 'claude',
  });
  const run = store.enqueue(worker.id, randomUUID(), 'More');
  expect(pulsar.decision(store.run(run.id)).eligible).toBe(false);
  const codex = store.addAgent({
    projectId: f.p.id,
    parentId: f.p.managerId,
    taskId: f.task.id,
    role: 'researcher',
    name: 'Codex',
    cwd: root,
    provider: 'codex',
  });
  const codexRun = store.enqueue(codex.id, randomUUID(), 'Other provider');
  expect(pulsar.decision(store.run(codexRun.id)).eligible).toBe(true);
});
it('only owner can extend a cap, receipts survive retries and concurrent updates conflict', () => {
  const f = fixture(),
    saved = budget(f);
  const input = {
    key: randomUUID(),
    id: saved.id,
    expectedRevision: saved.revision,
    projectId: f.p.id,
    taskId: f.task.id,
    provider: 'claude',
    windowId: 'secondary',
    limitPercent: 12,
  };
  expect(() => quark.saveBudget(input, 'manager')).toThrow('Only the owner');
  const next = quark.saveBudget(input);
  expect(quark.saveBudget(input)).toEqual(next);
  expect(() => quark.saveBudget({ ...input, key: randomUUID(), limitPercent: 15 })).toThrow(
    'Reload',
  );
  expect(() => quark.saveBudget({ ...input, id: undefined, key: randomUUID() })).toThrow(
    'already has',
  );
});
it('retains a pause and queued messages over restart; release requires fresh capacity and creates no duplicate work', () => {
  const f = fixture();
  budget(f, 10);
  launch(f);
  const queued = store.enqueue(f.agent.id, randomUUID(), 'An unsent message');
  quark.hold(store.run(f.run.id), 'Budget reached');
  store.updateRun(f.run.id, { status: 'interrupted' });
  store.updateAgent(f.agent.id, { status: 'interrupted', turnId: null });
  quark.sync();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  expect(quark.holds()).toHaveLength(1);
  expect(store.run(queued.id).status).toBe('queued');
  advance(7 * 60000);
  expect(() => quark.release(f.run.id)).toThrow('fresh');
  usage(6);
  quark.sync();
  quark.release(f.run.id);
  expect(quark.holds()).toHaveLength(0);
  expect(store.runs()).toHaveLength(2);
  expect(() => quark.release(f.run.id)).toThrow('already');
});
it('does not invent a weekly window or treat stale unknown usage as permission', () => {
  const f = fixture();
  store.setSetting('capacity:v1:claude', null);
  expect(() => budget(f)).toThrow('reported allowance');
  usage(6);
  budget(f);
  advance(7 * 60000);
  expect(quark.reason(store.run(f.run.id))).toContain('fresh');
});
it('turns cache warming off for new and existing installs without changing caps or history', () => {
  expect(quark.settings().cacheEnabled).toBe(false);
  const f = fixture();
  const cap = budget(f);
  const previous = { ...quark.settings(), cacheEnabled: true, bufferPercent: 3, revision: 7 };
  store.setSetting('quark:settings', previous);
  const restarted = new Quark(store, pulsar);
  expect(restarted.settings()).toEqual({ ...previous, cacheEnabled: false, revision: 8 });
  expect(restarted.budgets()[0]).toMatchObject({ id: cap.id, limitPercent: 10 });
  expect(store.task(f.task.id).title).toBe(f.task.title);
  expect(() =>
    restarted.saveSettings({
      key: randomUUID(),
      settings: { ...restarted.settings(), cacheEnabled: true },
    }),
  ).toThrow('deferred');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(new Quark(store, new Pulsar(store, () => null)).settings()).toMatchObject({
    cacheEnabled: false,
    bufferPercent: 3,
    revision: 8,
  });
});
it('Codex cache expiry stays unknown until configured and cache settings preserve concurrent-device protection', () => {
  const f = fixture('Codex', 'codex');
  launch(f);
  expect(quark.cacheStatus()[0]!.estimatedExpiresAt).toBeNull();
  const settings = { ...quark.settings(), cacheMinutes: { claude: 60, codex: 30 } };
  quark.saveSettings({ key: randomUUID(), settings });
  expect(quark.cacheStatus()[0]!.estimatedExpiresAt).not.toBeNull();
  expect(() => quark.saveSettings({ key: randomUUID(), settings })).toThrow('another device');
});

it('keeps a model-specific allowance independent and latches a spent grant across new workers', () => {
  const f = fixture();
  store.updateAgent(f.agent.id, { model: 'sonnet' });
  const capacity = parseCapacity(
    'claude',
    [
      {
        provider: 'claude',
        source: 'oauth',
        usage: {
          updatedAt: new Date().toISOString(),
          primary: {
            usedPercent: 6,
            windowMinutes: 300,
            resetsAt: new Date(start + 300 * 60000).toISOString(),
          },
          extraRateWindows: [
            {
              id: 'fable',
              title: 'Fable',
              window: {
                usedPercent: 80,
                windowMinutes: 10080,
                resetsAt: new Date(reset).toISOString(),
              },
            },
          ],
        },
      },
    ],
    Date.now(),
  );
  store.setSetting('capacity:v1:claude', capacity);
  quark.sync();
  const cap = quark.saveBudget({
    key: randomUUID(),
    projectId: f.p.id,
    taskId: f.task.id,
    provider: 'claude',
    windowId: 'extra:fable',
    limitPercent: 0.5,
  });
  expect(quark.reason(store.run(f.run.id), true)).toBeNull();
  store.updateAgent(f.agent.id, { model: 'fable' });
  expect(quark.reason(store.run(f.run.id), true)).toContain('remaining');
  launch(f);
  quark.hold(store.run(f.run.id), 'Budget reached');
  store.updateRun(f.run.id, { status: 'interrupted' });
  store.updateAgent(f.agent.id, { status: 'interrupted', turnId: null });
  quark.sync();
  advance(120000);
  capacity.observedAt = new Date().toISOString();
  store.setSetting('capacity:v1:claude', capacity);
  quark.sync();
  expect(quark.budgetStatus(cap).reason).toContain('grant is paused');
  const worker = store.addAgent({
    projectId: f.p.id,
    parentId: f.p.managerId,
    taskId: f.task.id,
    role: 'researcher',
    name: 'Replacement',
    cwd: root,
    provider: 'claude',
  });
  store.updateAgent(worker.id, { model: 'fable' });
  const run = store.enqueue(worker.id, randomUUID(), 'Do not evade the pause');
  expect(quark.reason(store.run(run.id))).toContain('grant is paused');
});

it('leaves long sampling gaps unattributed instead of charging a returning project for outside work', () => {
  const f = fixture();
  launch(f);
  claude(f, 100);
  quark.sync();
  advance(20 * 60000);
  usage(26);
  quark.sync();
  const w = quark.status().windows.find((w) => w.provider === 'claude')!;
  expect(w.unattributedPercent).toBe(20);
  expect(w.projects).toEqual([]);
});

it('requires admission and a signed manager lease, rejects tampering, and fences leases on restart', () => {
  const f = fixture('Lease');
  const run = store.enqueue(f.p.managerId, randomUUID(), 'Orchestrate');
  expect(() => quark.issueManagerLease(store.run(run.id))).toThrow('admit');
  expect(pulsar.reserve(store.run(run.id), new Set())).toBe(true);
  quark.issueManagerLease(store.run(run.id));
  store.updateRun(run.id, { status: 'running' });
  const key = `quark:manager-lease:${run.id}`;
  const signed = store.getSetting(key) as { lease: { projectId: string }; signature: string };
  expect(quark.requireManagerLease(store.run(run.id)).managerId).toBe(f.p.managerId);
  store.setSetting(key, { ...signed, lease: { ...signed.lease, projectId: randomUUID() } });
  expect(() => quark.requireManagerLease(store.run(run.id))).toThrow('signed');
  store.setSetting(key, signed);
  const next = store.enqueue(f.p.managerId, randomUUID(), 'Another turn');
  store.setSetting(`quark:manager-lease:${next.id}`, signed);
  store.updateRun(next.id, { status: 'running' });
  expect(() => quark.requireManagerLease(store.run(next.id))).toThrow('signed');
  const restarted = new Quark(store, pulsar);
  expect(() => restarted.requireManagerLease(store.run(run.id))).toThrow('signed');
  store.updateRun(run.id, { status: 'completed' });
  expect(() => quark.requireManagerLease(store.run(run.id))).toThrow('active');
});

it('only host heartbeats renew unexpired manager leases and recheck current allowance holds', () => {
  const f = fixture('Lease renewal');
  const run = store.enqueue(f.p.managerId, randomUUID(), 'Orchestrate');
  pulsar.reserve(store.run(run.id), new Set());
  quark.issueManagerLease(store.run(run.id));
  store.updateRun(run.id, { status: 'running' });
  const original = quark.requireManagerLease(store.run(run.id));
  advance(20_000);
  expect(quark.requireManagerLease(store.run(run.id)).expiresAt).toBe(original.expiresAt);
  expect(quark.renewManagerLease(store.run(run.id))).toBeNull();
  const extended = quark.requireManagerLease(store.run(run.id));
  expect(Date.parse(extended.expiresAt)).toBeGreaterThan(Date.parse(original.expiresAt));
  quark.hold(store.run(run.id), 'Owner budget pause');
  expect(quark.renewManagerLease(store.run(run.id))).toContain('pause');
  expect(() => quark.requireManagerLease(store.run(run.id))).toThrow('pause');
  advance(61_000);
  expect(quark.renewManagerLease(store.run(run.id))).toContain('expired');
});

function failedReading(provider: 'codex' | 'claude' = 'claude') {
  store.setSetting(`capacity:v1:${provider}`, {
    ...(store.getSetting(`capacity:v1:${provider}`) as object),
    state: 'error',
    stale: true,
  });
}
function confirmedStop(f: ReturnType<typeof fixture>) {
  store.updateRun(f.run.id, { status: 'interrupted' });
  store.updateAgent(f.agent.id, { status: 'interrupted', turnId: null });
  quark.acknowledgeStop(f.run.id);
  quark.sync();
}
it('blocks admission on a failed refresh but gives admitted work only the remaining six-minute Claude reading lifetime', () => {
  const f = fixture();
  budget(f);
  launch(f);
  advance(60_000);
  failedReading();
  expect(quark.block(store.run(f.run.id))).toBeNull();
  expect(quark.block(store.run(f.run.id), true)?.cause).toBe('monitoring');
  advance(299_999);
  expect(quark.block(store.run(f.run.id))).toBeNull();
  advance(1);
  expect(quark.block(store.run(f.run.id))?.cause).toBe('monitoring');
});
it('recovers a monitoring hold once after a fresh reading and a confirmed stop, across restart', () => {
  const f = fixture();
  budget(f);
  launch(f);
  advance(180_000);
  failedReading();
  quark.hold(store.run(f.run.id), 'Collector unavailable', false, 'monitoring');
  advance(60_000);
  usage(6);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1); // Stop request alone cannot acknowledge delivery.
  confirmedStop(f);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  quark.recoverTransient(new Set([f.agent.id]));
  expect(quark.holds()).toHaveLength(1); // Native terminal or another owner controls input.
  quark.recoverTransient(new Set());
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
  const next = store.runs().filter((r) => r.agentId === f.agent.id && r.status === 'queued');
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ kind: 'resume' });
  expect(next[0]!.id).not.toBe(f.run.id);
  expect(next[0]!.text).toContain('Do not repeat side effects');
  expect(store.run(f.run.id).status).toBe('interrupted');
  expect(store.events().filter((e) => e.type === 'quark.resumed')).toHaveLength(1);
});
it('never classifies a known exhausted grant as a telemetry outage, or auto-clears a latched budget', () => {
  const f = fixture();
  const b = budget(f, 1);
  launch(f);
  failedReading();
  expect(quark.block(store.run(f.run.id))?.cause).toBe('budget');
  quark.hold(store.run(f.run.id), 'Monitoring', false, 'monitoring');
  confirmedStop(f);
  advance(180_000);
  usage(6);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
  expect(quark.holds()[0]?.cause).toBe('budget');
  expect(quark.budgetStatus(b).reason).toContain('grant is paused');
});
it('promotes a capacity hold when delayed spending exhausts its cap, retaining the stop receipt across restart', () => {
  pulsar.savePolicy({
    key: randomUUID(),
    policy: { ...pulsar.policy(), enabled: true, reservePercent: 5 },
  });
  advance();
  usage(92);
  quark.sync();
  const f = fixture();
  const b = budget(f);
  launch(f);
  const sessionId = store.agent(f.agent.id).threadId!;
  beginClaudeUsageSession(store, f.agent.id, sessionId, false);
  const progress = (messageId: string) =>
    expect(
      recordClaudeStepUsage(store, f.agent.id, {
        sessionId,
        deliveryId: f.run.id,
        messageId,
        usage: {
          inputTokens: 2000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }).status,
    ).toBe('recorded');
  progress('before-stop');
  quark.sync();
  advance();
  usage(95);
  quark.sync();
  const block = quark.block(store.run(f.run.id))!;
  expect(block.cause).toBe('headroom');
  quark.hold(store.run(f.run.id), block.reason, false, block.cause);
  progress('while-stopping'); // Final input evidence arrives before the group stops.
  confirmedStop(f);
  const paused = quark.holds()[0]!;
  advance();
  usage(100); // The fresh allowance report catches up with the final work.
  quark.sync();
  expect(quark.budgetStatus(b).spentPercent).toBeCloseTo(8);
  quark.recoverTransient(new Set());
  quark.recoverTransient(new Set());
  expect(quark.holds()[0]).toMatchObject({
    cause: 'budget',
    reason: expect.stringContaining('budget'),
    createdAt: paused.createdAt,
    stopAcknowledgedAt: paused.stopAcknowledgedAt,
  });
  expect(store.events().filter((e) => e.type === 'quark.pause_changed')).toHaveLength(1);
  expect(store.runs()).toHaveLength(1);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  advance();
  usage(0, reset + 7 * 86400_000); // A verified reset does not refill the task's grant.
  quark.sync();
  const raised = quark.saveBudget({
    key: randomUUID(),
    id: b.id,
    expectedRevision: b.revision,
    projectId: b.projectId,
    taskId: b.taskId,
    provider: b.provider,
    windowId: b.windowId,
    limitPercent: 50,
  });
  quark.recoverTransient(new Set());
  expect(quark.holds()[0]?.cause).toBe('budget');
  expect(quark.budgetStatus(raised).reason).toContain('grant is paused');
  expect(store.runs()).toHaveLength(1);
  quark.release(f.run.id);
  expect(quark.holds()).toHaveLength(0);
  expect(quark.budgetStatus(raised).reason).toBeNull();
  expect(store.runs().filter((r) => r.kind === 'resume')).toHaveLength(1);
});
it('keeps explicit, legacy and manager pauses explicit, including a manual pause during an outage', () => {
  const f = fixture();
  launch(f);
  quark.hold(store.run(f.run.id), 'Monitoring', false, 'monitoring');
  confirmedStop(f);
  quark.hold(store.run(f.run.id), 'Manager requested pause: Keep this stopped');
  advance();
  usage(6);
  quark.recoverTransient(new Set());
  expect(quark.holds()[0]?.cause).toBe('manual');
  const saved = quark.holds()[0]!;
  const { cause: _cause, stopAcknowledgedAt: _ack, ...legacy } = saved;
  store.setSetting(`quark:hold:${f.run.id}`, legacy);
  expect(quark.holds()[0]?.cause).toBe('manual');
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
});
it('does not mistake recovery of an uncertain running turn for a provider stop acknowledgement', () => {
  const f = fixture();
  launch(f);
  quark.hold(store.run(f.run.id), 'Waiting for usage', false, 'monitoring');
  store.recover();
  advance();
  usage(6);
  quark.recoverTransient(new Set());
  expect(quark.holds()[0]?.stopAcknowledgedAt).toBeNull();
  expect(store.runs()).toHaveLength(1);
});
it('does not freeze a conversation or repeat a cache nudge after its bounded turn stops', () => {
  const f = fixture();
  store.setSetting(`quark:nudge:${f.run.id}`, true);
  launch(f);
  quark.hold(store.run(f.run.id), 'Cache time bound', false, 'cache');
  confirmedStop(f);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
  expect(store.agent(f.agent.id).status).toBe('idle');
  expect(store.runs()).toHaveLength(1);
});
it('recovers interrupted context compaction without launching new assignment work', () => {
  const f = fixture();
  store.setSetting(`quark:compaction:${f.run.id}`, true);
  launch(f);
  quark.hold(store.run(f.run.id), 'Collector unavailable', false, 'monitoring');
  confirmedStop(f);
  advance();
  usage(6);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
  expect(store.agent(f.agent.id).status).toBe('idle');
  expect(store.runs()).toHaveLength(1);
  expect(store.run(f.run.id).status).toBe('interrupted');
});
it('requires a newly verified reset, even inside the last-reading grace period', () => {
  const f = fixture();
  budget(f);
  usage(6, start + 60_000);
  launch(f);
  advance(60_000);
  failedReading();
  expect(quark.block(store.run(f.run.id))?.cause).toBe('reset');
  quark.hold(store.run(f.run.id), 'Waiting for reset', false, 'reset');
  confirmedStop(f);
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(1);
  advance();
  usage(0);
  quark.sync();
  quark.recoverTransient(new Set());
  expect(quark.holds()).toHaveLength(0);
});
it('keeps reset-clock jitter in one window and reports distinct project rates over the observation interval', () => {
  const f = fixture('Rate');
  launch(f);
  claude(f, 100);
  quark.sync();
  advance(300_000);
  usage(8, reset + 400);
  quark.sync();
  const window = quark.status().windows.find((value) => value.provider === 'claude')!;
  expect(window.deltaPercent).toBe(2);
  expect(window.projects.find((value) => value.projectId === f.p.id)?.estimatedPercent).toBeCloseTo(
    2,
  );
  const rate = quark
    .projectRates()
    .rates.find((value) => value.provider === 'claude' && value.projectId === f.p.id)!;
  expect(rate.estimatedPercentPerHour).toBeCloseTo(24);
  expect(rate.from).toBe(new Date(start).toISOString());
  advance(60_000);
  usage(1, reset + 7 * 86400_000);
  quark.sync();
  expect(
    quark
      .projectRates()
      .rates.find((value) => value.provider === 'claude' && value.projectId === f.p.id)
      ?.estimatedPercentPerHour,
  ).toBeNull();
});

it('reports spare five-hour capacity using account-wide readings without granting extra budget', () => {
  const sessionReset = start + 5 * 3600_000;
  const setSession = (used: number, end = sessionReset) => {
    store.setSetting(
      'capacity:v1:claude',
      parseCapacity(
        'claude',
        [
          {
            provider: 'claude',
            source: 'oauth',
            usage: {
              updatedAt: new Date().toISOString(),
              primary: {
                usedPercent: used,
                windowMinutes: 300,
                resetsAt: new Date(end).toISOString(),
              },
            },
          },
        ],
        Date.now(),
      ),
    );
    quark.sync();
  };
  setSession(5);
  vi.setSystemTime(start + 30 * 60_000);
  setSession(10);
  const policy = pulsar.policy();
  const spare = quark.utilization().find((row) => row.provider === 'claude')!;
  expect(spare).toMatchObject({
    state: 'underused',
    remainingPercent: 90,
    observedPercentPerHour: 10,
    projectedRemainingPercent: 45,
  });
  expect(spare.reservePercent).toBe(policy.reservePercent);
  expect(pulsar.policy()).toEqual(policy);
  vi.setSystemTime(start + 60 * 60_000);
  setSession(55);
  expect(quark.utilization().find((row) => row.provider === 'claude')?.state).toBe('fast');
  vi.setSystemTime(start + 61 * 60_000);
  setSession(1, sessionReset + 5 * 3600_000);
  expect(quark.utilization().find((row) => row.provider === 'claude')).toMatchObject({
    state: 'unknown',
    observedPercentPerHour: null,
  });
  vi.setSystemTime(start + 120 * 60_000);
  expect(quark.utilization().find((row) => row.provider === 'claude')?.state).toBe('unknown');
});
