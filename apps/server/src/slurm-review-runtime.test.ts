import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSlurmSubmissionPolicy, type ClusterStatus } from '@dock/shared';
import { modelFixture } from './model-policy.fixture.js';
import { DemoProvider } from './demo.js';
import {
  ClaudeSession,
  claudeArguments,
  parseClaudeIdentity,
  type ClaudeEvent,
  type ClaudeModel,
  type ClaudeSessionOptions,
} from './claude-session.js';
import { Runtime } from './runtime.js';
import { slurmReviewerCharter } from './slurm-review.js';
import { Store } from './store.js';

const identity = parseClaudeIdentity({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.invalid',
  orgId: 'fixture',
});
const models: ClaudeModel[] = [
  {
    value: 'default',
    displayName: 'Default Claude fixture',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
];
class FixtureSession extends ClaudeSession {
  override inspectCommands = vi.fn(async () => []);
  override submit = vi.fn(
    async (input: { deliveryId: string; text: string; appContext?: string }) => {
      if (this.submit.mock.calls.length === 1) this.options.beforeStart?.();
      this.options.beforeWrite?.(input.deliveryId);
    },
  );
  override close = vi.fn(async () => {});
  override interrupt = vi.fn(async (): Promise<'cancelled_start' | 'requested'> => 'requested');
  send(event: ClaudeEvent) {
    this.emit('event', event);
  }
}

let root: string, store: Store, runtime: Runtime, manager: string, projectRoot: string;
let instances: FixtureSession[];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dock-slurm-runtime-'));
  projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, 'job.sh'), '#!/bin/bash\n#SBATCH -t 30\necho hi\n');
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const registered = store.register(projectRoot, 'Cluster fixture', '');
  manager = registered.managerId;
  store.updateAgent(manager, { provider: 'claude' });
  instances = [];
  runtime = new Runtime(store, root, 'never-spawn-codex', async () => new DemoProvider(), {
    identity: async () => identity,
    inspect: async () => ({ identity, models }),
    session: (options: ClaudeSessionOptions) => {
      const session = new FixtureSession(options);
      instances.push(session);
      return session;
    },
  });
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  const section = { observedAt, error: null, items: [], omitted: 0 };
  // Never contact a cluster from this test: readings are fixed fakes.
  vi.spyOn(runtime.cluster, 'refresh').mockResolvedValue(undefined as never);
  vi.spyOn(runtime.cluster, 'tick').mockResolvedValue(undefined);
  vi.spyOn(runtime.cluster, 'settings').mockReturnValue({
    enabled: true,
    alias: 'cannon',
    label: 'Cannon',
    accountingDays: 3,
  });
  const reading: ClusterStatus = {
    configured: true,
    settings: { enabled: true, alias: 'cannon', label: 'Cannon', accountingDays: 3 },
    revision: 1,
    connection: {
      state: 'connected',
      master: 'running',
      checkedAt: observedAt,
      connectedAt: observedAt,
      message: '',
    },
    scheduler: { version: '24.05', cluster: 'fixture' },
    queue: { ...section, priority: [] },
    fairshare: { ...section },
    limits: { ...section, accounts: [], qos: [], partitions: [], site: null },
    recent: { ...section },
    tracked: [],
    unavailable: [],
    refreshing: false,
    nextRefreshAt: null,
    stale: false,
    notice: '',
  };
  vi.spyOn(runtime.cluster, 'status').mockReturnValue(reading);
  runtime.slurmReview.savePolicy({
    scope: 'global',
    key: randomUUID(),
    expectedRevision: 0,
    policy: {
      ...defaultSlurmSubmissionPolicy,
      enabled: true,
      confirmedAccount: 'lab',
      reviewer: { provider: 'claude', family: 'sonnet', model: 'default', effort: null },
    },
  });
  await runtime.initialize();
});
afterEach(async () => {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
async function started(agentId: string, runId: string) {
  await vi.waitFor(() =>
    expect(
      instances.some((session) =>
        session.submit.mock.calls.some(([input]) => input.deliveryId === runId),
      ),
    ).toBe(true),
  );
  expect(store.agent(agentId).status).toBe('running');
  return instances.find((session) =>
    session.submit.mock.calls.some(([input]) => input.deliveryId === runId),
  )!;
}
const bash = (session: FixtureSession, runId: string, command: string) =>
  session.options.hook!(
    {
      session_id: session.options.sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: randomUUID(),
      tool_input: { command },
      cwd: projectRoot,
    },
    runId,
  );

it('holds a managed manager submission, runs one tool-less reviewer under QUARK and then passes the exact command', async () => {
  const run = store.enqueue(manager, randomUUID(), 'Submit the fixture job');
  const session = await started(manager, run.id);
  expect(session.options.charter).toContain('dock_slurm_review');
  expect(session.options.tools.map((tool) => tool.name)).toContain('dock_slurm_review');
  // Unrelated native tools keep native behavior.
  expect(
    session.options.hook!(
      {
        session_id: session.options.sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'ls',
        tool_input: { command: 'ls' },
      },
      run.id,
    ),
  ).toEqual({});
  const command = 'sbatch --account=lab job.sh';
  expect(bash(session, run.id, command)).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringMatching(/pending[\s\S]*Do not poll/),
    },
  });
  const [review] = runtime.slurmReview.list();
  await vi.waitFor(() => expect(runtime.slurmReview.get(review!.id).reviewer?.runId).toBeTruthy());
  const reviewer = runtime.slurmReview.get(review!.id).reviewer!;
  // The manager finishes its turn instead of waiting; QUARK admits the reviewer separately.
  session.send({
    type: 'result',
    id: randomUUID(),
    deliveryId: run.id,
    sessionId: session.options.sessionId,
    status: 'completed',
    text: '',
    usage: null,
  });
  const reviewerSession = await started(reviewer.agentId!, reviewer.runId!);
  expect(runtime.pulsar.isUrgentDiagnostic(store.run(reviewer.runId!))).toBe(true);
  expect(reviewerSession.options).toMatchObject({
    role: 'read-only',
    tools: [],
    inheritNative: false,
    nativeTools: 'off',
  });
  const arguments_ = claudeArguments(reviewerSession.options);
  expect(arguments_[arguments_.indexOf('--tools') + 1]).toBe('');
  expect(arguments_).toContain('--strict-mcp-config');
  expect(arguments_).toContain('--disable-slash-commands');
  expect(reviewerSession.options.charter).toContain(slurmReviewerCharter.slice(0, 80));
  const submitted = reviewerSession.submit.mock.calls[0]![0];
  expect(submitted.text).toBe(
    'Review the supplied Slurm submission proposal and reply with the JSON assessment only.',
  );
  expect(submitted.appContext).toContain('Slurm submission proposal and evidence');
  expect(submitted.appContext).toContain('echo hi');
  // The reviewer itself can never run a submission.
  expect(bash(reviewerSession, reviewer.runId!, command)).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny' },
  });
  reviewerSession.send({
    type: 'message',
    id: 'assessment',
    role: 'assistant',
    text: JSON.stringify({
      disposition: 'approve',
      summary: 'Thirty-minute job on the confirmed account.',
      findings: [],
      suggestedCorrection: null,
      uncertainty: 'No partition limits were reported.',
      evidenceUsed: ['owner policy'],
    }),
  });
  reviewerSession.send({
    type: 'result',
    id: randomUUID(),
    deliveryId: reviewer.runId!,
    sessionId: reviewerSession.options.sessionId,
    status: 'completed',
    text: '',
    usage: null,
  });
  await vi.waitFor(() =>
    expect(runtime.slurmReview.get(review!.id)).toMatchObject({
      status: 'completed',
      allowsSubmission: true,
    }),
  );
  const report = store
    .runs()
    .find((item) => item.agentId === manager && item.key === `slurm-review:report:${review!.id}`);
  expect(report?.kind).toBe('report');
  const next = await started(manager, report!.id);
  expect(bash(next, report!.id, command)).toEqual({});
  expect(store.events().some((event) => event.type === 'slurm_review.passed')).toBe(true);
});

it('reads saved results without granting reviewer tools or direct continuation', async () => {
  const tools = runtime['tools'](store.agent(manager)).map((tool) => tool.name);
  expect(tools).toContain('dock_slurm_review');
  const result = (await runtime.tool(manager, randomUUID(), 'dock_slurm_review', {
    command: 'sbatch --account=lab job.sh',
  })) as { reviewId: string };
  await vi.waitFor(() =>
    expect(runtime.slurmReview.get(result.reviewId).reviewer?.agentId).toBeTruthy(),
  );
  const reviewerId = runtime.slurmReview.get(result.reviewId).reviewer!.agentId!;
  expect(runtime['tools'](store.agent(reviewerId))).toEqual([]);
  expect(() => runtime.requireDirectControl(reviewerId)).toThrow('single bounded request');
  await expect(
    runtime.tool(reviewerId, randomUUID(), 'dock_slurm_review', { reviewId: result.reviewId }),
  ).rejects.toThrow('supplied evidence');
  expect(
    await runtime.tool(manager, randomUUID(), 'dock_slurm_review', { reviewId: result.reviewId }),
  ).toMatchObject({ reviewId: result.reviewId });
});
