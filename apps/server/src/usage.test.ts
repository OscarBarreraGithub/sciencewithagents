import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { repoRoot } from './paths.js';
import {
  recordCodexRateLimits,
  recordCodexUsage,
  usageStaleAfterMs,
  usageContext,
  usageSummary,
} from './usage.js';

let root: string, store: Store;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/usage-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  vi.useRealTimers();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function fixture(name = 'Usage') {
  const project = store.register(join(root, name), name, '');
  const threadId = randomUUID();
  const turnId = randomUUID();
  const run = store.enqueue(project.managerId, randomUUID(), 'An already recorded fixture turn');
  store.updateRun(run.id, { turnId, status: 'completed' });
  store.updateAgent(project.managerId, { threadId, model: 'fixture-model' });
  return { project, agentId: project.managerId, threadId, turnId, run };
}
const counts = (n = 100) => ({
  totalTokens: n,
  inputTokens: n - 20,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 5,
  outputTokens: 20,
  reasoningOutputTokens: 3,
});
const report = (value: ReturnType<typeof fixture>, n = 100) => ({
  threadId: value.threadId,
  turnId: value.turnId,
  tokenUsage: { total: counts(n), last: counts(), modelContextWindow: 200_000 },
});
const limit = (usedPercent = 25) => ({
  limitId: 'codex',
  limitName: 'Included',
  normalModelSlug: 'fixture-model',
  primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_789_301_000 },
  secondary: null,
  spendControlReached: false,
  rateLimitReachedType: null,
});
const observedEvents = () =>
  store.db.prepare("SELECT * FROM events WHERE type='usage.observed'").all();

describe('provider-reported usage evidence', () => {
  it('bounds large summaries without mislabeling omitted reported agents as unknown', () => {
    const value = fixture();
    recordCodexUsage(store, value.agentId, report(value));
    for (let index = 0; index < 55; index++) {
      const peer = store.addManager(value.project.id, `Peer ${index}`, '');
      const threadId = randomUUID();
      store.updateAgent(peer.id, { threadId });
      recordCodexUsage(store, peer.id, { ...report(value), turnId: null, threadId });
    }
    const summary = usageSummary(store, value.project.id);
    expect(summary.tokenSnapshots).toHaveLength(50);
    expect(summary.omitted.tokenSnapshots).toBe(6);
    expect(summary.omitted.agents).toBe(6);
    expect(summary.unknownTokenAgentIds).toEqual([]);
    expect(summary.unknownQuotaAgentIds).toHaveLength(50);
  });
  it('keeps default context to the selected current agent and four recent quota buckets', () => {
    const value = fixture();
    const peer = store.addManager(value.project.id, 'Other manager', '');
    store.updateAgent(peer.id, { threadId: randomUUID() });
    recordCodexUsage(store, value.agentId, report(value));
    recordCodexUsage(store, peer.id, {
      ...report(value),
      threadId: store.agent(peer.id).threadId,
      turnId: null,
    });
    const buckets = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`bucket-${i}`, { ...limit(), limitId: `bucket-${i}` }]),
    );
    recordCodexRateLimits(
      store,
      value.agentId,
      { rateLimits: limit(), rateLimitsByLimitId: buckets },
      'read',
    );
    const context = usageContext(store, value.project.id, value.agentId);
    expect(context.tokens?.total.totalTokens).toBe(100);
    expect(context.quota?.buckets).toHaveLength(4);
    expect(context.quota?.omittedBuckets).toBe(4);
    expect(context.quota?.accountAffinity).toBe('unknown');
    expect(JSON.stringify(context)).not.toContain(peer.id);
    expect(context).not.toHaveProperty('tokenSnapshots');
  });
  it('replaces cumulative snapshots instead of summing, deduplicates retries through restart, and remains append-only', () => {
    const value = fixture();
    expect(recordCodexUsage(store, value.agentId, report(value))).toMatchObject({
      status: 'recorded',
    });
    vi.advanceTimersByTime(1000);
    expect(recordCodexUsage(store, value.agentId, report(value, 180))).toMatchObject({
      status: 'recorded',
    });
    const before = usageSummary(store, value.project.id, value.agentId);
    expect(before.tokenSnapshots).toHaveLength(1);
    expect(before.tokenSnapshots[0]).toMatchObject({
      provider: 'codex',
      runId: value.run.id,
      total: { totalTokens: 180 },
      currentContext: true,
      modelScope: 'context-only-not-billing',
    });
    expect(before).not.toHaveProperty('totalTokens');
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(recordCodexUsage(store, value.agentId, report(value))).toMatchObject({
      status: 'duplicate',
    });
    expect(usageSummary(store, value.project.id, value.agentId)).toEqual(before);
    expect(observedEvents()).toHaveLength(2);
    expect(() => store.db.exec("DELETE FROM events WHERE type='usage.observed'")).toThrow(
      'append-only',
    );
  });

  it('can record within a host transaction and rolls projection and receipt back together', () => {
    const value = fixture();
    expect(() =>
      store.transaction(() => {
        recordCodexUsage(store, value.agentId, report(value));
        throw new Error('Rollback fixture');
      }),
    ).toThrow('Rollback fixture');
    expect(usageSummary(store, value.project.id).tokenSnapshots).toEqual([]);
    expect(observedEvents()).toEqual([]);
    expect(recordCodexUsage(store, value.agentId, report(value))).toMatchObject({
      status: 'recorded',
    });
  });

  it('ignores malformed, foreign-thread, unknown-turn and stale-turn updates without losing current evidence', () => {
    const value = fixture();
    const newer = store.enqueue(value.agentId, randomUUID(), 'A later recorded turn');
    const newerTurn = randomUUID();
    store.updateRun(newer.id, { turnId: newerTurn, status: 'completed' });
    expect(
      recordCodexUsage(store, value.agentId, { ...report(value, 250), turnId: newerTurn }).status,
    ).toBe('recorded');
    for (const bad of [
      null,
      {},
      { ...report(value), threadId: randomUUID() },
      { ...report(value), turnId: randomUUID() },
      report(value, 150),
      { ...report(value), tokenUsage: { ...report(value).tokenUsage, total: counts(-1) } },
      { ...report(value), tokenUsage: { ...report(value).tokenUsage, total: counts(Infinity) } },
    ])
      expect(recordCodexUsage(store, value.agentId, bad).status).toBe('ignored');
    expect(recordCodexUsage(store, randomUUID(), report(value)).status).toBe('ignored');
    expect(usageSummary(store, value.project.id).tokenSnapshots[0].total.totalTokens).toBe(250);
    expect(observedEvents()).toHaveLength(1);
  });

  it('keeps old thread context labels separate and optional counters unknown, with no cache or billing inference', () => {
    const value = fixture();
    const raw = report(value);
    const { cacheWriteInputTokens: _removed, ...olderCounts } = raw.tokenUsage.total;
    recordCodexUsage(store, value.agentId, {
      ...raw,
      turnId: null,
      tokenUsage: { ...raw.tokenUsage, total: olderCounts, modelContextWindow: null },
    });
    store.updateAgent(value.agentId, { threadId: randomUUID(), model: 'different-model' });
    expect(recordCodexUsage(store, value.agentId, raw).status).toBe('ignored');
    const summary = usageSummary(store, value.project.id);
    expect(summary.tokenSnapshots[0]).toMatchObject({
      modelAtObservation: 'fixture-model',
      currentContext: false,
      total: { cacheWriteInputTokens: null },
      modelContextWindow: null,
      turnId: null,
      runId: null,
    });
    expect(summary.unknownTokenAgentIds).toEqual([value.agentId]);
    expect(summary.notice).toContain('not historical per-model billing');
  });

  it('isolates project and agent observations and never adds overlapping native family counters', () => {
    const first = fixture(),
      other = fixture('Other');
    const child = store.addAgent({
      projectId: first.project.id,
      parentId: first.agentId,
      taskId: null,
      role: 'researcher',
      name: 'Native child',
      provider: 'codex',
      cwd: root,
    });
    store.updateAgent(child.id, { threadId: randomUUID(), nativeRootId: first.agentId });
    recordCodexUsage(store, first.agentId, report(first));
    recordCodexUsage(store, other.agentId, report(other, 500));
    recordCodexUsage(store, child.id, {
      ...report(first),
      turnId: null,
      threadId: store.agent(child.id).threadId,
    });
    recordCodexRateLimits(store, other.agentId, { rateLimits: limit() });
    const summary = usageSummary(store, first.project.id);
    expect(summary.tokenSnapshots).toHaveLength(2);
    expect(summary.quotaSnapshots).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain(other.agentId);
    expect(usageSummary(store, first.project.id, first.agentId).tokenSnapshots).toHaveLength(1);
    expect(() => usageSummary(store, first.project.id, other.agentId)).toThrow(
      'outside this project',
    );
    expect(summary.notice).toContain('may overlap');
  });

  it('does not attribute Codex observations to an agent assigned another provider', () => {
    const value = fixture();
    const agent = { ...store.agent(value.agentId), provider: 'claude' };
    store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(agent), agent.id);
    expect(recordCodexUsage(store, value.agentId, report(value)).status).toBe('ignored');
    expect(recordCodexRateLimits(store, value.agentId, { rateLimits: limit() }).status).toBe(
      'ignored',
    );
    expect(observedEvents()).toEqual([]);
    expect(usageSummary(store, value.project.id).unknownTokenAgentIds).toEqual([value.agentId]);
  });

  it('projects only quota windows/flags, merges sparse observations without freshening retained windows, and never guesses account affinity', () => {
    const value = fixture();
    const raw = {
      ordinaryUsageAllowed: true,
      accountId: 'private-account-secret',
      rateLimitUpsell: { token: 'private-secret' },
      rateLimits: { ...limit(), credits: { balance: 'private-credit-balance' } },
      rateLimitsByLimitId: { codex: limit() },
    };
    recordCodexRateLimits(store, value.agentId, raw, 'read', 'first-read');
    vi.advanceTimersByTime(usageStaleAfterMs + 1);
    recordCodexRateLimits(store, value.agentId, {
      rateLimits: {
        limitId: 'codex',
        primary: null,
        secondary: { usedPercent: 51, resetsAt: null },
        limitName: null,
        spendControlReached: null,
      },
    });
    const quota = usageSummary(store, value.project.id).quotaSnapshots[0];
    expect(quota).toMatchObject({
      accountAffinity: 'unknown',
      scope: 'provider-local-installation',
      stale: false,
      ordinaryUsageAllowed: true,
      ordinaryUsageStale: true,
    });
    expect(quota.buckets[0]).toMatchObject({
      name: 'Included',
      primary: { usedPercent: 25 },
      primaryStale: true,
      secondary: { usedPercent: 51, resetsAt: null },
      secondaryStale: false,
      spendControlReached: null,
    });
    expect(JSON.stringify(quota)).not.toContain('private-');
    expect(JSON.stringify(observedEvents())).not.toContain('private-');
  });

  it('deduplicates quota refresh receipts across restart, accepts a new unchanged read as fresh, and rejects changed reuse', () => {
    const value = fixture(),
      raw = { rateLimits: limit() };
    recordCodexRateLimits(store, value.agentId, raw, 'read', 'refresh-one');
    const first = usageSummary(store, value.project.id).quotaSnapshots[0];
    vi.advanceTimersByTime(usageStaleAfterMs + 1);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(recordCodexRateLimits(store, value.agentId, raw, 'read', 'refresh-one').status).toBe(
      'duplicate',
    );
    expect(usageSummary(store, value.project.id).quotaSnapshots[0].observedAt).toBe(
      first.observedAt,
    );
    expect(
      recordCodexRateLimits(store, value.agentId, { rateLimits: limit(50) }, 'read', 'refresh-one')
        .status,
    ).toBe('ignored');
    expect(recordCodexRateLimits(store, value.agentId, raw, 'read', 'refresh-two').status).toBe(
      'recorded',
    );
    const current = usageSummary(store, value.project.id).quotaSnapshots[0];
    expect(current.observedAt).not.toBe(first.observedAt);
    expect(current.stale).toBe(false);
    expect(current.ordinaryUsageAllowed).toBeNull();
    expect(observedEvents()).toHaveLength(2);
  });

  it('marks elapsed resets stale instead of assuming recovered availability and keeps unreported values unknown', () => {
    const value = fixture();
    recordCodexRateLimits(store, value.agentId, {
      rateLimits: {
        ...limit(),
        primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) - 1 },
      },
    });
    const quota = usageSummary(store, value.project.id).quotaSnapshots[0];
    expect(quota.buckets[0]).toMatchObject({
      primary: { usedPercent: 100, windowDurationMins: null },
      primaryStale: true,
      secondary: null,
      secondaryStale: null,
    });
    expect(quota.ordinaryUsageAllowed).toBeNull();
    expect(usageSummary(store, value.project.id).tokenSnapshots).toEqual([]);
    for (const raw of [
      null,
      {},
      { rateLimits: { primary: { usedPercent: -5 } } },
      { rateLimits: limit(), rateLimitsByLimitId: { wrong: limit() } },
    ])
      expect(recordCodexRateLimits(store, value.agentId, raw, 'read').status).toBe('ignored');
  });
});
