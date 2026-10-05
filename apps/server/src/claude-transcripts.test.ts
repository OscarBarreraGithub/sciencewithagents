import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { NativeChildren } from './native-children.js';
import { ClaudeTranscripts } from './claude-transcripts.js';
import { Quark } from './quark.js';
import { Pulsar } from './pulsar.js';
import {
  beginClaudeUsageSession,
  recordClaudeUsage,
  recordClaudeHelperTotal,
  usageSummary,
} from './usage.js';

let root: string, store: Store, reader: ClaudeTranscripts;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T13:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'swa-claude-transcripts-'));
  store = new Store(join(root, 'dock.sqlite'));
  reader = new ClaudeTranscripts(store, join(root, 'claude'));
});
afterEach(async () => {
  await reader.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture() {
  const project = store.register(join(root, 'project'), 'Fixture', '');
  const sessionId = randomUUID(),
    nativeId = 'helper-1';
  store.updateAgent(project.managerId, { provider: 'claude' });
  store.updateAgent(project.managerId, { threadId: sessionId });
  const parentRun = store.enqueue(project.managerId, randomUUID(), 'Parent');
  store.updateRun(parentRun.id, { status: 'running', turnId: parentRun.id });
  store.updateAgent(project.managerId, { turnId: parentRun.id });
  const child = new NativeChildren(store).claude(project.managerId, sessionId, nativeId)!;
  const run = store.enqueue(child.id, `native:claude:${child.id}:${parentRun.id}:start`, 'Helper');
  store.updateRun(run.id, { status: 'running', turnId: run.id });
  store.updateAgent(child.id, { status: 'running', turnId: run.id });
  const quark = new Quark(store, new Pulsar(store, () => null));
  quark.begin(store.run(parentRun.id));
  quark.begin(store.run(run.id));
  const path = join(
    root,
    'claude',
    'projects',
    'provider-owned-folder',
    sessionId,
    'subagents',
    `agent-${nativeId}.jsonl`,
  );
  mkdirSync(join(path, '..'), { recursive: true });
  const hook = {
    hook_event_name: 'SubagentStop' as const,
    session_id: sessionId,
    agent_id: nativeId,
    agent_transcript_path: path,
  };
  reader.register(child.id, hook);
  const message = (id: string, amount: number, extra = {}) => ({
    sessionId,
    agentId: nativeId,
    type: 'assistant',
    timestamp: new Date(Date.now() + 1).toISOString(),
    uuid: randomUUID(),
    message: {
      id,
      model: 'claude-native-fixture',
      usage: {
        input_tokens: amount,
        cache_read_input_tokens: amount * 2,
        cache_creation_input_tokens: amount * 3,
        output_tokens: 1,
      },
      content: [
        { type: 'thinking', thinking: 'PRIVATE THINKING' },
        { type: 'text', text: `Reply ${id}` },
      ],
    },
    ...extra,
  });
  return { project, sessionId, nativeId, child, run, parentRun, quark, path, hook, message };
}
const lines = (...values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join('\n') + '\n';
const advance = () => vi.setSystemTime(Date.now() + 11_000);
it('contains an unexpected collector failure and retries without losing the host', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture();
  writeFileSync(f.path, lines(f.message('after-retry', 10)));
  const query = vi.spyOn(store.db, 'prepare').mockImplementationOnce(() => {
    throw new Error('Temporary query failure');
  });
  await expect(reader.flush()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledTimes(1);
  query.mockRestore();
  advance();
  await reader.flush();
  expect(store.entries(f.child.id).some((entry) => entry.text === 'Reply after-retry')).toBe(true);
  log.mockRestore();
});
it('retains helper evidence and deduplicated partial counters without charging the root twice', async () => {
  const f = fixture();
  const first = f.message('api-1', 10);
  writeFileSync(
    f.path,
    lines(
      first,
      { ...first, uuid: randomUUID() },
      f.message('api-2', 20),
      f.message('foreign', 1000, { agentId: 'another-helper' }),
    ),
  );
  await reader.flush();
  f.quark.sync();
  const helper = f.quark.status().runs.find((run) => run.runId === f.run.id)!;
  expect(helper).toMatchObject({
    basis: 'partial',
    tokens: {
      inputTokens: 30,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 90,
      outputTokens: null,
      totalTokens: null,
    },
  });
  expect(store.agent(f.child.id).model).toBe('claude-native-fixture');
  expect(JSON.stringify(store.entries(f.child.id))).not.toContain('PRIVATE THINKING');
  expect(store.entries(f.child.id).some((entry) => entry.text === 'Reply api-2')).toBe(true);
  recordClaudeHelperTotal(
    store,
    f.child.id,
    f.run.id,
    f.sessionId,
    f.nativeId,
    'completed-agent',
    200,
  );
  beginClaudeUsageSession(store, f.project.managerId, f.sessionId, false);
  recordClaudeUsage(store, f.project.managerId, {
    sessionId: f.sessionId,
    deliveryId: f.parentRun.id,
    resultId: 'root-result',
    usage: null,
    modelUsage: {
      'root-and-helpers': {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 100,
      },
    },
  });
  f.quark.sync();
  expect(f.quark.status().totals.find((total) => total.agentId === null)?.tokens.totalTokens).toBe(
    400,
  );
  expect(
    f.quark.status().totals.find((total) => total.agentId === f.child.id)?.tokens.inputTokens,
  ).toBe(30);
});
it('retains a reported helper run total through delayed transcript writes and restart without adding it twice', async () => {
  const f = fixture();
  writeFileSync(f.path, lines(f.message('api-1', 10)));
  await reader.flush();
  expect(
    recordClaudeHelperTotal(store, f.child.id, f.run.id, f.sessionId, f.nativeId, 'agent-call', 450)
      .status,
  ).toBe('recorded');
  f.quark.sync();
  expect(f.quark.status().runs.find((r) => r.runId === f.run.id)).toMatchObject({
    basis: 'partial',
    tokens: { totalTokens: 450, inputTokens: 10, outputTokens: null },
  });
  await reader.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  reader = new ClaudeTranscripts(store, join(root, 'claude'));
  expect(
    recordClaudeHelperTotal(store, f.child.id, f.run.id, f.sessionId, f.nativeId, 'agent-call', 450)
      .status,
  ).toBe('duplicate');
  appendFileSync(f.path, lines(f.message('api-2', 20)));
  advance();
  await reader.flush();
  const snapshot = usageSummary(store, f.project.id, f.child.id).tokenSnapshots[0];
  expect(snapshot.last).toMatchObject({ totalTokens: 450, inputTokens: 30, outputTokens: null });
  expect(
    recordClaudeHelperTotal(
      store,
      f.child.id,
      f.parentRun.id,
      f.sessionId,
      f.nativeId,
      'foreign',
      999,
    ).status,
  ).toBe('ignored');
});
it('catches a delayed partial write after restart and attributes resumed work without rebilling old API messages', async () => {
  const f = fixture();
  const first = f.message('first', 10);
  const delayed = JSON.stringify(f.message('delayed', 20));
  writeFileSync(f.path, lines(first) + delayed.slice(0, 50));
  await reader.flush();
  store.updateRun(f.run.id, { status: 'completed' });
  store.updateAgent(f.child.id, { status: 'idle', turnId: null });
  await reader.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  reader = new ClaudeTranscripts(store, join(root, 'claude'));
  appendFileSync(f.path, delayed.slice(50) + '\n');
  vi.setSystemTime(Date.now() + 3 * 60_000); // Sleep beyond the catch-up window still gets a final read.
  await reader.flush();
  expect(usageSummary(store, f.project.id, f.child.id).tokenSnapshots[0].last.inputTokens).toBe(30);
  const next = store.enqueue(
    f.child.id,
    `native:claude:${f.child.id}:${f.parentRun.id}:resumed`,
    'Resume',
  );
  store.updateRun(next.id, { status: 'running', turnId: next.id });
  store.updateAgent(f.child.id, { status: 'running', turnId: next.id });
  reader.register(f.child.id, f.hook);
  appendFileSync(
    f.path,
    lines({ ...first, timestamp: new Date(Date.now() + 1).toISOString() }, f.message('new', 7)),
  );
  advance();
  await reader.flush();
  const snapshots = usageSummary(store, f.project.id, f.child.id).tokenSnapshots;
  expect(snapshots.find((item) => item.runId === f.run.id)?.last.inputTokens).toBe(30);
  expect(snapshots.find((item) => item.runId === next.id)?.last.inputTokens).toBe(7);
  // A replaced native file may replay all records. Durable receipts remain authoritative.
  rmSync(f.path);
  writeFileSync(f.path, lines(first));
  advance();
  await reader.flush();
  expect(
    usageSummary(store, f.project.id, f.child.id).tokenSnapshots.find(
      (item) => item.runId === f.run.id,
    )?.last.inputTokens,
  ).toBe(30);
});
it('rejects path/session substitutions and ignores inherited messages from before registration', async () => {
  const f = fixture();
  const outside = join(root, 'outside.jsonl');
  writeFileSync(outside, lines(f.message('private', 999)));
  symlinkSync(outside, f.path);
  await reader.flush();
  expect(usageSummary(store, f.project.id, f.child.id).tokenSnapshots).toHaveLength(0);
  expect(store.getSetting(`claude:transcript:${f.child.id}`)).toMatchObject({
    error: expect.stringContaining('unavailable'),
  });
  rmSync(f.path);
  writeFileSync(
    f.path,
    lines(
      f.message('inherited', 800, { timestamp: new Date(Date.now() - 60_000).toISOString() }),
      f.message('wrong-session', 900, { sessionId: randomUUID() }),
      f.message('mine', 5),
    ),
  );
  advance();
  await reader.flush();
  expect(usageSummary(store, f.project.id, f.child.id).tokenSnapshots[0].last.inputTokens).toBe(5);
  reader.register(f.child.id, { ...f.hook, agent_transcript_path: outside });
  expect(store.getSetting(`claude:transcript:${f.child.id}`)).toMatchObject({ path: f.path });
});
