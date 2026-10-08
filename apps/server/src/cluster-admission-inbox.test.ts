import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RemoteAccountIdentity,
  RemoteAdmissionCandidate,
  RemoteAdmissionGrant,
  RemoteRuntimeIdentity,
} from '@dock/shared';
import { Store } from './store.js';
import { ClusterAdmissionInbox } from './cluster-admission-inbox.js';
import { projectNativeCodexAccount } from './cluster-native-accounts.js';
import { Pulsar } from './pulsar.js';
import { remoteRequestHash } from './cluster-admission-request.js';

let root: string,
  store: Store,
  identity: RemoteRuntimeIdentity,
  account: RemoteAccountIdentity,
  inbox: ClusterAdmissionInbox,
  runId: string,
  clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-cluster-grant-'));
  store = new Store(join(root, 'dock.sqlite'));
  clock = Date.now();
  const project = store.register(root, 'Cluster project', '', 'codex');
  runId = store.enqueue(project.managerId, randomUUID(), 'A saved request').id;
  identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: randomUUID(),
    remoteProjectId: project.id,
    jobId: '41234',
    leaseToken: randomUUID(),
  };
  account = {
    provider: 'codex',
    affinity: 'a'.repeat(64),
    identityBasis: 'native',
    state: 'ready',
    observedAt: new Date(clock).toISOString(),
    message: 'Verified',
  };
  inbox = new ClusterAdmissionInbox(
    store,
    identity,
    () => account,
    () => clock,
    () => candidate(),
  );
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const candidate = (): RemoteAdmissionCandidate => {
  const run = store.run(runId),
    agent = store.agent(run.agentId);
  return {
    runId,
    agentId: agent.id,
    projectId: agent.projectId,
    projectName: store.project(agent.projectId).name,
    provider: agent.provider,
    accountAffinity: account.affinity!,
    model: agent.model,
    effort: agent.effort,
    taskClass: 'manager',
    followQuark: true,
    kind: run.kind,
    estimate: new Pulsar(store, () => null).estimate(run),
    createdAt: run.createdAt,
  };
};
const grant = (): RemoteAdmissionGrant => ({
  id: randomUUID(),
  controllerHostId: identity.controllerHostId,
  remoteHostId: identity.remoteHostId,
  clusterProjectId: identity.clusterProjectId,
  jobId: identity.jobId,
  leaseToken: identity.leaseToken,
  runId,
  provider: 'codex',
  accountAffinity: account.affinity!,
  requestHash: remoteRequestHash(candidate()),
  policyRevision: 'policy1',
  expiresAt: new Date(clock + 30000).toISOString(),
  decision: 'allow',
  reason: 'Controller admitted this exact account/run.',
});

it('persists a grant once, reads it without consuming, and refuses replay after restart', () => {
  const input = { key: randomUUID(), grant: grant() };
  const receipt = inbox.push(input);
  expect(inbox.push(input)).toEqual(receipt);
  expect(inbox.reason(store.run(runId))).toBeNull();
  expect(inbox.reason(store.run(runId))).toBeNull();
  expect(inbox.consume(store.run(runId))).toBe(true);
  expect(inbox.consume(store.run(runId))).toBe(false);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  inbox = new ClusterAdmissionInbox(
    store,
    identity,
    () => account,
    () => clock,
    () => candidate(),
  );
  expect(inbox.reason(store.run(runId))).toContain('already consumed');
  expect(inbox.consume(store.run(runId))).toBe(false);
});

it('fences controller/host/job/account changes and expired grants without sending a native turn', () => {
  for (const field of ['controllerHostId', 'remoteHostId', 'leaseToken'] as const)
    expect(() =>
      inbox.push({ key: randomUUID(), grant: { ...grant(), [field]: randomUUID() } }),
    ).toThrow('different controller');
  expect(() => inbox.push({ key: randomUUID(), grant: { ...grant(), jobId: '9' } })).toThrow(
    'different controller',
  );
  expect(() =>
    inbox.push({ key: randomUUID(), grant: { ...grant(), accountAffinity: 'b'.repeat(64) } }),
  ).toThrow('account or project');
  inbox.push({ key: randomUUID(), grant: grant() });
  account = { ...account, affinity: 'b'.repeat(64) };
  expect(inbox.reason(store.run(runId))).toContain('Waiting for controller');
  expect(inbox.consume(store.run(runId))).toBe(false);
  account = { ...account, affinity: 'a'.repeat(64) };
  clock += 30001;
  expect(inbox.reason(store.run(runId))).toContain('expired');
  expect(store.run(runId).status).toBe('queued');
});

it('rolls back consumption when local admission fails and retains stable final receipts until acknowledged', () => {
  const input = { key: randomUUID(), grant: grant() };
  inbox.push(input);
  expect(() =>
    store.transaction(() => {
      expect(inbox.consume(store.run(runId))).toBe(true);
      throw new Error('Local resource hold');
    }),
  ).toThrow('resource hold');
  expect(inbox.reason(store.run(runId))).toBeNull();
  expect(inbox.consume(store.run(runId))).toBe(true);
  store.updateRun(runId, { status: 'completed' });
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
  };
  const receipts = inbox.receipts(() => ({ tokens: unknown, basis: 'unknown' }));
  clock += 10000;
  expect(inbox.receipts(() => ({ tokens: unknown, basis: 'unknown' }))).toEqual(receipts);
  inbox.acknowledge({ key: randomUUID(), grantIds: [input.grant.id] });
  expect(inbox.receipts(() => ({ tokens: unknown, basis: 'unknown' }))).toEqual([]);
});

it('uses native Codex accountId and blocks ordinary usage even when percentages are low', () => {
  const raw = {
    accountId: 'native-private-account-id',
    ordinaryUsageAllowed: false,
    rateLimits: {
      primary: {
        usedPercent: 1,
        windowDurationMins: 300,
        resetsAt: Math.floor(clock / 1000) + 100,
      },
    },
  };
  const result = projectNativeCodexAccount(raw, clock);
  expect(result.account.affinity).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain(raw.accountId);
  expect(result.capacity.state).toBe('error');
  expect(result.ordinaryUsageAllowed).toBe(false);
  expect(() => projectNativeCodexAccount({ ...raw, accountId: null }, clock)).toThrow(
    'native account identity',
  );
});

it('requires an exact unused acknowledgment before retiring an expired grant, and binds the prepared model', () => {
  const original = grant();
  inbox.push({ key: randomUUID(), grant: original });
  expect(() => inbox.dispose({ key: randomUUID(), grant: original })).toThrow(
    'expired unconsumed grant',
  );
  clock += 30001;
  const request = { key: randomUUID(), grant: original };
  const unused = inbox.dispose(request);
  expect(unused).toMatchObject({ state: 'unused', startedAt: null, usage: { totalTokens: 0 } });
  expect(inbox.dispose(request)).toEqual(unused);
  expect(inbox.consume(store.run(runId))).toBe(false);
  const next = grant();
  store.updateAgent(store.run(runId).agentId, { model: 'changed-model' });
  expect(() => inbox.push({ key: randomUUID(), grant: next })).toThrow('request/model changed');
});

it('revokes a live queued grant before applying owner policy, while a consumed grant remains accountable', () => {
  const first = grant();
  inbox.push({ key: randomUUID(), grant: first });
  const revoked = inbox.revoke({ key: randomUUID(), grant: first });
  expect(revoked.state).toBe('unused');
  expect(inbox.consume(store.run(runId))).toBe(false);
  const next = grant();
  inbox.push({ key: randomUUID(), grant: next });
  expect(inbox.consume(store.run(runId))).toBe(true);
  expect(inbox.revoke({ key: randomUUID(), grant: next })).toEqual({
    state: 'consumed',
    receipt: null,
  });
});

it('refuses grant replacement or identity mutation until exact unused disposition, and never resurrects retired permission', () => {
  const first = grant();
  inbox.push({ key: randomUUID(), grant: first });
  expect(() => inbox.push({ key: randomUUID(), grant: { ...first, decision: 'hold' } })).toThrow(
    'identity cannot be changed',
  );
  expect(() => inbox.push({ key: randomUUID(), grant: grant() })).toThrow(
    'Reconcile the existing grant',
  );
  inbox.revoke({ key: randomUUID(), grant: first });
  expect(() => inbox.push({ key: randomUUID(), grant: first })).toThrow('final disposition');
  const next = grant();
  expect(inbox.push({ key: randomUUID(), grant: next }).grantId).toBe(next.id);
  expect(
    inbox.receipts(() => {
      throw new Error('Unused receipt must not read native usage');
    }),
  ).toMatchObject([{ grantId: first.id, state: 'unused' }]);
});

it('keeps a final receipt visible behind more than64pending grants and across restart until acknowledgment', () => {
  const first = grant();
  inbox.push({ key: randomUUID(), grant: first });
  expect(inbox.consume(store.run(runId))).toBe(true);
  store.updateRun(runId, { status: 'completed' });
  for (let index = 0; index < 70; index++)
    store.setSetting('cluster-admission:run:' + randomUUID(), {
      grant: { ...first, id: randomUUID(), runId: randomUUID() },
      consumedAt: null,
      retired: false,
    });
  const unknown = {
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
  };
  const receipts = inbox.receipts(() => ({ tokens: unknown, basis: 'unknown' }));
  expect(receipts).toMatchObject([{ grantId: first.id, state: 'complete' }]);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  inbox = new ClusterAdmissionInbox(
    store,
    identity,
    () => account,
    () => clock,
    () => candidate(),
  );
  expect(
    inbox.receipts(() => {
      throw new Error('Final receipt must not be recalculated');
    }),
  ).toEqual(receipts);
  inbox.acknowledge({ key: randomUUID(), grantIds: [first.id] });
  expect(inbox.receipts(() => ({ tokens: unknown, basis: 'unknown' }))).toEqual([]);
});

it('settles a coalesced source as unused without admitting or replaying it', () => {
  const first = grant();
  inbox.push({ key: randomUUID(), grant: first });
  store.updateRun(runId, { status: 'coalesced' });
  expect(inbox.consume(store.run(runId))).toBe(false);
  expect(inbox.dispose({ key: randomUUID(), grant: first })).toMatchObject({
    state: 'unused',
    startedAt: null,
  });
  expect(store.run(runId).status).toBe('coalesced');
});

it('can replace a hold that authorized no work with a fresh exact allowance grant', () => {
  inbox.push({
    key: randomUUID(),
    grant: { ...grant(), decision: 'hold', reason: 'Waiting for allowance' },
  });
  expect(inbox.reason(store.run(runId))).toBe('Waiting for allowance');
  const allowed = grant();
  inbox.push({ key: randomUUID(), grant: allowed });
  expect(inbox.consume(store.run(runId))).toBe(true);
});

it('fences the full saved grant before unused disposition or the consumed revoke fast path', () => {
  const first = grant();
  inbox.push({ key: randomUUID(), grant: first });
  for (const changed of [
    { expiresAt: new Date(clock - 1).toISOString() },
    { accountAffinity: 'b'.repeat(64) },
    { provider: 'claude' as const },
    { requestHash: 'b'.repeat(64) },
  ])
    expect(() => inbox.dispose({ key: randomUUID(), grant: { ...first, ...changed } })).toThrow(
      'exact saved grant',
    );
  expect(inbox.reason(store.run(runId))).toBeNull();
  expect(inbox.consume(store.run(runId))).toBe(true);
  for (const changed of [
    { leaseToken: randomUUID() },
    { controllerHostId: randomUUID() },
    { accountAffinity: 'b'.repeat(64) },
    { requestHash: 'b'.repeat(64) },
  ])
    expect(() => inbox.revoke({ key: randomUUID(), grant: { ...first, ...changed } })).toThrow();
  expect(inbox.revoke({ key: randomUUID(), grant: first })).toEqual({
    state: 'consumed',
    receipt: null,
  });
});

it('keeps final disposition bound to the original grant after replacement', () => {
  const first = grant();
  inbox.push({ key: randomUUID(), grant: first });
  const unused = inbox.revoke({ key: randomUUID(), grant: first });
  inbox.push({ key: randomUUID(), grant: grant() });
  expect(() =>
    inbox.dispose({
      key: randomUUID(),
      grant: { ...first, expiresAt: new Date(clock - 1).toISOString() },
    }),
  ).toThrow('exact saved grant');
  expect(inbox.revoke({ key: randomUUID(), grant: first })).toEqual(unused);
});
