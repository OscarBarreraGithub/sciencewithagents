import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  defaultModelPolicy,
  quarkProjectPolicySchema,
  modelPolicySchema,
  jobEstimateSchema,
  pulsarPolicySchema,
  pulsarPolicyUpdateSchema,
  pulsarStatusSchema,
  jobControlSchema,
  tokenUsageSnapshotSchema,
  type PulsarStatus,
  type JobEstimate,
  type MachineCapacity,
  type LocalJob,
  type LocalResources,
} from '@dock/shared';
import { Conflict, Store, type PrivateRun } from './store.js';
import { readCapacity } from './capacity.js';
import { localJobPriority } from './local-jobs.js';

const leaseSchema = z.object({
  runId: z.string(),
  provider: z.enum(['codex', 'claude']),
  managerId: z.string(),
  taskId: z.string().nullable(),
  model: z.string().nullable(),
  estimate: jobEstimateSchema,
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
    return pulsarPolicySchema.parse(this.store.getSetting('pulsar:policy') ?? {});
  }
  savePolicy(raw: unknown) {
    const input = pulsarPolicyUpdateSchema.parse(raw);
    return this.store.operation(input.key, { kind: 'pulsar.policy', ...input }, () => {
      this.store.setSetting('pulsar:policy', input.policy);
      this.store.event('pulsar.policy', null, null, input.policy);
      return input.policy;
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
    const project = quarkProjectPolicySchema.parse(
      this.store.getSetting(`quark:project:${this.store.agent(run.agentId).projectId}`) ?? {},
    );
    return jobEstimateSchema.parse({
      ...(task?.scheduling ?? {}),
      ...(project.priority !== null ? { priority: project.priority } : {}),
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
  examples() {
    return this.leases()
      .filter((l) => l.finishedAt)
      .slice(-8)
      .reverse()
      .map((l) => ({
        project: this.store.project(this.store.agent(this.store.run(l.runId).agentId).projectId)
          .name,
        provider: l.provider,
        model: l.model,
        task: l.taskId ? this.store.task(l.taskId).title : 'Manager or unassigned turn',
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
      }));
  }
  /** One owner-requested diagnosis can run alongside the normal work slots. */
  isInteractiveDiagnostic(run: PrivateRun) {
    return (
      ['user', 'resume'].includes(run.kind) &&
      this.store.agent(run.agentId).resourceAssistant?.mode === 'interactive'
    );
  }
  ordered(runs: PrivateRun[]) {
    if (!this.policy().enabled)
      return [...runs].sort(
        (a, b) =>
          Number(this.isInteractiveDiagnostic(b)) - Number(this.isInteractiveDiagnostic(a)) ||
          rank[this.estimate(b).priority] - rank[this.estimate(a).priority] ||
          this.projectWeight(b) - this.projectWeight(a),
      );
    return [...runs].sort(
      (a, b) =>
        Number(this.isInteractiveDiagnostic(b)) - Number(this.isInteractiveDiagnostic(a)) ||
        rank[this.estimate(b).priority] - rank[this.estimate(a).priority] ||
        this.projectWeight(b) - this.projectWeight(a) ||
        String(this.store.getSetting(`pulsar:last-manager:${this.manager(a)}`) ?? '').localeCompare(
          String(this.store.getSetting(`pulsar:last-manager:${this.manager(b)}`) ?? ''),
        ) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }
  private foregroundWork(except?: string, executing: ReadonlySet<string> = new Set()) {
    return this.store.runs().some((run) => {
      if (run.id === except || this.estimate(run).priority === 'background') return false;
      if (run.status === 'running') return true;
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
    const allowance = this.allowanceDecision(run);
    if (allowance)
      return typeof allowance === 'string' ? reject(allowance) : { eligible: false, ...allowance };
    if (
      this.store.getSetting(`pulsar:held:${run.id}`) === true ||
      (taskId && this.store.getSetting(`pulsar:held-task:${taskId}`) === true)
    )
      return reject(
        'Paused. Release this job to let QUARK reconsider it. Running agent turns finish at their boundary.',
      );
    if (!policy.enabled)
      return {
        eligible: true,
        reason: 'QUARK pacing is off; the existing work queue controls admission.',
      };
    const all = this.leases();
    const active = all.filter(
      (l) =>
        !l.finishedAt &&
        (this.store.run(l.runId).status === 'running' ||
          executing.has(this.store.run(l.runId).agentId)),
    );
    const sameProvider = active.filter((l) => l.provider === agent.provider);
    const diagnostic = this.isInteractiveDiagnostic(run);
    const diagnosticSlot =
      diagnostic && !active.some((l) => this.isInteractiveDiagnostic(this.store.run(l.runId)));
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
    if (taskId) {
      const charged = all
        .filter((l) => l.taskId === taskId && l.runId !== run.id)
        .reduce((n, l) => n + l.tokensCharged, 0);
      const taskBudget = this.store.task(taskId).scheduling.tokenBudget;
      if (charged + estimate.expectedTokens > taskBudget && !override)
        return {
          ...reject(
            `Task token budget: ${charged.toLocaleString()} charged or reserved; this turn estimates ${estimate.expectedTokens.toLocaleString()}. Increase the budget or explicitly override.`,
          ),
          budgetBlock: { kind: 'tokens', targetId: taskId },
        };
    }
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
      let ceiling = estimate.priority === 'interactive' ? 98 : 100 - policy.reservePercent;
      if (estimate.priority === 'background' && window.windowMinutes === 300 && window.resetsAt) {
        const elapsed = Math.max(
          0,
          Math.min(1, 1 - (Date.parse(window.resetsAt) - this.clock()) / (300 * 60_000)),
        );
        ceiling = Math.min(ceiling, 15 + elapsed * (85 - policy.reservePercent));
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
  reconcile() {
    for (const lease of this.leases()) this.settle(lease.runId);
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
  status(projectId?: string) {
    const jobs = this.store
      .runs()
      .filter((r) => ['queued', 'running'].includes(r.status) || !!this.lease(r.id))
      .filter((r) => !projectId || this.store.agent(r.agentId).projectId === projectId)
      .map((run) => {
        const agent = this.store.agent(run.agentId),
          estimate = this.estimate(run),
          lease = this.lease(run.id);
        const taskId = this.taskId(run);
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
          provider: agent.provider,
          status: run.status,
          estimate,
          held,
          override: this.store.getSetting(`pulsar:override:${run.id}`) === true,
          ...decision,
          expectedFinishAt:
            lease && !lease.finishedAt
              ? new Date(
                  Date.parse(lease.startedAt) + estimate.expectedSeconds * 1000,
                ).toISOString()
              : null,
          tokensCharged: lease?.tokensCharged ?? 0,
          tokenBasis: lease?.tokenBasis ?? 'none',
        };
      });
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
