import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import {
  recordClaudeUsage,
  recordClaudeStepUsage,
  beginClaudeUsageSession,
  recordCodexUsage,
  usageSummary,
  usageContext,
  usageStaleAfterMs,
} from './usage.js';

let root: string, store: Store;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T17:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'dock-claude-usage-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  vi.useRealTimers();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function fixture(name = 'Claude usage') {
  const project = store.register(join(root, name), name, '');
  const sessionId = randomUUID();
  store.updateAgent(project.managerId, { provider: 'claude' });
  const run = store.enqueue(project.managerId, randomUUID(), 'Disposable usage fixture');
  store.updateRun(run.id, { turnId: run.id, status: 'running' });
  store.updateAgent(project.managerId, {
    threadId: sessionId,
    turnId: run.id,
    model: 'fixture-claude',
  });
  return { projectId: project.id, agentId: project.managerId, sessionId, run };
}
const report = (value: ReturnType<typeof fixture>) => ({
  sessionId: value.sessionId,
  deliveryId: value.run.id,
  resultId: randomUUID(),
  usage: {
    inputTokens: 13,
    outputTokens: 7,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 20,
  },
});
const events = () => store.db.prepare("SELECT * FROM events WHERE type='usage.observed'").all();
function nextRun(value: ReturnType<typeof fixture>) {
  store.updateRun(value.run.id, { status: 'completed' });
  const run = store.enqueue(value.agentId, randomUUID(), 'Next bounded turn');
  store.updateRun(run.id, { turnId: run.id, status: 'running' });
  store.updateAgent(value.agentId, { turnId: run.id });
  return run;
}
const modelCounts = (n: number) => ({
  inputTokens: n,
  outputTokens: n,
  cacheReadInputTokens: n,
  cacheCreationInputTokens: n,
});

it('deduplicates live message counters across reopen, ignores output placeholders and replaces progress with terminal totals', () => {
  const value = fixture();
  beginClaudeUsageSession(store, value.agentId, value.sessionId, false);
  const step = {
    sessionId: value.sessionId,
    deliveryId: value.run.id,
    messageId: 'native-api-message',
    usage: modelCounts(100),
  };
  expect(recordClaudeStepUsage(store, value.agentId, step).status).toBe('recorded');
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'observed-steps',
    last: { inputTokens: 100, outputTokens: null },
  });
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(recordClaudeStepUsage(store, value.agentId, step).status).toBe('duplicate');
  expect(
    recordClaudeStepUsage(store, value.agentId, { ...step, messageId: 'second-api-message' })
      .status,
  ).toBe('recorded');
  expect(usageSummary(store, value.projectId).tokenSnapshots[0].last.inputTokens).toBe(200);
  recordClaudeUsage(store, value.agentId, {
    ...report(value),
    modelUsage: { main: modelCounts(300) },
  });
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'whole-tree',
    last: { inputTokens: 300, outputTokens: 300 },
  });
  expect(
    recordClaudeStepUsage(store, value.agentId, { ...step, messageId: 'late-message' }).status,
  ).toBe('ignored');
  const next = nextRun(value);
  expect(recordClaudeStepUsage(store, value.agentId, { ...step, deliveryId: next.id }).status).toBe(
    'ignored',
  );
  expect(
    recordClaudeStepUsage(store, value.agentId, {
      ...step,
      sessionId: randomUUID(),
      deliveryId: next.id,
      messageId: 'unrelated',
    }).status,
  ).toBe('ignored');
  expect(usageContext(store, value.projectId, value.agentId).tokens?.coverage).toBe('whole-tree');
});

it('keeps observed input/cache evidence when an error result loses its counters', () => {
  const value = fixture();
  recordClaudeStepUsage(store, value.agentId, {
    sessionId: value.sessionId,
    deliveryId: value.run.id,
    messageId: 'native-api-message',
    usage: modelCounts(200),
  });
  recordClaudeUsage(store, value.agentId, { ...report(value), usage: null, modelUsage: {} });
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'observed-steps',
    last: { inputTokens: 200, cachedInputTokens: 200, outputTokens: null },
  });
});

it('counts whole-team cumulative differences once, including newly appearing models, with atomic baseline receipts', () => {
  const value = fixture();
  beginClaudeUsageSession(store, value.agentId, value.sessionId, false);
  const input = {
    ...report(value),
    modelUsage: { main: modelCounts(200), helper: modelCounts(100) },
  };
  expect(() =>
    store.transaction(() => {
      recordClaudeUsage(store, value.agentId, input);
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('recorded');
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'whole-tree',
    last: { inputTokens: 300, outputTokens: 300 },
  });
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('duplicate');
  const next = nextRun(value);
  recordClaudeUsage(store, value.agentId, {
    ...input,
    deliveryId: next.id,
    resultId: randomUUID(),
    modelUsage: { main: modelCounts(400), helper: modelCounts(150), another: modelCounts(50) },
  });
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'whole-tree',
    last: { inputTokens: 300, outputTokens: 300 },
  });
  expect(events()).toHaveLength(2);
});

it('establishes a baseline on resume without charging restored history, then counts the next team difference', () => {
  const value = fixture();
  beginClaudeUsageSession(store, value.agentId, value.sessionId, false);
  const input = { ...report(value), modelUsage: { main: modelCounts(200) } };
  recordClaudeUsage(store, value.agentId, input);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  beginClaudeUsageSession(store, value.agentId, value.sessionId, true);
  let next = nextRun(value);
  recordClaudeUsage(store, value.agentId, {
    ...input,
    deliveryId: next.id,
    resultId: randomUUID(),
    modelUsage: { main: modelCounts(10000) },
  });
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'main-loop',
    last: { inputTokens: 13 },
  });
  next = nextRun({ ...value, run: next });
  recordClaudeUsage(store, value.agentId, {
    ...input,
    deliveryId: next.id,
    resultId: randomUUID(),
    modelUsage: { main: modelCounts(10200) },
  });
  expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
    coverage: 'whole-tree',
    last: { inputTokens: 200 },
  });
});

it.each(['missing', 'reset', 'helpers still working', 'incomplete counters', 'missing model'])(
  'keeps %s partial and never turns an uncertain boundary into a team total',
  (reason) => {
    const value = fixture();
    beginClaudeUsageSession(store, value.agentId, value.sessionId, false);
    const input = {
      ...report(value),
      modelUsage: { main: modelCounts(200), helper: modelCounts(200) },
    };
    recordClaudeUsage(store, value.agentId, input);
    const next = nextRun(value);
    const modelUsage =
      reason === 'missing'
        ? undefined
        : reason === 'reset'
          ? { main: modelCounts(10) }
          : reason === 'missing model'
            ? { main: modelCounts(400) }
            : {
                main: modelCounts(400),
                helper: {
                  ...modelCounts(400),
                  outputTokens: reason === 'incomplete counters' ? null : 400,
                },
              };
    recordClaudeUsage(store, value.agentId, {
      ...input,
      deliveryId: next.id,
      resultId: randomUUID(),
      modelUsage,
      helpersPending: reason === 'helpers still working',
    });
    expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
      coverage: 'main-loop',
      last: { inputTokens: 13 },
    });
    if (reason === 'missing' || reason === 'helpers still working') {
      const third = nextRun({ ...value, run: next });
      recordClaudeUsage(store, value.agentId, {
        ...input,
        deliveryId: third.id,
        resultId: randomUUID(),
        modelUsage: { main: modelCounts(600), helper: modelCounts(600) },
      });
      expect(usageSummary(store, value.projectId).tokenSnapshots[0]).toMatchObject({
        coverage: 'main-loop',
        last: { inputTokens: 13 },
      });
    }
  },
);

it('records exact last-turn cache/input/output counters without inventing cumulative totals, costs or quota', () => {
  const value = fixture();
  const input = report(value);
  expect(recordClaudeUsage(store, value.agentId, input)).toEqual({ status: 'recorded' });
  const summary = usageSummary(store, value.projectId, value.agentId);
  expect(summary.tokenSnapshots).toHaveLength(1);
  const snapshot = summary.tokenSnapshots[0];
  expect(snapshot).toMatchObject({
    provider: 'claude',
    threadId: value.sessionId,
    runId: value.run.id,
    turnId: value.run.id,
    last: {
      totalTokens: null,
      inputTokens: 13,
      outputTokens: 7,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 20,
      reasoningOutputTokens: null,
    },
    modelContextWindow: null,
    currentContext: true,
  });
  expect(Object.values(snapshot.total).every((count) => count === null)).toBe(true);
  expect(summary.quotaSnapshots).toEqual([]);
  expect(summary.unknownQuotaAgentIds).toEqual([value.agentId]);
  expect(summary).not.toHaveProperty('totalTokens');
  expect(JSON.stringify(summary)).not.toContain('estimatedCost');
  expect(usageContext(store, value.projectId, value.agentId).tokens?.total.totalTokens).toBeNull();
  expect(usageContext(store, value.projectId, value.agentId).tokens?.last).toEqual(snapshot.last);
});

it('preserves unknown fields as null and reported zeros as zero; all-missing usage stays unknown', () => {
  const value = fixture();
  const input = report(value);
  expect(
    recordClaudeUsage(store, value.agentId, {
      ...input,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
      },
    }).status,
  ).toBe('recorded');
  expect(usageSummary(store, value.projectId).tokenSnapshots[0].last.inputTokens).toBeNull();
  const next = nextRun(value);
  expect(
    recordClaudeUsage(store, value.agentId, {
      ...input,
      deliveryId: next.id,
      resultId: randomUUID(),
      usage: {
        inputTokens: null,
        outputTokens: 0,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: 0,
      },
    }).status,
  ).toBe('recorded');
  expect(usageSummary(store, value.projectId).tokenSnapshots[0].last).toEqual({
    totalTokens: null,
    inputTokens: null,
    outputTokens: 0,
    cachedInputTokens: null,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: null,
  });
});

it('deduplicates the native result and delivery through restart without refreshing the observation time', () => {
  const value = fixture();
  const input = report(value);
  recordClaudeUsage(store, value.agentId, input);
  const before = usageSummary(store, value.projectId).tokenSnapshots[0];
  store.updateRun(value.run.id, { status: 'completed' });
  store.updateAgent(value.agentId, { turnId: null });
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  vi.advanceTimersByTime(usageStaleAfterMs + 1);
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('duplicate');
  expect(
    recordClaudeUsage(store, value.agentId, {
      ...input,
      usage: { ...input.usage, outputTokens: 999 },
    }).status,
  ).toBe('ignored');
  expect(recordClaudeUsage(store, value.agentId, { ...input, resultId: randomUUID() }).status).toBe(
    'ignored',
  );
  const after = usageSummary(store, value.projectId).tokenSnapshots[0];
  expect(after.observedAt).toBe(before.observedAt);
  expect(after.last).toEqual(before.last);
  expect(after.stale).toBe(true);
  expect(events()).toHaveLength(1);
});

it('refuses unrelated providers, sessions, agents, runs and malformed counts before storing anything', () => {
  const value = fixture();
  const input = report(value);
  const other = fixture('Other Claude');
  for (const raw of [
    { ...input, sessionId: randomUUID() },
    { ...input, deliveryId: other.run.id },
    { ...input, deliveryId: randomUUID() },
    { ...input, resultId: '' },
    { ...input, usage: 'malformed' },
    ...[-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((inputTokens) => ({
      ...input,
      usage: { ...input.usage, inputTokens },
    })),
  ])
    expect(recordClaudeUsage(store, value.agentId, raw).status).toBe('ignored');
  expect(recordClaudeUsage(store, randomUUID(), input).status).toBe('ignored');
  const codex = store.addManager(value.projectId, 'Codex fixture', '');
  store.updateAgent(codex.id, { threadId: value.sessionId });
  expect(recordClaudeUsage(store, codex.id, input).status).toBe('ignored');
  expect(events()).toEqual([]);
});

it('rejects queued, mismatched and superseded deliveries including delayed reused native results', () => {
  const value = fixture();
  const input = report(value);
  store.updateRun(value.run.id, { status: 'queued' });
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('ignored');
  store.updateRun(value.run.id, { status: 'running', turnId: randomUUID() });
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('ignored');
  store.updateRun(value.run.id, { turnId: value.run.id });
  recordClaudeUsage(store, value.agentId, input);
  const next = store.enqueue(value.agentId, randomUUID(), 'Another bounded turn');
  store.updateRun(next.id, { status: 'running', turnId: next.id });
  store.updateAgent(value.agentId, { turnId: next.id });
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('ignored');
  expect(recordClaudeUsage(store, value.agentId, { ...input, deliveryId: next.id }).status).toBe(
    'ignored',
  );
  const nextInput = {
    ...input,
    deliveryId: next.id,
    resultId: randomUUID(),
    usage: { ...input.usage, outputTokens: 2 },
  };
  expect(recordClaudeUsage(store, value.agentId, nextInput).status).toBe('recorded');
  store.updateAgent(value.agentId, { turnId: null });
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('ignored');
  expect(usageSummary(store, value.projectId).tokenSnapshots[0].last.outputTokens).toBe(2);
  expect(usageSummary(store, value.projectId).tokenSnapshots[0].total.totalTokens).toBeNull();
  expect(events()).toHaveLength(2);
});

it('keeps Claude and Codex observations isolated without aggregating parents or sibling counters', () => {
  const value = fixture();
  const peer = store.addManager(value.projectId, 'Codex peer', '');
  const threadId = randomUUID();
  store.updateAgent(peer.id, { threadId });
  const counts = {
    totalTokens: 20,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 0,
  };
  recordCodexUsage(store, peer.id, { threadId, tokenUsage: { total: counts, last: counts } });
  recordClaudeUsage(store, value.agentId, report(value));
  const summary = usageSummary(store, value.projectId);
  expect(summary.tokenSnapshots).toHaveLength(2);
  expect(
    summary.tokenSnapshots.find((snapshot) => snapshot.provider === 'codex')!.total.totalTokens,
  ).toBe(20);
  expect(
    summary.tokenSnapshots.find((snapshot) => snapshot.provider === 'claude')!.total.totalTokens,
  ).toBeNull();
  expect(summary).not.toHaveProperty('totalTokens');
});

it('rolls projection and both idempotency receipts back inside a host transaction', () => {
  const value = fixture();
  const input = report(value);
  expect(() =>
    store.transaction(() => {
      recordClaudeUsage(store, value.agentId, input);
      throw new Error('rollback fixture');
    }),
  ).toThrow('rollback fixture');
  expect(events()).toEqual([]);
  expect(usageSummary(store, value.projectId).tokenSnapshots).toEqual([]);
  expect(recordClaudeUsage(store, value.agentId, input).status).toBe('recorded');
  expect(() => store.db.exec("DELETE FROM events WHERE type='usage.observed'")).toThrow(
    'append-only',
  );
});
