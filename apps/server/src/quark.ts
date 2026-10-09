import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  sameAllowanceReset,
  effectiveProviderReserve,
  windowPacingSchema,
  projectRatesSchema,
  defaultModelPolicy,
  modelPolicySchema,
  allowanceRequestSchema,
  allowanceFieldsSchema,
  allowanceSchema,
  quarkRunSchema,
  quarkSettingsSchema,
  quarkSettingsUpdateSchema,
  quarkStatusSchema,
  quotaHoldSchema,
  tokenUsageSnapshotSchema,
  managerLeaseSchema,
  projectQuarkPolicySchema,
  projectQuarkPolicySaveSchema,
  chatQuarkPolicySchema,
  chatQuarkPolicySaveSchema,
  type Allowance,
  type QuarkRun,
  type QuotaHold,
  type TokenCounts,
  type TokenUsageSnapshot,
} from '@dock/shared';
import { z } from 'zod';
import { captureGroupQuarkTransition } from './group-native-activity-producers.js';
import { Store, Conflict, type PrivateRun } from './store.js';
import { readCapacity, readClaudeCapacityAffinity, capacityMaxAge } from './capacity.js';
import type { Pulsar } from './pulsar.js';
import { currentRateSamples, rateHistory } from './quark-rates.js';
import { managedChat, chatBypassRun, chatBypassAllowed } from './quark-chat.js';
import { projectFollowsQuark, projectSchedulerKey } from './quark-project.js';
import { adaptivePace, materialDemand, projectWeight, reservedPercent } from './quark-demand.js';
import { coordinationTaskIds } from './coordination-reviews.js';

const transientCauses: QuotaHold['cause'][] = [
  'hourly',
  'monitoring',
  'reset',
  'headroom',
  'cache',
];
/** Native rate-limit types matched to the exact capacity window QUARK reads. */
const nativeWindows = {
  five_hour: { id: 'primary', label: 'five-hour', minutes: 300 },
  seven_day: { id: 'secondary', label: 'weekly', minutes: 10080 },
  seven_day_opus: { id: 'extra:seven_day_opus', label: 'Opus weekly', minutes: 10080 },
  seven_day_sonnet: { id: 'extra:seven_day_sonnet', label: 'Sonnet weekly', minutes: 10080 },
} as const;
const nativeAccountSchema = z
  .object({
    runId: z.string().uuid(),
    sessionId: z.string().uuid(),
    affinity: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const unknown: TokenCounts = {
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  reasoningOutputTokens: null,
};
const zero = Object.fromEntries(Object.keys(unknown).map((k) => [k, 0])) as TokenCounts;
const stamp = (at: number) => new Date(at).toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allocation = z.object({
  runId: z.string(),
  projectId: z.string(),
  taskIds: z.array(z.string()),
  percent: z.number(),
});
const intervalSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  windowId: z.string(),
  label: z.string(),
  resetsAt: z.string().nullable(),
  observedAt: z.string(),
  baseline: z.boolean().optional(),
  from: z.string().nullable().optional(),
  gap: z.boolean().optional(),
  delta: z.number(),
  unattributed: z.number(),
  allocations: z.array(allocation),
});
const meterSchema = z.object({
  observedAt: z.string(),
  resetsAt: z.string().nullable(),
  usedPercent: z.number(),
  scores: z.record(z.string(), z.number()),
  pending: z.record(z.string(), z.number()),
  unitsPerPercent: z.number().nullable(),
  samples: z.number(),
});
const rateSchema = z.object({
  unitsPerPercent: z.number().positive(),
  samples: z.number(),
  updatedAt: z.string(),
});
const windowTotalSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  windowId: z.string(),
  label: z.string(),
  resetsAt: z.string().nullable(),
  observedAt: z.string(),
  deltaPercent: z.number(),
  unattributedPercent: z.number(),
  samples: z.number(),
  projects: z.record(z.string(), z.number()),
});

/** One host-owned ledger. Provider counters are evidence; allowance shares are estimates. */
export class Quark {
  executing: () => ReadonlySet<string> = () => new Set();
  private demandSnapshot: {
    value?: ReturnType<typeof materialDemand>;
    holds?: QuotaHold[];
  } | null = null;
  /** Share immutable inputs only within one synchronous, read-only decision batch. */
  withDemandSnapshot<T>(read: () => T, fresh = false): T {
    if (this.demandSnapshot && !fresh) return read();
    const previous = this.demandSnapshot;
    this.demandSnapshot = {};
    try {
      return read();
    } finally {
      this.demandSnapshot = previous;
    }
  }
  // A process-local signer fences old leases on restart. This key never enters a
  // model prompt, API response, repository or provider credential store.
  private readonly leaseSigner = randomBytes(32);
  private spentCache = new Map<string, { sequence: number; percent: number }>();
  private runSpentCache = new Map<string, { sequence: number; percent: number }>();
  constructor(
    readonly store: Store,
    readonly pulsar: Pulsar,
    private clock = Date.now,
  ) {
    if (!store.getSetting('quark:since')) store.setSetting('quark:since', stamp(clock()));
    // Do not invent historical run baselines from today's context/model.
    if (store.getSetting('quark:cursor') === null) store.setSetting('quark:cursor', store.head);
    // Cache warming is deferred. Upgrade existing installs without touching caps or history.
    const settings = this.settings();
    if (settings.cacheEnabled) {
      const next = { ...settings, cacheEnabled: false, revision: settings.revision + 1 };
      store.setSetting('quark:settings', next);
      store.event('quark.settings', null, null, next);
    }
  }
  settings() {
    return quarkSettingsSchema.parse(this.store.getSetting('quark:settings') ?? {});
  }
  projectPolicy(projectId: string) {
    this.store.project(projectId);
    return projectQuarkPolicySchema.parse(
      this.store.getSetting(projectSchedulerKey(projectId)) ?? { projectId },
    );
  }
  saveProjectPolicy(projectId: string, raw: unknown) {
    const input = projectQuarkPolicySaveSchema.parse(raw);
    return this.store.operation(
      `project-quark-policy:${input.key}`,
      { projectId, ...input },
      () => {
        const previous = this.projectPolicy(projectId);
        if (previous.revision !== input.expectedRevision)
          throw new Conflict('Project scheduling changed. Refresh it before saving.');
        const policy = projectQuarkPolicySchema.parse({
          projectId,
          enabled: input.enabled,
          revision: previous.revision + 1,
        });
        this.store.setSetting(projectSchedulerKey(projectId), policy);
        this.store.event('quark.project_scheduler', projectId, null, policy);
        return policy;
      },
    );
  }
  chatPolicy(agentId: string) {
    this.store.agent(agentId);
    return chatQuarkPolicySchema.parse(
      this.store.getSetting(`quark:chat-policy:${agentId}`) ?? { agentId },
    );
  }
  saveChatPolicy(agentId: string, raw: unknown) {
    const input = chatQuarkPolicySaveSchema.parse(raw);
    return this.store.operation(`chat-quark-policy:${input.key}`, { agentId, ...input }, () => {
      if (!managedChat(this.store.agent(agentId)))
        throw new Conflict(
          'This preference is available only for app-managed manager conversations, not workers or native sessions.',
        );
      const current = this.chatPolicy(agentId);
      if (current.revision !== input.expectedRevision)
        throw new Conflict('The conversation preference changed. Refresh it before saving.');
      const policy = chatQuarkPolicySchema.parse({
        agentId,
        enabled: input.enabled,
        revision: current.revision + 1,
      });
      this.store.setSetting(`quark:chat-policy:${agentId}`, policy);
      this.store.event('quark.chat_policy', this.store.agent(agentId).projectId, agentId, policy);
      for (const run of this.store.runs(['queued'])) {
        // New literal messages carry an explicit boolean marker. Older owner
        // messages used the typed UUID send receipt; synthetic inputs use namespaced keys.
        const ownerMessage =
          typeof this.store.getSetting(`quark:chat-bypass-run:${run.id}`) === 'boolean' ||
          z.string().uuid().safeParse(run.key).success;
        if (run.agentId === agentId && run.kind === 'user' && run.sourceId === null && ownerMessage)
          this.captureOwnerChat(run);
      }
      return policy;
    });
  }
  /** Atomic owner message/preference capture, never a message retry or native steering. */
  captureOwnerChat(run: PrivateRun) {
    const enabled =
      managedChat(this.store.agent(run.agentId)) && this.chatPolicy(run.agentId).enabled;
    const previous = this.store.getSetting(`quark:chat-bypass-run:${run.id}`) === true;
    this.store.setSetting(`quark:chat-bypass-run:${run.id}`, enabled);
    if (enabled !== previous)
      this.store.event('quark.chat_bypass', this.store.agent(run.agentId).projectId, run.agentId, {
        runId: run.id,
        enabled,
      });
  }
  private signLease(lease: z.infer<typeof managerLeaseSchema>) {
    return createHmac('sha256', this.leaseSigner).update(JSON.stringify(lease)).digest('hex');
  }
  private readManagerLease(run: PrivateRun) {
    const saved = z
      .object({ lease: managerLeaseSchema, signature: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(this.store.getSetting(`quark:manager-lease:${run.id}`));
    if (!saved.success) return null;
    const { lease, signature } = saved.data;
    const agent = this.store.agent(run.agentId);
    if (
      lease.runId !== run.id ||
      lease.managerId !== agent.id ||
      lease.projectId !== agent.projectId ||
      lease.provider !== agent.provider ||
      lease.model !== agent.model ||
      agent.role !== 'manager' ||
      agent.nativeRootId ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.signLease(lease), 'hex'))
    )
      return null;
    return lease;
  }
  /** Called only by admission, before a managed manager can send its first token. */
  issueManagerLease(run: PrivateRun) {
    const agent = this.store.agent(run.agentId);
    if (agent.role !== 'manager') return;
    if (run.status !== 'queued' || agent.nativeRootId || !this.pulsar.hasReservation(run.id))
      throw new Conflict('QUARK must admit this manager turn before issuing its lease.');
    const reason = this.reason(run, true);
    if (reason) throw new Conflict(reason);
    const conversationOnly =
      chatBypassRun(this.store, run) &&
      !this.pulsar.decision(run, this.executing(), false, true).eligible;
    const lease = managerLeaseSchema.parse({
      id: randomUUID(),
      runId: run.id,
      managerId: agent.id,
      projectId: agent.projectId,
      provider: agent.provider,
      model: agent.model,
      issuedAt: stamp(this.clock()),
      expiresAt: stamp(this.clock() + 60_000),
      ...(conversationOnly ? { scope: 'conversation' as const } : {}),
    });
    this.store.setSetting(`quark:manager-lease:${run.id}`, {
      lease,
      signature: this.signLease(lease),
    });
    this.store.event('quark.manager_lease', agent.projectId, agent.id, lease);
  }
  managerLeaseReason(run: PrivateRun): string | null {
    const lease = this.readManagerLease(run);
    if (!lease || this.store.run(run.id).status !== 'running')
      return 'QUARK has not signed a lease for this active manager turn.';
    if (Date.parse(lease.expiresAt) <= this.clock())
      return 'The QUARK manager lease expired. Saved work requires explicit continuation.';
    return this.reason(run);
  }
  /** Only the host heartbeat can renew; model tool calls cannot renew or self-sign. */
  renewManagerLease(run: PrivateRun) {
    const reason = this.managerLeaseReason(run);
    if (reason) return reason;
    const lease = this.readManagerLease(run)!;
    if (Date.parse(lease.expiresAt) - this.clock() <= 45_000) {
      const next = { ...lease, expiresAt: stamp(this.clock() + 60_000) };
      this.store.setSetting(`quark:manager-lease:${run.id}`, {
        lease: next,
        signature: this.signLease(next),
      });
    }
    return null;
  }
  requireManagerLease(run: PrivateRun | undefined) {
    if (!run) throw new Conflict('QUARK requires an admitted manager turn before orchestration.');
    const reason = this.managerLeaseReason(run);
    if (reason) throw new Conflict(reason);
    const lease = this.readManagerLease(run)!;
    if (chatBypassRun(this.store, run)) {
      const ordinary = this.pulsar.decision(run, this.executing(), false, true);
      if (!ordinary.eligible)
        throw new Conflict(
          `Direct chat bypass does not authorize protected work: ${ordinary.reason}`,
        );
      if (lease.scope === 'conversation') {
        const upgraded = { ...lease, scope: 'orchestration' as const };
        this.store.setSetting(`quark:manager-lease:${run.id}`, {
          lease: upgraded,
          signature: this.signLease(upgraded),
        });
        this.store.event(
          'quark.manager_lease_upgraded',
          lease.projectId,
          lease.managerId,
          upgraded,
        );
        return upgraded;
      }
    } else if (lease.scope === 'conversation') {
      throw new Conflict(
        'This signed lease authorizes conversation only. Protected work requires ordinary QUARK admission.',
      );
    }
    return lease;
  }
  managerLeaseStatus(run: PrivateRun | undefined) {
    if (!run)
      return {
        state: 'inactive',
        reason: 'No active manager turn.',
        lease: null,
        notice: undefined,
      };
    const lease = this.readManagerLease(run);
    const reason = this.managerLeaseReason(run);
    return {
      state: reason ? 'blocked' : 'active',
      lease,
      reason,
      ...(lease?.scope === 'conversation'
        ? {
            notice:
              'Direct conversation only. Answer the owner and retain source-linked asks with dock_work_item. Delegate or start protected work only when ordinary QUARK headroom permits it.',
          }
        : {}),
    };
  }
  saveSettings(raw: unknown) {
    const input = quarkSettingsUpdateSchema.parse(raw);
    if (input.settings.cacheEnabled)
      throw new Conflict('Automatic context-cache refreshes are deferred and cannot be enabled.');
    return this.store.operation(input.key, { kind: 'quark.settings', ...input }, () => {
      if (input.settings.revision !== this.settings().revision)
        throw new Conflict('Settings changed on another device. Reload before saving.');
      const next = { ...input.settings, revision: input.settings.revision + 1 };
      this.store.setSetting('quark:settings', next);
      this.store.event('quark.settings', null, null, next);
      return next;
    });
  }
  /** Durable exact admission evidence. Retained artifacts must not depend on
   * the bounded recent-runs view used for current scheduling/display. */
  runLedger(runId: string): QuarkRun | null {
    const row = this.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(runId);
    return row ? quarkRunSchema.parse(JSON.parse(String(row.body))) : null;
  }
  runs(recent = false, since = this.clock() - 120_000) {
    return this.store.db
      .prepare(
        recent
          ? "SELECT body FROM quark_runs WHERE json_extract(body,'$.finishedAt') IS NULL OR json_extract(body,'$.finishedAt')>?"
          : 'SELECT body FROM quark_runs',
      )
      .all(...(recent ? [stamp(since)] : []))
      .map((r) => quarkRunSchema.parse(JSON.parse(String(r.body))));
  }
  private saveRun(run: QuarkRun) {
    this.store.db
      .prepare(
        'INSERT INTO quark_runs VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body',
      )
      .run(run.runId, JSON.stringify(quarkRunSchema.parse(run)));
  }
  private snapshot(agentId: string): TokenUsageSnapshot | null {
    const a = this.store.agent(agentId);
    if (!a.threadId) return null;
    const result = tokenUsageSnapshotSchema.safeParse(
      this.store.getSetting(`usage:v1:tokens:${a.provider}:${a.id}:${hash(a.threadId)}`),
    );
    return result.success ? result.data : null;
  }
  taskIds(run: PrivateRun): string[] {
    const agent = this.store.agent(run.agentId);
    let taskId = agent.taskId;
    if (!taskId && run.sourceId) {
      const source = this.store.agent(run.sourceId);
      if (source.projectId === agent.projectId) taskId = source.taskId;
    }
    const saved = this.store.getSetting(`pulsar:task:${run.id}`);
    if (!taskId && typeof saved === 'string') taskId = saved;
    const result: string[] = [];
    while (taskId && !result.includes(taskId)) {
      const task = this.store.task(taskId);
      if (task.projectId !== agent.projectId) break;
      result.push(taskId);
      taskId = task.parentId;
    }
    return [...new Set([...result, ...coordinationTaskIds(this.store, run)])];
  }
  begin(run: PrivateRun) {
    if (this.store.db.prepare('SELECT 1 FROM quark_runs WHERE run_id=?').get(run.id)) return;
    const a = this.store.agent(run.agentId),
      snapshot = this.snapshot(a.id),
      estimate = this.pulsar.estimate(run);
    const tasks = this.taskIds(run);
    this.saveRun({
      runId: run.id,
      agentId: a.id,
      projectId: a.projectId,
      taskId: tasks[0] ?? null,
      taskAncestors: tasks,
      nativeRootId: a.nativeRootId,
      provider: a.provider,
      model: a.model,
      threadId: a.threadId,
      startedAt: stamp(this.clock()),
      finishedAt: null,
      observedAt: null,
      baseline:
        a.provider === 'codex'
          ? (snapshot?.total ??
            (!a.threadId && !a.nativeRootId && a.interview?.continuity !== 'native-fork'
              ? zero
              : unknown))
          : unknown,
      tokens: unknown,
      basis: 'unknown',
      expectedTokens: estimate.expectedTokens,
      quotaPercent: estimate.quotaPercent,
      expectedSeconds: estimate.expectedSeconds,
      cacheNudge: this.isNudge(run.id),
    });
  }
  private observe(snapshot: TokenUsageSnapshot) {
    if (!snapshot.runId) return;
    const row = this.store.db
      .prepare('SELECT body FROM quark_runs WHERE run_id=?')
      .get(snapshot.runId);
    if (!row) return;
    const run = quarkRunSchema.parse(JSON.parse(String(row.body)));
    if (
      run.agentId !== snapshot.agentId ||
      run.provider !== snapshot.provider ||
      (run.threadId && run.threadId !== snapshot.threadId)
    )
      return;
    let tokens: TokenCounts;
    if (run.provider === 'claude') {
      tokens = { ...snapshot.last };
      const parts = [
        tokens.inputTokens,
        tokens.outputTokens,
        tokens.cachedInputTokens,
        tokens.cacheWriteInputTokens,
      ];
      tokens.totalTokens = parts.every((n) => n !== null)
        ? parts.reduce<number>((n, v) => n + (v ?? 0), 0)
        : tokens.totalTokens;
    } else {
      tokens = { ...unknown };
      for (const k of Object.keys(unknown) as (keyof TokenCounts)[]) {
        const value = snapshot.total[k],
          baseline = run.baseline[k];
        tokens[k] =
          value !== null && baseline !== null && value >= baseline ? value - baseline : null;
        // A native/imported thread may already contain inherited history. Start a
        // partial observed slice from its first last-request counter, then use
        // cumulative differences. Never count inherited context as new spending.
        if (baseline === null) {
          const previous = run.lastTotal?.[k];
          tokens[k] =
            previous !== undefined && previous !== null && value !== null && value >= previous
              ? (run.tokens[k] ?? 0) + value - previous
              : !run.observedAt
                ? snapshot.last[k]
                : run.tokens[k];
        }
      }
    }
    this.saveRun({
      ...run,
      tokens,
      observedModels: snapshot.observedModels,
      threadId: snapshot.threadId,
      observedAt: snapshot.observedAt,
      lastTotal: snapshot.total,
      basis:
        tokens.totalTokens === null ||
        (run.provider === 'claude' && snapshot.coverage !== 'whole-tree') ||
        (run.provider === 'codex' && run.baseline.totalTokens === null)
          ? 'partial'
          : 'measured',
    });
  }
  /**
   * Cluster ledger evidence: a remote QUARK's normalized cumulative counts for one run.
   * There is no native thread, so counts replace (never add to) this run's tokens; a later
   * unknown field keeps earlier evidence. The receipt contract proves no whole-tree coverage,
   * so remote evidence is at most 'partial' and never trains model rates as measured.
   */
  observeRemoteRun(runId: string, counts: TokenCounts) {
    if (!this.store.db.isTransaction) throw new Error('Remote usage requires an atomic request.');
    const row = this.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(runId);
    if (!row) throw new Conflict('This remote run has no QUARK accounting record.');
    const run = quarkRunSchema.parse(JSON.parse(String(row.body)));
    if (run.threadId) throw new Conflict('Native conversations report usage by native snapshot.');
    const tokens = { ...run.tokens };
    for (const k of Object.keys(unknown) as (keyof TokenCounts)[]) {
      const before = run.tokens[k],
        after = counts[k];
      if (after === null) continue;
      if (before !== null && after < before)
        throw new Conflict('Remote token counts are cumulative per run and cannot decrease.');
      tokens[k] = after;
    }
    const known = Object.values(tokens).some((n) => n !== null);
    this.saveRun({
      ...run,
      tokens,
      observedAt: known ? stamp(this.clock()) : run.observedAt,
      basis: known ? 'partial' : run.basis,
    });
    return tokens;
  }
  /** A durably proven never-consumed admission leaves no spend evidence to retain. */
  discardUnconsumed(runId: string) {
    const row = this.store.db.prepare('SELECT body FROM quark_runs WHERE run_id=?').get(runId);
    if (row && quarkRunSchema.parse(JSON.parse(String(row.body))).observedAt)
      throw new Conflict('Observed usage cannot be discarded.');
    this.pulsar.discardUnconsumed(runId);
    this.store.db.prepare('DELETE FROM quark_runs WHERE run_id=?').run(runId);
  }
  sync() {
    this.store.transaction(() => {
      let cursor = Number(this.store.getSetting('quark:cursor') ?? 0);
      // A bounded batch, including duplicates after restart, never adds cumulative snapshots.
      const events = this.store.events(cursor, 2000);
      for (const e of events) {
        if (e.type === 'usage.observed') {
          const data = z
            .object({ kind: z.literal('tokens'), observation: tokenUsageSnapshotSchema })
            .safeParse(e.data);
          if (data.success) this.observe(data.data.observation);
        }
        cursor = e.id;
      }
      this.store.setSetting('quark:cursor', cursor);
      for (const r of this.runs(true)) {
        if (!r.finishedAt && !['queued', 'running'].includes(this.store.run(r.runId).status))
          this.saveRun({ ...r, finishedAt: stamp(this.clock()) });
      }
    });
    for (const provider of ['codex', 'claude'] as const) this.reconcileAllowance(provider);
  }
  private score(r: QuarkRun) {
    const t = r.tokens;
    const seconds = Math.max(
      0,
      (Math.min(this.clock(), r.finishedAt ? Date.parse(r.finishedAt) : this.clock()) -
        Date.parse(r.startedAt)) /
        1000,
    );
    const estimate = r.expectedTokens * Math.min(4, seconds / r.expectedSeconds);
    // Transparent, version-independent heuristic, NOT an API price or quota conversion.
    // Codex input includes cached input; Claude reports it separately.
    if (t.inputTokens !== null || t.outputTokens !== null) {
      const observed =
        Math.max(
          0,
          (t.inputTokens ?? 0) -
            (r.provider === 'codex'
              ? (t.cachedInputTokens ?? 0) + (t.cacheWriteInputTokens ?? 0)
              : 0),
        ) +
        (t.cachedInputTokens ?? 0) * 0.1 +
        (t.cacheWriteInputTokens ?? 0) * 1.25 +
        (t.outputTokens ?? 0) * 4;
      return t.inputTokens !== null && t.outputTokens !== null
        ? observed
        : Math.max(observed, estimate);
    }
    return estimate;
  }
  private modelRate(provider: string, windowId: string, model: string | null) {
    const parsed = rateSchema.safeParse(
      this.store.getSetting(`quark:rate:${hash({ provider, windowId, model })}`),
    );
    return parsed.success &&
      parsed.data.samples >= 3 &&
      this.clock() - Date.parse(parsed.data.updatedAt) < 30 * 86400_000
      ? parsed.data.unitsPerPercent
      : null;
  }
  private reconcileAllowance(provider: 'codex' | 'claude') {
    const capacity = readCapacity(this.store, provider, this.clock());
    if (capacity.stale || !capacity.observedAt || capacity.state !== 'ready') return;
    for (const w of capacity.windows) {
      if (w.scope === 'other') continue;
      const key = `quark:meter:${provider}:${w.id}`,
        parsed = meterSchema.safeParse(this.store.getSetting(key));
      const previous = parsed.success ? parsed.data : null;
      if (previous && Date.parse(previous.observedAt) >= Date.parse(capacity.observedAt)) continue;
      const gap =
        !!previous &&
        Date.parse(capacity.observedAt) - Date.parse(previous.observedAt) >
          capacityMaxAge(provider);
      // A completed turn can precede the collector's next report by more than
      // two minutes (Claude normally polls every five). Retain that interval's
      // work, including across restart, without reopening old history on gaps.
      const runs = this.runs(
        true,
        previous && !gap ? Date.parse(previous.observedAt) - 120_000 : this.clock() - 120_000,
      ).filter((r) => r.provider === provider);
      const matching = runs.filter(
        (r) =>
          !r.nativeRootId &&
          (w.scope !== 'model' || (!!w.model && r.model?.toLowerCase().includes(w.model))),
      );
      const scores = Object.fromEntries(matching.map((r) => [r.runId, this.score(r)]));
      const same =
        previous &&
        sameAllowanceReset(previous.resetsAt, w.resetsAt) &&
        w.usedPercent >= previous.usedPercent;
      const pending: Record<string, number> = same && !gap ? { ...previous.pending } : {};
      for (const id of Object.keys(pending)) if (!(id in scores)) delete pending[id];
      if (same && !gap)
        for (const r of matching) {
          // Fresh completed/active work only: retained history is not new spend.
          if (r.finishedAt && Date.parse(r.finishedAt) < Date.parse(previous.observedAt) - 120_000)
            continue;
          pending[r.runId] =
            (pending[r.runId] ?? 0) +
            Math.max(0, scores[r.runId]! - (previous.scores[r.runId] ?? 0));
        }
      const delta = same ? w.usedPercent - previous.usedPercent : 0;
      const units = Object.values(pending).reduce((a, b) => a + b, 0);
      const contributors = matching.filter((r) => (pending[r.runId] ?? 0) > 0);
      const weighted = new Map(
        contributors.map((r) => [
          r.runId,
          pending[r.runId]! /
            ((r.observedModels && (r.observedModels.length !== 1 || r.observedModels[0] !== r.model)
              ? null
              : this.modelRate(provider, w.id, r.model)) ??
              previous?.unitsPerPercent ??
              r.expectedTokens / r.quotaPercent),
        ]),
      );
      const weight = [...weighted.values()].reduce((a, b) => a + b, 0);
      const allocations =
        delta > 0 && weight > 0
          ? contributors.map((r) => ({
              runId: r.runId,
              projectId: r.projectId,
              taskIds: r.taskAncestors,
              percent: (delta * weighted.get(r.runId)!) / weight,
            }))
          : [];
      const measuredRatio = delta > 0 && units > 0 ? units / delta : null;
      this.store.transaction(() => {
        const receipt = hash({ provider, windowId: w.id, at: capacity.observedAt });
        this.store.db
          .prepare('INSERT OR IGNORE INTO quark_intervals(receipt,body) VALUES(?,?)')
          .run(
            receipt,
            JSON.stringify(
              intervalSchema.parse({
                provider,
                windowId: w.id,
                label: w.label,
                resetsAt: w.resetsAt,
                observedAt: capacity.observedAt,
                baseline: !same,
                from: previous?.observedAt ?? null,
                gap,
                delta,
                unattributed: allocations.length ? 0 : delta,
                allocations,
              }),
            ),
          );
        const summaryKey = `quark:window-total:${provider}:${w.id}`;
        const priorSummary = windowTotalSchema.safeParse(this.store.getSetting(summaryKey));
        const summary =
          same && priorSummary.success
            ? priorSummary.data
            : {
                provider,
                windowId: w.id,
                label: w.label,
                resetsAt: w.resetsAt,
                observedAt: capacity.observedAt!,
                deltaPercent: 0,
                unattributedPercent: 0,
                samples: 0,
                projects: {} as Record<string, number>,
              };
        summary.observedAt = capacity.observedAt!;
        summary.deltaPercent += delta;
        summary.unattributedPercent += allocations.length ? 0 : delta;
        if (delta > 0) summary.samples++;
        for (const a of allocations)
          summary.projects[a.projectId] = (summary.projects[a.projectId] ?? 0) + a.percent;
        this.store.setSetting(summaryKey, summary);
        this.store.setSetting(
          key,
          meterSchema.parse({
            observedAt: capacity.observedAt,
            resetsAt: w.resetsAt,
            usedPercent: w.usedPercent,
            scores,
            pending: delta > 0 ? {} : pending,
            unitsPerPercent: same
              ? measuredRatio === null
                ? previous.unitsPerPercent
                : previous.unitsPerPercent === null
                  ? measuredRatio
                  : previous.unitsPerPercent * 0.75 + measuredRatio * 0.25
              : null,
            samples: (same ? previous.samples : 0) + (measuredRatio === null ? 0 : 1),
          }),
        );
        // Learn separate model weights only where the observed interval is
        // identifiable; mixed-model intervals cannot reveal independent prices.
        if (
          measuredRatio &&
          new Set(contributors.map((r) => r.model)).size === 1 &&
          contributors.every((r) => r.model && r.basis === 'measured') &&
          contributors.every(
            (r) =>
              !r.observedModels ||
              (r.observedModels.length === 1 && r.observedModels[0] === r.model),
          ) &&
          !runs.some(
            (r) => r.nativeRootId && contributors.some((c) => c.agentId === r.nativeRootId),
          )
        ) {
          const rateKey = `quark:rate:${hash({ provider, windowId: w.id, model: contributors[0]!.model })}`;
          const rate = rateSchema.safeParse(this.store.getSetting(rateKey));
          this.store.setSetting(rateKey, {
            unitsPerPercent: rate.success
              ? rate.data.unitsPerPercent * 0.75 + measuredRatio * 0.25
              : measuredRatio,
            samples: (rate.success ? rate.data.samples : 0) + 1,
            updatedAt: capacity.observedAt,
          });
        }
      });
    }
  }
  budgets() {
    return this.store.db
      .prepare('SELECT body FROM quark_allowances')
      .all()
      .map((r) => allowanceSchema.parse(JSON.parse(String(r.body))));
  }
  saveBudget(
    raw: unknown,
    source: 'owner' | 'manager' = 'owner',
    toolReceipt?: { key: string; input: unknown },
  ) {
    const input = allowanceRequestSchema.parse(raw);
    this.store.project(input.projectId);
    if (input.taskId && this.store.task(input.taskId).projectId !== input.projectId)
      throw new Conflict('Task is outside this project.');
    this.sync();
    return this.store.operation(
      toolReceipt?.key ?? input.key,
      toolReceipt?.input ?? { kind: 'quark.budget', source, ...input },
      () => this.writeBudget(input, source),
    );
  }
  /** Called only while creating a task in its durable transaction, after sync(). */
  createTaskBudget(raw: unknown) {
    if (!this.store.db.isTransaction) throw new Error('Task caps require an atomic request.');
    const input = allowanceFieldsSchema.omit({ id: true, expectedRevision: true }).parse(raw);
    if (!input.taskId || this.store.task(input.taskId).projectId !== input.projectId)
      throw new Conflict('Task is outside this project.');
    return this.writeBudget({ ...input, expectedRevision: 0 }, 'agent-client');
  }
  private writeBudget(input: z.infer<typeof allowanceRequestSchema>, source: Allowance['source']) {
    allowanceRequestSchema.parse(input);
    if (!input.enabled && input.period !== 'hour')
      throw new Conflict(
        'Only hourly limits can be turned off. Existing window grants remain enforced.',
      );
    const old = this.budgets().find((b) => b.id === input.id);
    if (input.id && !old) throw new Conflict('Budget not found.');
    if (
      old &&
      (old.revision !== input.expectedRevision ||
        old.projectId !== input.projectId ||
        old.taskId !== input.taskId ||
        old.provider !== input.provider ||
        old.windowId !== input.windowId ||
        old.period !== input.period)
    )
      throw new Conflict('Budget changed or its scope differs. Reload before saving.');
    if (source !== 'owner' && (!input.enabled || (old && input.limitPercent > old.limitPercent)))
      throw new Conflict('Only the owner can increase an allowance budget.');
    if (
      !old &&
      this.budgets().some(
        (b) =>
          b.projectId === input.projectId &&
          b.taskId === input.taskId &&
          b.provider === input.provider &&
          b.windowId === input.windowId &&
          b.period === input.period,
      )
    )
      throw new Conflict('This scope already has a budget. Update that budget instead.');
    if (!old) {
      const cap = readCapacity(this.store, input.provider, this.clock());
      if (cap.stale || !cap.windows.some((w) => w.id === input.windowId))
        throw new Conflict(
          'Refresh usage first and select a reported allowance window. No weekly allowance is invented for plans without one.',
        );
    }
    const { key: _key, expectedRevision: _revision, ...fields } = input;
    const value = allowanceSchema.parse({
      ...fields,
      id: old?.id ?? randomUUID(),
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? stamp(this.clock()),
      startSequence:
        old?.startSequence ??
        Number(
          this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM quark_intervals').get()!.n,
        ),
      source: old?.source ?? source,
    });
    this.store.db
      .prepare(
        'INSERT INTO quark_allowances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(value.id, JSON.stringify(value));
    this.store.event('quark.budget', value.projectId, null, value);
    return value;
  }
  private applies(
    b: Allowance,
    run: Pick<QuarkRun, 'projectId' | 'provider' | 'taskAncestors'> & { model?: string | null },
  ) {
    // Most allowances belong to another project/task. Do not parse a provider
    // report for those identities during each queue/demand decision.
    if (
      b.projectId !== run.projectId ||
      b.provider !== run.provider ||
      (b.taskId && !run.taskAncestors.includes(b.taskId))
    )
      return false;
    const window = readCapacity(this.store, b.provider, this.clock()).windows.find(
      (w) => w.id === b.windowId,
    );
    if (
      window?.scope === 'model' &&
      window.model &&
      run.model &&
      !run.model.toLowerCase().includes(window.model)
    )
      return false;
    return true;
  }
  private spent(b: Allowance) {
    const cached = this.spentCache.get(b.id) ?? { sequence: b.startSequence, percent: 0 };
    const head = Number(
      this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM quark_intervals').get()!.n,
    );
    if (head > cached.sequence) {
      const rows = this.store.db
        .prepare(
          "SELECT body FROM quark_intervals WHERE json_extract(body,'$.provider')=? AND json_extract(body,'$.windowId')=? AND id>? ORDER BY id",
        )
        .all(b.provider, b.windowId, cached.sequence);
      for (const row of rows) {
        const i = intervalSchema.parse(JSON.parse(String(row.body)));
        cached.percent += i.allocations
          .filter((a) => a.projectId === b.projectId && (!b.taskId || a.taskIds.includes(b.taskId)))
          .reduce((n, a) => n + a.percent, 0);
      }
      cached.sequence = head;
      this.spentCache.set(b.id, cached);
    }
    return cached.percent;
  }
  private reservation(r: QuarkRun, windowId: string) {
    const meter = meterSchema.safeParse(
      this.store.getSetting(`quark:meter:${r.provider}:${windowId}`),
    );
    const calibration =
      this.modelRate(r.provider, windowId, r.model) ??
      (meter.success && meter.data.samples >= 3 ? meter.data.unitsPerPercent : null);
    return Math.max(
      r.quotaPercent,
      calibration ? Math.max(r.expectedTokens, this.score(r)) / calibration : 0,
    );
  }
  private reservationRuns(since = this.clock() - 3600_000): QuarkRun[] {
    const runs = this.runs(true, since);
    const ids = new Set(runs.map((r) => r.runId));
    for (const l of this.pulsar.allowanceReservations(since)) {
      if (ids.has(l.runId)) continue;
      const run = this.store.run(l.runId),
        a = this.store.agent(run.agentId);
      runs.push({
        runId: run.id,
        agentId: a.id,
        projectId: a.projectId,
        taskId: this.taskIds(run)[0] ?? null,
        taskAncestors: this.taskIds(run),
        nativeRootId: a.nativeRootId,
        provider: a.provider,
        model: l.model,
        threadId: a.threadId,
        startedAt: l.startedAt,
        finishedAt: l.finishedAt,
        observedAt: null,
        baseline: unknown,
        tokens: unknown,
        basis: 'unknown',
        expectedTokens: l.estimate.expectedTokens,
        quotaPercent: l.estimate.quotaPercent,
        expectedSeconds: l.estimate.expectedSeconds,
        cacheNudge: false,
      });
    }
    return runs;
  }
  private hourlyStatus(b: Allowance, allowRecentReading: boolean, excludeRunId?: string) {
    const intervals = this.recentIntervals().filter(
      (i) => i.provider === b.provider && i.windowId === b.windowId,
    );
    // Keep the rolling hour across account resets. New caps cannot erase recent spend.
    const spentPercent = intervals
      .flatMap((i) => i.allocations)
      .filter((a) => a.projectId === b.projectId && (!b.taskId || a.taskIds.includes(b.taskId)))
      .reduce((n, a) => n + a.percent, 0);
    const reservations = this.reservationRuns().filter(
      (r) => r.runId !== excludeRunId && !r.nativeRootId && this.applies(b, r),
    );
    let reservedPercent = 0;
    const expiry: number[] = [];
    for (const i of intervals)
      if (
        i.allocations.some(
          (a) => a.projectId === b.projectId && (!b.taskId || a.taskIds.includes(b.taskId)),
        )
      )
        expiry.push(Date.parse(i.observedAt) + 3600_000);
    for (const r of reservations) {
      // A later positive observation containing the finished run replaces its
      // estimate. A reset, outage or zero-delta report alone cannot prove this.
      const reflected =
        r.finishedAt &&
        intervals.some(
          (i) =>
            !i.baseline &&
            Date.parse(i.observedAt) >= Date.parse(r.finishedAt!) + 30_000 &&
            i.allocations.some((a) => a.runId === r.runId),
        );
      if (reflected) continue;
      reservedPercent += Math.max(
        0,
        this.reservation(r, b.windowId) - this.runAttributed(r, b.windowId),
      );
      if (r.finishedAt) expiry.push(Date.parse(r.finishedAt) + 3600_000);
    }
    const cap = readCapacity(this.store, b.provider, this.clock());
    const w = cap.windows.find((w) => w.id === b.windowId);
    const atLimit =
      spentPercent + reservedPercent >=
      b.limitPercent - Math.min(this.settings().bufferPercent, b.limitPercent * 0.2);
    const expired = w?.resetsAt && Date.parse(w.resetsAt) <= this.clock();
    const unavailable = !this.usableReading(cap, allowRecentReading) || !w;
    const cause = !b.enabled
      ? null
      : b.limitPercent === 0
        ? ('hourly' as const)
        : expired
          ? ('reset' as const)
          : unavailable
            ? ('monitoring' as const)
            : atLimit
              ? ('hourly' as const)
              : null;
    const futureExpiry = expiry.filter((at) => at > this.clock());
    const nextEligibleAt = futureExpiry.length ? stamp(Math.min(...futureExpiry)) : null;
    return {
      ...b,
      spentPercent,
      reservedPercent,
      remainingPercent: Math.max(0, b.limitPercent - spentPercent),
      nextEligibleAt,
      cause,
      reason:
        cause === 'hourly'
          ? b.limitPercent === 0
            ? `Saved ${b.provider === 'claude' ? 'Claude' : 'Codex'} rate is 0%/hour. This project's provider work stays paused until you raise the rate.`
            : 'Rolling hourly allowance limit reached its stopping buffer. Waiting for earlier spending or reservations to leave the hour.'
          : cause === 'reset'
            ? 'Waiting for a verified allowance reset.'
            : cause === 'monitoring'
              ? 'Waiting for a fresh report of this allowance.'
              : null,
    };
  }
  private runAttributed(r: QuarkRun, windowId: string) {
    const key = `${r.runId}:${windowId}`;
    const cached = this.runSpentCache.get(key) ?? { sequence: 0, percent: 0 };
    const head = Number(
      this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM quark_intervals').get()!.n,
    );
    if (head > cached.sequence) {
      const rows = this.store.db
        .prepare(
          "SELECT body FROM quark_intervals INDEXED BY quark_intervals_window_observed WHERE json_extract(body,'$.provider')=? AND json_extract(body,'$.windowId')=? AND json_extract(body,'$.observedAt')>=? AND id>? ORDER BY id",
        )
        .all(r.provider, windowId, r.startedAt, cached.sequence);
      for (const row of rows)
        cached.percent += intervalSchema
          .parse(JSON.parse(String(row.body)))
          .allocations.filter((a) => a.runId === r.runId)
          .reduce((sum, a) => sum + a.percent, 0);
      cached.sequence = head;
      if (!this.runSpentCache.has(key) && this.runSpentCache.size >= 1000)
        this.runSpentCache.delete(this.runSpentCache.keys().next().value!);
      this.runSpentCache.set(key, cached);
    }
    return cached.percent;
  }
  budgetStatus(
    b: Allowance,
    ignorePause = false,
    allowRecentReading = false,
    excludeRunId?: string,
  ) {
    if (b.period === 'hour') return this.hourlyStatus(b, allowRecentReading, excludeRunId);
    const spentPercent = this.spent(b);
    const reservedPercent = this.reservationRuns()
      .filter(
        (r) =>
          r.runId !== excludeRunId &&
          this.applies(b, r) &&
          !r.nativeRootId &&
          (!r.finishedAt || this.clock() - Date.parse(r.finishedAt) < 90_000),
      )
      .reduce((n, r) => n + this.reservation(r, b.windowId), 0);
    const cap = readCapacity(this.store, b.provider, this.clock());
    const w = cap.windows.find((w) => w.id === b.windowId);
    const atLimit =
      spentPercent + reservedPercent >=
      Math.max(0, b.limitPercent - Math.min(this.settings().bufferPercent, b.limitPercent * 0.2));
    const paused = !ignorePause && this.store.getSetting(`quark:budget-paused:${b.id}`);
    const expired = w?.resetsAt && Date.parse(w.resetsAt) <= this.clock();
    const unavailable = !this.usableReading(cap, allowRecentReading) || !w;
    const cause = !b.enabled
      ? null
      : paused || atLimit
        ? ('budget' as const)
        : expired
          ? ('reset' as const)
          : unavailable
            ? ('monitoring' as const)
            : null;
    const reason = paused
      ? 'This allowance grant is paused. The owner must explicitly continue saved work.'
      : atLimit
        ? 'Allowance budget reached its stopping buffer. Increase the budget to continue.'
        : expired
          ? 'Waiting for a verified allowance reset.'
          : unavailable
            ? 'Waiting for a fresh report of this allowance.'
            : null;
    return {
      ...b,
      spentPercent,
      reservedPercent,
      remainingPercent: Math.max(0, b.limitPercent - spentPercent),
      nextEligibleAt: null,
      reason,
      cause,
    };
  }
  holds(): QuotaHold[] {
    const read = () =>
      this.store.db
        .prepare('SELECT value FROM settings WHERE key >= ? AND key < ?')
        .all('quark:hold:', 'quark:hold;')
        .map((r) => quotaHoldSchema.parse(JSON.parse(String(r.value))))
        .filter((h) => !h.releasedAt);
    return this.demandSnapshot ? (this.demandSnapshot.holds ??= read()) : read();
  }
  private usableReading(cap: ReturnType<typeof readCapacity>, allowRecent: boolean) {
    return (
      !cap.stale ||
      (allowRecent &&
        cap.state === 'error' &&
        cap.observedAt !== null &&
        this.clock() - Date.parse(cap.observedAt) >= 0 &&
        this.clock() - Date.parse(cap.observedAt) < capacityMaxAge(cap.provider))
    );
  }
  reason(run: PrivateRun, admitting = false, ignoreHold = false): string | null {
    return this.block(run, admitting, ignoreHold)?.reason ?? null;
  }
  block(
    run: PrivateRun,
    admitting = false,
    ignoreHold = false,
    ignoreBudgetPause = ignoreHold,
    allowChatBypass = true,
    paced = true,
  ): { cause: QuotaHold['cause']; reason: string; budgetTargetId?: string } | null {
    const a = this.store.agent(run.agentId),
      rootId = a.nativeRootId ?? a.id;
    const projectBypass = !projectFollowsQuark(this.store, a.projectId);
    const bypass = projectBypass || (allowChatBypass && chatBypassAllowed(this.store, run));
    if (!ignoreHold) {
      const hold = this.holds().find((h) => h.agentId === rootId);
      if (
        hold &&
        (hold.nativeExhaustion ||
          !bypass ||
          ![
            'budget',
            'hourly',
            'headroom',
            'monitoring',
            'reset',
            ...(projectBypass ? ['project'] : []),
          ].includes(hold.cause))
      ) {
        const budget =
          hold.cause === 'budget'
            ? this.budgets().find(
                (b) =>
                  this.applies(b, {
                    projectId: a.projectId,
                    provider: a.provider,
                    model: a.model,
                    taskAncestors: this.taskIds(run),
                  }) && this.budgetStatus(b).cause === 'budget',
              )
            : undefined;
        return {
          cause: hold.cause,
          reason: `Paused by QUARK: ${hold.reason}`,
          ...(budget ? { budgetTargetId: budget.taskId ?? a.projectId } : {}),
        };
      }
    }
    if (
      !projectBypass &&
      (this.store.getSetting(`quark:project:${a.projectId}`) as { paused?: boolean } | null)?.paused
    )
      return {
        cause: 'project',
        reason: 'Paused by QUARK: this project is paused by a saved scheduling decision.',
      };
    if (bypass) return null;
    const allowRecent = !admitting && this.store.run(run.id).status === 'running';
    const taskAncestors = this.taskIds(run);
    const budgets = this.budgets()
      .filter(
        (b) =>
          b.enabled &&
          this.applies(b, {
            projectId: a.projectId,
            provider: a.provider,
            model: a.model,
            taskAncestors,
          }),
      )
      .map((b) =>
        this.budgetStatus(b, ignoreBudgetPause, allowRecent, admitting ? run.id : undefined),
      );
    // A known exhausted grant outranks a telemetry outage. It must never become
    // an automatically recoverable hold when the collector fails at the same time.
    const exhausted = budgets.find((b) => b.cause === 'budget');
    if (exhausted)
      return {
        cause: 'budget',
        reason: exhausted.reason!,
        budgetTargetId: exhausted.taskId ?? a.projectId,
      };
    const zeroRate = budgets.find((b) => b.period === 'hour' && b.limitPercent === 0);
    if (zeroRate)
      return {
        cause: 'hourly',
        reason: zeroRate.reason!,
        budgetTargetId: zeroRate.taskId ?? a.projectId,
      };
    const cap = readCapacity(this.store, a.provider, this.clock());
    const windows = cap.windows.filter(
      (w) => w.scope === 'general' || (w.model && a.model?.toLowerCase().includes(w.model)),
    );
    if (this.pulsar.policy().enabled) {
      if (!this.usableReading(cap, allowRecent) || !windows.length)
        return {
          cause: 'monitoring',
          reason: 'Usage is unavailable or stale; protecting the shared allowance.',
        };
      const models = modelPolicySchema.parse(
        this.store.getSetting('model-policy') ?? defaultModelPolicy,
      ).models[a.provider];
      const required = Object.values(models).find(
        (m) =>
          m.requiresModelAllowance &&
          a.model &&
          (m.model === a.model || a.model.toLowerCase().includes(m.family.toLowerCase())),
      );
      if (
        required &&
        !windows.some((w) => w.scope === 'model' && w.model === required.family.toLowerCase())
      )
        return {
          cause: 'monitoring',
          reason: `Waiting for a verified ${required.family} allowance.`,
        };
      for (const w of windows) {
        if (w.resetsAt && Date.parse(w.resetsAt) <= this.clock())
          return { cause: 'reset', reason: 'Waiting for a verified allowance reset.' };
        if (
          w.usedPercent >=
          100 -
            effectiveProviderReserve(this.pulsar.policy(), cap, w, this.clock()).effectivePercent
        )
          return { cause: 'headroom', reason: `${w.label} reached the shared headroom limit.` };
      }
    }
    for (const b of budgets) {
      if (b.reason) return { cause: b.cause!, reason: b.reason };
      if (
        admitting &&
        b.spentPercent + b.reservedPercent + this.pulsar.estimate(run).quotaPercent >
          b.limitPercent - Math.min(this.settings().bufferPercent, b.limitPercent * 0.2)
      )
        return {
          cause: b.period === 'hour' ? 'hourly' : 'budget',
          reason:
            b.period === 'hour'
              ? 'This turn would exceed the rolling hourly allowance limit and stopping buffer. Wait for room or refine its turn estimate.'
              : 'This turn would exceed the remaining allowance budget and stopping buffer.',
          budgetTargetId: b.taskId ?? a.projectId,
        };
    }
    // Explicit caps, reserve, stale/native and manual gates above always win first.
    if (admitting && paced && this.pulsar.policy().enabled)
      return this.paceBlock(run, a, cap, windows);
    return null;
  }
  /** Pace applies only while a window is projected to reach its reserve before its reported reset. */
  private enforcesPace(
    provider: 'codex' | 'claude',
    window: { id: string; windowMinutes: number | null },
    pacing = this.utilization(),
  ) {
    // Follow the owner's explicit five-hour utilization choice.
    if (
      provider === 'claude' &&
      window.windowMinutes === 300 &&
      this.pulsar.policy().maximizeClaudeFiveHour
    )
      return false;
    return pacing.some(
      (p) => p.provider === provider && p.windowId === window.id && p.state === 'fast',
    );
  }
  /**
   * Adaptive admission: while a reported window runs fast, each project with ready work gets
   * its weighted share of the headroom left until that window's own reset. Rolling attributed
   * use plus outstanding reservations must fit the share. A project with nothing in the last
   * hour may always start one turn, so a large estimate cannot deadlock startup. Owner
   * messages and explicit per-job overrides are not paced; no cap is saved.
   */
  private paceBlock(
    run: PrivateRun,
    a: ReturnType<Store['agent']>,
    cap: ReturnType<typeof readCapacity>,
    windows: ReturnType<typeof readCapacity>['windows'],
  ): { cause: QuotaHold['cause']; reason: string } | null {
    if (
      run.kind === 'user' ||
      this.store.run(run.id).status !== 'queued' ||
      this.store.getSetting(`pulsar:override:${run.id}`) === true
    )
      return null;
    const now = this.clock(),
      pacing = this.utilization();
    let demand: ReturnType<typeof materialDemand> | null = null;
    for (const window of windows) {
      if (!this.enforcesPace(a.provider, window, pacing)) continue;
      demand ??= this.demandSnapshot
        ? (this.demandSnapshot.value ??= materialDemand(this.store, this, now))
        : materialDemand(this.store, this, now);
      const caps = this.budgets().filter(
        (b) =>
          b.projectId === a.projectId &&
          !b.taskId &&
          b.provider === a.provider &&
          b.windowId === window.id &&
          b.period === 'hour' &&
          b.enabled,
      );
      const pace = adaptivePace({
        now,
        capacity: cap,
        window,
        policy: this.pulsar.policy(),
        reservedPercent: reservedPercent(this, cap, window, now),
        projectId: a.projectId,
        demand,
        weight: (id) => projectWeight(this.store, id),
        hourlyCapPercent: caps.length ? Math.min(...caps.map((b) => b.limitPercent)) : null,
      });
      // Unknown/blocked readings are handled by the ordinary gates; never pace without a share.
      if (pace.state !== 'ready' || pace.percentPerHour === null) continue;
      // Reuse the rolling hourly attribution and reservation ledger for this project and window.
      const recent = this.hourlyStatus(
        {
          id: a.projectId,
          projectId: a.projectId,
          taskId: null,
          provider: a.provider,
          windowId: window.id,
          period: 'hour',
          enabled: true,
          limitPercent: pace.percentPerHour,
          revision: 0,
          createdAt: stamp(now),
          startSequence: 0,
          source: 'owner',
        },
        false,
        run.id,
      );
      const used = recent.spentPercent + recent.reservedPercent;
      if (used > 0 && used + this.pulsar.estimate(run).quotaPercent > pace.percentPerHour)
        return {
          cause: 'headroom',
          reason: `Pacing ${window.label}: it is projected to reach its reserve before the reported reset, so ${pace.demandProjects} project${pace.demandProjects === 1 ? '' : 's'} with ready work share about ${pace.percentPerHour.toFixed(2)}%/hour here by weight. This project used about ${used.toFixed(1)}% in the rolling hour, including reservations. Waiting for earlier use to leave the hour${recent.nextEligibleAt ? ` (around ${recent.nextEligibleAt.slice(11, 16)} UTC)` : ''} or for a calmer reading. Estimate only; no cap was saved.`,
        };
    }
    return null;
  }
  hold(
    run: PrivateRun,
    reason: string,
    withinTransaction = false,
    cause: QuotaHold['cause'] = 'manual',
  ) {
    const save = () => {
      const a = this.store.agent(run.agentId);
      const old = this.holds().find((h) => h.runId === run.id);
      if (old && (!['manual', 'budget', 'lease'].includes(cause) || old.cause === cause))
        return old;
      for (const b of this.budgets().filter(
        (b) =>
          b.enabled &&
          b.period === 'window' &&
          this.applies(b, {
            projectId: a.projectId,
            provider: a.provider,
            model: a.model,
            taskAncestors: this.taskIds(run),
          }),
      )) {
        const status = this.budgetStatus(b, true);
        if (
          status.spentPercent + status.reservedPercent >=
          b.limitPercent - Math.min(this.settings().bufferPercent, b.limitPercent * 0.2)
        )
          this.store.setSetting(`quark:budget-paused:${b.id}`, {
            at: stamp(this.clock()),
            runId: run.id,
          });
      }
      if (old) {
        const next = { ...old, cause, reason };
        this.store.setSetting(`quark:hold:${run.id}`, next);
        const event = this.store.event('quark.pause_changed', a.projectId, a.id, next);
        captureGroupQuarkTransition(this.store, run.id, `quark:${event.id}`, 'held', cause);
        return next;
      }
      const value = quotaHoldSchema.parse({
        runId: run.id,
        agentId: a.id,
        projectId: a.projectId,
        reason,
        cause,
        createdAt: stamp(this.clock()),
        releasedAt: null,
        lastAttemptAt: null,
        error: null,
      });
      this.store.setSetting(`quark:hold:${run.id}`, value);
      const event = this.store.event('quark.paused', a.projectId, a.id, value);
      captureGroupQuarkTransition(this.store, run.id, `quark:${event.id}`, 'held', cause);
      return value;
    };
    return withinTransaction ? save() : this.store.transaction(save);
  }
  /**
   * Typed native primary-window rejection for the current owned turn. Existing
   * explicit holds win; evidence is written once and never refreshed by later frames.
   */
  nativeExhaustion(
    run: PrivateRun,
    event: {
      sessionId: string;
      rateLimitType: NonNullable<QuotaHold['nativeExhaustion']>['rateLimitType'];
      resetsAtSeconds: number;
    },
  ) {
    const window = nativeWindows[event.rateLimitType];
    const resetsAt = event.resetsAtSeconds * 1000;
    if (
      run.status !== 'running' ||
      resetsAt <= this.clock() ||
      resetsAt > this.clock() + (window.minutes + 10) * 60_000
    )
      return null;
    return this.store.transaction(() => {
      const old = this.holds().find((h) => h.runId === run.id);
      if (old && (old.nativeExhaustion || !transientCauses.includes(old.cause))) return old;
      const reason = `Claude reported its ${window.label} allowance exhausted until ${new Date(resetsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. QUARK resumes once after a fresh reading shows that window reset.`;
      const hold = this.hold(run, reason, true, 'reset');
      const value = quotaHoldSchema.parse({
        ...hold,
        cause: 'reset',
        reason,
        nativeExhaustion: {
          source: 'claude-rate-limit-event',
          sessionId: event.sessionId,
          runId: run.id,
          rateLimitType: event.rateLimitType,
          windowId: window.id,
          resetsAt: new Date(resetsAt).toISOString(),
          observedAt: stamp(this.clock()),
        },
      });
      this.store.setSetting(`quark:hold:${run.id}`, value);
      // Capture the owned conversation's immutable account binding, not a usage
      // reading that may have lagged behind this direct native rejection.
      const agent = this.store.agent(run.agentId);
      const account = nativeAccountSchema.safeParse({
        runId: run.id,
        sessionId: event.sessionId,
        affinity: this.store.getSetting(`claude:account:${agent.id}`),
      });
      if (agent.provider === 'claude' && agent.threadId === event.sessionId && account.success)
        this.store.setSetting(`quark:native-account:${run.id}`, account.data);
      return value;
    });
  }
  recordStop(runId: string, error: string | null) {
    const value = this.holds().find((h) => h.runId === runId);
    if (value)
      this.store.setSetting(`quark:hold:${runId}`, {
        ...value,
        lastAttemptAt: stamp(this.clock()),
        error,
      });
  }
  /** Called only after the provider/group completion acknowledgement, not on a stop request or restart. */
  acknowledgeStop(runId: string) {
    const h = this.holds().find((h) => h.runId === runId);
    if (h && ['interrupted', 'completed'].includes(this.store.run(runId).status))
      this.store.setSetting(`quark:hold:${runId}`, {
        ...h,
        stopAcknowledgedAt: stamp(this.clock()),
      });
  }
  recoverTransient(excluded: ReadonlySet<string>) {
    for (const h of this.holds()) {
      if (
        (!transientCauses.includes(h.cause) &&
          !(
            ['budget', 'project'].includes(h.cause) && !projectFollowsQuark(this.store, h.projectId)
          )) ||
        !h.stopAcknowledgedAt ||
        excluded.has(h.agentId)
      )
        continue;
      const run = this.store.run(h.runId);
      if (!['interrupted', 'completed'].includes(run.status)) continue;
      // An explicit project opt-out releases scheduler-only stops after the owned
      // provider has acknowledged stopping. Native exhaustion and manual pauses stay.
      if (!h.nativeExhaustion && !projectFollowsQuark(this.store, h.projectId)) {
        try {
          this.store.transaction(() => this.release(h.runId, true));
        } catch {
          /* Another pause or active owned process still requires waiting. */
        }
        continue;
      }
      // Automatic recovery always requires a new, successful report. A stale
      // reading accepted briefly for an already admitted turn is not admission.
      const agent = this.store.agent(h.agentId);
      const cap = readCapacity(this.store, agent.provider, this.clock());
      if (
        h.cause !== 'cache' &&
        (cap.stale || !cap.observedAt || Date.parse(cap.observedAt) <= Date.parse(h.createdAt))
      )
        continue;
      const native = h.nativeExhaustion;
      if (native) {
        const w = cap.windows.find((w) => w.id === native.windowId);
        if (!w || Date.parse(cap.observedAt!) <= Date.parse(native.observedAt)) continue;
        const laterReset =
          w.resetsAt !== null &&
          Date.parse(w.resetsAt) > Date.parse(native.resetsAt) &&
          !sameAllowanceReset(w.resetsAt, native.resetsAt);
        // Claude can report an available, unused window with no next reset until
        // another turn starts. Require a fresh post-reset native reading tied to
        // the same owned session/account; time alone and same-window lows never suffice.
        const account = nativeAccountSchema.safeParse(
          this.store.getSetting(`quark:native-account:${run.id}`),
        );
        const availableAfterReset =
          w.resetsAt === null &&
          w.usedPercent < 100 &&
          w.windowMinutes === nativeWindows[native.rateLimitType].minutes &&
          Date.parse(cap.observedAt!) > Date.parse(native.resetsAt) &&
          Date.parse(cap.observedAt!) <= this.clock() &&
          agent.provider === 'claude' &&
          agent.threadId === native.sessionId &&
          account.success &&
          account.data.runId === run.id &&
          account.data.sessionId === native.sessionId &&
          account.data.affinity === this.store.getSetting(`claude:account:${agent.id}`) &&
          account.data.affinity === readClaudeCapacityAffinity(this.store, cap);
        if (!laterReset && !availableAfterReset) continue;
      }
      const block = this.block(run, true, true, false);
      if (block?.cause === 'budget') {
        // A recovered reading can reveal spending that arrived after the outage.
        // Preserve the stop receipt, but expose/latch the cap that now prevents recovery.
        this.hold(run, block.reason, false, 'budget');
        continue;
      }
      try {
        this.store.transaction(() => this.release(h.runId, true));
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
  }
  release(runId: string, automatic = false) {
    const h = this.holds().find((h) => h.runId === runId);
    if (!h) throw new Conflict('This pause was already released or no longer exists.');
    const run = this.store.run(runId),
      a = this.store.agent(run.agentId);
    if (
      automatic &&
      a.autoTurns >= (this.pulsar.policy().enabled ? this.pulsar.policy().maxAutomaticTurns : 12)
    )
      throw new Conflict(
        'Automatic work reached its turn limit. Review progress before continuing.',
      );
    if (
      a.turnId ||
      this.store
        .runs()
        .some(
          (r) =>
            (r.agentId === a.id || this.store.agent(r.agentId).nativeRootId === a.id) &&
            r.status === 'running',
        )
    )
      throw new Conflict('The provider is still stopping. Wait for its acknowledgement.');
    if (
      automatic &&
      (this.store.getSetting(`pulsar:held:${runId}`) === true ||
        this.taskIds(run).some(
          (taskId) => this.store.getSetting(`pulsar:held-task:${taskId}`) === true,
        ))
    )
      throw new Conflict('Another saved queue pause still protects this work.');
    if (automatic && this.holds().some((other) => other.agentId === a.id && other.runId !== runId))
      throw new Conflict('Another pause still protects this conversation.');
    const reason = this.block(run, true, true, !automatic)?.reason;
    if (reason) throw new Conflict(reason);
    if (!automatic)
      for (const b of this.budgets().filter((b) =>
        this.applies(b, {
          projectId: a.projectId,
          provider: a.provider,
          model: a.model,
          taskAncestors: this.taskIds(run),
        }),
      ))
        this.store.setSetting(`quark:budget-paused:${b.id}`, null);
    this.store.setSetting(`quark:hold:${runId}`, { ...h, releasedAt: stamp(this.clock()) });
    this.store.updateAgent(a.id, { status: 'idle', autoTurns: automatic ? a.autoTurns : 0 });
    if (
      !(automatic && (this.isMaintenance(runId) || run.status === 'completed')) &&
      !this.store.runs().some((r) => r.agentId === a.id && r.status === 'queued')
    )
      this.store.enqueue(
        a.id,
        `quark:resume:${runId}`,
        `${automatic ? 'QUARK has verified fresh capacity and the provider confirmed its stop' : 'The owner resumed this saved conversation'}. Inspect retained progress and uncertain actions before continuing. Do not repeat side effects merely because a turn was interrupted.`,
        'resume',
      );
    const event = this.store.event('quark.resumed', a.projectId, a.id, {
      runId,
      automatic,
      cause: h.cause,
    });
    captureGroupQuarkTransition(this.store, runId, `quark:${event.id}`, 'resumed', h.cause);
    this.store.setSetting(`quark:recovery:${a.id}`, {
      runId,
      at: stamp(this.clock()),
      automatic,
      instruction:
        'Inspect retained progress and uncertain actions before continuing. Never replay an interrupted action without checking its outcome.',
    });
  }
  isNudge(runId: string) {
    return this.store.getSetting(`quark:nudge:${runId}`) === true;
  }
  isMaintenance(runId: string) {
    return this.isNudge(runId) || this.store.getSetting(`quark:compaction:${runId}`) === true;
  }
  cacheStatus() {
    const ledger = this.runs();
    const nudges = this.store
      .runs()
      .filter((r) => Date.parse(r.createdAt) > this.clock() - 86400_000 && this.isNudge(r.id));
    return this.store
      .agents()
      .filter((a) => a.threadId && !a.nativeRootId)
      .map((a) => {
        const snapshot = this.snapshot(a.id),
          ttl = this.settings().cacheMinutes[a.provider];
        const latest = ledger.filter((r) => r.agentId === a.id).at(-1);
        // Start time is deliberately conservative; end-of-turn is not a provider cache write timestamp.
        const observedAt = latest?.startedAt ?? snapshot?.observedAt ?? null;
        const expires = ttl && observedAt ? Date.parse(observedAt) + ttl * 60_000 : null;
        const nudgesToday = nudges.filter((r) => r.agentId === a.id).length;
        return {
          agentId: a.id,
          name: a.name,
          provider: a.provider,
          observedAt,
          estimatedExpiresAt: expires ? stamp(expires) : null,
          cachedTokens: snapshot?.last.cachedInputTokens ?? null,
          nudgesToday,
          state:
            ttl === null
              ? 'Expiry is not exposed; no automatic timer configured.'
              : expires === null
                ? 'Waiting for token evidence.'
                : expires <= this.clock()
                  ? 'Estimated cache lifetime elapsed; conversation retained.'
                  : 'Estimated timer, not a provider guarantee.',
        };
      });
  }
  private recentIntervals(hours = 1) {
    const cutoff = stamp(this.clock() - hours * 3600_000);
    return this.store.db
      .prepare(
        `SELECT body FROM quark_intervals INDEXED BY quark_intervals_observed WHERE json_extract(body,'$.observedAt')>=? ORDER BY json_extract(body,'$.observedAt') DESC,id DESC ${hours > 1 ? 'LIMIT 12001' : ''}`,
      )
      .all(cutoff)
      .reverse()
      .map((row) => intervalSchema.parse(JSON.parse(String(row.body))));
  }
  /** Account-wide observed burn, not a project allocation or permission to spend. */
  utilization() {
    const intervals = this.recentIntervals();
    const policy = this.pulsar.policy();
    return (['codex', 'claude'] as const).flatMap((provider) => {
      const capacity = readCapacity(this.store, provider, this.clock());
      return capacity.windows
        .filter((window) => window.scope !== 'other')
        .map((window) => {
          const protection = effectiveProviderReserve(policy, capacity, window, this.clock());
          const reserve = protection.effectivePercent;
          const matching = intervals.filter(
            (row) =>
              row.provider === provider &&
              row.windowId === window.id &&
              sameAllowanceReset(row.resetsAt, window.resetsAt),
          );
          const samples = currentRateSamples(matching, window.resetsAt, capacityMaxAge(provider));
          const hours =
            samples.length > 1
              ? (Date.parse(samples.at(-1)!.observedAt) - Date.parse(samples[0]!.observedAt)) /
                3600_000
              : 0;
          const remaining = Math.max(0, 100 - window.usedPercent);
          const until = window.resetsAt
            ? (Date.parse(window.resetsAt) - this.clock()) / 3600_000
            : null;
          const fresh =
            capacity.state === 'ready' && !capacity.stale && (until === null || until > 0);
          const rate =
            fresh && hours >= 5 / 60
              ? samples.slice(1).reduce((sum, row) => sum + row.delta, 0) / hours
              : null;
          const target = fresh && until !== null ? Math.max(0, remaining - reserve) / until : null;
          const projected =
            rate !== null && until !== null
              ? Math.max(0, Math.min(100, remaining - rate * until))
              : null;
          const shortWindow = window.windowMinutes !== null && window.windowMinutes <= 360;
          const state = !fresh
            ? 'unknown'
            : remaining <= reserve
              ? 'protected'
              : rate === null || projected === null
                ? 'unknown'
                : target !== null && rate > target
                  ? 'fast'
                  : shortWindow && projected! > reserve + 10
                    ? 'underused'
                    : 'on-track';
          return windowPacingSchema.parse({
            provider,
            windowId: window.id,
            label: window.label,
            remainingPercent: remaining,
            reservePercent: reserve,
            savedReservePercent: protection.reservePercent,
            reserveReleased: protection.released,
            releaseEnabled: protection.releaseEnabled,
            releaseBeforeResetMinutes: protection.releaseBeforeResetMinutes,
            resetsAt: window.resetsAt,
            minutesToReset: until === null ? null : Math.max(0, Math.round(until * 60)),
            observedPercentPerHour: rate,
            targetPercentPerHour: target,
            projectedRemainingPercent: projected,
            observedAt: capacity.observedAt,
            reserveAt:
              rate !== null && rate > 0 && capacity.observedAt
                ? stamp(
                    Date.parse(capacity.observedAt) +
                      (Math.max(0, remaining - reserve) / rate) * 3600_000,
                  )
                : fresh && remaining <= reserve
                  ? capacity.observedAt
                  : null,
            exhaustionAt:
              rate !== null && rate > 0 && capacity.observedAt
                ? stamp(Date.parse(capacity.observedAt) + (remaining / rate) * 3600_000)
                : null,
            resetBeforeReserve:
              rate !== null && rate > 0 && capacity.observedAt && window.resetsAt
                ? Date.parse(window.resetsAt) <
                  Date.parse(capacity.observedAt) +
                    (Math.max(0, remaining - reserve) / rate) * 3600_000
                : null,
            state,
            message:
              state === 'underused'
                ? 'Spare reset-window capacity: advance suitable authorized work if project provider choices, all model windows, caps and computer resources allow. Do not create filler work.'
                : state === 'fast'
                  ? 'The recent rate projects below the protected reserve. Reduce new starts or pause at a safe boundary; existing guards still apply.'
                  : state === 'protected'
                    ? 'The protected reserve is reached. Wait for verified fresh capacity; do not lower it automatically.'
                    : state === 'unknown'
                      ? 'A fresh reset time and at least five minutes of comparable readings are needed before estimating window use.'
                      : 'Compare useful remaining work with this account-wide rate; estimates do not grant capacity.',
          });
        });
    });
  }
  projectRates() {
    const now = this.clock(),
      intervals = this.recentIntervals(12),
      rates = [];
    const projects = this.store.projects(),
      budgets = this.budgets(),
      pacing = this.utilization(),
      demand = materialDemand(this.store, this, now),
      policy = this.pulsar.policy();
    const accounts = [];
    for (const provider of ['codex', 'claude'] as const) {
      const capacity = readCapacity(this.store, provider, now);
      for (const window of capacity.windows.filter((w) => w.scope !== 'other')) {
        const reserved = reservedPercent(this, capacity, window, now);
        const historyRows = intervals.filter(
          (row) => row.provider === provider && row.windowId === window.id,
        );
        const samples = currentRateSamples(
          historyRows.filter((row) => Date.parse(row.observedAt) >= now - 3600_000),
          window.resetsAt,
          capacityMaxAge(provider),
        );
        const from = samples[0]?.observedAt ?? null,
          to = samples.at(-1)?.observedAt ?? null;
        const hours = from && to ? (Date.parse(to) - Date.parse(from)) / 3600_000 : 0;
        for (const project of projects) {
          const estimatedPercent = samples
            .slice(1)
            .flatMap((row) => row.allocations)
            .filter((item) => item.projectId === project.id)
            .reduce((sum, item) => sum + item.percent, 0);
          const history = rateHistory(historyRows, project.id, now, capacityMaxAge(provider));
          const caps = budgets.filter(
            (b) =>
              b.projectId === project.id &&
              !b.taskId &&
              b.provider === provider &&
              b.windowId === window.id &&
              b.period === 'hour' &&
              b.enabled,
          );
          rates.push({
            projectId: project.id,
            provider,
            windowId: window.id,
            label: window.label,
            resetsAt: window.resetsAt,
            from,
            to,
            estimatedPercentPerHour:
              hours >= 5 / 60 && !samples.slice(1).some((row) => row.unattributed > 0)
                ? estimatedPercent / hours
                : null,
            estimatedPercent,
            samples: samples.length,
            stale: capacity.stale || capacity.state !== 'ready',
            history,
            historyCoverageMinutes: history.reduce((sum, point) => sum + point.coverageMinutes, 0),
            adaptive: adaptivePace({
              now,
              capacity,
              window,
              policy,
              reservedPercent: reserved,
              projectId: project.id,
              demand,
              weight: (id) => projectWeight(this.store, id),
              hourlyCapPercent: caps.length ? Math.min(...caps.map((b) => b.limitPercent)) : null,
              enforced: this.enforcesPace(provider, window, pacing),
            }),
          });
        }
        const forecast = pacing.find(
          (row) => row.provider === provider && row.windowId === window.id,
        );
        if (!forecast) continue;
        const capped = budgets.filter(
          (b) =>
            !b.taskId &&
            b.provider === provider &&
            b.windowId === window.id &&
            b.period === 'hour' &&
            b.enabled,
        );
        accounts.push({
          provider,
          windowId: window.id,
          label: window.label,
          observedAt: capacity.observedAt,
          remainingPercent: forecast.remainingPercent,
          savedReservePercent: forecast.savedReservePercent ?? forecast.reservePercent,
          effectiveReservePercent: forecast.reservePercent,
          reserveReleased: forecast.reserveReleased,
          resetsAt: window.resetsAt,
          estimatedPercentPerHour: forecast.observedPercentPerHour,
          reserveAt: forecast.reserveAt,
          exhaustionAt: forecast.exhaustionAt,
          resetBeforeReserve: forecast.resetBeforeReserve,
          stale: capacity.stale || capacity.state !== 'ready',
          configuredProjectPercentPerHour: capped.reduce((sum, b) => sum + b.limitPercent, 0),
          uncappedProjects: projects.filter(
            (p) => !p.internal && !capped.some((b) => b.projectId === p.id),
          ).length,
        });
      }
    }
    return projectRatesSchema.parse({
      observedAt: stamp(now),
      historyFrom: stamp(now - 12 * 3600_000),
      historyTruncated: intervals.length >= 12001,
      rates,
      accounts,
      notice:
        'Estimated percentage points of each full reported allowance per hour. Current rates use up to one comparable hour, with at least five minutes of readings. The last 12 hours show only observed coverage; missing, reset and unattributed intervals are gaps. Account forecasts include external activity and are approximate.',
    });
  }
  status(projectId?: string) {
    const all = this.runs().filter((r) => !projectId || r.projectId === projectId);
    const nativeRoots = new Set(all.map((r) => r.nativeRootId).filter(Boolean));
    const totals = new Map<
      string,
      {
        projectId: string;
        agentId: string | null;
        provider: 'codex' | 'claude';
        name: string;
        tokens: TokenCounts;
        measuredRuns: number;
        incompleteRuns: number;
        nativeOverlap: boolean;
      }
    >();
    for (const r of all)
      for (const agentId of r.nativeRootId ? [r.agentId] : [r.agentId, null]) {
        const key = `${r.projectId}:${r.provider}:${agentId ?? 'project'}`;
        const t = totals.get(key) ?? {
          projectId: r.projectId,
          agentId,
          provider: r.provider,
          name: agentId ? this.store.agent(agentId).name : this.store.project(r.projectId).name,
          tokens: { ...unknown },
          measuredRuns: 0,
          incompleteRuns: 0,
          nativeOverlap: !!r.nativeRootId,
        };
        for (const k of Object.keys(unknown) as (keyof TokenCounts)[])
          if (r.tokens[k] !== null) t.tokens[k] = (t.tokens[k] ?? 0) + r.tokens[k]!;
        if (r.basis === 'measured') t.measuredRuns++;
        else t.incompleteRuns++;
        if (!agentId && nativeRoots.has(r.agentId)) t.nativeOverlap = true;
        totals.set(key, t);
      }
    const windows = this.store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'quark:window-total:%'")
      .all()
      .map((row) => windowTotalSchema.parse(JSON.parse(String(row.value))));
    return quarkStatusSchema.parse({
      settings: this.settings(),
      since: this.store.getSetting('quark:since'),
      budgets: this.budgets()
        .filter((b) => !projectId || b.projectId === projectId)
        .map((b) => {
          const { cause: _cause, ...status } = this.budgetStatus(b);
          return status;
        }),
      holds: this.holds().filter((h) => !projectId || h.projectId === projectId),
      runs: all
        .slice(-200)
        .reverse()
        .map((r) => ({
          ...r,
          agentName: this.store.agent(r.agentId).name,
          projectName: this.store.project(r.projectId).name,
          status: this.store.run(r.runId).status,
        })),
      omittedRuns: Math.max(0, all.length - 200),
      totals: [...totals.values()],
      windows: windows.map((w) => ({
        ...w,
        projects: Object.entries(w.projects)
          .filter(([id]) => !projectId || id === projectId)
          .map(([id, estimatedPercent]) => ({
            projectId: id,
            name: this.store.project(id).name,
            estimatedPercent,
          })),
      })),
      cache: this.cacheStatus().filter(
        (c) => !projectId || this.store.agent(c.agentId).projectId === projectId,
      ),
      notice:
        'Tokens are provider evidence; allowance shares use weighted tokens or elapsed-work estimates across one computer. Concurrent external usage may be attributed to active work. Unobserved intervals remain unattributed. Accuracy within 2–3 percentage points is not yet validated. Native-child counters are shown separately and excluded from rollups because overlap is unverified. Cache timers are estimates, never a promise of cache retention. Pauses preserve files/history. Temporary monitoring or capacity pauses can recover after a confirmed stop and fresh capacity; budget and explicit pauses need owner continuation. In-flight requests can overshoot.',
    });
  }
}
