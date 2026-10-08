import {
  remoteAccountReaderSchema,
  remoteAccountCapacitySchema,
  remoteAdmissionCandidateSchema,
  remoteAdmissionSnapshotSchema,
  type RemoteRuntimeIdentity,
  type RemoteAccountCapacity,
  type ProviderId,
  type TokenCounts,
} from '@dock/shared';
import { Conflict, type PrivateRun, type Store } from './store.js';
import type { Pulsar } from './pulsar.js';
import type { Quark } from './quark.js';
import { projectFollowsQuark } from './quark-project.js';
import { ClusterAdmissionInbox } from './cluster-admission-inbox.js';
import { ClusterNativeAccounts } from './cluster-native-accounts.js';
import { quarkRunSchema, type RemoteAdmissionCandidate } from '@dock/shared';
import { remoteRequestHash } from './cluster-admission-request.js';

/** These routes are authenticated gateway control; they are deliberately absent from browser proxyPath. */
export function clusterInternalPath(method: string, path: string) {
  return method === 'GET'
    ? path === '/api/cluster/runtime/admission'
    : method === 'POST' &&
        [
          '/api/cluster/runtime/admission/grants',
          '/api/cluster/runtime/admission/reader',
          '/api/cluster/runtime/admission/acknowledge',
          '/api/cluster/runtime/admission/dispose',
          '/api/cluster/runtime/admission/revoke',
          '/api/cluster/runtime/admission/drain',
          '/api/cluster/runtime/admission/reopen',
        ].includes(path);
}
const unknown: TokenCounts = {
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
};
export interface RemoteAdmissionRuntime {
  store: Store;
  pulsar: Pulsar;
  quark: Quark;
  clusterCodexAccountLimits(): Promise<unknown>;
  isInternalProject(projectId: string): boolean;
  preparedForRemoteAdmission(runId: string): boolean;
  nativeAdmissionReason: (run: PrivateRun) => string | null;
  nativeAdmissionConsume: (run: PrivateRun) => boolean;
  nativeAdmissionVerify: (run: PrivateRun) => Promise<void>;
  clusterBackgroundMetadataAllowed: () => boolean;
  settleClusterBackgroundMetadata: () => Promise<void>;
}
export class ClusterRemoteAdmission {
  readonly inbox: ClusterAdmissionInbox;
  readonly accounts: ClusterNativeAccounts;
  private readonly readings = new Map<ProviderId, RemoteAccountCapacity>();
  private readonly readers = new Map<ProviderId, { generation: string; expiresAt: number }>();
  private readonly pending = new Map<ProviderId, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private candidateCursor = 0;
  constructor(
    private readonly runtime: RemoteAdmissionRuntime,
    readonly identity: RemoteRuntimeIdentity,
    private readonly now: () => number = Date.now,
    accounts?: ClusterNativeAccounts,
  ) {
    this.accounts =
      accounts ?? new ClusterNativeAccounts(() => runtime.clusterCodexAccountLimits(), now);
    const settleMetadata = runtime.settleClusterBackgroundMetadata;
    runtime.settleClusterBackgroundMetadata = async () => {
      await Promise.allSettled([...this.pending.values()]);
      await settleMetadata();
    };
    this.inbox = new ClusterAdmissionInbox(
      runtime.store,
      identity,
      (provider) => this.accounts.get(provider),
      now,
      (run) => this.candidate(run),
    );
    runtime.nativeAdmissionReason = (run) => {
      const provider = runtime.store.agent(run.agentId).provider;
      return this.accounts.reading(provider)?.ordinaryUsageAllowed === false ||
        this.readings.get(provider)?.ordinaryUsageAllowed === false
        ? `Native ${provider === 'codex' ? 'Codex' : 'Claude'} ordinary included usage is blocked.`
        : this.inbox.reason(run);
    };
    runtime.nativeAdmissionConsume = (run) => this.inbox.consume(run);
    runtime.nativeAdmissionVerify = async (run) => {
      const provider = runtime.store.agent(run.agentId).provider,
        grant = this.inbox.grant(run.id);
      // Identity reads tied to a requested turn never publish a follower's allowance sample.
      const current = await this.accounts.discover(provider, true);
      if (
        !grant ||
        !this.candidate(run) ||
        remoteRequestHash(this.candidate(run)!) !== grant.requestHash ||
        current.account.state !== 'ready' ||
        current.account.affinity !== grant.accountAffinity ||
        current.ordinaryUsageAllowed === false
      )
        throw new Conflict(
          'The native cluster account changed or became unavailable before dispatch. No native turn started.',
        );
    };
  }
  async initialize() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.collect(), 10000);
    this.timer.unref();
    // Metadata startup may outlast a gateway request or the bootstrap health wait.
    // Expose the real checking state while the single-flight reader continues.
    void this.collect();
  }
  private usage(run: PrivateRun) {
    const row = this.runtime.store.db
      .prepare('SELECT body FROM quark_runs WHERE run_id=?')
      .get(run.id);
    if (!row) return { tokens: unknown, basis: 'unknown' as const };
    const observed = quarkRunSchema.parse(JSON.parse(String(row.body)));
    return { tokens: observed.tokens, basis: observed.basis };
  }
  private candidate(run: PrivateRun): RemoteAdmissionCandidate | null {
    const agent = this.runtime.store.agent(run.agentId),
      account = this.accounts.get(agent.provider);
    if (
      account?.state !== 'ready' ||
      !account.affinity ||
      (agent.projectId !== this.identity.remoteProjectId &&
        !this.runtime.isInternalProject(agent.projectId))
    )
      return null;
    return remoteAdmissionCandidateSchema.parse({
      runId: run.id,
      agentId: agent.id,
      projectId: this.identity.remoteProjectId,
      projectName: this.runtime.store.project(this.identity.remoteProjectId).name,
      provider: agent.provider,
      accountAffinity: account.affinity,
      model: agent.model,
      effort: agent.effort,
      taskClass: agent.role === 'manager' ? 'manager' : 'reasoning',
      followQuark: projectFollowsQuark(this.runtime.store, this.identity.remoteProjectId),
      kind: run.kind,
      estimate: this.runtime.pulsar.estimate(run),
      createdAt: run.createdAt,
    });
  }

  snapshot() {
    if (this.timer) void this.collect();
    this.runtime.quark.sync();
    const store = this.runtime.store;
    const projects = store
      .projects()
      .filter(
        (project) =>
          project.id === this.identity.remoteProjectId ||
          this.runtime.isInternalProject(project.id),
      )
      .map((project) => project.id);
    const candidates: RemoteAdmissionCandidate[] = [];
    if (projects.length) {
      // Fetch metadata only, at most128 conversation heads per poll. Owner/recovery FIFO,
      // including a held owner input, remains ahead of internal coordination updates.
      const heads = store.db.prepare(`WITH heads AS (
        SELECT r.id,r.rowid AS position,json_extract(r.body,'$.queueEdit') AS editing,
        ROW_NUMBER() OVER (PARTITION BY r.agent_id ORDER BY CASE WHEN json_extract(r.body,'$.sourceId') IS NULL AND json_extract(r.body,'$.kind') IN ('user','resume') THEN 0 ELSE 1 END,r.rowid) AS head
        FROM runs r JOIN agents a ON a.id=r.agent_id WHERE r.status='queued'
        AND a.project_id IN (${projects.map(() => '?').join(',')})
        AND json_extract(a.body,'$.nativeRootId') IS NULL
        AND json_extract(a.body,'$.archivedAt') IS NULL
        AND json_extract(a.body,'$.status') NOT IN ('interrupted','failed','waiting')
      ) SELECT id,position,editing FROM heads WHERE head=1 AND position>? ORDER BY position LIMIT 128`);
      let rows = heads.all(...projects, this.candidateCursor);
      if (!rows.length && this.candidateCursor) rows = heads.all(...projects, 0);
      for (const row of rows) {
        this.candidateCursor = Number(row.position);
        if (row.editing || !this.runtime.preparedForRemoteAdmission(String(row.id))) continue;
        const candidate = this.candidate(store.run(String(row.id)));
        if (candidate) candidates.push(candidate);
        if (candidates.length === 32) break;
      }
    }
    return remoteAdmissionSnapshotSchema.parse({
      identity: this.identity,
      followQuark: projectFollowsQuark(this.runtime.store, this.identity.remoteProjectId),
      accounts: this.accounts.all(),
      candidates,
      receipts: this.inbox.receipts((run) => this.usage(run)),
      capacities: [...this.readings.values()],
    });
  }
  selectReader(raw: unknown) {
    if (this.stopped) throw new Conflict('Remote admission is stopping.');
    const input = remoteAccountReaderSchema.parse(raw),
      account = this.accounts.get(input.provider);
    if (
      input.controllerHostId !== this.identity.controllerHostId ||
      account?.affinity !== input.accountAffinity ||
      input.expiresAt <= new Date(this.now()).toISOString() ||
      Date.parse(input.expiresAt) > this.now() + 60000
    )
      throw new Conflict('Capacity reader lease identity or lifetime changed.');
    if (
      input.cached &&
      (input.cached.accountAffinity !== account.affinity ||
        input.cached.provider !== input.provider ||
        input.cached.generation !== input.generation ||
        input.cached.capacity.provider !== input.provider)
    )
      throw new Conflict('Cached allowance belongs to another account or reader generation.');
    return this.runtime.store.operation(`cluster-admission:reader:${input.key}`, input, () => {
      if (input.reader)
        this.readers.set(input.provider, {
          generation: input.generation,
          expiresAt: Date.parse(input.expiresAt),
        });
      else this.readers.delete(input.provider);
      if (input.cached) this.accept(input.cached);
      void this.collect();
      return { key: input.key, accepted: true, generation: input.generation };
    });
  }
  private accept(reading: RemoteAccountCapacity) {
    this.readings.set(reading.provider, reading);
    this.runtime.store.setSetting(`capacity:v1:${reading.provider}`, reading.capacity);
    this.runtime.store.event('capacity.updated', null, null, {
      provider: reading.provider,
      state: reading.capacity.state,
      observedAt: reading.capacity.observedAt,
    });
  }
  private async collect() {
    if (this.stopped || !this.runtime.clusterBackgroundMetadataAllowed()) return;
    for (const provider of ['codex', 'claude'] as const) {
      if (this.pending.has(provider)) continue;
      const account = this.accounts.get(provider);
      const discover = account?.state !== 'ready';
      const lease = this.readers.get(provider);
      if (!discover && (!lease || lease.expiresAt <= this.now())) continue;
      const previous = this.readings.get(provider);
      if (
        !discover &&
        previous?.capacity.attemptedAt &&
        this.now() - Date.parse(previous.capacity.attemptedAt) <
          (provider === 'claude' ? 300000 : 60000)
      )
        continue;
      const work = (discover ? this.accounts.discover(provider) : this.accounts.capacity(provider))
        .then((reading) => {
          if (this.stopped) return;
          if (reading.account.state !== 'ready' || reading.account.affinity !== account?.affinity) {
            // Old reader generations/capacity cannot authorize a replacement native account.
            this.readers.delete(provider);
            this.readings.delete(provider);
            if (previous) this.runtime.store.setSetting(`capacity:v1:${provider}`, null);
            return;
          }
          if (
            !lease ||
            this.readers.get(provider)?.generation !== lease.generation ||
            lease.expiresAt <= this.now() ||
            !reading.capacity ||
            !reading.account.affinity
          )
            return;
          this.accept(
            remoteAccountCapacitySchema.parse({
              provider,
              accountAffinity: reading.account.affinity,
              readerHostId: this.identity.remoteHostId,
              generation: lease.generation,
              capacity: reading.capacity,
              ordinaryUsageAllowed: reading.ordinaryUsageAllowed,
            }),
          );
        })
        .catch(() => {
          /* Retain the last bounded sample; native verification still fences dispatch. */
        })
        .finally(() => this.pending.delete(provider));
      this.pending.set(provider, work);
    }
  }
  close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.readers.clear();
  }
}
