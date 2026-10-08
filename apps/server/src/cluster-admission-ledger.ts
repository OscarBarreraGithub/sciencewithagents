import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  clusterAdmissionHoldSchema,
  clusterAdmissionStatusSchema,
  clusterLedgerAccountSchema,
  managerModelChoice,
  pulsarPolicySchema,
  taskTiers,
  remoteAccountCapacitySchema,
  remoteAccountIdentitySchema,
  remoteAdmissionCandidateSchema,
  remoteAdmissionGrantSchema,
  remoteAdmissionReceiptSchema,
  remoteRuntimeIdentitySchema,
  tokenCountsSchema,
  type ClusterAdmissionStatus,
  type ClusterLedgerAccount,
  type ModelPolicy,
  type ProviderCapacity,
  type RemoteAccountCapacity,
  type RemoteAccountIdentity,
  type RemoteAdmissionCandidate,
  type RemoteAdmissionGrant,
  type RemoteAdmissionReceipt,
  type RemoteRuntimeIdentity,
} from '@dock/shared';
import { Conflict, Store, type PrivateRun } from './store.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { projectSchedulerKey } from './quark-project.js';

export { clusterLedgerAccountSchema, type ClusterLedgerAccount };
const grantMs = 60_000;
const skewMs = 60_000;
const holdVisibleMs = 10 * 60_000;
const holdRetainMs = 24 * 3600_000;
const basisSchema = z.enum(['measured', 'partial', 'unknown']);
const entrySchema = z.object({
  grant: remoteAdmissionGrantSchema,
  internalRunId: z.uuid(),
  identity: remoteRuntimeIdentitySchema,
  state: z.enum(['granted', 'running', 'complete', 'interrupted', 'failed', 'unused']),
  receipt: z.string().nullable(),
  usage: tokenCountsSchema.nullable(),
  basis: basisSchema,
  settledAt: z.string().nullable(),
});
type Entry = z.infer<typeof entrySchema>;
const recordSchema = z.object({
  candidate: remoteAdmissionCandidateSchema,
  attempts: z.number().int().positive(),
  current: entrySchema,
  // Only grants proven unused are replaced; their receipts stay idempotent.
  history: z.array(entrySchema).max(8),
});
type AdmissionRecord = z.infer<typeof recordSchema>;
type Hold = z.infer<typeof clusterAdmissionHoldSchema>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Stable accounting-run ID per remote run attempt, so repeated holds create no rows. */
const derivedId = (...parts: string[]) => {
  const h = hash(parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const runStatus = {
  complete: 'completed',
  interrupted: 'interrupted',
  failed: 'failed',
} as const;
const terminal = ['complete', 'interrupted', 'failed'] as const;

/** One private accounting store per positively identified remote provider account. */
class AccountLedger {
  readonly pulsar: Pulsar;
  readonly quark: Quark;
  constructor(
    readonly account: ClusterLedgerAccount,
    readonly store: Store,
    clock: () => number,
  ) {
    // No machine reading: remote runtimes own their compute; no Runtime or launcher attached.
    this.pulsar = new Pulsar(store, () => null, clock);
    this.pulsar.remoteCompute = true;
    this.quark = new Quark(store, this.pulsar, clock);
    this.pulsar.allowanceDecision = (run, protectedChat = false) => {
      const block = this.quark.block(run, protectedChat || run.status === 'queued', false, false);
      return block ? { reason: block.reason } : null;
    };
    if (!store.getSetting('pulsar:policy'))
      store.transaction(() => {
        const policy = pulsarPolicySchema.parse({ enabled: false });
        store.setSetting('pulsar:policy', policy);
        store.event('pulsar.initialized', null, null, { enabled: false, cluster: true });
      });
  }
  record(runId: string): AdmissionRecord | null {
    const raw = this.store.getSetting(`cluster:admission:${runId}`);
    return raw ? recordSchema.parse(raw) : null;
  }
  saveRecord(record: AdmissionRecord) {
    this.store.setSetting(`cluster:admission:${record.candidate.runId}`, record);
  }
  query(where: string, suffix = '') {
    return this.store.db
      .prepare(
        `SELECT value FROM settings WHERE key LIKE 'cluster:admission:%' AND ${where} ${suffix}`,
      )
      .all()
      .map((row) => recordSchema.parse(JSON.parse(String(row.value))));
  }
}

export class ClusterAdmissionLedgers {
  private ledgers = new Map<string, AccountLedger>();
  private db: DatabaseSync | null = null;
  private closed = false;
  constructor(
    private root: string,
    private policy: () => ModelPolicy,
    private clock: () => number = Date.now,
  ) {}

  /** Durable index of owned ledger files and current holds; no directory traversal. */
  private index() {
    if (this.closed) throw new Conflict('Cluster admission is closed.');
    if (!this.db) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(join(this.root, 'index.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS accounts (key TEXT PRIMARY KEY, provider TEXT NOT NULL, affinity TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holds (run_id TEXT PRIMARY KEY, provider TEXT NOT NULL, affinity TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);`);
    }
    return this.db;
  }

  private ledger(account: ClusterLedgerAccount, create: boolean) {
    const parsed = clusterLedgerAccountSchema.parse(account);
    const key = `${parsed.provider}-${parsed.affinity}`;
    const cached = this.ledgers.get(key);
    if (cached) return cached;
    const index = this.index();
    const known = index.prepare('SELECT 1 FROM accounts WHERE key=?').get(key);
    // Owner settings never create a ledger; only a verified remote identity can.
    if (!known && !create) throw new Conflict('This cluster account has no admission ledger yet.');
    // Opaque provider + native affinity names the file; the browser never supplies a path.
    const ledger = new AccountLedger(
      parsed,
      new Store(join(this.root, `${key}.sqlite`)),
      this.clock,
    );
    if (!known)
      index
        .prepare('INSERT INTO accounts VALUES(?,?,?,?)')
        .run(key, parsed.provider, parsed.affinity, this.stamp());
    this.ledgers.set(key, ledger);
    return ledger;
  }

  private stamp(at = this.clock()) {
    return new Date(at).toISOString();
  }
  private future(at: string | null, label: string) {
    if (at && Date.parse(at) > this.clock() + skewMs)
      throw new Conflict(`The remote ${label} is in the future; check the cluster clock.`);
  }

  private holdGrant(
    identity: RemoteRuntimeIdentity,
    candidate: RemoteAdmissionCandidate,
    reason: string,
    policyRevision = 'unconfigured',
    decision: 'allow' | 'hold' = 'hold',
  ): RemoteAdmissionGrant {
    return remoteAdmissionGrantSchema.parse({
      id: randomUUID(),
      controllerHostId: identity.controllerHostId,
      remoteHostId: identity.remoteHostId,
      clusterProjectId: identity.clusterProjectId,
      jobId: identity.jobId,
      leaseToken: identity.leaseToken,
      runId: candidate.runId,
      provider: candidate.provider,
      accountAffinity: candidate.accountAffinity,
      requestHash: hash(candidate),
      policyRevision,
      expiresAt: this.stamp(this.clock() + grantMs),
      decision,
      reason: reason.slice(0, 500),
    });
  }

  /** The latest reason replaces an older one; an allow clears it. */
  private recordHold(candidate: RemoteAdmissionCandidate, cause: Hold['cause'], reason: string) {
    const at = this.stamp();
    const body = clusterAdmissionHoldSchema.parse({
      runId: candidate.runId,
      projectId: candidate.projectId,
      cause,
      reason: reason.slice(0, 500),
      at,
    });
    const index = this.index();
    index.prepare('DELETE FROM holds WHERE at<?').run(this.stamp(this.clock() - holdRetainMs));
    index
      .prepare(
        'INSERT INTO holds VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET provider=excluded.provider, affinity=excluded.affinity, body=excluded.body, at=excluded.at',
      )
      .run(
        candidate.runId,
        candidate.provider,
        candidate.accountAffinity,
        JSON.stringify(body),
        at,
      );
  }

  private ensureAccounting(
    ledger: AccountLedger,
    identity: RemoteRuntimeIdentity,
    c: RemoteAdmissionCandidate,
  ) {
    const { store } = ledger;
    const binding = store.getSetting(`cluster:project:${c.projectId}`) as {
      clusterProjectId: string;
      controllerHostId: string;
    } | null;
    if (
      binding &&
      (binding.clusterProjectId !== identity.clusterProjectId ||
        binding.controllerHostId !== identity.controllerHostId)
    )
      throw new Conflict('This remote project is bound to a different cluster project.');
    if (!binding) {
      // Accounting-only rows; there is no local root, manager process or chat.
      const project = {
        id: c.projectId,
        root: `cluster-ledger:${c.projectId}`,
        name: c.projectName,
        description: 'Cluster allowance accounting',
        managerId: c.agentId,
        createdAt: this.stamp(),
      };
      store.db
        .prepare('INSERT INTO projects VALUES(?,?,?)')
        .run(project.id, project.root, JSON.stringify(project));
      store.setSetting(`cluster:project:${c.projectId}`, {
        clusterProjectId: identity.clusterProjectId,
        controllerHostId: identity.controllerHostId,
      });
    }
    const agent = store.db.prepare('SELECT project_id FROM agents WHERE id=?').get(c.agentId);
    if (agent && String(agent.project_id) !== c.projectId)
      throw new Conflict('This remote agent belongs to a different project.');
    if (!agent)
      store.addAgent({
        id: c.agentId,
        projectId: c.projectId,
        parentId: null,
        taskId: null,
        name: c.projectName.slice(0, 60) || 'Cluster agent',
        role: 'implementer',
        cwd: `cluster-ledger:${c.projectId}`,
        provider: c.provider,
      });
    // Explicit resolved choices stay unchanged; null uses the central default for its class.
    const policy = this.policy();
    const tier =
      c.taskClass === 'manager'
        ? managerModelChoice(policy, c.provider)
        : policy.models[c.provider][taskTiers[c.taskClass]];
    store.updateAgent(c.agentId, {
      provider: c.provider,
      model: c.model ?? tier.model,
      effort: c.effort,
    });
    // Mirror the authoritative remote preference; account accounting never re-enables pacing.
    store.setSetting(projectSchedulerKey(c.projectId), {
      projectId: c.projectId,
      enabled: c.followQuark,
    });
  }

  private accountingRun(ledger: AccountLedger, c: RemoteAdmissionCandidate, id: string) {
    const run = {
      id,
      agentId: c.agentId,
      sourceId: null,
      key: `cluster-admission:${id}`,
      text: '',
      kind: c.kind,
      status: 'queued',
      turnId: null,
      createdAt: c.createdAt,
    } as PrivateRun;
    ledger.store.db
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
      .run(run.id, run.agentId, run.key, run.status, JSON.stringify(run));
    ledger.store.setSetting(`pulsar:estimate:${id}`, c.estimate);
    return ledger.store.run(id);
  }

  /**
   * Readings are ordered by their own evidence time: a ready reading by observedAt, a failed
   * read by attemptedAt. An older or equal reading never overwrites newer accepted evidence.
   */
  private acceptCapacity(ledger: AccountLedger, capacity: RemoteAccountCapacity) {
    const evidence = (c: ProviderCapacity) =>
      c.state === 'ready' && c.observedAt
        ? Date.parse(c.observedAt)
        : Date.parse(c.attemptedAt ?? '');
    const incoming = evidence(capacity.capacity);
    if (Number.isNaN(incoming)) return;
    const source = this.capacitySource(ledger);
    if (source && incoming <= source.at) return;
    ledger.store.transaction(() => {
      ledger.store.setSetting(`capacity:v1:${capacity.provider}`, capacity.capacity);
      ledger.store.setSetting('cluster:capacity-source', {
        at: incoming,
        ordinaryUsageAllowed: capacity.ordinaryUsageAllowed,
        readerHostId: capacity.readerHostId,
        generation: capacity.generation,
      });
    });
  }

  private capacitySource(ledger: AccountLedger) {
    return ledger.store.getSetting('cluster:capacity-source') as {
      at: number;
      ordinaryUsageAllowed: boolean | null;
    } | null;
  }

  private checkCapacity(account: RemoteAccountIdentity, capacity: RemoteAccountCapacity) {
    if (
      account.provider !== capacity.provider ||
      capacity.capacity.provider !== capacity.provider ||
      (account.affinity !== null && account.affinity !== capacity.accountAffinity)
    )
      throw new Conflict('The remote account and usage reading do not match.');
    this.future(account.observedAt, 'account check');
    this.future(capacity.capacity.observedAt, 'usage reading');
    this.future(capacity.capacity.attemptedAt, 'usage attempt');
  }

  /** Records a remote account reading without a candidate; it drives allowance attribution. */
  async observeCapacity(rawAccount: RemoteAccountIdentity, rawCapacity: RemoteAccountCapacity) {
    const account = remoteAccountIdentitySchema.parse(rawAccount);
    const capacity = remoteAccountCapacitySchema.parse(rawCapacity);
    this.checkCapacity(account, capacity);
    if (account.state !== 'ready' || account.affinity === null)
      throw new Conflict('The remote account identity is not verified.');
    const ledger = this.ledger({ provider: account.provider, affinity: account.affinity }, true);
    this.acceptCapacity(ledger, capacity);
    ledger.quark.sync();
  }

  async decide(
    rawIdentity: RemoteRuntimeIdentity,
    rawAccount: RemoteAccountIdentity,
    rawCandidate: RemoteAdmissionCandidate,
    rawCapacity: RemoteAccountCapacity,
  ): Promise<RemoteAdmissionGrant> {
    const identity = remoteRuntimeIdentitySchema.parse(rawIdentity);
    const account = remoteAccountIdentitySchema.parse(rawAccount);
    const candidate = remoteAdmissionCandidateSchema.parse(rawCandidate);
    const capacity = remoteAccountCapacitySchema.parse(rawCapacity);
    if (candidate.projectId !== identity.remoteProjectId)
      throw new Conflict('The candidate belongs to a different remote project.');
    if (
      account.provider !== candidate.provider ||
      capacity.accountAffinity !== candidate.accountAffinity
    )
      throw new Conflict('The remote account, reading and candidate do not match.');
    this.checkCapacity(account, capacity);
    this.future(candidate.createdAt, 'request time');
    const hold = (cause: Hold['cause'], reason: string, revision?: string) => {
      this.recordHold(candidate, cause, reason);
      return this.holdGrant(identity, candidate, reason, revision);
    };
    if (account.state !== 'ready' || account.affinity === null)
      return hold(
        'setup',
        `The remote ${candidate.provider === 'claude' ? 'Claude' : 'Codex'} account needs setup: ${account.message || 'native sign-in is not verified'}`,
      );
    const ledger = this.ledger({ provider: candidate.provider, affinity: account.affinity }, true);
    this.acceptCapacity(ledger, capacity);
    // Like Runtime admission: observe settled evidence first, then decide atomically.
    ledger.quark.sync();
    const requestHash = hash(candidate);
    const outcome = ledger.store.transaction(
      ():
        | { grant: RemoteAdmissionGrant }
        | { cause: Hold['cause']; reason: string; revision?: string } => {
        const existing = ledger.record(candidate.runId);
        const current = existing?.current;
        if (existing && current && current.state !== 'unused') {
          if (current.grant.requestHash !== requestHash)
            throw new Conflict('This remote run was already admitted with a different request.');
          // A restarted controller or changed allocation never earns a second spend grant.
          if (hash(current.identity) !== hash(identity))
            return {
              cause: 'allocation',
              reason:
                'This run already holds an admission for another allocation; waiting for its explicit receipt.',
              revision: current.grant.policyRevision,
            };
          return { grant: current.grant };
        }
        if (
          capacity.ordinaryUsageAllowed === false ||
          this.capacitySource(ledger)?.ordinaryUsageAllowed === false
        )
          return {
            cause: 'usage-not-allowed',
            reason:
              'The remote account reports that ordinary usage is not allowed; QUARK will not choose another account.',
          };
        ledger.store.setSetting('model-policy', this.policy());
        this.ensureAccounting(ledger, identity, candidate);
        const revision = `pulsar:${ledger.pulsar.policy().revision};model:${this.policy().revision}`;
        const attempts = existing?.attempts ?? 0;
        const internalRunId = derivedId('cluster-run', candidate.runId, String(attempts));
        // A hold leaves no queued accounting run behind to influence later decisions.
        ledger.store.db.exec('SAVEPOINT cluster_admission');
        const run = this.accountingRun(ledger, candidate, internalRunId);
        if (!ledger.pulsar.reserve(run, new Set(), true)) {
          const reason = ledger.pulsar.decision(run).reason;
          ledger.store.db.exec('ROLLBACK TO cluster_admission; RELEASE cluster_admission');
          return { cause: 'allowance', reason, revision };
        }
        ledger.store.db.exec('RELEASE cluster_admission');
        ledger.store.updateRun(run.id, { status: 'running' });
        ledger.quark.begin(ledger.store.run(run.id));
        const grant = this.holdGrant(
          identity,
          candidate,
          'Allowance reserved for this remote run. Start before the grant expires.',
          revision,
          'allow',
        );
        ledger.saveRecord({
          candidate,
          attempts: attempts + 1,
          current: {
            grant,
            internalRunId,
            identity,
            state: 'granted',
            receipt: null,
            usage: null,
            basis: 'unknown',
            settledAt: null,
          },
          history: existing ? [...existing.history, existing.current].slice(-8) : [],
        });
        ledger.store.event('cluster.admission.allowed', candidate.projectId, candidate.agentId, {
          runId: candidate.runId,
          grantId: grant.id,
          jobId: identity.jobId,
          attempt: attempts + 1,
        });
        return { grant };
      },
    );
    if ('cause' in outcome) return hold(outcome.cause, outcome.reason, outcome.revision);
    this.index().prepare('DELETE FROM holds WHERE run_id=?').run(candidate.runId);
    return outcome.grant;
  }

  async settle(
    rawIdentity: RemoteRuntimeIdentity,
    rawAccount: RemoteAccountIdentity,
    rawReceipt: RemoteAdmissionReceipt,
  ): Promise<void> {
    const identity = remoteRuntimeIdentitySchema.parse(rawIdentity);
    const account = remoteAccountIdentitySchema.parse(rawAccount);
    const receipt = remoteAdmissionReceiptSchema.parse(rawReceipt);
    if (account.provider !== receipt.provider || account.affinity !== receipt.accountAffinity)
      throw new Conflict('The receipt belongs to a different remote account.');
    this.future(receipt.startedAt, 'start time');
    this.future(receipt.finishedAt, 'finish time');
    if (receipt.state === 'running' && (!receipt.startedAt || receipt.finishedAt))
      throw new Conflict('A running receipt needs a start time and no finish time.');
    if (receipt.state !== 'running' && receipt.state !== 'unused' && !receipt.finishedAt)
      throw new Conflict('A terminal receipt requires a finish time.');
    if (receipt.state === 'complete' && !receipt.startedAt)
      throw new Conflict('A complete receipt requires a start time.');
    if (
      receipt.state === 'unused' &&
      (receipt.startedAt || Object.values(receipt.usage).some((n) => n !== null && n > 0))
    )
      throw new Conflict('An unused grant cannot report a start or usage.');
    let ledger: AccountLedger;
    try {
      ledger = this.ledger(
        { provider: receipt.provider, affinity: receipt.accountAffinity },
        false,
      );
    } catch (error) {
      if (!(error instanceof Conflict) || this.closed) throw error;
      throw new Conflict('No matching remote admission grant exists for this receipt.');
    }
    ledger.store.transaction(() => {
      const record = ledger.record(receipt.runId);
      const entry = record
        ? [record.current, ...record.history].find((e) => e.grant.id === receipt.grantId)
        : undefined;
      if (!record || !entry)
        throw new Conflict('No matching remote admission grant exists for this receipt.');
      if (hash(entry.identity) !== hash(identity))
        throw new Conflict('This receipt comes from a different allocation or controller.');
      const fingerprint = hash(receipt);
      if (entry.receipt === fingerprint) return;
      if (entry.state === 'unused') {
        // A replaced grant was proven unused; nothing later may settle it or its successor.
        if (receipt.state === 'unused') return;
        throw new Conflict('This grant was proven unused; a later receipt contradicts that proof.');
      }
      if ((terminal as readonly string[]).includes(entry.state)) {
        // Reconciled once; an older running report cannot regress it.
        if (receipt.state === 'running' || receipt.state === entry.state) return;
        throw new Conflict('This remote run was already reconciled with a different outcome.');
      }
      const save = (next: Partial<Entry>) =>
        ledger.saveRecord({ ...record, current: { ...entry, receipt: fingerprint, ...next } });
      if (receipt.state === 'unused') {
        if (entry.state !== 'granted')
          throw new Conflict('A started remote run cannot be reported unused.');
        ledger.store.updateRun(entry.internalRunId, { status: 'cancelled' });
        ledger.quark.discardUnconsumed(entry.internalRunId);
        save({ state: 'unused', settledAt: this.stamp() });
        ledger.store.event('cluster.admission.unused', record.candidate.projectId, null, {
          runId: receipt.runId,
          grantId: receipt.grantId,
        });
        return;
      }
      // Cumulative per run: replaces counts, never adds; unknown keeps earlier evidence.
      const usage = ledger.quark.observeRemoteRun(entry.internalRunId, receipt.usage);
      const basis = receipt.basis === 'unknown' ? entry.basis : receipt.basis;
      if (receipt.state === 'running') return save({ state: 'running', usage, basis });
      save({ state: receipt.state, usage, basis, settledAt: this.stamp() });
      ledger.store.updateRun(entry.internalRunId, { status: runStatus[receipt.state] });
      ledger.pulsar.settle(
        entry.internalRunId,
        basis === 'measured' && usage.totalTokens !== null ? usage.totalTokens : null,
      );
      ledger.store.event('cluster.admission.settled', record.candidate.projectId, null, {
        runId: receipt.runId,
        state: receipt.state,
        basis,
        totalTokens: usage.totalTokens,
      });
    });
    ledger.quark.sync();
  }

  /** Owner/project allowance controls on the authoritative account ledger. */
  saveBudget(account: ClusterLedgerAccount, raw: unknown) {
    const ledger = this.ledger(account, false);
    const projectId = z.object({ projectId: z.uuid() }).passthrough().parse(raw).projectId;
    if (!ledger.store.getSetting(`cluster:project:${projectId}`))
      throw new Conflict('This cluster project has no accounting on this account yet.');
    return ledger.quark.saveBudget(raw, 'owner');
  }
  savePolicy(account: ClusterLedgerAccount, raw: unknown) {
    return this.ledger(account, false).pulsar.savePolicy(raw);
  }
  policyFor(account: ClusterLedgerAccount) {
    return this.ledger(account, false).pulsar.policy();
  }
  /** Unknown native accounts inherit new-installation Off, without opening a ledger. */
  schedulingEnabled(account: ClusterLedgerAccount) {
    const parsed = clusterLedgerAccountSchema.parse(account);
    const known = this.index()
      .prepare('SELECT 1 FROM accounts WHERE key=?')
      .get(`${parsed.provider}-${parsed.affinity}`);
    return known ? this.ledger(parsed, false).pulsar.policy().enabled : false;
  }

  status(): ClusterAdmissionStatus {
    const now = this.clock(),
      index = this.index();
    const accounts = new Map<string, { account: ClusterLedgerAccount; verified: boolean }>();
    for (const row of index
      .prepare('SELECT provider, affinity FROM accounts ORDER BY created_at LIMIT 64')
      .all()) {
      const account = clusterLedgerAccountSchema.parse({ ...row });
      accounts.set(`${account.provider}-${account.affinity}`, { account, verified: true });
    }
    const holds = new Map<string, Hold[]>();
    for (const row of index
      .prepare('SELECT provider, affinity, body FROM holds WHERE at>? ORDER BY at DESC LIMIT 256')
      .all(this.stamp(now - holdVisibleMs))) {
      const account = clusterLedgerAccountSchema.parse({
        provider: row.provider,
        affinity: row.affinity,
      });
      const key = `${account.provider}-${account.affinity}`;
      if (!accounts.has(key) && accounts.size < 64) accounts.set(key, { account, verified: false });
      holds.set(key, [
        ...(holds.get(key) ?? []),
        clusterAdmissionHoldSchema.parse(JSON.parse(String(row.body))),
      ]);
    }
    return clusterAdmissionStatusSchema.parse(
      [...accounts].map(([key, { account, verified }]) => {
        const base = {
          provider: account.provider,
          accountAffinity: account.affinity,
          verified,
          holds: (holds.get(key) ?? []).slice(0, 32),
        };
        if (!verified)
          return {
            ...base,
            policyRevision: null,
            reservedPercent: 0,
            running: 0,
            uncertain: [],
            settled: { complete: 0, interrupted: 0, failed: 0, unused: 0 },
            recent: [],
            budgets: [],
          };
        const ledger = this.ledger(account, false);
        const open = ledger.query("json_extract(value,'$.current.state') IN ('granted','running')");
        const settled = { complete: 0, interrupted: 0, failed: 0, unused: 0 };
        for (const row of ledger.store.db
          .prepare(
            "SELECT json_extract(value,'$.current.state') AS state, COUNT(*) AS n FROM settings WHERE key LIKE 'cluster:admission:%' GROUP BY state",
          )
          .all())
          if (String(row.state) in settled)
            settled[String(row.state) as keyof typeof settled] = Number(row.n);
        return {
          ...base,
          policyRevision: ledger.pulsar.policy().revision,
          reservedPercent: open.reduce((n, r) => n + r.candidate.estimate.quotaPercent, 0),
          running: open.filter((r) => r.current.state === 'running').length,
          uncertain: open
            .filter(
              (r) => r.current.state === 'granted' && Date.parse(r.current.grant.expiresAt) <= now,
            )
            .slice(0, 32)
            .map((r) => ({ runId: r.candidate.runId, projectId: r.candidate.projectId })),
          settled,
          recent: ledger
            .query(
              "json_extract(value,'$.current.settledAt') IS NOT NULL",
              "ORDER BY json_extract(value,'$.current.settledAt') DESC LIMIT 10",
            )
            .map((r) => ({
              runId: r.candidate.runId,
              projectId: r.candidate.projectId,
              state: r.current.state as (typeof terminal)[number] | 'unused',
              basis: r.current.basis,
              totalTokens: r.current.usage?.totalTokens ?? null,
              settledAt: r.current.settledAt!,
            })),
          budgets: ledger.quark.budgets().map((b) => {
            const s = ledger.quark.budgetStatus(b);
            return {
              ...b,
              spentPercent: s.spentPercent,
              reservedPercent: s.reservedPercent,
              remainingPercent: s.remainingPercent,
            };
          }),
        };
      }),
    );
  }

  async close() {
    this.closed = true;
    for (const ledger of this.ledgers.values()) ledger.store.close();
    this.ledgers.clear();
    this.db?.close();
    this.db = null;
  }
}
