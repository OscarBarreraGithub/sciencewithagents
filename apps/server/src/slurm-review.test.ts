import { developmentProposal } from './cluster-development.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  defaultModelPolicy,
  defaultSlurmSubmissionPolicy,
  type ClusterStatus,
  type ProviderId,
  type SlurmSubmissionPolicy,
} from '@dock/shared';
import { ModelPolicy } from './model-policy.js';
import { remoteScriptProgram } from './slurm-remote-script.js';
import {
  parseSlurmAssessment,
  registerSlurmReviewRoutes,
  SlurmReview,
  slurmReviewerCharter,
} from './slurm-review.js';
import { Conflict, Store } from './store.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const approve = JSON.stringify({
  disposition: 'approve',
  summary: 'Small test job within the confirmed account and partition limits.',
  findings: [
    {
      severity: 'note',
      rule: 'Site: test partition',
      detail: 'Two hours fits 12 h.',
      evidence: 'site rules',
    },
  ],
  suggestedCorrection: null,
  uncertainty: 'Queue state can change before submission.',
  evidenceUsed: ['partition test', 'association lab'],
});

function cluster(observedAt: string, overrides: Partial<ClusterStatus> = {}): ClusterStatus {
  const section = { observedAt, error: null, items: [], omitted: 0 };
  return {
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
    scheduler: { version: '24.05', cluster: 'odyssey' },
    queue: { ...section, priority: [] },
    fairshare: {
      ...section,
      items: [
        {
          account: 'lab',
          fairShare: 0.4,
          levelFairShare: null,
          accountNormShares: null,
          accountEffectiveUsage: null,
          accountRawUsage: null,
          userRawUsage: null,
        },
      ],
    },
    limits: {
      ...section,
      items: [
        {
          cluster: 'odyssey',
          account: 'lab',
          partition: '',
          qos: ['normal'],
          defaultQos: 'normal',
          maxJobs: null,
          maxSubmit: null,
          maxWall: '',
          maxTres: '',
          maxTresPerNode: '',
          grpJobs: null,
          grpSubmit: null,
          grpTres: '',
          grpTresRunMins: '',
          grpWall: '',
        },
      ],
      accounts: [],
      qos: [],
      partitions: [
        {
          name: 'test',
          state: 'UP',
          maxTime: '12:00:00',
          defaultTime: '00:10:00',
          maxNodes: 'UNLIMITED',
          maxCpusPerNode: 'UNLIMITED',
          defMemPerCpu: '',
          defMemPerNode: '',
          maxMemPerNode: '',
          qos: 'normal',
          preemptMode: 'OFF',
          priorityTier: 1,
          totalCpus: 2240,
          totalNodes: 20,
          gres: '',
          cpus: { allocated: 100, idle: 2000, other: 0, total: 2240 },
          accessible: true,
        },
      ],
      site: {
        maxArraySize: 10000,
        maxJobCount: null,
        enforce: 'limits,qos',
        priorityType: 'multifactor',
        priorityFlags: '',
      },
    },
    recent: { ...section },
    tracked: [],
    unavailable: [],
    refreshing: false,
    nextRefreshAt: null,
    stale: false,
    notice: '',
    ...overrides,
  };
}

function fixture(
  options: {
    enabled?: ProviderId[];
    insideAllocation?: boolean;
    remote?: Map<string, string | Error>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'swa-slurm-review-'));
  const store = new Store(join(root, 'dock.sqlite'));
  store.setSetting('slurm-review:policy', { ...defaultSlurmSubmissionPolicy, enabled: true });
  const modelPolicy = structuredClone(defaultModelPolicy);
  modelPolicy.enabledProviders = options.enabled ?? ['codex', 'claude'];
  store.setSetting('model-policy', modelPolicy);
  let now = Date.parse('2026-10-06T12:00:00.000Z');
  const models = vi.fn(async (provider: ProviderId) =>
    provider === 'claude'
      ? [
          {
            id: 'claude-sonnet-5-5',
            label: 'Sonnet 5.5',
            isDefault: false,
            efforts: ['low', 'medium', 'high'],
          },
          { id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: false, efforts: ['high'] },
        ]
      : [{ id: 'gpt-terra-2', label: 'Terra 2', isDefault: false, efforts: ['low', 'medium'] }],
  );
  const policy = new ModelPolicy(store, models, () => now);
  const resolve = vi.spyOn(policy, 'resolve');
  let evidence: ClusterStatus | null = cluster(new Date(now - 60_000).toISOString());
  const refresh = vi.fn();
  const kick = vi.fn();
  const release = vi.fn(async () => true);
  const interrupt = vi.fn(async (agentId: string) => {
    for (const run of store.runs().filter((r) => r.agentId === agentId && r.status === 'running'))
      store.updateRun(run.id, { status: 'interrupted' });
  });
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(
    join(project, 'job.sh'),
    '#!/bin/bash\n#SBATCH -t 02:00:00\n#SBATCH --mem=4G\npython run.py\n',
  );
  const siteDir = join(root, 'site-rules');
  mkdirSync(siteDir);
  writeFileSync(
    join(siteDir, 'fasrc-cannon.md'),
    '---\ntitle: FASRC Cannon\nretrieved: 2026-10-06\nsources:\n  - https://docs.rc.fas.harvard.edu/kb/running-jobs/\n---\nThe test partition allows 1-5 small jobs up to 12 hours.\n',
  );
  const registered = store.register(project, 'Cluster work', 'Cluster project', 'claude');
  const make = () =>
    new SlurmReview(
      store,
      root,
      {
        policy,
        evidence: () => evidence,
        refreshEvidence: refresh,
        release,
        interrupt,
        kick,
        insideAllocation: options.insideAllocation ?? false,
        clusterAlias: () => 'cannon',
        ...(options.remote
          ? {
              remoteScript: async (_alias: string, path: string, directory: string | null) => {
                const value = options.remote!.get(`${directory ?? ''}|${path}`);
                return value === undefined
                  ? { error: 'The remote script is missing or unreadable.' }
                  : value instanceof Error
                    ? { error: value.message }
                    : { content: value };
              },
            }
          : {}),
        siteRuleDirectories: [join(root, 'refreshed-rules'), siteDir],
      },
      () => now,
    );
  let review = make();
  cleanups.push(async () => {
    await review.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const savePolicy = (change: Partial<SlurmSubmissionPolicy>, projectId?: string) => {
    const current = projectId ? review.policies(projectId).project : review.policy().policy;
    return review.savePolicy({
      ...(projectId ? { scope: 'project', projectId } : { scope: 'global' }),
      key: randomUUID(),
      expectedRevision: current?.revision ?? 0,
      policy: { ...(current ?? defaultSlurmSubmissionPolicy), ...change },
    });
  };
  const bash = (command: string, agentId = registered.managerId, cwd = project) =>
    review.hook({
      agentId,
      event: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: randomUUID(),
        cwd,
      },
    });
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(review['dispatching'].values());
  };
  const reviewerRun = (id: string) => {
    const saved = review.get(id);
    return { agentId: saved.reviewer!.agentId!, runId: saved.reviewer!.runId! };
  };
  const finish = async (
    id: string,
    text: string | null,
    status: 'completed' | 'failed' = 'completed',
  ) => {
    const { agentId, runId } = reviewerRun(id);
    store.updateRun(runId, { status: 'running' });
    await review.maintain();
    if (text !== null)
      store.entry({
        id: randomUUID(),
        agentId,
        runId,
        kind: 'assistant',
        title: 'Reply',
        text,
        status: 'complete',
        createdAt: new Date(now).toISOString(),
      });
    store.updateRun(runId, { status });
    await review.maintain();
    return review.get(id);
  };
  return {
    root,
    store,
    get review() {
      return review;
    },
    /** A new service instance over the same durable store (process restart). */
    restart() {
      review = make();
    },
    project,
    registered,
    models,
    resolve,
    refresh,
    release,
    interrupt,
    savePolicy,
    bash,
    settle,
    finish,
    reviewerRun,
    setEvidence(value: ClusterStatus | null) {
      evidence = value;
    },
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}
const reviewIdFrom = (output: Record<string, unknown> | null) => {
  const reason = (output?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)
    ?.permissionDecisionReason;
  return reason?.match(/review ([0-9a-f-]{36})/)?.[1] ?? null;
};
const reasonOf = (output: Record<string, unknown> | null) =>
  (output?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)
    ?.permissionDecisionReason ?? '';

describe('Slurm submission review hook adapter', () => {
  it('preserves native behavior for unrelated events, tools, commands and validation runs', () => {
    const f = fixture();
    expect(f.bash('ls -la && python run.py')).toBeNull();
    expect(f.bash('sbatch --test-only job.sh')).toBeNull();
    expect(
      f.review.hook({
        agentId: f.registered.managerId,
        event: {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'sbatch job.sh' },
        },
      }),
    ).toBeNull();
    expect(
      f.review.hook({
        agentId: f.registered.managerId,
        event: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: 'sbatch' },
        },
      }),
    ).toBeNull();
    expect(f.store.events().filter((event) => event.type.startsWith('slurm_review.'))).toEqual([]);
  });

  it('turns off completely when the owner disables review', async () => {
    const f = fixture();
    f.savePolicy({ enabled: false });
    expect(f.bash('sbatch job.sh')).toBeNull();
    await expect(
      f.review.tool(f.registered.managerId, randomUUID(), { command: 'sbatch job.sh' }),
    ).rejects.toThrow(/turned off/);
  });

  it('asks the owner without a model turn when no lab account is confirmed', async () => {
    const f = fixture();
    const held = f.bash('sbatch -p test job.sh');
    const id = reviewIdFrom(held)!;
    expect(reasonOf(held)).toMatch(/ask_owner[\s\S]*No lab account has been confirmed/);
    await f.settle();
    const saved = f.review.get(id);
    expect(saved).toMatchObject({
      status: 'completed',
      disposition: 'ask_owner',
      allowsSubmission: false,
      reviewer: null,
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.store.runs()).toHaveLength(0);
  });

  it('holds a new submission, reviews it once, and passes the identical retry after approval', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab', siteRules: 'fasrc-cannon' });
    const first = f.bash('sbatch --account=lab -p test job.sh');
    const id = reviewIdFrom(first)!;
    expect(reasonOf(first)).toMatch(/pending[\s\S]*Do not poll/);
    // Duplicate deliveries and the manager retrying before completion reuse the same review.
    expect(reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'))).toBe(id);
    await f.settle();
    // Exact text is the proposal: a textually different command is reviewed separately.
    const variant = reviewIdFrom(f.bash('sbatch   --account=lab -p test job.sh'));
    expect(variant).not.toBe(id);
    await f.settle();
    const runs = f.store.runs();
    expect(runs.filter((run) => run.key.startsWith('slurm-review:run:'))).toHaveLength(2);
    const saved = f.review.get(id);
    expect(saved.reviewer).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
    expect(f.resolve).toHaveBeenCalledWith(
      'routine',
      expect.objectContaining({ provider: 'claude' }),
      false,
      { family: 'sonnet', model: null, effort: null },
    );
    const context = f.review.context(saved.reviewer!.agentId!);
    expect(context).toContain('FASRC Cannon');
    expect(context).toContain('python run.py');
    expect(context).toContain('"fairShare":0.4');
    const done = await f.finish(id, approve);
    expect(done).toMatchObject({
      status: 'completed',
      disposition: 'approve',
      allowsSubmission: true,
    });
    expect(f.bash('sbatch --account=lab -p test job.sh')).toBeNull();
    // One completion report reaches the manager; a later maintenance pass does not repeat it.
    await f.review.maintain();
    const reports = f.store
      .runs()
      .filter((run) => run.agentId === f.registered.managerId && run.kind === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain('approved');
    expect(f.release).toHaveBeenCalledWith(saved.reviewer!.agentId);
    // Approval expires; identical content then needs a fresh review.
    f.advance(121 * 60_000);
    f.setEvidence(cluster(new Date(f.now - 60_000).toISOString()));
    expect(reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'))).not.toBe(id);
  });

  it('never reuses an approval for a changed script, command, policy or native limits', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'))!;
    await f.settle();
    await f.finish(id, approve);
    expect(f.bash('sbatch --account=lab -p test job.sh')).toBeNull();

    writeFileSync(
      join(f.project, 'job.sh'),
      '#!/bin/bash\n#SBATCH -t 11:00:00\npython run.py --big\n',
    );
    const changedScript = reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'));
    expect(changedScript).not.toBe(id);
    expect(f.review.get(changedScript!).status).toBe('queued');

    writeFileSync(
      join(f.project, 'job.sh'),
      '#!/bin/bash\n#SBATCH -t 02:00:00\n#SBATCH --mem=4G\npython run.py\n',
    );
    expect(f.bash('sbatch --account=lab -p test job.sh')).toBeNull();
    expect(reviewIdFrom(f.bash('sbatch --account=lab -p test -c 8 job.sh'))).not.toBe(id);

    f.savePolicy({ labRules: 'Use the test partition for anything under one hour.' });
    const changedPolicy = reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'));
    expect(changedPolicy).not.toBeNull();
    expect(changedPolicy).not.toBe(id);
  });

  it('invalidates on changed native limits but not on volatile fairshare', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'))!;
    await f.settle();
    await f.finish(id, approve);
    const reading = cluster(new Date(f.now - 30_000).toISOString());
    reading.fairshare.items[0]!.fairShare = 0.1;
    reading.limits.partitions[0]!.cpus = { allocated: 2000, idle: 240, other: 0, total: 2240 };
    f.setEvidence(reading);
    expect(f.bash('sbatch --account=lab -p test job.sh')).toBeNull();
    const tightened = cluster(new Date(f.now - 30_000).toISOString());
    tightened.limits.partitions[0]!.maxTime = '06:00:00';
    f.setEvidence(tightened);
    expect(reviewIdFrom(f.bash('sbatch --account=lab -p test job.sh'))).not.toBe(id);
  });

  it('treats malformed or absent reviewer results as failures, never approval, and bounds retries', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    const malformed = await f.finish(id, 'Looks fine to me! {"disposition":"approve"}');
    expect(malformed).toMatchObject({
      status: 'failed',
      allowsSubmission: false,
      disposition: null,
    });
    expect(malformed.failure).toMatch(/not a valid structured assessment/);
    const second = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    expect(second).not.toBe(id);
    await f.settle();
    const absent = await f.finish(second, null, 'failed');
    expect(absent).toMatchObject({ status: 'failed', allowsSubmission: false });
    // Two automatic attempts; the third retry stays held for the owner without a new run.
    const runs = f.store.runs().length;
    const third = f.bash('sbatch --account=lab job.sh');
    expect(reviewIdFrom(third)).toBe(second);
    expect(reasonOf(third)).toMatch(/Ask the owner/);
    expect(f.store.runs()).toHaveLength(runs);
    // An explicit owner retry starts a fresh attempt.
    const retried = f.review.ownerDecision(second, {
      key: randomUUID(),
      decision: 'retry',
      note: '',
    });
    expect(retried.id).not.toBe(second);
    expect(retried.origin).toBe('owner');
  });

  it('downgrades an approve with blocking findings and keeps host owner-policy findings', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    const inconsistent = JSON.parse(approve);
    inconsistent.findings.push({
      severity: 'blocking',
      rule: 'Site: test',
      detail: 'Combined partitions.',
      evidence: 'site',
    });
    expect(await f.finish(id, '```json\n' + JSON.stringify(inconsistent) + '\n```')).toMatchObject({
      disposition: 'revise',
      allowsSubmission: false,
    });
    const deterministic = f.bash('sbatch -p test job.sh');
    expect(reasonOf(deterministic)).toMatch(/revise[\s\S]*Add --account=lab/);
    f.savePolicy({
      allowedPartitions: ['test'],
      resources: { ...defaultSlurmSubmissionPolicy.resources, maxTimeMinutes: 60 },
    });
    expect(reasonOf(f.bash('sbatch --account=lab -p shared job.sh'))).toMatch(
      /outside the owner's allowed partitions[\s\S]*exceeds the owner's 60 minutes/,
    );
  });

  it('waits for fresh evidence instead of reviewing stale or absent readings', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    f.setEvidence(cluster(new Date(f.now - 3 * 3600_000).toISOString()));
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    expect(f.review.get(id)).toMatchObject({ status: 'waiting_evidence', allowsSubmission: false });
    expect(f.refresh).toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    f.setEvidence(cluster(new Date(f.now - 10_000).toISOString()));
    await f.review.maintain();
    await f.settle();
    expect(f.review.get(id).status).toBe('queued');
    expect(f.review.get(id).reviewer).not.toBeNull();

    // A configured cluster that has not reported limits yet: wait, then fail without approval.
    const pending = cluster(new Date(f.now).toISOString());
    pending.limits.observedAt = null;
    f.setEvidence(pending);
    const absent = reviewIdFrom(f.bash('sbatch --account=lab -c 2 job.sh'))!;
    expect(f.review.get(absent)).toMatchObject({
      status: 'waiting_evidence',
      evidence: { state: 'absent' },
    });
    f.advance(11 * 60_000);
    await f.review.maintain();
    expect(f.review.get(absent)).toMatchObject({ status: 'failed', allowsSubmission: false });
    expect(f.review.get(absent).failure).toMatch(/never approval/);

    // No cluster configured at all: nothing can arrive, so it fails at once with no model turn.
    f.setEvidence(null);
    const runs = f.store.runs().length;
    const none = f.bash('sbatch --account=lab -c 4 job.sh');
    expect(reasonOf(none)).toMatch(/No cluster reading is configured[\s\S]*not approved/);
    expect(f.review.get(reviewIdFrom(none)!)).toMatchObject({ status: 'failed', reviewer: null });
    expect(f.store.runs()).toHaveLength(runs);
  });

  it('keeps an unadmitted review as one pending run without respawns and interrupts overruns', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const queued = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    f.advance(40 * 60_000);
    f.setEvidence(cluster(new Date(f.now - 10_000).toISOString()));
    await f.review.maintain();
    // The waiting manager retrying gets the same pending review; QUARK still owns admission.
    expect(reviewIdFrom(f.bash('sbatch --account=lab job.sh'))).toBe(queued);
    expect(f.review.get(queued)).toMatchObject({ status: 'queued', allowsSubmission: false });
    expect(f.store.runs().filter((run) => run.key.startsWith('slurm-review:run:'))).toHaveLength(1);

    const slow = reviewIdFrom(f.bash('sbatch --account=lab -c 3 job.sh'))!;
    await f.settle();
    const { agentId, runId } = f.reviewerRun(slow);
    f.store.updateRun(runId, { status: 'running' });
    await f.review.maintain();
    expect(f.review.get(slow).status).toBe('running');
    f.advance(4 * 60_000);
    await f.review.maintain();
    expect(f.interrupt).toHaveBeenCalledWith(agentId, expect.stringMatching(/three-minute/));
    await f.review.maintain();
    expect(f.review.get(slow)).toMatchObject({ status: 'failed', allowsSubmission: false });
  });

  it('fails one damaged review safely without stalling maintenance of others', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const damaged = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    const healthy = reviewIdFrom(f.bash('sbatch --account=lab -c 2 job.sh'))!;
    await f.settle();
    const row = f.store.db.prepare('SELECT body FROM slurm_reviews WHERE id=?').get(damaged)!;
    const body = JSON.parse(String(row.body));
    body.reviewer.runId = randomUUID();
    f.store.db
      .prepare('UPDATE slurm_reviews SET body=? WHERE id=?')
      .run(JSON.stringify(body), damaged);
    await expect(f.review.maintain()).resolves.toBeUndefined();
    expect(f.review.get(damaged)).toMatchObject({ status: 'failed', allowsSubmission: false });
    expect(f.review.get(healthy).status).toBe('queued');
    expect((await f.finish(healthy, approve)).allowsSubmission).toBe(true);
  });

  it('keeps reviewer provider choice explicit and never substitutes another provider', async () => {
    const f = fixture({ enabled: ['codex'] });
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    expect(f.review.get(id)).toMatchObject({ status: 'failed', reviewer: null });
    expect(f.review.get(id).failure).toMatch(/not enabled[\s\S]*no other provider was used/);
    expect(f.resolve).not.toHaveBeenCalled();

    f.savePolicy({ reviewer: { provider: 'codex', family: 'terra', model: null, effort: null } });
    const terra = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    expect(f.review.get(terra).reviewer).toMatchObject({
      provider: 'codex',
      model: 'gpt-terra-2',
      effort: 'low',
    });

    f.savePolicy({
      reviewer: { provider: 'codex', family: 'terra', model: 'gpt-terra-9', effort: null },
    });
    const pinned = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    expect(f.review.get(pinned)).toMatchObject({ status: 'failed', reviewer: null });
    expect(f.review.get(pinned).failure).toMatch(/not available[\s\S]*No substitute/);
  });

  it('honors exact model and effort pins for the reviewer', async () => {
    const f = fixture();
    f.savePolicy({
      confirmedAccount: 'lab',
      reviewer: { provider: 'claude', family: 'sonnet', model: 'claude-opus-5-5', effort: 'high' },
    });
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    expect(f.review.get(id).reviewer).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
  });
});

describe('Slurm reviewer isolation', () => {
  it('denies every reviewer tool, refuses recursive review requests and grants it no tools', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    const { agentId } = f.reviewerRun(id);
    for (const tool of ['Bash', 'Read', 'mcp__dock__dock_slurm_review'])
      expect(
        reasonOf(
          f.review.hook({
            agentId,
            event: {
              hook_event_name: 'PreToolUse',
              tool_name: tool,
              tool_input: { command: 'sbatch job.sh' },
            },
          }),
        ),
      ).toMatch(/supplied evidence/);
    await expect(
      f.review.tool(agentId, randomUUID(), { command: 'sbatch job.sh' }),
    ).rejects.toThrow(Conflict);
    const reviewer = f.store.agent(agentId);
    expect(f.review.toolsFor(reviewer)).toEqual([]);
    expect(reviewer).toMatchObject({
      permission: 'read-only',
      toolPolicy: 'restricted',
      mcpServers: [],
      webSearch: 'disabled',
    });
    expect(
      f.review.toolsFor(f.store.agent(f.registered.managerId)).map((tool) => tool.name),
    ).toEqual(['dock_slurm_review']);
    expect(slurmReviewerCharter).toMatch(/no tools/i);
  });

  it('has no command execution path: the service never imports a process runner', () => {
    const source = readFileSync(new URL('./slurm-review.ts', import.meta.url), 'utf8');
    const parser = readFileSync(new URL('./slurm-command.ts', import.meta.url), 'utf8');
    for (const text of [source, parser]) {
      expect(text).not.toMatch(/node:child_process|execFile|spawn\(|ClusterRunner/);
    }
    // The only remote access is the fixed reader: it reads one file and never submits.
    const reader = readFileSync(new URL('./slurm-remote-script.ts', import.meta.url), 'utf8');
    expect(reader).not.toMatch(/sbatch|salloc|srun|scancel|scontrol/);
    expect(remoteScriptProgram).toMatch(/cat -- "\$f"\n$/);
  });
});

describe('typed dock_slurm_review tool', () => {
  it('reviews an ssh submission with declared script content and lets that exact command run after approval', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const command = "ssh cannon 'cd ~/proj && sbatch --account=lab -p test run.sh'";
    const held = f.bash(command);
    expect(reasonOf(held)).toMatch(
      /cannot see all of it[\s\S]*on the cluster[\s\S]*dock_slurm_review/,
    );
    expect(reviewIdFrom(held)).toBeNull();
    await expect(f.review.tool(f.registered.managerId, randomUUID(), { command })).rejects.toThrow(
      /scriptContent/,
    );
    const key = randomUUID();
    const request = {
      command,
      scriptContent: '#!/bin/bash\n#SBATCH -t 30\necho hi\n',
      purpose: 'smoke test',
    };
    const pending = await f.review.tool(f.registered.managerId, key, request);
    expect(pending).toMatchObject({
      status: 'queued',
      allowsSubmission: false,
      verification: 'unverified',
    });
    expect(pending.message).toMatch(/Do not poll/);
    expect((await f.review.tool(f.registered.managerId, key, request)).reviewId).toBe(
      pending.reviewId,
    );
    expect(reasonOf(f.bash(command))).toMatch(new RegExp(`review ${pending.reviewId} is pending`));
    await f.settle();
    await f.finish(pending.reviewId, approve);
    expect(
      await f.review.tool(f.registered.managerId, randomUUID(), { reviewId: pending.reviewId }),
    ).toMatchObject({
      allowsSubmission: true,
      disposition: 'approve',
      verification: 'unverified',
    });
    expect(f.review.get(pending.reviewId).message).toMatch(/not verified/);
    const reviewsBeforeHook = f.store.db
      .prepare('SELECT count(*) AS count FROM slurm_reviews')
      .get()!.count;
    expect(f.bash(command)).toBeNull();
    expect(f.store.db.prepare('SELECT count(*) AS count FROM slurm_reviews').get()!.count).toBe(
      reviewsBeforeHook,
    );
    expect(f.store.events().some((event) => event.type === 'slurm_review.passed_unverified')).toBe(
      true,
    );
    // A newer declaration of the same command supersedes the earlier advisory approval.
    await f.review.tool(f.registered.managerId, randomUUID(), {
      command,
      scriptContent: '#!/bin/bash\n#SBATCH -t 600\necho bigger\n',
    });
    expect(reasonOf(f.bash(command))).toMatch(/is pending/);
    expect(reviewIdFrom(f.bash(command.replace('-p test', '-p shared')))).toBeNull();
    const saved = f.review.get(pending.reviewId);
    expect(saved.proposal.invocations[0]!.script).toMatchObject({
      source: 'declared',
      path: 'run.sh',
    });
    expect(saved.proposal).toMatchObject({
      location: 'ssh',
      sshAlias: 'cannon',
      purpose: 'smoke test',
    });
  });

  it('records owner decisions as exact, expiring approvals and audits unreviewed submissions', async () => {
    const f = fixture();
    const id = reviewIdFrom(f.bash('sbatch -p test job.sh'))!;
    expect(f.review.get(id).disposition).toBe('ask_owner');
    const key = randomUUID();
    const approved = f.review.ownerDecision(id, {
      key,
      decision: 'approve',
      note: 'One-off test.',
    });
    expect(approved).toMatchObject({
      allowsSubmission: true,
      ownerDecision: { decision: 'approve' },
    });
    expect(f.review.ownerDecision(id, { key, decision: 'approve', note: 'One-off test.' }).id).toBe(
      id,
    );
    expect(f.bash('sbatch -p test job.sh')).toBeNull();
    expect(f.store.runs().filter((run) => run.kind === 'report')).toHaveLength(1);
    expect(
      f.review.audit(f.registered.managerId, 'sbatch -p test job.sh', 'Submitted batch job 42'),
    ).toBeNull();
    expect(
      f.review.audit(f.registered.managerId, 'sbatch other.sh', 'Submitted batch job 43'),
    ).toEqual({
      commandHash: expect.any(String),
      jobIds: ['43'],
    });
    f.advance(3 * 3600_000);
    f.setEvidence(cluster(new Date(f.now - 1000).toISOString()));
    expect(f.review.get(id).allowsSubmission).toBe(false);
  });

  it('serves policy and reviews through owner routes with revision checks', async () => {
    const f = fixture();
    const app = Fastify();
    registerSlurmReviewRoutes(app, f.review, () => {});
    cleanups.push(async () => {
      await app.close();
    });
    const status = await app.inject({ method: 'GET', url: '/api/slurm-review' });
    expect(status.json()).toMatchObject({
      policy: { confirmedAccount: null, reviewer: { provider: 'claude', family: 'sonnet' } },
    });
    expect(status.json().siteRuleSets).toEqual([
      expect.objectContaining({ id: 'fasrc-cannon', retrievedAt: '2026-10-06', origin: 'bundled' }),
    ]);
    const save = (expectedRevision: number) =>
      app.inject({
        method: 'PUT',
        url: '/api/slurm-review/policy',
        payload: {
          scope: 'project',
          projectId: f.registered.id,
          key: randomUUID(),
          expectedRevision,
          policy: { ...defaultSlurmSubmissionPolicy, confirmedAccount: 'lab' },
        },
      });
    expect((await save(0)).json()).toMatchObject({ revision: 1, confirmedAccount: 'lab' });
    expect((await save(0)).statusCode).not.toBe(200);
    expect(f.review.policy(f.registered.id)).toMatchObject({
      scope: 'project',
      policy: { confirmedAccount: 'lab' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/slurm-review/reviews',
      payload: {
        key: randomUUID(),
        projectId: f.registered.id,
        command: 'sbatch --account=lab job.sh',
      },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: `/api/slurm-review/reviews?projectId=${f.registered.id}`,
    });
    expect(list.json()[0].proposal.invocations[0].script.content).toBeNull();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/slurm-review/reviews/${created.json().id}`,
    });
    expect(detail.json().proposal.invocations[0].script.content).toContain('python run.py');
  });
});

describe('reviewer output parsing', () => {
  it('accepts only the exact bounded assessment schema', () => {
    expect(parseSlurmAssessment(approve)?.disposition).toBe('approve');
    expect(parseSlurmAssessment('Here you go:\n```json\n' + approve + '\n```')?.disposition).toBe(
      'approve',
    );
    expect(parseSlurmAssessment('')).toBeNull();
    expect(parseSlurmAssessment('{"disposition":"approve","summary":"ok"}')).toBeNull();
    expect(parseSlurmAssessment(approve.replace('"approve"', '"submit"'))).toBeNull();
    expect(
      parseSlurmAssessment(JSON.stringify({ ...JSON.parse(approve), extra: true })),
    ).toBeNull();
  });
});

const approved = async (f: ReturnType<typeof fixture>, command = 'sbatch --account=lab job.sh') => {
  const id = reviewIdFrom(f.bash(command) as Record<string, unknown> | null)!;
  await f.settle();
  expect(await f.finish(id, approve)).toMatchObject({ allowsSubmission: true });
  expect(f.bash(command)).toBeNull();
  return id;
};
const tightened = (f: ReturnType<typeof fixture>) => {
  const reading = cluster(new Date(f.now - 10_000).toISOString());
  // The lab account's own association is relevant evidence for every lab submission.
  reading.limits.items[0]!.maxWall = '1-00:00:00';
  return reading;
};

describe('current-approval gate', () => {
  it('withdraws an approval while native evidence is stale or missing, and keeps it across restart', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = await approved(f);
    f.setEvidence(cluster(new Date(f.now - 3 * 3600_000).toISOString()));
    expect(f.review.get(id)).toMatchObject({
      allowsSubmission: false,
      validity: { state: 'evidence_unavailable' },
    });
    expect(reasonOf(f.bash('sbatch --account=lab job.sh'))).toMatch(/was not run/);
    f.setEvidence(null);
    expect(f.review.get(id).validity.state).toBe('evidence_unavailable');
    expect(reasonOf(f.bash('sbatch --account=lab job.sh'))).toMatch(/was not run/);
    // Restart: durable state is re-validated, never trusted from memory.
    f.restart();
    f.setEvidence(cluster(new Date(f.now - 10_000).toISOString()));
    expect(f.review.get(id).validity.state).toBe('current');
    f.setEvidence(tightened(f));
    expect(f.review.get(id)).toMatchObject({
      allowsSubmission: false,
      validity: { state: 'evidence_changed' },
    });
  });

  it('withdraws approvals in views after a policy change and gates owner approvals on evidence unless overridden', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = await approved(f);
    f.savePolicy({ labRules: 'Prefer test for short runs.' });
    expect(f.review.get(id)).toMatchObject({
      allowsSubmission: false,
      validity: { state: 'policy_changed' },
    });
    expect(
      await f.review.tool(f.registered.managerId, randomUUID(), { reviewId: id }),
    ).toMatchObject({ allowsSubmission: false });

    const g = fixture();
    const owner = reviewIdFrom(g.bash('sbatch -p test job.sh'))!;
    g.review.ownerDecision(owner, { key: randomUUID(), decision: 'approve', note: '' });
    expect(g.review.get(owner).allowsSubmission).toBe(true);
    g.setEvidence(cluster(new Date(g.now - 3 * 3600_000).toISOString()));
    expect(g.review.get(owner).validity.state).toBe('evidence_unavailable');
    expect(reasonOf(g.bash('sbatch -p test job.sh'))).toMatch(/was not run/);
    const explicit = g.review.ownerDecision(owner, {
      key: randomUUID(),
      decision: 'approve',
      note: 'Cluster reading is down; I checked this myself.',
      withoutCurrentEvidence: true,
    });
    expect(explicit).toMatchObject({
      allowsSubmission: true,
      ownerDecision: { withoutCurrentEvidence: true },
    });
  });

  it('never turns a limit change during an in-flight review into approval', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = reviewIdFrom(f.bash('sbatch --account=lab job.sh'))!;
    await f.settle();
    f.setEvidence(tightened(f));
    const done = await f.finish(id, approve);
    expect(done).toMatchObject({
      disposition: 'approve',
      allowsSubmission: false,
      validity: { state: 'evidence_changed' },
    });
    expect(reviewIdFrom(f.bash('sbatch --account=lab job.sh'))).not.toBe(id);
  });
});

describe('execution identity and remote scripts', () => {
  it('does not reuse an approval across projects or working directories', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const id = await approved(f);
    const other = join(f.root, 'other');
    mkdirSync(join(other, 'sub'), { recursive: true });
    const script = readFileSync(join(f.project, 'job.sh'), 'utf8');
    writeFileSync(join(other, 'job.sh'), script);
    writeFileSync(join(other, 'sub', 'job.sh'), script);
    const second = f.store.register(other, 'Other lab work', '', 'claude');
    const crossProject = reviewIdFrom(
      f.bash('sbatch --account=lab job.sh', second.managerId, other),
    );
    expect(crossProject).not.toBeNull();
    expect(crossProject).not.toBe(id);
    expect(f.review.get(crossProject!).subject).toMatchObject({ kind: 'local', id: second.id });
    const otherDirectory = reviewIdFrom(
      f.bash('sbatch --account=lab job.sh', second.managerId, join(other, 'sub')),
    );
    expect(otherDirectory).not.toBeNull();
    expect(otherDirectory).not.toBe(crossProject);
  });

  it('reads configured-alias scripts at use, re-reviews changed remote content and holds when unreadable', async () => {
    const remote = new Map<string, string | Error>([
      ['~/proj|run.sh', '#!/bin/bash\n#SBATCH -t 30\necho remote\n'],
    ]);
    const f = fixture({ remote });
    f.savePolicy({ confirmedAccount: 'lab' });
    const command = "ssh cannon 'cd ~/proj && sbatch --account=lab -p test run.sh'";
    const first = f.bash(command);
    expect(first).toBeInstanceOf(Promise);
    const id = reviewIdFrom(await first)!;
    expect(f.review.get(id)).toMatchObject({
      verification: 'exact',
      proposal: { invocations: [{ script: { source: 'remote-read', path: 'cannon:run.sh' } }] },
    });
    expect(f.review.get(id).proposal.invocations[0]!.requested.time).toBe('30');
    await f.settle();
    await f.finish(id, approve);
    expect(await f.bash(command)).toBeNull();
    remote.set('~/proj|run.sh', '#!/bin/bash\n#SBATCH -t 700\necho changed\n');
    const changed = reviewIdFrom(await f.bash(command));
    expect(changed).not.toBeNull();
    expect(changed).not.toBe(id);
    remote.set('~/proj|run.sh', new Error('The cluster did not return the script in time.'));
    const unreadable = await f.bash(command);
    expect(reasonOf(unreadable)).toMatch(/Could not verify the remote script[\s\S]*not run/);
    expect(reviewIdFrom(unreadable)).toBeNull();
    await expect(
      f.review.tool(f.registered.managerId, randomUUID(), {
        command,
        scriptContent: '#!/bin/bash\necho declared\n',
      }),
    ).rejects.toThrow(/Could not verify/);
    // Another alias is never read: it stays an explicit, unverified typed review.
    expect(reasonOf(await f.bash(command.replace('cannon', 'elsewhere')))).toMatch(
      /cannot see all of it/,
    );
  });
});

const workspace = (overrides: Record<string, unknown> = {}) => ({
  key: randomUUID(),
  alias: 'cannon',
  workspaceRevision: 3,
  username: 'fixture-user',
  account: 'fixture_lab',
  siteRules: 'fasrc-cannon',
  development: {
    partition: 'test',
    qos: null,
    cpus: 2,
    memoryMb: 8192,
    timeMinutes: 120,
    idleMinutes: 20,
  },
  ...overrides,
});

describe('workspace defaults', () => {
  it('merges confirmed setup atomically inside the caller transaction and preserves explicit choices', async () => {
    const f = fixture();
    f.savePolicy({
      labRules: 'Keep jobs small.',
      reviewer: { provider: 'codex', family: 'terra', model: null, effort: null },
      resources: { ...defaultSlurmSubmissionPolicy.resources, maxCpus: 8 },
    });
    const before = f.review.policy().policy;
    const input = workspace();
    const saved = f.store.operation('setup:fixture-1', { input }, () =>
      f.review.syncWorkspaceDefaults(input),
    );
    expect(saved).toMatchObject({
      revision: before.revision + 1,
      confirmedAccount: 'fixture_lab',
      siteRules: 'fasrc-cannon',
      defaultPartition: 'test',
      defaultQos: null,
      labRules: 'Keep jobs small.',
      reviewer: { provider: 'codex', family: 'terra' },
      resources: { maxCpus: 8 },
    });
    expect(f.review.policy().policy).toEqual(saved);
    expect(JSON.stringify(f.store.getSetting('slurm-review:workspace-sync'))).not.toContain(
      'fixture-user',
    );
    // A retried callback with the same key changes nothing.
    f.store.transaction(() => f.review.syncWorkspaceDefaults(input));
    expect(f.review.policy().policy.revision).toBe(saved.revision);
    // A failure later in the same setup transaction rolls the policy back too.
    expect(() =>
      f.store.transaction(() => {
        f.review.syncWorkspaceDefaults(workspace({ account: 'other_lab' }));
        throw new Error('setup write failed');
      }),
    ).toThrow('setup write failed');
    expect(f.review.policy().policy).toEqual(saved);
    // Invalid input throws before any write.
    expect(() =>
      f.store.transaction(() =>
        f.review.syncWorkspaceDefaults(workspace({ account: 'bad account!' })),
      ),
    ).toThrow();
    expect(f.review.policy().policy).toEqual(saved);
    if ('isTransaction' in f.store.db)
      expect(() => f.review.syncWorkspaceDefaults(workspace())).toThrow(/setup transaction/);
  });

  it('removing the confirmed account withdraws approvals and asks the owner again', async () => {
    const f = fixture();
    f.store.transaction(() => f.review.syncWorkspaceDefaults(workspace({ account: 'lab' })));
    const id = await approved(f);
    f.store.transaction(() => f.review.syncWorkspaceDefaults(workspace({ account: null })));
    expect(f.review.get(id)).toMatchObject({
      allowsSubmission: false,
      validity: { state: 'policy_changed' },
    });
    expect(reasonOf(f.bash('sbatch --account=lab job.sh'))).toMatch(/ask_owner/);
  });
});

describe('server development allocation review', () => {
  it('keeps one pending reviewer across retries, status reads, maintenance and fresh observation timestamps', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const input = {
      key: randomUUID(),
      clusterProjectId: randomUUID(),
      clusterProjectName: 'Single pending review',
      command: "ssh cannon 'sbatch --account=lab -p test -c 2 --mem=8G -t 120 holder.sh'",
      script: '#!/bin/sh\nexec sleep 7200\n',
      workingDirectory: '/home/owner/project',
    };
    const first = f.review.requestDevelopmentReview(input);
    await f.settle();
    const runId = f.review.get(first.reviewId).reviewer!.runId;
    for (let i = 0; i < 3; i++) {
      f.advance(10_000);
      const reading = cluster(new Date(f.now).toISOString());
      reading.limits.partitions[0]!.cpus.idle = 1900 - i;
      f.setEvidence(reading);
      expect(f.review.requestDevelopmentReview(input)).toMatchObject({
        reviewId: first.reviewId,
        pending: true,
      });
      f.review.status();
      await f.review.maintain();
      await f.settle();
      expect(f.review.get(first.reviewId).reviewer!.runId).toBe(runId);
      expect(f.store.runs()).toHaveLength(1);
    }
  });

  it('renews the same allocation review after account correction and approval expiry without changing its submission key', async () => {
    const f = fixture();
    const input = {
      key: randomUUID(),
      clusterProjectId: randomUUID(),
      clusterProjectName: 'Retained open intent',
      command: "ssh cannon 'sbatch --account=lab -p test -c 2 --mem=8G -t 120 holder.sh'",
      script: '#!/bin/sh\nexec sleep 7200\n',
      workingDirectory: '/home/owner/project',
    };
    const unconfirmed = f.review.requestDevelopmentReview(input);
    expect(unconfirmed).toMatchObject({ disposition: 'ask_owner', allowed: false });
    f.savePolicy({ confirmedAccount: 'lab' });
    const corrected = f.review.requestDevelopmentReview(input);
    expect(corrected).toMatchObject({ pending: true, allowed: false });
    expect(corrected.reviewId).not.toBe(unconfirmed.reviewId);
    expect(f.review.requestDevelopmentReview(input).reviewId).toBe(corrected.reviewId);
    await f.settle();
    await f.finish(corrected.reviewId, approve);
    expect(f.review.requestDevelopmentReview(input)).toMatchObject({
      reviewId: corrected.reviewId,
      allowed: true,
    });
    f.advance(121 * 60_000);
    f.setEvidence(cluster(new Date(f.now - 60_000).toISOString()));
    const renewed = f.review.requestDevelopmentReview(input);
    expect(renewed).toMatchObject({ pending: true, allowed: false });
    expect(renewed.reviewId).not.toBe(corrected.reviewId);
    expect(f.review.requestDevelopmentReview(input).reviewId).toBe(renewed.reviewId);
    expect(f.review.get(unconfirmed.reviewId).disposition).toBe('ask_owner');
    expect(f.review.get(corrected.reviewId).validity.state).toBe('expired');
    expect(f.store.getSetting(`cluster-development:${input.clusterProjectId}`)).toBeNull();
  });

  it('renews changed native evidence on the same allocation key and bounds failed review attempts', async () => {
    const f = fixture();
    f.savePolicy({ confirmedAccount: 'lab' });
    const input = {
      key: randomUUID(),
      clusterProjectId: randomUUID(),
      clusterProjectName: 'Evidence renewal',
      command: "ssh cannon 'sbatch --account=lab -p test -c 2 --mem=8G -t 120 holder.sh'",
      script: '#!/bin/sh\nexec sleep 7200\n',
      workingDirectory: '/home/owner/project',
    };
    const original = f.review.requestDevelopmentReview(input);
    await f.settle();
    await f.finish(original.reviewId, approve);
    f.setEvidence(tightened(f));
    const changed = f.review.requestDevelopmentReview(input);
    expect(changed.reviewId).not.toBe(original.reviewId);
    expect(changed.pending).toBe(true);
    await f.settle();
    await f.finish(changed.reviewId, null, 'failed');
    const retry = f.review.requestDevelopmentReview(input);
    expect(retry.reviewId).not.toBe(changed.reviewId);
    await f.settle();
    await f.finish(retry.reviewId, null, 'failed');
    const runs = f.store.runs().length;
    expect(f.review.requestDevelopmentReview(input)).toMatchObject({
      pending: false,
      allowed: false,
    });
    await f.settle();
    expect(f.store.runs()).toHaveLength(runs);
  });

  it('retains a rejected legacy holder review and reviews corrected context on the same allocation key', async () => {
    const f = fixture();
    f.store.transaction(() =>
      f.review.syncWorkspaceDefaults(workspace({ account: 'fixture_lab' })),
    );
    const key = randomUUID(),
      clusterProjectId = randomUUID();
    const input = {
      key,
      clusterProjectId,
      clusterProjectName: 'Retry holder',
      command:
        "ssh cannon 'sbatch --account=fixture_lab --partition=test --cpus-per-task=2 --mem=8192M --time=120'",
      script: '#!/bin/sh\nexec sleep 7200\n',
      workingDirectory: '/home/owner/project',
    };
    const old = f.review.requestDevelopmentReview(input);
    await f.settle();
    await f.finish(
      old.reviewId,
      JSON.stringify({
        disposition: 'revise',
        summary: 'Explain why this sleep holder is useful.',
        findings: [],
        suggestedCorrection: 'Supply lifecycle context.',
        uncertainty: 'Queue state can change.',
        evidenceUsed: ['partition test'],
      }),
    );
    expect(f.review.get(old.reviewId).disposition).toBe('revise');
    const corrected = {
      ...input,
      purpose:
        'The holder supplies a bounded allocation for subsequent owned srun build, runtime and native manager steps; persistent runtime-private.log records diagnostics.',
    };
    const next = f.review.requestDevelopmentReview(corrected);
    expect(next.reviewId).not.toBe(old.reviewId);
    expect(next.pending).toBe(true);
    expect(f.review.requestDevelopmentReview(corrected).reviewId).toBe(next.reviewId);
    expect(f.review.get(old.reviewId)).toMatchObject({
      disposition: 'revise',
      proposal: { purpose: null },
    });
    expect(f.review.get(next.reviewId).proposal.invocations[0]!.script.sha256).toBe(
      f.review.get(old.reviewId).proposal.invocations[0]!.script.sha256,
    );
    expect(f.store.getSetting(`cluster-development:${clusterProjectId}`)).toBeNull();
  });
  it('reviews actual fixed holder context and preserves its exact script identity', () => {
    const f = fixture();
    f.store.transaction(() =>
      f.review.syncWorkspaceDefaults(workspace({ account: 'fixture_lab' })),
    );
    const clusterProjectId = randomUUID(),
      key = randomUUID();
    const proposal = developmentProposal(
      {
        projectId: clusterProjectId,
        alias: 'cannon',
        username: 'owner',
        account: 'fixture_lab',
        path: '/home/owner/project',
        resources: {
          cpus: 2,
          memoryMb: 8192,
          timeMinutes: 120,
          idleMinutes: 20,
          partition: 'test',
          qos: null,
        },
      },
      {
        projectId: clusterProjectId,
        token: key,
        username: 'owner',
        alias: 'cannon',
        configuration: 'a'.repeat(64),
        state: 'allocating',
        jobId: null,
        node: null,
        createdAt: new Date().toISOString(),
        observedAt: null,
        message: '',
      },
    );
    const result = f.review.requestDevelopmentReview({
      key,
      clusterProjectId,
      clusterProjectName: 'Owned runtime fixture',
      ...proposal,
      workingDirectory: '/home/owner/project',
    });
    const saved = f.review.get(result.reviewId);
    expect(saved.proposal.purpose).toContain('subsequent owned srun steps');
    expect(saved.proposal.purpose).toContain('runtime-private.log');
    expect(saved.proposal.purpose).toContain('unavailable idle proof');
    expect(saved.proposal.invocations[0]!.script.content).toBe('#!/bin/sh\nexec sleep 7200\n');
    expect(saved.proposal.invocations[0]!.script.sha256).toBe(
      createHash('sha256').update(proposal.script).digest('hex'),
    );
  });

  const script =
    '#!/bin/bash\n#SBATCH --account=fixture_lab\n#SBATCH -p test -c 2 --mem=8G -t 120\nexec runtime\n';
  const request = (clusterProjectId: string, overrides: Record<string, unknown> = {}) => ({
    key: randomUUID(),
    clusterProjectId,
    clusterProjectName: 'Cluster fixture project',
    command: "ssh cannon 'sbatch --parsable ~/.sciencewithagents/dev.sbatch'",
    script,
    workingDirectory: null,
    ...overrides,
  });

  it('reviews the exact server-generated sbatch once, without a manager turn, and settles listeners', async () => {
    const f = fixture();
    f.store.transaction(() =>
      f.review.syncWorkspaceDefaults(workspace({ account: 'fixture_lab' })),
    );
    const settled = vi.fn();
    f.review.onSettled(settled);
    const clusterProjectId = randomUUID();
    const input = request(clusterProjectId);
    const first = f.review.requestDevelopmentReview(input);
    expect(first).toMatchObject({ pending: true, allowed: false, status: 'queued' });
    expect(f.review.requestDevelopmentReview(input).reviewId).toBe(first.reviewId);
    expect(f.review.requestDevelopmentReview(request(clusterProjectId)).reviewId).toBe(
      first.reviewId,
    );
    await f.settle();
    const saved = f.review.get(first.reviewId);
    expect(saved).toMatchObject({
      origin: 'server',
      agentId: null,
      verification: 'exact',
      subject: { kind: 'cluster', id: clusterProjectId },
      proposal: { invocations: [{ script: { source: 'server' } }] },
    });
    expect(saved.proposal.invocations[0]!.requested).toMatchObject({
      account: 'fixture_lab',
      partition: 'test',
    });
    const reviewer = f.store.agent(saved.reviewer!.agentId!);
    expect(f.review.toolsFor(reviewer)).toEqual([]);
    await f.finish(first.reviewId, approve);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.reviewId, allowsSubmission: true }),
    );
    expect(f.store.runs().filter((run) => run.kind === 'report')).toHaveLength(0);
    expect(f.review.requestDevelopmentReview(request(clusterProjectId))).toMatchObject({
      reviewId: first.reviewId,
      allowed: true,
      pending: false,
    });
    const changed = f.review.requestDevelopmentReview(
      request(clusterProjectId, { script: script.replace('-c 2', '-c 4') }),
    );
    expect(changed.reviewId).not.toBe(first.reviewId);
    const otherProject = f.review.requestDevelopmentReview(request(randomUUID()));
    expect(otherProject.reviewId).not.toBe(first.reviewId);
  });
});

it('keeps fresh review off and does not enable it from workspace defaults', () => {
  const f = fixture();
  f.store.db.prepare('DELETE FROM settings WHERE key=?').run('slurm-review:policy');
  expect(f.review.policy().policy.enabled).toBe(false);
  expect(f.bash('sbatch job.sh')).toBeNull();
  f.store.transaction(() =>
    f.review.syncWorkspaceDefaults({
      key: randomUUID(),
      alias: 'cannon',
      workspaceRevision: 1,
      username: 'fixture',
      account: 'lab',
      siteRules: 'fasrc-cannon',
      development: {
        partition: 'test',
        qos: null,
        cpus: 2,
        memoryMb: 4096,
        timeMinutes: 60,
        idleMinutes: 10,
      },
    }),
  );
  expect(f.review.policy().policy).toMatchObject({
    enabled: false,
    confirmedAccount: 'lab',
    siteRules: 'fasrc-cannon',
  });
});
