import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  defaultModelPolicy,
  quarkProjectPolicySchema,
  modelPolicySchema,
  jobEstimateSchema,
  pulsarPolicySchema,
  providerReservePolicy,
  effectiveProviderReserve,
  pulsarPolicyUpdateSchema,
  pulsarStatusSchema,
  jobControlSchema,
  jobDetailSchema,
  type JobDetailText,
  tokenUsageSnapshotSchema,
  type PulsarStatus,
  type JobEstimate,
  type MachineCapacity,
  type LocalJob,
  type LocalResources,
} from '@dock/shared';
import { Conflict, Store, type PrivateRun } from './store.js';
import { readCapacity, capacityMaxAge } from './capacity.js';
import { localJobPriority } from './local-jobs.js';
import { chatBypassAllowed } from './quark-chat.js';

const leaseSchema = z.object({
  runId: z.string(),
  provider: z.enum(['codex', 'claude']),
  managerId: z.string(),
  taskId: z.string().nullable(),
  model: z.string().nullable(),
  estimate: jobEstimateSchema,
  estimateBasis: z.enum(['turn', 'task-forecast']).default('task-forecast'),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  baselineTokens: z.number().nullable(),
  tokensCharged: z.number(),
  tokenBasis: z.enum(['measured', 'estimated', 'reserved']),
});
type Lease = z.infer<typeof leaseSchema>;
const rank = { interactive: 3, high: 2, normal: 1, background: 0 };
/** Main calls this before Runtime constructs model policy or starts any collector. */
export function initializeScheduling(store: Store) {
  if (
    store.getSetting('pulsar:policy') ||
    store.getSetting('model-policy') ||
    store.projects().length
  )
    return;
  store.transaction(() => {
    const policy = pulsarPolicySchema.parse({ enabled: true });
    store.setSetting('pulsar:policy', policy);
    store.event('pulsar.initialized', null, null, { enabled: true });
  });
}
export class Pulsar {
  allowanceDecision: (
    run: PrivateRun,
    protectedChat?: boolean,
  ) =>
    | string
    | { reason: string; budgetBlock?: PulsarStatus['jobs'][number]['budgetBlock'] }
    | null = () => null;
  localResources: () => (LocalResources & { id: string })[] = () => [];
  hasForegroundLocal: () => boolean = () => false;
  constructor(
    readonly store: Store,
    private machine: () => MachineCapacity | null,
    private clock = Date.now,
  ) {}
  policy() {
    const policy = pulsarPolicySchema.parse(this.store.getSetting('pulsar:policy') ?? {});
    return {
      ...policy,
      providerReserves: {
        codex: providerReservePolicy(policy, 'codex'),
        claude: providerReservePolicy(policy, 'claude'),
      },
    };
  }
  savePolicy(raw: unknown) {
    const input = pulsarPolicyUpdateSchema.parse(raw);
    return this.store.operation(input.key, { kind: 'pulsar.policy', ...input }, () => {
      const current = this.policy();
      if (input.policy.revision !== current.revision)
        throw new Conflict('Shared allowance settings changed. Reload before saving.');
      // A legacy client editing the global field still explicitly adjusts both providers.
      const legacyEdit =
        input.policy.reservePercent !== current.reservePercent &&
        (!input.policy.providerReserves ||
          JSON.stringify(input.policy.providerReserves) ===
            JSON.stringify(current.providerReserves));
      const base = legacyEdit
        ? { ...input.policy, providerReserves: undefined }
        : {
            ...input.policy,
            providerReserves: input.policy.providerReserves ?? current.providerReserves,
          };
      const policy = {
        ...input.policy,
        revision: current.revision + 1,
        providerReserves: {
          codex: providerReservePolicy(base, 'codex'),
          claude: providerReservePolicy(base, 'claude'),
        },
      };
      this.store.setSetting('pulsar:policy', policy);
      this.store.event('pulsar.policy', null, null, policy);
      return policy;
    });
  }
  private leases(): Lease[] {
    return this.store.db
      .prepare('SELECT body FROM pulsar_leases')
      .all()
      .map((row) => leaseSchema.parse(JSON.parse(String(row.body))));
  }
  private lease(runId: string): Lease | null {
    const row = this.store.db.prepare('SELECT body FROM pulsar_leases WHERE run_id=?').get(runId);
    return row ? leaseSchema.parse(JSON.parse(String(row.body))) : null;
  }
  hasReservation(runId: string) {
    return this.lease(runId) !== null;
  }
  /** Includes admitted jobs awaiting provider startup; no second reservation ledger. */
  allowanceReservations(since: number) {
    return this.store.db
      .prepare(
        "SELECT body FROM pulsar_leases WHERE json_extract(body,'$.finishedAt') IS NULL OR json_extract(body,'$.finishedAt')>?",
      )
      .all(new Date(since).toISOString())
      .map((row) => leaseSchema.parse(JSON.parse(String(row.body))));
  }
  private saveLease(lease: Lease) {
    this.store.db
      .prepare(
        'INSERT INTO pulsar_leases(run_id,body) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body',
      )
      .run(lease.runId, JSON.stringify(lease));
  }
  private taskId(run: PrivateRun): string | null {
    const agent = this.store.agent(run.agentId);
    if (agent.taskId) return agent.taskId;
    const source = run.sourceId ? this.store.agent(run.sourceId) : null;
    if (source?.projectId === agent.projectId && source.taskId) return source.taskId;
    const saved = this.store.getSetting(`pulsar:task:${run.id}`);
    return typeof saved === 'string' && this.store.task(saved).projectId === agent.projectId
      ? saved
      : null;
  }
  estimate(run: PrivateRun): JobEstimate {
    // Changing a project priority affects future admission, not the admitted turn's record.
    const admitted = this.lease(run.id);
    if (admitted && run.status !== 'queued') return admitted.estimate;
    const saved = this.store.getSetting(`pulsar:estimate:${run.id}`);
    if (saved) return jobEstimateSchema.parse(saved);
    const taskId = this.taskId(run);
    const task = taskId ? this.store.task(taskId) : null;
    const agent = this.store.agent(run.agentId);
    const project = quarkProjectPolicySchema.parse(
      this.store.getSetting(`quark:project:${this.store.agent(run.agentId).projectId}`) ?? {},
    );
    return jobEstimateSchema.parse({
      // A task forecast is not the cost of every coordination reply. Managers
      // can reassess or delegate in a bounded turn, charged to the same task.
      // Explicit per-run estimates above still describe deliberate larger turns.
      ...(agent.role === 'manager' && !agent.nativeRootId
        ? {
            priority: task?.scheduling.priority ?? 'normal',
            expectedTokens: 4000,
            quotaPercent: 0.5,
            expectedSeconds: 120,
            estimateNote:
              'Bounded manager coordination starter estimate, not a whole-task forecast or a guaranteed ceiling. Actual usage remains supervised and charged to its task/project.',
          }
        : (task?.scheduling ?? {})),
      ...(project.priority !== null ? { priority: project.priority } : {}),
      ...(task?.ownerTicket ? { priority: 'background' } : {}),
      ...(['user', 'resume'].includes(run.kind) ? { priority: 'interactive' } : {}),
    });
  }
  private manager(run: PrivateRun) {
    const agent = this.store.agent(run.agentId);
    const taskId = this.taskId(run);
    return taskId
      ? this.store.task(taskId).managerId
      : agent.role === 'manager'
        ? agent.id
        : (agent.parentId ?? agent.id);
  }
  projectWeight(run: PrivateRun) {
    return quarkProjectPolicySchema.parse(
      this.store.getSetting(`quark:project:${this.store.agent(run.agentId).projectId}`) ?? {},
    ).weight;
  }
  examples(target?: {
    projectId: string;
    provider: 'codex' | 'claude';
    model: string | null;
    taskId?: string | null;
  }) {
    const candidates = this.store.db
      .prepare(
        "SELECT body FROM pulsar_leases WHERE json_extract(body,'$.finishedAt') IS NOT NULL ORDER BY json_extract(body,'$.finishedAt') DESC, rowid DESC LIMIT 100",
      )
      .all()
      .map((row) => {
        const lease = leaseSchema.parse(JSON.parse(String(row.body)));
        const run = this.store.run(lease.runId),
          agent = this.store.agent(run.agentId);
        const comparison = target
          ? {
              sameTask: !!target.taskId && lease.taskId === target.taskId,
              sameProject: agent.projectId === target.projectId,
              sameProvider: lease.provider === target.provider,
              sameModel: !!target.model && lease.model === target.model,
            }
          : null;
        const score = comparison
          ? Number(comparison.sameTask) * 8 +
            Number(comparison.sameProject) * 4 +
            Number(comparison.sameModel) * 2 +
            Number(comparison.sameProvider)
          : 0;
        return { lease, run, agent, comparison, score };
      })
      .sort((a, b) => b.score - a.score);
    // Prefer comparable work while retaining provider/model variety. Never
    // present only the most recent unrelated turn as a universal forecast.
    const selected: typeof candidates = [],
      groups = new Map<string, number>();
    for (const candidate of candidates) {
      const group = `${candidate.lease.provider}:${candidate.lease.model}:${candidate.agent.role}`;
      if ((groups.get(group) ?? 0) >= 2) continue;
      selected.push(candidate);
      groups.set(group, (groups.get(group) ?? 0) + 1);
      if (selected.length === 8) break;
    }
    for (const candidate of candidates) {
      if (selected.length === 8) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }
    return selected.map(({ lease: l, run, agent, comparison }) => ({
      project: this.store.project(agent.projectId).name,
      provider: l.provider,
      model: l.model,
      task: l.taskId ? this.store.task(l.taskId).title : 'Manager or unassigned turn',
      role: agent.role,
      turnKind: run.kind,
      comparison,
      estimateBasis: l.estimateBasis,
      estimateNote: l.estimate.estimateNote,
      comparisonNotice:
        l.estimateBasis === 'turn'
          ? 'Compare with similar individual turns, not whole-task elapsed time.'
          : 'Inherited task forecast (legacy source may be unknown); do not treat its difference from one turn as forecast error.',
      durationBasis:
        'Admitted wall time including provider/tool/permission waits; excludes prior queue time.',
      estimatedSeconds: l.estimate.expectedSeconds,
      actualSeconds: Math.max(
        0,
        Math.round((Date.parse(l.finishedAt!) - Date.parse(l.startedAt)) / 1000),
      ),
      expectedTokens: l.estimate.expectedTokens,
      tokens: l.tokensCharged,
      tokenBasis: l.tokenBasis,
      estimatedAllowancePercent: l.estimate.quotaPercent,
      attributedAllowance: this.store.db
        .prepare(
          "SELECT json_extract(i.body,'$.windowId') AS windowId, json_extract(i.body,'$.label') AS label, SUM(json_extract(a.value,'$.percent')) AS percent, MAX(json_extract(i.body,'$.observedAt')) AS observedAt FROM quark_intervals i INDEXED BY quark_intervals_observed, json_each(i.body,'$.allocations') a WHERE json_extract(i.body,'$.observedAt')>=? AND json_extract(i.body,'$.observedAt')<=? AND json_extract(i.body,'$.provider')=? AND json_extract(a.value,'$.runId')=? GROUP BY windowId,label",
        )
        .all(
          l.startedAt,
          new Date(Date.parse(l.finishedAt!) + capacityMaxAge(l.provider) + 120_000).toISOString(),
          l.provider,
          l.runId,
        ),
      allowanceBasis:
        'Estimated attribution of reported allowance changes; delayed observations can still arrive. No row means unavailable, not zero.',
    }));
  }
  /** One owner-requested diagnosis can run alongside the normal work slots. */
  isInteractiveDiagnostic(run: PrivateRun) {
    return (
      ['user', 'resume'].includes(run.kind) &&
      this.store.agent(run.agentId).resourceAssistant?.mode === 'interactive'
    );
  }
  isUrgentDiagnostic(run: PrivateRun) {
    return (
      this.isInteractiveDiagnostic(run) ||
      this.store.agent(run.agentId).resourceAssistant?.reason === 'pressure'
    );
  }
  ordered(runs: PrivateRun[]) {
    if (!this.policy().enabled)
      return [...runs].sort(
        (a, b) =>
          Number(this.isInteractiveDiagnostic(b)) - Number(this.isInteractiveDiagnostic(a)) ||
          rank[this.estimate(b).priority] - rank[this.estimate(a).priority] ||
          this.backgroundScore(b) - this.backgroundScore(a) ||
          this.projectWeight(b) - this.projectWeight(a),
      );
    return [...runs].sort(
      (a, b) =>
        Number(this.isInteractiveDiagnostic(b)) - Number(this.isInteractiveDiagnostic(a)) ||
        rank[this.estimate(b).priority] - rank[this.estimate(a).priority] ||
        this.backgroundScore(b) - this.backgroundScore(a) ||
        this.projectWeight(b) - this.projectWeight(a) ||
        String(this.store.getSetting(`pulsar:last-manager:${this.manager(a)}`) ?? '').localeCompare(
          String(this.store.getSetting(`pulsar:last-manager:${this.manager(b)}`) ?? ''),
        ) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }
  /** Relative effort is a queue hint, never a provider allowance or CPU entitlement. */
  private backgroundScore(run: PrivateRun) {
    if (this.estimate(run).priority !== 'background') return 0;
    const taskId = this.taskId(run);
    const ticket = taskId ? this.store.task(taskId).ownerTicket : undefined;
    const ageHours = Math.max(0, (this.clock() - Date.parse(run.createdAt)) / 3600_000);
    return (
      (ticket?.priority ?? 3) * 20 - (ticket?.estimatedCompute ?? 3) * 2 + Math.min(ageHours, 168)
    );
  }
  private foregroundWork(except?: string, executing: ReadonlySet<string> = new Set()) {
    const agentId = except ? this.store.run(except).agentId : null;
    return this.store.runs(['queued', 'running']).some((run) => {
      if (run.id === except || this.estimate(run).priority === 'background') return false;
      if (run.status === 'running') return true;
      // Runtime selects one input per conversation; queued peers cannot contend
      // with that input for foreground admission. Global demand still sees them.
      if (run.agentId === agentId) return false;
      if (
        run.status !== 'queued' ||
        ['waiting', 'interrupted', 'failed'].includes(this.store.agent(run.agentId).status)
      )
        return false;
      // Non-background decisions never call foregroundWork; this cannot recurse.
      return this.decision(run, executing, true).eligible;
    });
  }
  wantsForeground(executing: ReadonlySet<string>) {
    return this.foregroundWork(undefined, executing) || this.hasForegroundLocal();
  }
  decision(
    run: PrivateRun,
    executing: ReadonlySet<string> = new Set(),
    preparingPreemption = false,
    protectedChat = false,
  ): {
    eligible: boolean;
    reason: string;
    budgetBlock?: PulsarStatus['jobs'][number]['budgetBlock'];
  } {
    const estimate = this.estimate(run),
      policy = this.policy();
    const agent = this.store.agent(run.agentId);
    const taskId = this.taskId(run);
    const reject = (reason: string) => ({ eligible: false, reason });
    if (run.queueEdit)
      return reject('Held for editing. Explicitly return this message to the queue when ready.');
    const modelWait = this.store.getSetting(`model-policy:wait:${run.id}`) as number | undefined;
    if (run.status === 'queued' && modelWait && modelWait > this.clock())
      return reject(
        'Model discovery is temporarily unavailable. Your message is saved; QUARK will retry automatically.',
      );
    const allowance = this.allowanceDecision(run, protectedChat);
    if (allowance)
      return typeof allowance === 'string' ? reject(allowance) : { eligible: false, ...allowance };
    if (
      this.store.getSetting(`pulsar:held:${run.id}`) === true ||
      (taskId && this.store.getSetting(`pulsar:held-task:${taskId}`) === true)
    )
      return reject(
        'Paused. Release this job to let QUARK reconsider it. Running agent turns finish at their boundary.',
      );
    if (!protectedChat && chatBypassAllowed(this.store, run))
      return {
        eligible: true,
        reason:
          'Owner chat bypass: direct conversation only. Protected work still requires ordinary QUARK admission.',
      };
    if (!policy.enabled)
      return {
        eligible: true,
        reason: 'QUARK pacing is off; the existing work queue controls admission.',
      };
    // Rechecking this admitted chat needs no second reservation or provider slot.
    const all = this.leases().filter((lease) => !protectedChat || lease.runId !== run.id);
    const active = all.filter(
      (l) =>
        !l.finishedAt &&
        (this.store.run(l.runId).status === 'running' ||
          executing.has(this.store.run(l.runId).agentId)),
    );
    const sameProvider = active.filter((l) => l.provider === agent.provider);
    const diagnostic = this.isUrgentDiagnostic(run);
    const diagnosticSlot =
      diagnostic && !active.some((l) => this.isUrgentDiagnostic(this.store.run(l.runId)));
    if (
      sameProvider.length >=
      (agent.provider === 'claude' ? policy.claudeConcurrent : policy.codexConcurrent) +
        Number(diagnosticSlot)
    )
      return reject(
        `Waiting for the shared ${agent.provider === 'claude' ? 'Claude' : 'Codex'} worker slot.`,
      );
    // Owner override is explicit per queued job, never an account/permission/approval bypass.
    const override = this.store.getSetting(`pulsar:override:${run.id}`) === true;
    // Token counters (including repeated cached context) are accounting evidence,
    // not subscription allowance. Legacy tokenBudget remains readable, never a gate.
    // Explicit allowance caps are enforced above by allowanceDecision, even with pacing off.
    if (estimate.priority === 'background' && !override) {
      const foreground = this.foregroundWork(run.id, executing);
      if (foreground || this.hasForegroundLocal())
        return reject('Background work is yielding to active or queued higher-priority work.');
      const last = Number(this.store.getSetting(`pulsar:last-background:${agent.provider}`) ?? 0);
      if (this.clock() - last < policy.backgroundGapSeconds * 1000)
        return reject('Pacing background work between turns to preserve capacity.');
    }
    const resource = this.resourceDecision(estimate, override, active, undefined, diagnostic);
    if (!resource.eligible && !preparingPreemption) return resource;
    const capacity = readCapacity(this.store, agent.provider, this.clock());
    const windows = capacity.windows.filter(
      (w) =>
        w.scope === 'general' ||
        (w.scope === 'model' && w.model && agent.model?.toLowerCase().includes(w.model)),
    );
    // An override may accept an unknown reading, but cannot erase a known
    // exhausted window or assume that an elapsed reset has refilled it.
    for (const window of windows) {
      if (window.resetsAt && Date.parse(window.resetsAt) <= this.clock())
        return reject(
          'A reset time has passed. Waiting for a new provider report before assuming renewed capacity.',
        );
      if (window.usedPercent >= 100)
        return reject(
          `${window.label} allowance is exhausted; native limits cannot be overridden.`,
        );
    }
    if (capacity.stale || capacity.state !== 'ready')
      return override
        ? {
            eligible: true,
            reason:
              'Owner override accepts unknown allowance for this turn; native limits still apply.',
          }
        : reject(
            'Waiting for fresh shared usage; missing or stale allowance is not spare capacity.',
          );
    if (!windows.length && !override) return reject('No verified allowance matches this model.');
    const models = modelPolicySchema.parse(
      this.store.getSetting('model-policy') ?? defaultModelPolicy,
    ).models[agent.provider];
    const independent = Object.values(models).find(
      (choice) =>
        choice.requiresModelAllowance &&
        !!agent.model &&
        (choice.model === agent.model ||
          agent.model?.toLowerCase().includes(choice.family.toLowerCase())),
    );
    if (
      independent &&
      !windows.some((w) => w.scope === 'model' && w.model === independent.family.toLowerCase()) &&
      !override
    )
      return reject(
        `Waiting for a verified ${independent.family} allowance; an absent model meter is not extra capacity.`,
      );
    for (const window of windows) {
      // Retain finished reservations until a later poll can observe their effects.
      const reserved = all
        .filter(
          (l) =>
            l.provider === agent.provider &&
            (!l.finishedAt ||
              !capacity.observedAt ||
              Date.parse(l.finishedAt) + 30_000 > Date.parse(capacity.observedAt)),
        )
        .filter(
          (l) =>
            window.scope !== 'model' ||
            (!!window.model && l.model?.toLowerCase().includes(window.model)),
        )
        .reduce((n, l) => n + l.estimate.quotaPercent, 0);
      const reserve = effectiveProviderReserve(
        policy,
        capacity,
        window,
        this.clock(),
      ).effectivePercent;
      let ceiling = 100 - reserve;
      if (
        estimate.priority === 'background' &&
        window.windowMinutes === 300 &&
        window.resetsAt &&
        !(agent.provider === 'claude' && policy.maximizeClaudeFiveHour)
      ) {
        const elapsed = Math.max(
          0,
          Math.min(1, 1 - (Date.parse(window.resetsAt) - this.clock()) / (300 * 60_000)),
        );
        ceiling = Math.min(ceiling, 15 + elapsed * (85 - reserve));
      }
      if (!override && window.usedPercent + reserved + estimate.quotaPercent > ceiling)
        return reject(
          `${window.label}: protecting headroom (${Math.round(window.usedPercent)}% used, ${reserved.toFixed(1)}% reserved). Waiting for capacity or the next verified reset.`,
        );
    }
    return {
      eligible: true,
      reason: override
        ? 'Owner scheduling override for this turn; original approvals and limits still apply.'
        : 'Capacity reserved at admission; ready for the next available work slot.',
    };
  }
  reserve(run: PrivateRun, executing: ReadonlySet<string>, withinTransaction = false) {
    const save = () => {
      if (!this.decision(run, executing).eligible) return false;
      if (this.lease(run.id)) return true;
      const agent = this.store.agent(run.agentId),
        estimate = this.estimate(run);
      const startedAt = new Date(this.clock()).toISOString();
      this.saveLease({
        runId: run.id,
        provider: agent.provider,
        managerId: this.manager(run),
        taskId: this.taskId(run),
        model: agent.model,
        estimate,
        estimateBasis:
          this.store.getSetting(`pulsar:estimate:${run.id}`) || agent.role === 'manager'
            ? 'turn'
            : 'task-forecast',
        startedAt,
        finishedAt: null,
        baselineTokens: agent.threadId ? (this.tokens(run)?.total.totalTokens ?? null) : 0,
        tokensCharged: estimate.expectedTokens,
        tokenBasis: 'reserved',
      });
      this.store.setSetting(`pulsar:last-manager:${this.manager(run)}`, startedAt);
      if (estimate.priority === 'background')
        this.store.setSetting(`pulsar:last-background:${agent.provider}`, this.clock());
      this.store.event('pulsar.admitted', agent.projectId, agent.id, { runId: run.id, estimate });
      return true;
    };
    return withinTransaction ? save() : this.store.transaction(save);
  }
  private resourceDecision(
    estimate: Pick<JobEstimate, 'cpuCores' | 'memoryMb'>,
    override: boolean,
    active: Lease[],
    localId?: string,
    diagnostic = false,
  ) {
    const reject = (reason: string) => ({ eligible: false, reason });
    if (!this.policy().enabled || override)
      return { eligible: true, reason: 'Capacity pacing overridden or disabled.' };
    const machine = this.machine(),
      policy = this.policy();
    if (!machine || this.clock() - Date.parse(machine.observedAt) > 30_000)
      return reject('Waiting for a fresh computer-capacity reading.');
    const reservedCores =
      active.reduce((n, l) => n + l.estimate.cpuCores, 0) +
      this.localResources()
        .filter((r) => r.id !== localId)
        .reduce((n, r) => n + r.cpuCores, 0);
    const occupiedCores = ((machine.cpuUsedPercent ?? 100) * machine.cpuCount) / 100;
    if (
      !diagnostic &&
      Math.max(reservedCores, occupiedCores) + estimate.cpuCores >
        (machine.cpuCount * policy.maxCpuPercent) / 100
    )
      return reject('Waiting for CPU headroom; other computer activity is included.');
    const reservedMemory =
      active.reduce((n, l) => n + l.estimate.memoryMb, 0) +
      this.localResources()
        .filter((r) => r.id !== localId)
        .reduce((n, r) => n + r.memoryMb, 0);
    if (
      machine.memoryAvailableBytes <
      (reservedMemory + estimate.memoryMb + policy.memoryReserveMb) * 1024 ** 2
    )
      return reject(
        'Waiting for available memory after existing reservations and the computer’s reserve.',
      );
    if (machine.diskAvailableBytes === null || machine.diskAvailableBytes < 512 * 1024 ** 2)
      return reject('Waiting for a verified minimum of 512 MB free disk space.');
    return { eligible: true, reason: 'Computer capacity is available.' };
  }
  localDecision(job: LocalJob, executing: ReadonlySet<string>) {
    if (
      job.projectId &&
      quarkProjectPolicySchema.parse(this.store.getSetting(`quark:project:${job.projectId}`) ?? {})
        .paused
    )
      return { eligible: false, reason: 'This project is paused by a saved QUARK decision.' };
    const override = this.store.getSetting(`localjob:override:${job.id}`) === true;
    if (
      this.policy().enabled &&
      localJobPriority(this.store, job) === 'background' &&
      !override &&
      this.foregroundWork(undefined, executing)
    )
      return {
        eligible: false,
        reason: 'Background transcription is yielding to active agent work.',
      };
    const active = this.leases().filter(
      (l) =>
        !l.finishedAt &&
        (this.store.run(l.runId).status === 'running' ||
          executing.has(this.store.run(l.runId).agentId)),
    );
    return this.resourceDecision(
      { ...job.resources, memoryMb: job.status === 'paused' ? 0 : job.resources.memoryMb },
      override,
      active,
      job.id,
    );
  }
  private tokens(run: PrivateRun) {
    const agent = this.store.agent(run.agentId);
    if (!agent.threadId) return null;
    const hash = createHash('sha256').update(JSON.stringify(agent.threadId)).digest('hex');
    const parsed = tokenUsageSnapshotSchema.safeParse(
      this.store.getSetting(`usage:v1:tokens:${agent.provider}:${agent.id}:${hash}`),
    );
    return parsed.success ? parsed.data : null;
  }
  settle(runId: string) {
    const lease = this.lease(runId);
    if (!lease) return;
    if (lease.finishedAt && lease.tokenBasis === 'measured') return;
    const run = this.store.run(runId);
    if (['queued', 'running'].includes(run.status)) return;
    const snapshot = this.tokens(run);
    let measured: number | null = null;
    if (snapshot?.runId === run.id) {
      if (
        lease.provider === 'codex' &&
        snapshot.total.totalTokens !== null &&
        lease.baselineTokens !== null
      )
        measured = Math.max(0, snapshot.total.totalTokens - (lease.baselineTokens ?? 0));
      else if (
        lease.provider === 'claude' &&
        snapshot.last.inputTokens !== null &&
        snapshot.last.outputTokens !== null
      )
        measured =
          snapshot.last.inputTokens +
          snapshot.last.outputTokens +
          (snapshot.last.cachedInputTokens ?? 0) +
          (snapshot.last.cacheWriteInputTokens ?? 0);
    }
    if (
      lease.finishedAt &&
      lease.tokensCharged === (measured ?? lease.estimate.expectedTokens) &&
      lease.tokenBasis === (measured === null ? 'estimated' : 'measured')
    )
      return;
    this.saveLease({
      ...lease,
      finishedAt: lease.finishedAt ?? new Date(this.clock()).toISOString(),
      tokensCharged: measured ?? lease.estimate.expectedTokens,
      tokenBasis: measured === null ? 'estimated' : 'measured',
    });
  }
  reconcile(agentId?: string | null) {
    const rows = this.store.db
      .prepare(
        `SELECT l.run_id FROM pulsar_leases l JOIN runs r ON r.id=l.run_id
      WHERE (json_extract(l.body,'$.finishedAt') IS NULL OR COALESCE(json_extract(l.body,'$.tokenBasis'),'reserved')!='measured')
      ${agentId ? 'AND r.agent_id=?' : ''}`,
      )
      .all(...(agentId ? [agentId] : []));
    for (const row of rows) this.settle(String(row.run_id));
  }
  control(raw: unknown) {
    const input = jobControlSchema.parse(raw);
    return this.store.operation(input.key, { kind: 'pulsar.control', ...input }, () => {
      const run = this.store.run(input.runId),
        agent = this.store.agent(run.agentId);
      const taskId = this.taskId(run);
      if (!['queued', 'running'].includes(run.status))
        throw new Conflict('This job has ended. Its history remains available.');
      if (run.status === 'running' && !['hold', 'release'].includes(input.action))
        throw new Conflict(
          'This turn has started. Open its conversation to stop the exact reply; never replay it automatically.',
        );
      if (input.action === 'hold' || input.action === 'release') {
        this.store.setSetting(`pulsar:held:${run.id}`, input.action === 'hold');
        if (taskId) this.store.setSetting(`pulsar:held-task:${taskId}`, input.action === 'hold');
      }
      if (input.action === 'configure') {
        this.store.setSetting(`pulsar:estimate:${run.id}`, input.estimate);
        if (taskId) this.store.updateTask(taskId, { scheduling: input.estimate });
      }
      if (input.action === 'override') this.store.setSetting(`pulsar:override:${run.id}`, true);
      if (input.action === 'cancel') {
        this.store.updateRun(run.id, { status: 'cancelled' });
        if (
          !this.store
            .runs()
            .some((r) => r.agentId === agent.id && ['running', 'queued'].includes(r.status))
        )
          this.store.updateAgent(agent.id, { status: 'idle' });
      }
      this.store.event('pulsar.control', agent.projectId, agent.id, {
        runId: run.id,
        action: input.action,
      });
      return { saved: true };
    });
  }
  private statusRow(run: PrivateRun) {
    const agent = this.store.agent(run.agentId),
      estimate = this.estimate(run),
      lease = this.lease(run.id);
    const taskId = lease ? lease.taskId : this.taskId(run);
    const held =
      this.store.getSetting(`pulsar:held:${run.id}`) === true ||
      (!!taskId && this.store.getSetting(`pulsar:held-task:${taskId}`) === true);
    const ended = !['queued', 'running'].includes(run.status);
    const runningAllowance = run.status === 'running' ? this.allowanceDecision(run) : null;
    const runningBlock =
      typeof runningAllowance === 'string' ? runningAllowance : runningAllowance?.reason;
    const decision = ended
      ? {
          eligible: false,
          reason: `Turn ${run.status}. History and original conversation are retained.`,
        }
      : run.status === 'running'
        ? {
            eligible: !runningBlock,
            reason:
              runningBlock ??
              (held
                ? 'Finishing this turn; following task turns are paused.'
                : 'Running with shared QUARK monitoring.'),
          }
        : this.decision(run);
    return {
      runId: run.id,
      agentId: agent.id,
      taskId,
      projectName: this.store.project(agent.projectId).name,
      agentName: agent.name,
      provider: lease?.provider ?? agent.provider,
      status: run.status,
      estimate,
      held,
      override: this.store.getSetting(`pulsar:override:${run.id}`) === true,
      ...decision,
      expectedFinishAt:
        lease && !lease.finishedAt
          ? new Date(Date.parse(lease.startedAt) + estimate.expectedSeconds * 1000).toISOString()
          : null,
      tokensCharged: lease?.tokensCharged ?? 0,
      tokenBasis: lease?.tokenBasis ?? 'none',
    };
  }
  /** Direct saved lookup, including jobs outside the recent queue and without a lease. */
  jobDetail(runId: string) {
    const run = this.store.run(z.string().uuid().parse(runId));
    const agent = this.store.agent(run.agentId);
    const lease = this.lease(run.id);
    const job = this.statusRow(run);
    const task = job.taskId ? this.store.task(job.taskId) : null;
    const text = (value: string): JobDetailText => ({
      text: value.slice(0, 8192),
      truncated: value.length > 8192,
    });
    const timestamp = (status: string) => {
      const event = this.store.db
        .prepare(
          `SELECT created_at FROM events WHERE agent_id=? AND type=? AND json_extract(data,'$.id')=? ORDER BY id ${status === 'running' ? 'ASC' : 'DESC'} LIMIT 1`,
        )
        .get(agent.id, `run.${status}`, run.id);
      return event ? String(event.created_at) : null;
    };
    // Only evidence explicitly attributed to this turn; later errors may belong to another run.
    const entries = this.store.db
      .prepare(
        "SELECT body FROM entries WHERE agent_id=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.kind') IN ('assistant','system') ORDER BY rowid DESC LIMIT 4",
      )
      .all(agent.id, run.id)
      .map(
        (row) =>
          JSON.parse(String(row.body)) as {
            id: string;
            kind: 'assistant' | 'system';
            title: string;
            text: string;
            createdAt: string;
          },
      );
    const runStartedAt = timestamp('running');
    const approval =
      run.status === 'running' &&
      agent.status === 'waiting' &&
      (!run.turnId || !agent.turnId || run.turnId === agent.turnId)
        ? this.store.db
            .prepare(
              "SELECT body FROM approvals WHERE agent_id=? AND json_extract(body,'$.status')='pending' AND json_extract(body,'$.createdAt')>=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(agent.id, runStartedAt ?? lease?.startedAt ?? run.createdAt)
        : null;
    const waiting = approval
      ? (JSON.parse(String(approval.body)) as { id: string; title: string })
      : null;
    return jobDetailSchema.parse({
      job: waiting
        ? { ...job, eligible: false, reason: 'Waiting for your answer in the conversation.' }
        : job,
      projectId: agent.projectId,
      request: text(run.text),
      kind: run.kind,
      createdAt: run.createdAt,
      startedAt: lease?.startedAt ?? runStartedAt,
      finishedAt: ['queued', 'running'].includes(run.status)
        ? null
        : (lease?.finishedAt ?? timestamp(run.status)),
      worker: {
        role: agent.role,
        status: agent.status,
        model: (lease ? lease.model : agent.model)?.slice(0, 500) ?? null,
        modelBasis: lease ? 'admission' : 'current',
      },
      task: task
        ? {
            id: task.id,
            title: task.title.slice(0, 500),
            status: task.status,
            goal: text(task.goal),
            acceptance: text(task.acceptance),
            review: task.review ? text(task.review) : null,
            closure: task.closure
              ? { reason: text(task.closure.reason), closedAt: task.closure.closedAt }
              : null,
          }
        : null,
      queueHold: run.status === 'queued' ? (run.queueEdit?.state ?? null) : null,
      approval: waiting ? { id: waiting.id, title: waiting.title.slice(0, 500) } : null,
      outcome: entries
        .slice(0, 3)
        .reverse()
        .map((entry) => ({
          id: entry.id.slice(0, 500),
          kind: entry.kind,
          title: entry.title.slice(0, 500),
          text: text(entry.text),
          createdAt: entry.createdAt,
        })),
      moreOutcome: entries.length > 3,
    });
  }
  status(projectId?: string) {
    const scope = projectId ? 'AND a.project_id=?' : '';
    const args = projectId ? [projectId] : [];
    const active = this.store.db
      .prepare(
        `SELECT r.body FROM runs r JOIN agents a ON a.id=r.agent_id
      WHERE r.status IN ('queued','running') ${scope} ORDER BY r.rowid`,
      )
      .all(...args);
    const history = this.store.db
      .prepare(
        `SELECT r.body FROM runs r JOIN agents a ON a.id=r.agent_id
      JOIN pulsar_leases l ON l.run_id=r.id WHERE r.status NOT IN ('queued','running') ${scope}
      ORDER BY r.rowid DESC LIMIT 30`,
      )
      .all(...args)
      .reverse();
    const jobs = [...active, ...history]
      .map((row) => JSON.parse(String(row.body)) as PrivateRun)
      .map((run) => this.statusRow(run));
    return pulsarStatusSchema.parse({
      name: 'QUARK',
      policy: this.policy(),
      jobs: jobs.filter((j) => ['queued', 'running'].includes(j.status)),
      history: jobs
        .filter((j) => !['queued', 'running'].includes(j.status))
        .slice(-30)
        .reverse(),
      notice:
        'Estimates guide admission; they are not provider-enforced token caps or bills. Running agent turns stop only through their original controls. Background work yields at turn boundaries. Reset times are not permission to replay interrupted actions.',
    });
  }
}
