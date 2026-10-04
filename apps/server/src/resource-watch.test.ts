import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModelPolicy, resourceSampleSchema, type ProviderId } from '@dock/shared';
import { Store } from './store.js';
import { ResourceWatch, resourceFindings } from './resource-watch.js';
import { parsePressure, parseProcesses, parseSwap, parseVm } from './resource-probe.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const base = (now: number, cpu = 20) =>
  resourceSampleSchema.parse({
    observedAt: new Date(now).toISOString(),
    machine: {
      observedAt: new Date(now).toISOString(),
      cpuCount: 8,
      cpuUsedPercent: cpu,
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
      diskAvailableBytes: 100 * 1024 ** 3,
      loadPerCore: 0.2,
    },
    hottestCorePercent: 80,
    memoryPressure: 'normal',
    compressedBytes: 3 * 1024 ** 3,
    swapUsedBytes: 1024 ** 3,
    swapOutBytesPerSecond: 0,
    diskTotalBytes: 512 * 1024 ** 3,
    groups: [],
    processCount: 200,
    unavailable: [],
  });
function fixture(singleProvider = false) {
  const root = mkdtempSync(join(tmpdir(), 'swa-resources-'));
  const store = new Store(join(root, 'dock.sqlite'));
  if (!singleProvider) store.setSetting('model-policy', structuredClone(defaultModelPolicy));
  let now = Date.parse('2026-09-25T00:00:00Z'),
    cpu = 20;
  const models = vi.fn(async (provider: ProviderId) => [
    {
      id: provider === 'codex' ? 'terra-fixture' : 'sonnet-fixture',
      label: provider === 'codex' ? 'Terra' : 'Sonnet',
      isDefault: false,
      efforts: ['low', 'high'],
    },
  ]);
  const release = vi.fn(async () => true),
    interrupt = vi.fn(async () => {});
  const dependencies = {
    probe: { sample: async () => base(now, cpu) },
    models,
    queue: () => ({ jobs: [] }),
    waitReason: () => 'Reserved headroom',
    release,
    interrupt,
  };
  const watch = new ResourceWatch(store, root, dependencies, () => now);
  cleanups.push(async () => {
    await watch.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    watch,
    dependencies,
    models,
    release,
    interrupt,
    advance: (ms: number) => {
      now += ms;
    },
    cpu: (n: number) => {
      cpu = n;
    },
    now: () => now,
  };
}
it('a fresh Codex-only installation can queue Ask without discovering or requiring Claude', async () => {
  const { watch, store, models } = fixture(true);
  await watch.tick();
  const check = (await watch.ask({ key: randomUUID(), question: 'Why is this computer slow?' }))
    .checks[0]!;
  expect(store.agent(check.agentId)).toMatchObject({
    provider: 'codex',
    model: 'terra-fixture',
    permission: 'workspace-write',
  });
  expect(models).toHaveBeenCalledWith('codex');
  expect(models).toHaveBeenCalledTimes(1);
  expect(store.runs()).toHaveLength(1);
});
it('honors explicit provider, exact model and effort through central model selection', async () => {
  const { watch, store, models } = fixture();
  await watch.tick();
  const codex = (await watch.ask({ key: randomUUID(), provider: 'codex' })).checks[0]!;
  expect(store.agent(codex.agentId)).toMatchObject({
    provider: 'codex',
    model: 'terra-fixture',
    effort: 'low',
  });
  expect(models).toHaveBeenLastCalledWith('codex');
  store.updateRun(codex.runId, { status: 'completed' });
  models.mockResolvedValueOnce([
    { id: 'sonnet-fixture', label: 'Sonnet', isDefault: false, efforts: ['low', 'high'] },
    { id: 'custom-fixture', label: 'Chosen exact model', isDefault: false, efforts: ['high'] },
  ]);
  const selected = (
    await watch.ask({
      key: randomUUID(),
      provider: 'claude',
      model: 'custom-fixture',
      effort: 'high',
    })
  ).checks[0]!;
  expect(store.agent(selected.agentId)).toMatchObject({
    provider: 'claude',
    model: 'custom-fixture',
    effort: 'high',
    permission: 'workspace-write',
    assignment: { source: 'manager_selection', tier: 'undergrad', taskClass: 'routine' },
  });
  expect(models).toHaveBeenLastCalledWith('claude');
  store.updateRun(selected.runId, { status: 'completed' });
  await expect(
    watch.ask({ key: randomUUID(), provider: 'claude', effort: 'unsupported' }),
  ).rejects.toThrow('thinking level');
  expect(store.runs()).toHaveLength(2);
});
it('continues the saved diagnostic context with fresh evidence and durable follow-up retry receipts', async () => {
  const { watch, store, root, dependencies, now, cpu, models } = fixture();
  await watch.tick();
  const first = (await watch.ask({ key: randomUUID(), question: 'Why was the computer slow?' }))
    .checks[0]!;
  store.updateRun(first.runId, { status: 'completed' });
  store.updateAgent(first.agentId, { threadId: 'diagnostic-fixture-thread', status: 'idle' });
  const replyId = randomUUID();
  store.entry({
    id: replyId,
    agentId: first.agentId,
    runId: first.runId,
    kind: 'assistant',
    title: '',
    text: 'CPU was elevated during that sample.',
    status: 'complete',
    createdAt: new Date(now()).toISOString(),
  });
  cpu(90);
  await watch.tick();
  const policy = structuredClone(defaultModelPolicy);
  policy.scheduledProvider = 'codex';
  store.setSetting('model-policy', policy);
  const input = {
    key: randomUUID(),
    agentId: first.agentId,
    question: 'Has CPU use improved?',
    effort: 'high',
  };
  const followup = (await watch.ask(input)).checks[0]!;
  expect(followup).toMatchObject({ agentId: first.agentId, model: first.model, reason: 'asked' });
  expect(followup.id).not.toBe(first.id);
  expect(followup.runId).not.toBe(first.runId);
  expect(store.agent(first.agentId)).toMatchObject({
    threadId: 'diagnostic-fixture-thread',
    provider: 'claude',
    model: 'sonnet-fixture',
    effort: 'high',
    permission: 'workspace-write',
    toolPolicy: 'native',
  });
  expect(store.agents()).toHaveLength(1);
  expect(store.entries(first.agentId).find((entry) => entry.id === replyId)?.text).toBe(
    'CPU was elevated during that sample.',
  );
  expect(watch.context(first.agentId).requestEvidence).toMatchObject({
    sample: { machine: { cpuUsedPercent: 90 } },
  });
  expect(watch.status().checks.find((check) => check.id === first.id)?.summary).toBe(
    'CPU was elevated during that sample.',
  );
  const restoredStore = new Store(join(root, 'dock.sqlite'));
  const restored = new ResourceWatch(restoredStore, root, dependencies, now);
  cleanups.push(async () => {
    await restored.close();
    restoredStore.close();
  });
  const calls = models.mock.calls.length;
  const retry = await restored.ask(input);
  expect(retry.checks[0]).toEqual(followup);
  expect(models.mock.calls).toHaveLength(calls);
  expect(restoredStore.runs()).toHaveLength(2);
  await expect(restored.ask({ ...input, question: 'Changed retry' })).rejects.toThrow('retry key');
  expect(restoredStore.runs()).toHaveLength(2);
});
it('rejects foreign or unregistered agents and incompatible follow-up model choices before queueing', async () => {
  const { watch, store, root, models } = fixture();
  await watch.tick();
  const first = (await watch.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(first.runId, { status: 'completed' });
  const foreign = store.register(join(root, 'another-project'), 'Other project', '', 'codex');
  store.setSetting(`resources:agent:${foreign.managerId}`, true);
  store.updateAgent(foreign.managerId, { model: 'terra-fixture' });
  const unregistered = store.addManager(watch.projectId()!, 'Ordinary manager', '', 'claude');
  store.updateAgent(unregistered.id, { model: 'sonnet-fixture' });
  const calls = models.mock.calls.length;
  for (const agentId of [randomUUID(), foreign.managerId, unregistered.id])
    await expect(watch.ask({ key: randomUUID(), agentId })).rejects.toThrow(
      'saved resource-assistant',
    );
  await expect(
    watch.ask({ key: randomUUID(), agentId: first.agentId, provider: 'codex' }),
  ).rejects.toThrow('keeps its provider and model');
  await expect(
    watch.ask({ key: randomUUID(), agentId: first.agentId, model: 'different-model' }),
  ).rejects.toThrow('keeps its provider and model');
  expect(models.mock.calls).toHaveLength(calls);
  expect(store.runs()).toHaveLength(1);
});
it('does not release or time-limit native assistance while the same agent has an active follow-up', async () => {
  const { watch, store, release, advance, interrupt } = fixture();
  await watch.tick();
  const first = (await watch.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(first.runId, { status: 'completed' });
  const followup = (
    await watch.ask({ key: randomUUID(), agentId: first.agentId, question: 'What changed?' })
  ).checks[0]!;
  await watch.tick();
  expect(release).not.toHaveBeenCalled();
  store.updateRun(followup.runId, { status: 'running' });
  await watch.tick();
  expect(release).not.toHaveBeenCalled();
  advance(181_000);
  await watch.tick();
  expect(interrupt).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  store.updateRun(followup.runId, { status: 'completed' });
  await watch.tick();
  expect(release).toHaveBeenCalledTimes(1);
  expect(store.getSetting(`resources:released:${first.runId}`)).toBe(true);
  expect(store.getSetting(`resources:released:${followup.runId}`)).toBe(true);
});
it('waits for in-flight cleanup before enqueueing a follow-up on the released agent', async () => {
  const { watch, store, release } = fixture();
  await watch.tick();
  const first = (await watch.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(first.runId, { status: 'completed' });
  let finishRelease!: (released: boolean) => void;
  release.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finishRelease = resolve;
      }),
  );
  const tick = watch.tick();
  expect(release).toHaveBeenCalledTimes(1);
  const followup = watch.ask({
    key: randomUUID(),
    agentId: first.agentId,
    question: 'What can I try next?',
  });
  await Promise.resolve();
  expect(store.runs()).toHaveLength(1);
  finishRelease(true);
  await tick;
  const next = (await followup).checks[0]!;
  expect(next.agentId).toBe(first.agentId);
  expect(store.runs()).toHaveLength(2);
  await watch.tick();
  expect(release).toHaveBeenCalledTimes(1);
});
it('reads safe app identities and distinguishes dispatch pressure flags from kernel enums', () => {
  const rows = parseProcesses(
    ' 123 1 Fri Sep 25 00:00:00 2026 12:30.50 1024 /Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n 124 123 Fri Sep 25 00:00:00 2026 1:02:03 2048 /usr/bin/node',
  );
  expect(rows.map((r) => r.name)).toEqual(['Google Chrome', 'node']);
  expect(rows.map((r) => r.cpuSeconds)).toEqual([750.5, 3723]);
  expect(JSON.stringify(rows)).not.toContain('/Applications');
  expect(parseProcesses('unrecognized output')).toEqual([]);
  expect(['1', '2', '4', '0', 'junk'].map(parsePressure)).toEqual([
    'normal',
    'warning',
    'critical',
    'unknown',
    'unknown',
  ]);
  expect(parseSwap('used = 1.25G')).toBe(1.25 * 1024 ** 3);
  expect(
    parseVm('page size of 16384 bytes\nPages occupied by compressor: 20.\nSwapouts: 4.'),
  ).toEqual({ compressedBytes: 20 * 16384, swapOutBytes: 4 * 16384 });
});
it('requires persistence, ignores old swap and resets sustained evidence after sleep', () => {
  const now = Date.now(),
    sample = base(now, 90);
  const first = resourceFindings(sample, [], now, false);
  expect(first.map((f) => f.id)).toEqual(['cpu']);
  expect(first[0]?.sustained).toBe(false);
  expect(resourceFindings(sample, first, now + 120_000, true)[0]?.sustained).toBe(true);
  expect(resourceFindings(sample, first, now + 120_000, false)[0]?.sustained).toBe(false);
  expect(resourceFindings({ ...base(now), memoryPressure: 'unknown' }, [], now, false)).toEqual([]);
});
it('retains a bounded history across restarts without starting agents on reads', async () => {
  const { watch, store, advance, root, dependencies, now } = fixture();
  await watch.tick();
  await watch.tick();
  expect(watch.status().history).toHaveLength(1);
  expect(store.agents()).toHaveLength(0);
  advance(86400_000 + 120_000);
  await watch.tick();
  expect(watch.status().history).toHaveLength(1);
  const restored = new ResourceWatch(store, root, dependencies, now);
  expect(restored.status().latest?.machine?.cpuUsedPercent).toBe(20);
  advance(60_000);
  expect(restored.status().stale).toBe(true);
  await restored.close();
});
it('uses a single durable request, an exact catalog model and the existing queue', async () => {
  const { watch, store, release, cpu } = fixture();
  await watch.tick();
  const key = randomUUID();
  const first = await watch.ask({ key, question: 'Why is Chrome slow?' });
  const check = first.checks[0]!;
  cpu(90);
  await watch.tick();
  expect(watch.context(check.agentId).requestEvidence).toMatchObject({
    sample: { machine: { cpuUsedPercent: 20 } },
  });
  expect(watch.context(check.agentId).latest?.machine?.cpuUsedPercent).toBe(90);
  expect(store.agent(check.agentId)).toMatchObject({
    provider: 'claude',
    model: 'sonnet-fixture',
    permission: 'workspace-write',
    role: 'manager',
  });
  expect(store.getSetting(`pulsar:estimate:${check.runId}`)).toMatchObject({
    priority: 'interactive',
    quotaPercent: 1,
  });
  await watch.ask({ key, question: 'Why is Chrome slow?' });
  expect(store.runs()).toHaveLength(1);
  await expect(watch.ask({ key, question: 'Changed request' })).rejects.toThrow('retry key');
  await expect(watch.ask({ key: randomUUID() })).rejects.toThrow('already queued');
  store.updateRun(check.runId, { status: 'completed' });
  store.entry({
    id: randomUUID(),
    agentId: check.agentId,
    runId: check.runId,
    kind: 'assistant',
    title: '',
    text: 'Chrome is using memory, but pressure is normal.',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  await watch.tick();
  expect(release).toHaveBeenCalledWith(check.agentId);
  expect(watch.status().checks[0]?.summary).toContain('pressure is normal');
});
it('does not guess another model, and stale or concurrent requests do not create agents', async () => {
  const { watch, store, models, advance } = fixture();
  await watch.tick();
  models.mockResolvedValueOnce([
    { id: 'unrelated', label: 'Another model', isDefault: true, efforts: ['low'] },
  ]);
  await expect(watch.ask({ key: randomUUID() })).rejects.toThrow('no sonnet model');
  expect(store.agents()).toHaveLength(0);
  advance(60_000);
  watch.save({ key: randomUUID(), settings: { automatic: true } });
  await expect(watch.ask({ key: randomUUID() }, 'checkpoint')).rejects.toThrow('fresh computer');
});
it('requested native inspection can start without a fresh snapshot, while automatic checks wait', async () => {
  const { watch, store } = fixture(true);
  watch.save({ key: randomUUID(), settings: { automatic: true } });
  await expect(watch.ask({ key: randomUUID() }, 'checkpoint')).rejects.toThrow('fresh computer');
  expect(store.agents()).toHaveLength(0);
  const check = (await watch.ask({ key: randomUUID(), question: 'Inspect a stalled service.' }))
    .checks[0]!;
  expect(store.agent(check.agentId)).toMatchObject({
    resourceAssistant: { mode: 'interactive', reason: 'asked' },
    permission: 'workspace-write',
    toolPolicy: 'native',
  });
  expect(watch.context(check.agentId)).toMatchObject({ stale: true, latest: null });
});
it('recovers durable automatic identity beyond the recent list without classifying ordinary chats', async () => {
  const { watch, store, root, dependencies, now } = fixture();
  watch.save({ key: randomUUID(), settings: { automatic: true } });
  await watch.tick();
  const check = (await watch.ask({ key: randomUUID() }, 'checkpoint')).checks[0]!;
  store.updateRun(check.runId, { status: 'completed' });
  const followup = (await watch.ask({ key: randomUUID(), agentId: check.agentId })).checks[0]!;
  store.updateRun(followup.runId, { status: 'completed' });
  // Emulate a report saved before durable identity metadata existed.
  store.updateAgent(check.agentId, {
    resourceAssistant: undefined,
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  store.setSetting('resources:checks', []);
  const ordinary = store.addManager(watch.projectId()!, 'My own computer chat', '', 'codex');
  const restored = new ResourceWatch(store, root, dependencies, now);
  expect(restored.status().checks).toHaveLength(0);
  expect(store.agent(check.agentId)).toMatchObject({
    resourceAssistant: { mode: 'snapshot', reason: 'checkpoint' },
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  expect(store.agent(ordinary.id)).not.toHaveProperty('resourceAssistant');
  expect(store.runs()).toHaveLength(2);
  await restored.ask({ key: randomUUID(), agentId: check.agentId });
  expect(restored.isInteractive(check.agentId)).toBe(true);
  await restored.close();
});
it('keeps a legacy resource identity with unknown origin bounded on an explicit follow-up', async () => {
  const { watch, store, root, dependencies, now } = fixture();
  await watch.tick();
  const check = (await watch.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(check.runId, { status: 'completed' });
  const legacy = store.addManager(watch.projectId()!, 'Legacy resource report', '', 'claude');
  store.setSetting(`resources:agent:${legacy.id}`, true);
  store.updateAgent(legacy.id, {
    model: 'sonnet-fixture',
    effort: 'low',
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  const restored = new ResourceWatch(store, root, dependencies, now);
  expect(store.agent(legacy.id).resourceAssistant).toEqual({ mode: 'snapshot' });
  await restored.ask({ key: randomUUID(), agentId: legacy.id });
  expect(store.agent(legacy.id)).toMatchObject({
    resourceAssistant: { mode: 'snapshot' },
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  await restored.close();
});
it('upgrades known reports only on an explicit owner question, preserving the same history', async () => {
  const { watch, store, root, dependencies, now, release } = fixture();
  await watch.tick();
  const first = (await watch.ask({ key: randomUUID() })).checks[0]!;
  const threadId = 'old-requested-resource-thread';
  store.updateRun(first.runId, { status: 'completed' });
  store.updateAgent(first.agentId, {
    threadId,
    resourceAssistant: undefined,
    permission: 'read-only',
    toolPolicy: 'restricted',
  });
  const restored = new ResourceWatch(store, root, dependencies, now);
  expect(restored.isSnapshot(first.agentId)).toBe(true);
  const next = (await restored.ask({ key: randomUUID(), agentId: first.agentId })).checks[0]!;
  expect(next.agentId).toBe(first.agentId);
  expect(release).toHaveBeenCalledWith(first.agentId);
  expect(store.agent(first.agentId)).toMatchObject({
    threadId,
    resourceAssistant: { mode: 'interactive', reason: 'asked' },
    permission: 'workspace-write',
    toolPolicy: 'native',
  });
  store.updateRun(next.runId, { status: 'completed' });
  restored.save({ key: randomUUID(), settings: { automatic: true } });
  const automatic = (await restored.ask({ key: randomUUID() }, 'pressure')).checks[0]!;
  store.updateRun(automatic.runId, { status: 'completed' });
  await restored.ask({
    key: randomUUID(),
    agentId: automatic.agentId,
    question: 'Explain that report.',
  });
  expect(store.agent(automatic.agentId)).toMatchObject({
    resourceAssistant: { mode: 'interactive', reason: 'asked' },
    permission: 'workspace-write',
    toolPolicy: 'native',
  });
  expect(store.runs()).toHaveLength(4);
  await restored.close();
});
it('queues persistent pressure once per episode, coalesces checkpoints and persists cooldown', async () => {
  const { watch, store, cpu, advance, root, dependencies, now } = fixture();
  watch.save({ key: randomUUID(), settings: { automatic: true, checkpointHours: 1 } });
  cpu(90);
  for (let i = 0; i < 9; i++) {
    await watch.tick();
    if (i < 8) advance(15_000);
  }
  expect(store.runs()).toHaveLength(1);
  const check = watch.status().checks[0]!;
  expect(check.reason).toBe('pressure');
  expect(store.getSetting(`pulsar:estimate:${check.runId}`)).toMatchObject({
    priority: 'background',
  });
  store.updateRun(check.runId, { status: 'completed' });
  for (let i = 0; i < 121; i++) {
    advance(15_000);
    await watch.tick();
  }
  expect(store.runs()).toHaveLength(1);
  const restored = new ResourceWatch(store, root, dependencies, now);
  await restored.tick();
  expect(store.runs()).toHaveLength(1);
  watch.save({ key: randomUUID(), settings: { automatic: false } });
  expect(watch.status().nextCheckpointAt).toBeNull();
  await restored.close();
});
it('expires queued diagnostics and interrupts a long running diagnosis without replay', async () => {
  const { watch, store, advance, interrupt } = fixture();
  watch.save({ key: randomUUID(), settings: { automatic: true } });
  await watch.tick();
  const queued = (await watch.ask({ key: randomUUID() }, 'checkpoint')).checks[0]!;
  advance(16 * 60_000);
  await watch.tick();
  expect(store.run(queued.runId).status).toBe('cancelled');
  const running = (await watch.ask({ key: randomUUID() }, 'checkpoint')).checks[0]!;
  store.updateRun(running.runId, { status: 'running' });
  await watch.tick();
  advance(181_000);
  await watch.tick();
  expect(interrupt).toHaveBeenCalledWith(running.agentId);
  expect(store.runs()).toHaveLength(2);
});
it('protects resource APIs from hostile origins and denies the assistant execution tools', async () => {
  const { root, store } = fixture();
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  cleanups.push(async () => {
    await app.close();
    await runtime.close();
  });
  expect(
    (await app.inject({ url: '/api/resources', headers: { host: '127.0.0.1:4330' } })).statusCode,
  ).toBe(200);
  expect(store.runs()).toHaveLength(0);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/resources/ask',
        payload: { key: randomUUID() },
        headers: { host: '127.0.0.1:4330', origin: 'https://evil.invalid' },
      })
    ).statusCode,
  ).toBe(403);
  const project = store.register(root, 'IT', '');
  store.setSetting(`resources:agent:${project.managerId}`, true);
  await expect(
    runtime.tool(project.managerId, randomUUID(), 'dock_task_create', {}),
  ).rejects.toThrow('only explain');
  expect(runtime.context(store.agent(project.managerId))).toContain('Resource evidence');
});
it('caps automatic work across restarts and never catches up missed checkpoints in a burst', async () => {
  const { watch, store, advance, root, dependencies, now } = fixture();
  watch.save({ key: randomUUID(), settings: { automatic: true, checkpointHours: 1 } });
  await watch.tick();
  for (let i = 0; i < 8; i++) {
    advance(3600_000);
    await watch.tick();
    const run = store.runs().find((r) => r.status === 'queued');
    if (run) store.updateRun(run.id, { status: 'completed' });
  }
  expect(store.runs()).toHaveLength(6);
  const restored = new ResourceWatch(store, root, dependencies, now);
  advance(3600_000);
  await restored.tick();
  expect(store.runs()).toHaveLength(6);
  expect(restored.status().automaticChecksToday).toBe(6);
  await restored.close();
});
it('an interrupted diagnostic is retained and not replayed on recovery', async () => {
  const { watch, store, root, dependencies, now } = fixture();
  await watch.tick();
  const check = (await watch.ask({ key: randomUUID() })).checks[0]!;
  store.updateRun(check.runId, { status: 'running' });
  store.updateAgent(check.agentId, { status: 'running' });
  store.recover();
  const restored = new ResourceWatch(store, root, dependencies, now);
  await restored.tick();
  expect(restored.status().checks[0]?.state).toBe('interrupted');
  expect(store.runs()).toHaveLength(1);
  await restored.close();
});
it('stops only the selected check and makes retries idempotent', async () => {
  const { watch, store } = fixture();
  await watch.tick();
  const check = (await watch.ask({ key: randomUUID() })).checks[0]!;
  const input = { key: randomUUID(), checkId: check.id };
  await watch.stop(input);
  await watch.stop(input);
  expect(store.run(check.runId).status).toBe('cancelled');
  expect(store.agent(check.agentId).status).toBe('idle');
  expect(watch.status().checks[0]?.waitReason).toContain('cancelled');
  await expect(watch.stop({ key: randomUUID(), checkId: randomUUID() })).rejects.toThrow(
    'recent check list',
  );
});

it.each(['queued', 'running'] as const)(
  'answers an owner while an automatic check is %s, without starting a second owner question',
  async (state) => {
    const { watch, store } = fixture();
    await watch.tick();
    watch.save({ key: randomUUID(), settings: { automatic: true } });
    const background = (await watch.ask({ key: randomUUID() }, 'checkpoint')).checks[0]!;
    store.updateRun(background.runId, { status: state });
    const question = (await watch.ask({ key: randomUUID(), question: 'What is using the CPU?' }))
      .checks[0]!;
    expect(question.reason).toBe('asked');
    expect(store.getSetting(`pulsar:estimate:${question.runId}`)).toMatchObject({
      priority: 'interactive',
    });
    expect(store.run(background.runId).status).toBe(state === 'queued' ? 'cancelled' : 'running');
    await expect(
      watch.ask({ key: randomUUID(), question: 'Another simultaneous question' }),
    ).rejects.toThrow('already queued or running');
  },
);
