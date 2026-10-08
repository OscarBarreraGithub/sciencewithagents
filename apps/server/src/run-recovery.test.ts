import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from './store.js';
import { ClaudePreflightError } from './claude-session.js';
import {
  prepareRunDelivery,
  markRunHandoff,
  recordRunFailure,
  recoverRun,
  runRecoveryView,
  runRecoveryReceipt,
} from './run-recovery.js';

let root: string, store: Store, agentId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-recovery-'));
  store = new Store(join(root, 'test.sqlite'));
  agentId = store.register(root, 'Recovery fixture', '').managerId;
  store.updateAgent(agentId, { provider: 'claude' });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function failed(
  handoff = false,
  error: Error = new ClaudePreflightError('timeout', 'Sanitized check timed out'),
) {
  const queued = store.enqueue(agentId, randomUUID(), 'Perform one original objective');
  const run = store.updateRun(queued.id, { status: 'running' });
  prepareRunDelivery(store, run);
  if (handoff) markRunHandoff(store, run);
  recordRunFailure(store, run, error);
  store.updateRun(run.id, { status: 'failed' });
  store.updateAgent(agentId, { status: 'failed', turnId: null });
  return run;
}
function request() {
  const view = runRecoveryView(store, agentId)!;
  return { key: randomUUID(), runId: view.runId, failureId: view.failureId, action: view.action };
}
it('a proven pre-send failure retries exact input once across distinct tabs and durable receipt reads', () => {
  const source = failed();
  expect(runRecoveryView(store, agentId)?.action).toBe('retry');
  const input = request();
  let captures = 0;
  const captured = () => {
    captures++;
  };
  const result = recoverRun(store, agentId, input, captured);
  expect(result.runId).not.toBe(source.id);
  expect(store.run(result.runId)).toMatchObject({
    text: source.text,
    status: 'queued',
    kind: 'user',
  });
  expect(recoverRun(store, agentId, input, captured)).toEqual(result);
  expect(recoverRun(store, agentId, { ...input, key: randomUUID() }, captured)).toEqual(result);
  expect(captures).toBe(1);
  expect(store.runs()).toHaveLength(2);
  expect(store.entries(agentId).filter((e) => e.kind === 'user')).toHaveLength(1);
  expect(store.events().filter((e) => e.type === 'run.recovery_requested')).toHaveLength(1);
  store.close();
  store = new Store(join(root, 'test.sqlite'));
  expect(runRecoveryReceipt(store, agentId, input.key)).toEqual(result);
  expect(recoverRun(store, agentId, input)).toEqual(result);
  expect(store.runs()).toHaveLength(2);
});
it('a native handoff or unknown failure offers inspection, never blind replay', () => {
  const source = failed(true);
  expect(runRecoveryView(store, agentId)?.action).toBe('continue');
  const input = request();
  expect(() => recoverRun(store, agentId, { ...input, action: 'retry' })).toThrow(
    'cannot be safely resent',
  );
  const result = recoverRun(store, agentId, input);
  expect(store.run(result.runId).kind).toBe('resume');
  expect(store.run(result.runId).text).toContain('Do not blindly repeat');
  expect(store.run(result.runId).text).not.toContain(source.text);
});
it.each([
  ['model', () => store.updateAgent(agentId, { model: 'changed-model' })],
  ['account', () => store.setSetting(`claude:account:${agentId}`, 'changed-affinity')],
  ['context', () => store.updateAgent(agentId, { threadId: randomUUID() })],
] as const)('changed %s boundary invalidates a retained Retry request', (_name, change) => {
  failed();
  const input = request();
  change();
  expect(runRecoveryView(store, agentId)?.action).toBe('continue');
  expect(() => recoverRun(store, agentId, input)).toThrow('cannot be safely resent');
  expect(store.runs()).toHaveLength(1);
});
it('a retained conversation cannot switch provider during recovery', () => {
  failed();
  expect(() => store.updateAgent(agentId, { provider: 'codex' })).toThrow('keeps its provider');
  expect(store.runs()).toHaveLength(1);
  expect(store.agent(agentId).provider).toBe('claude');
});
it('Stop and a later queued continuation suppress an old recovery action', () => {
  const source = failed();
  const input = request();
  store.updateRun(source.id, { status: 'interrupted' });
  store.updateAgent(agentId, { status: 'interrupted' });
  expect(runRecoveryView(store, agentId)?.action).toBe('continue');
  expect(() => recoverRun(store, agentId, input)).toThrow('cannot be safely resent');
  store.enqueue(agentId, randomUUID(), 'Explicit later continuation', 'resume');
  expect(runRecoveryView(store, agentId)).toBeNull();
  expect(() => recoverRun(store, agentId, input)).toThrow('conversation changed');
});
it('native input handoff is durable and refuses a second write intent', () => {
  const queued = store.enqueue(agentId, randomUUID(), 'One input');
  const run = store.updateRun(queued.id, { status: 'running' });
  prepareRunDelivery(store, run);
  markRunHandoff(store, run, 'fork');
  markRunHandoff(store, run);
  expect(() => markRunHandoff(store, run)).toThrow('already reached');
  recordRunFailure(store, run, new ClaudePreflightError('timeout', 'Sanitized timeout'));
  store.updateRun(run.id, { status: 'failed' });
  store.updateAgent(agentId, { status: 'failed' });
  expect(runRecoveryView(store, agentId)?.action).toBe('continue');
});

it('a model change after recovery admission still blocks the provider write', () => {
  failed();
  const receipt = recoverRun(store, agentId, request());
  const run = store.updateRun(receipt.runId, { status: 'running' });
  prepareRunDelivery(store, run);
  store.updateAgent(agentId, { model: 'changed-after-queue' });
  expect(() => markRunHandoff(store, run)).toThrow('changed before delivery');
  expect(store.events().filter((event) => event.type === 'run.provider_handoff')).toHaveLength(0);
});
it('late automatic reports retain Continue for a stopped conversation, while a queued owner continuation suppresses it', () => {
  const original = failed();
  const worker = store.addAgent({
    projectId: store.agent(agentId).projectId,
    parentId: agentId,
    taskId: null,
    role: 'researcher',
    name: 'Worker',
    cwd: root,
  });
  store.enqueue(agentId, randomUUID(), 'Late automatic worker update', 'report', worker.id);
  expect(store.agent(agentId).status).toBe('failed');
  expect(runRecoveryView(store, agentId)).toMatchObject({ runId: original.id, action: 'continue' });
  store.enqueue(agentId, randomUUID(), 'Already requested by owner', 'resume');
  store.enqueue(agentId, randomUUID(), 'Another late worker update', 'report', worker.id);
  store.updateAgent(agentId, { status: 'failed' });
  expect(runRecoveryView(store, agentId)).toBeNull();
});
