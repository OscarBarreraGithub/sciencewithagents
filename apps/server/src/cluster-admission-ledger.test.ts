import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  defaultModelPolicy,
  jobEstimateSchema,
  remoteAdmissionCandidateSchema,
  type RemoteAccountCapacity,
  type RemoteAccountIdentity,
  type RemoteAdmissionCandidate,
  type RemoteAdmissionGrant,
  type RemoteRuntimeIdentity,
  type TokenCounts,
} from '@dock/shared';
import { ClusterAdmissionLedgers } from './cluster-admission-ledger.js';

let dir: string, clock: number, ledgers: ClusterAdmissionLedgers;
const A = 'a'.repeat(64),
  B = 'b'.repeat(64);
const iso = (at = clock) => new Date(at).toISOString();
const open = () =>
  new ClusterAdmissionLedgers(
    dir,
    () => defaultModelPolicy,
    () => clock,
  );
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cluster-ledger-'));
  clock = Date.parse('2026-10-06T12:00:00Z');
  ledgers = open();
});
afterEach(async () => {
  await ledgers.close();
  rmSync(dir, { recursive: true, force: true });
});
const identity = (projectId = randomUUID()): RemoteRuntimeIdentity => ({
  controllerHostId: '00000000-0000-4000-8000-000000000001',
  remoteHostId: '00000000-0000-4000-8000-000000000002',
  clusterProjectId: randomUUID(),
  remoteProjectId: projectId,
  jobId: '4242',
  leaseToken: randomUUID(),
});
const account = (affinity: string | null = A, provider: 'claude' | 'codex' = 'claude') =>
  ({
    provider,
    affinity,
    identityBasis: 'native',
    state: affinity ? 'ready' : 'setup-required',
    observedAt: iso(),
    message: affinity ? '' : 'Sign in on the cluster.',
  }) satisfies RemoteAccountIdentity;
const capacity = (
  usedPercent: number,
  affinity = A,
  provider: 'claude' | 'codex' = 'claude',
  observedAt: string | null = iso(),
): RemoteAccountCapacity => ({
  provider,
  accountAffinity: affinity,
  readerHostId: randomUUID(),
  generation: randomUUID(),
  ordinaryUsageAllowed: null,
  capacity: {
    provider,
    account: 'local-sign-in',
    label: provider,
    plan: null,
    source: provider === 'claude' ? 'claude-native-oauth' : 'codex-native',
    observedAt,
    attemptedAt: observedAt,
    nextRefreshAt: null,
    state: observedAt ? 'ready' : 'unknown',
    stale: false,
    message: '',
    windows: observedAt
      ? [
          {
            id: 'primary',
            label: 'five-hour',
            scope: 'general',
            model: null,
            usedPercent,
            windowMinutes: 300,
            resetsAt: iso(Date.parse('2026-10-06T15:00:00Z')),
          },
        ]
      : [],
    weeklyPolicy: 'not-reported',
  },
});
const failedRead = (attemptedAt: number): RemoteAccountCapacity => {
  const value = capacity(0, A, 'claude', null);
  return {
    ...value,
    capacity: { ...value.capacity, state: 'error', attemptedAt: iso(attemptedAt) },
  };
};
const candidate = (
  id: RemoteRuntimeIdentity,
  quotaPercent = 10,
  affinity = A,
  provider: 'claude' | 'codex' = 'claude',
): RemoteAdmissionCandidate => ({
  runId: randomUUID(),
  agentId: randomUUID(),
  projectId: id.remoteProjectId,
  projectName: 'Remote project',
  provider,
  accountAffinity: affinity,
  model: provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-5.5',
  effort: 'medium',
  taskClass: 'reasoning',
  followQuark: true,
  kind: 'user',
  estimate: jobEstimateSchema.parse({ quotaPercent, priority: 'interactive' }),
  createdAt: iso(),
});
const none: TokenCounts = {
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  reasoningOutputTokens: null,
};
const receipt = (
  grant: Pick<RemoteAdmissionGrant, 'id' | 'runId'>,
  state: 'running' | 'complete' | 'interrupted' | 'failed' | 'unused',
  usage: Partial<TokenCounts> = {},
  basis: 'measured' | 'partial' | 'unknown' = 'measured',
  affinity = A,
) => ({
  grantId: grant.id,
  runId: grant.runId,
  provider: 'claude' as const,
  accountAffinity: affinity,
  state,
  startedAt: state === 'unused' ? null : iso(),
  finishedAt: state === 'running' ? null : iso(),
  usage: { ...none, ...usage },
  basis,
});
const summary = (affinity = A, provider = 'claude') =>
  ledgers.status().find((s) => s.provider === provider && s.accountAffinity === affinity)!;
/** Read-only inspection of the private accounting store's existing QUARK/Pulsar rows. */
const rows = (table: 'quark_runs' | 'pulsar_leases') => {
  const db = new DatabaseSync(join(dir, `claude-${A}.sqlite`), { readOnly: true });
  try {
    return db
      .prepare(`SELECT body FROM ${table}`)
      .all()
      .map((r) => JSON.parse(String(r.body)));
  } finally {
    db.close();
  }
};

const enableAccount = async (affinity = A, provider: 'claude' | 'codex' = 'claude') => {
  await ledgers.observeCapacity(account(affinity, provider), capacity(0, affinity, provider, null));
  const selected = { provider, affinity };
  ledgers.savePolicy(selected, {
    key: randomUUID(),
    policy: { ...ledgers.policyFor(selected), enabled: true },
  });
};

it('starts new accounts with pacing off and preserves explicit enabled account policy across restart', async () => {
  const selected = { provider: 'claude' as const, affinity: A };
  expect(ledgers.schedulingEnabled(selected)).toBe(false);
  expect(readdirSync(dir).filter((file) => file.endsWith('.sqlite'))).toEqual(['index.sqlite']);
  const first = identity();
  expect(
    (await ledgers.decide(first, account(), candidate(first, 90), capacity(95))).decision,
  ).toBe('allow');
  expect(ledgers.policyFor(selected).enabled).toBe(false);
  await ledgers.close();
  ledgers = open();
  expect(ledgers.schedulingEnabled(selected)).toBe(false);
  ledgers.savePolicy(selected, {
    key: randomUUID(),
    policy: { ...ledgers.policyFor(selected), enabled: true },
  });
  await ledgers.close();
  ledgers = open();
  expect(ledgers.schedulingEnabled(selected)).toBe(true);
  const next = identity();
  expect((await ledgers.decide(next, account(), candidate(next, 90), capacity(95))).decision).toBe(
    'hold',
  );
});

it('reserves across simultaneous projects on one account and isolates other accounts', async () => {
  await enableAccount();
  await enableAccount(B);
  await enableAccount(A, 'codex');
  const one = identity(),
    two = identity();
  // 60% used leaves room for one 12% turn under the default reserve, not two.
  const [first, second] = await Promise.all([
    ledgers.decide(one, account(), candidate(one, 12), capacity(60)),
    ledgers.decide(two, account(), candidate(two, 12), capacity(60)),
  ]);
  expect([first.decision, second.decision].sort()).toEqual(['allow', 'hold']);
  expect([first, second].find((g) => g.decision === 'hold')!.reason).toContain('reserved');
  const three = identity();
  expect(
    (await ledgers.decide(three, account(B), candidate(three, 12, B), capacity(60, B))).decision,
  ).toBe('allow');
  const four = identity();
  const codex = await ledgers.decide(
    four,
    account(A, 'codex'),
    candidate(four, 12, A, 'codex'),
    capacity(60, A, 'codex'),
  );
  expect(codex.decision).toBe('allow');
  expect(ledgers.status().map((s) => `${s.provider}:${s.accountAffinity}`)).toHaveLength(3);
  expect(summary()).toMatchObject({ verified: true, reservedPercent: 12 });
  expect(summary().holds).toEqual([expect.objectContaining({ cause: 'allowance' })]);
});

it('honors project QUARK Off across the remote account ledger while retaining native ordinary-usage blocks', async () => {
  await enableAccount();
  const first = identity(),
    second = identity(),
    off = identity();
  expect(
    (await ledgers.decide(first, account(), candidate(first, 12), capacity(60))).decision,
  ).toBe('allow');
  expect(
    (await ledgers.decide(second, account(), candidate(second, 12), capacity(60))).decision,
  ).toBe('hold');
  clock += 1000;
  const bypass = { ...candidate(off, 90), followQuark: false };
  expect((await ledgers.decide(off, account(), bypass, capacity(95))).decision).toBe('allow');
  expect(summary().reservedPercent).toBe(102);
  // A policy toggle cannot silently reuse the existing prepared permission.
  await expect(
    ledgers.decide(off, account(), { ...bypass, followQuark: true }, capacity(95)),
  ).rejects.toThrow('different request');
  const native = identity();
  const refusal = await ledgers.decide(
    native,
    account(A, 'codex'),
    { ...candidate(native, 90, A, 'codex'), followQuark: false },
    { ...capacity(1, A, 'codex'), ordinaryUsageAllowed: false },
  );
  expect(refusal.decision).toBe('hold');
  expect(refusal.reason).toContain('ordinary usage is not allowed');
});

it('shows setup and usage-not-allowed holds, replaces old reasons and rejects mismatches', async () => {
  expect(ledgers.status()).toEqual([]);
  const id = identity(),
    c = candidate(id);
  const setup = await ledgers.decide(id, account(null), c, capacity(5));
  expect(setup.decision).toBe('hold');
  expect(setup.reason).toContain('Sign in on the cluster.');
  // No verified identity: visible as a hold, but no ledger file is created for it.
  expect(ledgers.status()).toEqual([
    expect.objectContaining({
      accountAffinity: A,
      verified: false,
      holds: [expect.objectContaining({ cause: 'setup' })],
    }),
  ]);
  expect(readdirSync(dir).filter((f) => f.endsWith('.sqlite'))).toEqual(['index.sqlite']);
  const blocked = { ...capacity(5), ordinaryUsageAllowed: false };
  expect((await ledgers.decide(id, account(), c, blocked)).decision).toBe('hold');
  expect(summary()).toMatchObject({ verified: true, holds: [{ cause: 'usage-not-allowed' }] });
  // A later reading cannot clear the accepted refusal by being older.
  expect(
    (await ledgers.decide(id, account(), c, capacity(5, A, 'claude', iso(clock - 1000)))).decision,
  ).toBe('hold');
  await enableAccount();
  await enableAccount(B);
  const stale = capacity(5, B, 'claude', iso(clock - 30 * 60_000));
  const other = identity();
  expect((await ledgers.decide(other, account(B), candidate(other, 10, B), stale)).decision).toBe(
    'hold',
  );
  clock += 1000;
  expect((await ledgers.decide(id, account(), c, capacity(5))).decision).toBe('allow');
  expect(summary().holds.map((h) => h.runId)).not.toContain(c.runId);
  await expect(
    ledgers.decide(id, account(), { ...candidate(id), projectId: randomUUID() }, capacity(5)),
  ).rejects.toThrow('different remote project');
  await expect(ledgers.decide(id, account(), candidate(id), capacity(5, B))).rejects.toThrow(
    'do not match',
  );
  await expect(
    ledgers.decide(id, account(), candidate(id), capacity(5, A, 'claude', iso(clock + 3600_000))),
  ).rejects.toThrow('future');
});

it('never lets an older or failed reading overwrite newer accepted evidence', async () => {
  await enableAccount();
  await ledgers.observeCapacity(account(), capacity(10));
  const later = clock;
  clock += 60_000;
  await ledgers.observeCapacity(account(), capacity(12));
  // An older failed attempt and an older ready reading are both ignored.
  await ledgers.observeCapacity(account(), failedRead(later));
  const id = identity();
  const allowed = await ledgers.decide(
    id,
    account(),
    candidate(id, 5),
    capacity(10, A, 'claude', iso(later)),
  );
  expect(allowed.decision).toBe('allow');
  // A newer failed read is newer evidence: missing usage is never spare capacity.
  clock += 60_000;
  await ledgers.observeCapacity(account(), failedRead(clock));
  const next = identity();
  const held = await ledgers.decide(
    next,
    account(),
    candidate(next, 5),
    capacity(12, A, 'claude', iso(clock - 120_000)),
  );
  expect(held.decision).toBe('hold');
  await expect(ledgers.observeCapacity(account(B), capacity(10))).rejects.toThrow('do not match');
});

it('replays the exact grant, binds its request hash and never grants twice', async () => {
  await enableAccount();
  const id = identity(),
    c = candidate(id);
  const grant = await ledgers.decide(id, account(), c, capacity(5));
  expect(grant.decision).toBe('allow');
  expect(grant.requestHash).toBe(
    createHash('sha256')
      .update(JSON.stringify(remoteAdmissionCandidateSchema.parse(c)))
      .digest('hex'),
  );
  expect(await ledgers.decide(id, account(), c, capacity(5))).toEqual(grant);
  await expect(
    ledgers.decide(id, account(), { ...c, model: 'claude-opus-5-5' }, capacity(5)),
  ).rejects.toThrow('different request');
  const moved = { ...id, jobId: '4343', leaseToken: randomUUID() };
  const other = await ledgers.decide(moved, account(), c, capacity(5));
  expect(other).toMatchObject({ decision: 'hold', runId: c.runId });
  expect(summary().reservedPercent).toBe(10);
});

it('lost delivery: expiry keeps the reservation; proven unused re-grants once; old receipts stay fenced', async () => {
  await enableAccount();
  const id = identity(),
    c = candidate(id, 40);
  const first = await ledgers.decide(id, account(), c, capacity(10));
  expect(first.decision).toBe('allow');
  clock += 5 * 60_000;
  // Expired and unacknowledged: same grant on retry, reservation retained.
  expect(await ledgers.decide(id, account(), c, capacity(10))).toEqual(first);
  const rival = identity();
  expect(
    (await ledgers.decide(rival, account(), candidate(rival, 40), capacity(10))).decision,
  ).toBe('hold');
  expect(summary().uncertain).toEqual([{ runId: c.runId, projectId: c.projectId }]);
  await ledgers.settle(id, account(), receipt(first, 'unused', {}, 'unknown'));
  expect(summary()).toMatchObject({ reservedPercent: 0, uncertain: [] });
  expect(rows('pulsar_leases')).toHaveLength(0);
  // The remote moved to a new allocation; the same request is reconsidered on a new grant.
  const moved = { ...id, jobId: '5151', leaseToken: randomUUID() };
  const second = await ledgers.decide(moved, account(), c, capacity(10));
  expect(second).toMatchObject({ decision: 'allow', requestHash: first.requestHash });
  expect(second.id).not.toBe(first.id);
  expect(await ledgers.decide(moved, account(), c, capacity(10))).toEqual(second);
  expect(summary().reservedPercent).toBe(40);
  expect(rows('pulsar_leases').filter((l) => !l.finishedAt)).toHaveLength(1);
  // Delayed old-grant receipts: the exact unused disposition is idempotent; anything else is fenced.
  await ledgers.settle(id, account(), receipt(first, 'unused', {}, 'unknown'));
  await expect(
    ledgers.settle(id, account(), receipt(first, 'running', { totalTokens: 9 })),
  ).rejects.toThrow('proven unused');
  await expect(ledgers.settle(moved, account(), receipt(first, 'complete'))).rejects.toThrow(
    'different allocation',
  );
  await expect(ledgers.settle(id, account(), receipt(second, 'complete'))).rejects.toThrow(
    'different allocation',
  );
  expect(summary().reservedPercent).toBe(40);
  await ledgers.settle(moved, account(), receipt(second, 'complete', { totalTokens: 500 }));
  expect(summary()).toMatchObject({ reservedPercent: 0, settled: { complete: 1, unused: 0 } });
});

it('a canceled, never-consumed grant releases its reservation and cannot later report spend', async () => {
  await enableAccount();
  const id = identity(),
    c = candidate(id, 30);
  const grant = await ledgers.decide(id, account(), c, capacity(10));
  await expect(
    ledgers.settle(id, account(), receipt(grant, 'unused', { totalTokens: 5 }, 'unknown')),
  ).rejects.toThrow('cannot report');
  await ledgers.settle(id, account(), receipt(grant, 'unused', {}, 'unknown'));
  expect(summary()).toMatchObject({ reservedPercent: 0, settled: { unused: 1 } });
  expect(summary().recent).toEqual([expect.objectContaining({ runId: c.runId, state: 'unused' })]);
  expect(rows('quark_runs')).toHaveLength(0);
  await expect(ledgers.settle(id, account(), receipt(grant, 'running'))).rejects.toThrow(
    'proven unused',
  );
  const started = identity(),
    s = candidate(started, 5);
  const g2 = await ledgers.decide(started, account(), s, capacity(10));
  await ledgers.settle(started, account(), receipt(g2, 'running', { totalTokens: 10 }));
  await expect(
    ledgers.settle(started, account(), receipt(g2, 'unused', {}, 'unknown')),
  ).rejects.toThrow('started remote run');
});

it('feeds cumulative per-run usage to QUARK runs and Pulsar once, keeping known counts', async () => {
  await enableAccount();
  const id = identity(),
    c = candidate(id);
  const grant = await ledgers.decide(id, account(), c, capacity(5));
  await expect(
    ledgers.settle(id, account(), receipt({ ...grant, id: randomUUID() }, 'running')),
  ).rejects.toThrow('No matching');
  await expect(
    ledgers.settle({ ...id, leaseToken: randomUUID() }, account(), receipt(grant, 'running')),
  ).rejects.toThrow('different allocation');
  await expect(
    ledgers.settle(id, account(B), receipt(grant, 'running', {}, 'measured', B)),
  ).rejects.toThrow('No matching');
  const counts = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
  await ledgers.settle(id, account(), receipt(grant, 'running', counts));
  await ledgers.settle(id, account(), receipt(grant, 'running', counts));
  await expect(
    ledgers.settle(id, account(), receipt(grant, 'running', { totalTokens: 50 })),
  ).rejects.toThrow('cannot decrease');
  // A later unknown report never erases measured evidence.
  await ledgers.settle(id, account(), receipt(grant, 'complete', {}, 'unknown'));
  await ledgers.settle(id, account(), receipt(grant, 'complete', {}, 'unknown'));
  await ledgers.settle(id, account(), receipt(grant, 'running', { totalTokens: 200 }));
  await expect(ledgers.settle(id, account(), receipt(grant, 'failed'))).rejects.toThrow(
    'different outcome',
  );
  const [run] = rows('quark_runs');
  expect(run).toMatchObject({
    threadId: null,
    basis: 'partial',
    tokens: { totalTokens: 110, inputTokens: 100 },
  });
  expect(run.finishedAt).not.toBeNull();
  expect(rows('pulsar_leases')[0]).toMatchObject({ tokensCharged: 110, tokenBasis: 'measured' });
  expect(summary().recent[0]).toMatchObject({
    state: 'complete',
    basis: 'measured',
    totalTokens: 110,
  });
  // Partial or unknown remote totals stay estimated in Pulsar.
  const p = identity(),
    pc = candidate(p);
  const pg = await ledgers.decide(p, account(), pc, capacity(5));
  await ledgers.settle(p, account(), receipt(pg, 'interrupted', { totalTokens: 7 }, 'partial'));
  expect(rows('pulsar_leases').find((l) => l.runId !== run.runId)).toMatchObject({
    tokenBasis: 'estimated',
  });
});

it('attributes a later allowance reading to projects by their remote usage and budgets follow', async () => {
  await enableAccount();
  const p1 = identity(),
    p2 = identity();
  const r1 = await ledgers.decide(p1, account(), candidate(p1, 0.5), capacity(10));
  const r2 = await ledgers.decide(p2, account(), candidate(p2, 0.5), capacity(10));
  const acct = { provider: 'claude' as const, affinity: A };
  for (const projectId of [p1.remoteProjectId, p2.remoteProjectId])
    ledgers.saveBudget(acct, {
      key: randomUUID(),
      projectId,
      provider: 'claude',
      windowId: 'primary',
      limitPercent: 2,
    });
  await ledgers.settle(
    p1,
    account(),
    receipt(r1, 'complete', { inputTokens: 100_000, outputTokens: 20_000, totalTokens: 120_000 }),
  );
  await ledgers.settle(
    p2,
    account(),
    receipt(r2, 'complete', { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }),
  );
  clock += 5 * 60_000;
  await ledgers.observeCapacity(account(), capacity(11.5));
  const spent = Object.fromEntries(summary().budgets.map((b) => [b.projectId, b.spentPercent]));
  expect(spent[p1.remoteProjectId]).toBeGreaterThan(1.45);
  expect(spent[p2.remoteProjectId]).toBeLessThan(0.05);
  expect((await ledgers.decide(p1, account(), candidate(p1, 0.5), capacity(11.5))).decision).toBe(
    'hold',
  );
  expect((await ledgers.decide(p2, account(), candidate(p2, 0.5), capacity(11.5))).decision).toBe(
    'allow',
  );
});

it('restores accounts, reservations, budgets and policy on the first status after restart', async () => {
  await enableAccount();
  const id = identity(),
    c = candidate(id, 5);
  await ledgers.decide(id, account(), c, capacity(10));
  const acct = { provider: 'claude' as const, affinity: A };
  await expect(
    Promise.resolve().then(() => ledgers.policyFor({ ...acct, affinity: B })),
  ).rejects.toThrow('no admission ledger');
  const policy = ledgers.policyFor(acct);
  await expect(
    Promise.resolve().then(() =>
      ledgers.savePolicy(acct, {
        key: randomUUID(),
        policy: { ...policy, revision: policy.revision + 7 },
      }),
    ),
  ).rejects.toThrow('changed');
  ledgers.savePolicy(acct, { key: randomUUID(), policy: { ...policy, reservePercent: 20 } });
  ledgers.saveBudget(acct, {
    key: randomUUID(),
    projectId: id.remoteProjectId,
    provider: 'claude',
    windowId: 'primary',
    limitPercent: 6,
  });
  const held = identity();
  await ledgers.decide(held, account(null), candidate(held, 10, B), capacity(10, B));
  clock += 2 * 60_000;
  await ledgers.close();
  ledgers = open();
  const [first, setup] = [summary(), ledgers.status().find((s) => !s.verified)!];
  expect(first).toMatchObject({
    verified: true,
    policyRevision: policy.revision + 1,
    reservedPercent: 5,
    uncertain: [{ runId: c.runId }],
    budgets: [expect.objectContaining({ projectId: id.remoteProjectId, limitPercent: 6 })],
  });
  expect(setup.holds).toEqual([expect.objectContaining({ cause: 'setup' })]);
  expect((await ledgers.decide(id, account(), candidate(id, 5), capacity(10))).decision).toBe(
    'hold',
  );
  await expect(
    Promise.resolve().then(() =>
      ledgers.saveBudget(
        { provider: 'claude', affinity: B },
        {
          key: randomUUID(),
          projectId: id.remoteProjectId,
          provider: 'claude',
          windowId: 'primary',
          limitPercent: 6,
        },
      ),
    ),
  ).rejects.toThrow('no admission ledger');
});
