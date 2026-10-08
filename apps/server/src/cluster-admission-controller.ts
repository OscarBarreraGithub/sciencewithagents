import { randomUUID } from 'node:crypto';
import {
  remoteAdmissionSnapshotSchema,
  remoteAdmissionAcceptedSchema,
  remoteAdmissionReceiptSchema,
  remoteAdmissionGrantSchema,
  remoteRuntimeIdentitySchema,
  clusterAccountControlsSchema,
  clusterAccountPolicyUpdateSchema,
  clusterAccountBudgetUpdateSchema,
  remoteAccountIdentitySchema,
  type ClusterAdmissionStatus,
  type ClusterLedgerAccount,
  type PulsarPolicy,
  type ProviderId,
  type RemoteRuntimeIdentity,
  type RemoteAccountIdentity,
  type RemoteAccountCapacity,
  type RemoteAdmissionCandidate,
  type RemoteAdmissionGrant,
  type RemoteAdmissionReceipt,
} from '@dock/shared';
import { z } from 'zod';
import { developmentInput } from './cluster-runtime.js';
import type { ClusterProjects } from './cluster-projects.js';
import { Conflict, type Store } from './store.js';
import { remoteRequestHash } from './cluster-admission-request.js';

export interface RemoteAdmissionLedger {
  decide(
    identity: RemoteRuntimeIdentity,
    account: RemoteAccountIdentity,
    candidate: RemoteAdmissionCandidate,
    capacity: RemoteAccountCapacity,
  ): Promise<RemoteAdmissionGrant>;
  observeCapacity(account: RemoteAccountIdentity, capacity: RemoteAccountCapacity): Promise<void>;
  status(): ClusterAdmissionStatus;
  policyFor(account: ClusterLedgerAccount): PulsarPolicy;
  schedulingEnabled(account: ClusterLedgerAccount): boolean;
  savePolicy(account: ClusterLedgerAccount, raw: unknown): unknown;
  saveBudget(account: ClusterLedgerAccount, raw: unknown): unknown;
  settle(
    identity: RemoteRuntimeIdentity,
    account: RemoteAccountIdentity,
    receipt: RemoteAdmissionReceipt,
  ): Promise<void>;
}
type Reader = {
  hostId: string;
  projectId: string;
  generation: string;
  expiresAt: number;
  cached: RemoteAccountCapacity | null;
};
/** Controller polling moves only bounded typed admission evidence, never model prompts. */
export class ClusterAdmissionController {
  private readonly active = new Map<string, Promise<void>>();
  private readonly readers = new Map<string, Reader>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly controlsChanging = new Set<string>();
  private readonly idleAttempted = new Map<string, number>();
  constructor(
    private readonly store: Store,
    private readonly projects: ClusterProjects,
    private readonly ledger: RemoteAdmissionLedger,
    private readonly now: () => number = Date.now,
  ) {}
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 5000);
      this.timer.unref();
      void this.tick();
    }
  }
  private async request(
    projectId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const record = this.projects.record(projectId),
      gateway = this.projects.runtimes.gateway(projectId);
    const response = await gateway.forward(
      record.hostId,
      method,
      path,
      body,
      AbortSignal.timeout(20000),
    );
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 256 * 1024) {
        response.destroy();
        throw new Error('Remote admission summary exceeded its bound.');
      }
      buffers.push(bytes);
    }
    if (response.statusCode === 409)
      throw new Conflict('This remote admission item changed; its saved input is retained.');
    if (response.statusCode !== 200)
      throw new Error('Remote admission is unavailable; native input remains saved.');
    return JSON.parse(Buffer.concat(buffers).toString()) as unknown;
  }
  async tick() {
    if (this.stopped) return;
    for (const project of this.projects.list()) {
      if (!project.remoteProjectId || this.active.has(project.id)) continue;
      if (this.idleReleased(project.id)) continue;
      const promise = this.sync(project.id)
        .then(async () => {
          if (this.now() - (this.idleAttempted.get(project.id) ?? 0) < 60000) return;
          this.idleAttempted.set(project.id, this.now());
          await this.projects.runtimes.allocations.releaseIdle(
            developmentInput(this.projects.record(project.id)),
          );
          this.idleReleased(project.id);
        })
        .catch((error: unknown) => {
          if (!this.stopped && !this.idleReleased(project.id))
            this.store.setSetting(`cluster-admission:controller-status:${project.id}`, {
              state: 'unavailable',
              observedAt: new Date(this.now()).toISOString(),
              message: String(error instanceof Error ? error.message : error).slice(0, 500),
            });
        })
        .finally(() => this.active.delete(project.id));
      this.active.set(project.id, promise);
    }
    await Promise.all([...this.active.values()]);
  }
  private idleReleased(projectId: string) {
    const lease = this.projects.runtimes.allocations.get(projectId);
    if (lease?.state !== 'released') return false;
    const key = `cluster-admission:controller-status:${projectId}`;
    const saved = this.store.getSetting(key) as { state?: string; message?: string } | null;
    const message = 'Allocation released. Open this project to reconnect.';
    if (saved?.state !== 'idle' || saved.message !== message)
      this.store.setSetting(key, {
        state: 'idle',
        observedAt: lease.observedAt ?? new Date(this.now()).toISOString(),
        message,
      });
    return true;
  }
  private async sync(projectId: string) {
    const record = this.projects.record(projectId),
      snapshot = remoteAdmissionSnapshotSchema.parse(
        await this.request(projectId, 'GET', '/api/cluster/runtime/admission'),
      );
    if (
      snapshot.identity.controllerHostId !== record.controllerHostId ||
      snapshot.identity.remoteHostId !== record.remoteWorkspaceId ||
      snapshot.identity.clusterProjectId !== record.id ||
      snapshot.identity.remoteProjectId !== record.remoteProjectId
    )
      throw new Error('Remote admission identity changed. No grant was sent.');
    const lease = this.projects.runtimes.allocations.get(projectId);
    if (
      !lease ||
      snapshot.identity.jobId !== lease.jobId ||
      snapshot.identity.leaseToken !== lease.token
    )
      throw new Error('Remote admission belongs to another allocation.');
    this.store.setSetting(`cluster-admission:accounts:${projectId}`, {
      accounts: snapshot.accounts,
      observedAt: new Date(this.now()).toISOString(),
    });
    for (const account of snapshot.accounts) {
      if (account.state !== 'ready' || !account.affinity) continue;
      const name = `${account.provider}:${account.affinity}`;
      if (this.controlsChanging.has(name)) continue;
      let reader = this.readers.get(name);
      if (!reader) {
        const saved = this.store.getSetting(`cluster-admission:reader:${name}`) as Reader | null;
        if (saved && saved.expiresAt > this.now()) {
          reader = saved;
          this.readers.set(name, reader);
        }
      }
      if (!reader || reader.expiresAt <= this.now()) {
        reader = {
          hostId: snapshot.identity.remoteHostId,
          projectId,
          generation: randomUUID(),
          expiresAt: this.now() + 45000,
          cached: null,
        };
        this.readers.set(name, reader);
      }
      const elected = reader.hostId === snapshot.identity.remoteHostId;
      if (elected) reader.expiresAt = this.now() + 45000;
      const capacity = snapshot.capacities.find(
        (value) =>
          value.provider === account.provider &&
          value.accountAffinity === account.affinity &&
          value.readerHostId === reader.hostId &&
          value.generation === reader.generation,
      );
      if (capacity) reader.cached = capacity;
      if (reader.cached) await this.ledger.observeCapacity(account, reader.cached);
      this.store.setSetting(`cluster-admission:reader:${name}`, reader);
      await this.request(projectId, 'POST', '/api/cluster/runtime/admission/reader', {
        key: randomUUID(),
        controllerHostId: record.controllerHostId,
        provider: account.provider,
        accountAffinity: account.affinity,
        generation: reader.generation,
        reader: elected,
        expiresAt: new Date(this.now() + 45000).toISOString(),
        cached: reader.cached,
      });
      for (const receipt of snapshot.receipts.filter(
        (receipt) =>
          receipt.provider === account.provider && receipt.accountAffinity === account.affinity,
      )) {
        try {
          const delivered = this.intents(projectId).find(
            (value) => value.grant.id === receipt.grantId,
          );
          await this.ledger.settle(delivered?.identity ?? snapshot.identity, account, receipt);
          if (receipt.state !== 'running')
            await this.request(projectId, 'POST', '/api/cluster/runtime/admission/acknowledge', {
              key: this.deliveryKey(`ack:${receipt.grantId}`),
              grantIds: [receipt.grantId],
            });
          if (receipt.state !== 'running' && delivered)
            this.store.setSetting(`cluster-admission:delivery:${receipt.runId}`, null);
        } catch (error) {
          if (!(error instanceof Conflict)) throw error;
          this.store.event('cluster.admission.item_held', null, null, {
            projectId,
            message: error.message.slice(0, 500),
          });
        }
      }
      // A canceled or changed queued request can disappear from candidates; exact unused
      // proof retires its reservation, never mere age or absence from this list.
      for (const saved of this.intents(projectId).filter(
        (item) =>
          item.grant.provider === account.provider &&
          item.grant.accountAffinity === account.affinity,
      )) {
        try {
          const candidate = snapshot.candidates.find((value) => value.runId === saved.grant.runId);
          if (
            Date.parse(saved.grant.expiresAt) <= this.now() ||
            (candidate && remoteRequestHash(candidate) !== saved.grant.requestHash)
          ) {
            const disposed = await this.request(
              projectId,
              'POST',
              '/api/cluster/runtime/admission/revoke',
              { key: this.deliveryKey(`unused:${saved.grant.id}`), grant: saved.grant },
            );
            const result = z
              .object({
                state: z.enum(['consumed', 'unused']),
                receipt: remoteAdmissionReceiptSchema.nullable(),
              })
              .strict()
              .parse(disposed);
            if (result.state === 'unused' && result.receipt) {
              await this.ledger.settle(
                saved.identity ?? snapshot.identity,
                account,
                result.receipt,
              );
              await this.request(projectId, 'POST', '/api/cluster/runtime/admission/acknowledge', {
                key: this.deliveryKey(`ack:${saved.grant.id}`),
                grantIds: [saved.grant.id],
              });
              this.store.setSetting(`cluster-admission:delivery:${saved.grant.runId}`, null);
            }
          }
        } catch (error) {
          if (!(error instanceof Conflict)) throw error;
          this.store.event('cluster.admission.item_held', null, null, {
            projectId,
            message: error.message.slice(0, 500),
          });
        }
      }
      for (const candidate of snapshot.candidates.filter(
        (candidate) =>
          candidate.provider === account.provider && candidate.accountAffinity === account.affinity,
      )) {
        try {
          if (
            candidate.followQuark &&
            this.ledger.schedulingEnabled({
              provider: account.provider,
              affinity: account.affinity,
            }) &&
            (!reader.cached ||
              (reader.cached.capacity.state !== 'ready' &&
                reader.cached.ordinaryUsageAllowed !== false))
          )
            continue;
          // Work with app pacing off still needs exact account/run permission.
          const capacity: RemoteAccountCapacity = reader.cached ?? {
            provider: account.provider,
            accountAffinity: account.affinity,
            readerHostId: reader.hostId,
            generation: reader.generation,
            ordinaryUsageAllowed: null,
            capacity: {
              provider: account.provider,
              account: 'local-sign-in',
              label: 'Cluster native account',
              plan: null,
              source: account.provider === 'codex' ? 'codex-native' : 'claude-native-oauth',
              observedAt: null,
              attemptedAt: null,
              nextRefreshAt: null,
              state: 'unknown',
              stale: true,
              message:
                'QUARK pacing is off for this work. Native account verification remains required.',
              windows: [],
              weeklyPolicy: 'not-reported',
            },
          };
          const intentKey = `cluster-admission:delivery:${candidate.runId}`;
          let intent = this.store.getSetting(intentKey) as {
            key: string;
            grant: RemoteAdmissionGrant;
            accepted: boolean;
            projectId: string;
            identity: RemoteRuntimeIdentity;
          } | null;
          if (
            !intent ||
            (intent.accepted && Date.parse(intent.grant.expiresAt) <= this.now() + 5000)
          ) {
            const grant = remoteAdmissionGrantSchema.parse(
              await this.ledger.decide(snapshot.identity, account, candidate, capacity),
            );
            intent = {
              key: randomUUID(),
              grant,
              accepted: false,
              projectId,
              identity: snapshot.identity,
            };
            this.store.setSetting(intentKey, intent);
          }
          if (intent.accepted || this.controlsChanging.has(name)) continue;
          const accepted = remoteAdmissionAcceptedSchema.parse(
            await this.request(projectId, 'POST', '/api/cluster/runtime/admission/grants', {
              key: intent.key,
              grant: intent.grant,
            }),
          );
          if (
            accepted.key !== intent.key ||
            accepted.grantId !== intent.grant.id ||
            accepted.runId !== candidate.runId ||
            accepted.decision !== intent.grant.decision
          )
            throw new Error('Remote grant acknowledgement did not match its saved intent.');
          this.store.setSetting(intentKey, { ...intent, accepted: true });
        } catch (error) {
          if (!(error instanceof Conflict)) throw error;
          this.store.event('cluster.admission.item_held', null, null, {
            projectId,
            message: error.message.slice(0, 500),
          });
        }
      }
    }
    const selected = snapshot.accounts.find(
      (account) => account.provider === record.manager.provider,
    );
    const reader = selected?.affinity
      ? this.readers.get(selected.provider + ':' + selected.affinity)
      : null;
    const nativeBlocked = reader?.cached?.ordinaryUsageAllowed === false;
    const accountPacing = selected?.affinity
      ? this.ledger.schedulingEnabled({ provider: selected.provider, affinity: selected.affinity })
      : false;
    const ready =
      selected?.state === 'ready' &&
      !nativeBlocked &&
      (!snapshot.followQuark || !accountPacing || reader?.cached?.capacity.state === 'ready');
    this.store.setSetting(`cluster-admission:controller-status:${projectId}`, {
      state: ready ? 'ready' : selected?.state === 'ready' ? 'unavailable' : 'setup-required',
      observedAt: new Date(this.now()).toISOString(),
      message: ready
        ? snapshot.followQuark && accountPacing
          ? 'Native cluster account and authoritative QUARK admission are connected.'
          : snapshot.followQuark
            ? 'Native cluster account connected. QUARK pacing is off for this account.'
            : 'Native cluster account connected. QUARK scheduling is off for this project.'
        : nativeBlocked
          ? 'The native cluster account reports that ordinary usage is blocked.'
          : selected?.state === 'ready'
            ? 'Waiting for fresh native allowance evidence from this cluster account.'
            : (selected?.message ?? 'Native account setup required.'),
    });
  }
  private intents(projectId?: string) {
    return this.store.db
      .prepare(
        "SELECT value FROM settings WHERE key LIKE ? AND value <> ? AND json_extract(value,'$.grant.decision')='allow' LIMIT 256",
      )
      .all('cluster-admission:delivery:%', 'null')
      .flatMap((row) => {
        const parsed = z
          .object({
            key: z.uuid(),
            grant: remoteAdmissionGrantSchema,
            accepted: z.boolean(),
            projectId: z.uuid(),
            identity: remoteRuntimeIdentitySchema,
          })
          .nullable()
          .safeParse(JSON.parse(String(row.value)));
        return parsed.success && parsed.data && (!projectId || parsed.data.projectId === projectId)
          ? [parsed.data]
          : [];
      });
  }
  private accounts(projectId: string) {
    const raw = this.store.getSetting(`cluster-admission:accounts:${projectId}`) as {
      accounts: RemoteAccountIdentity[];
      observedAt: string;
    } | null;
    return raw && this.now() - Date.parse(raw.observedAt) < 30000
      ? raw.accounts.map((value) => remoteAccountIdentitySchema.parse(value))
      : [];
  }
  controls(projectId: string) {
    const record = this.projects.record(projectId),
      accounts = this.accounts(projectId),
      statuses = this.ledger.status();
    return clusterAccountControlsSchema.parse({
      projectId,
      remoteProjectId: record.remoteProjectId,
      accounts: (['codex', 'claude'] as const).map((provider) => {
        const account = accounts.find((value) => value.provider === provider);
        const selected =
          account?.state === 'ready' && account.affinity
            ? { provider, affinity: account.affinity }
            : null;
        return {
          provider,
          state: account?.state ?? 'unavailable',
          message:
            account?.message ?? 'Open this saved project to verify its native cluster account.',
          accountAffinity: account?.affinity ?? null,
          status: selected
            ? (statuses.find(
                (value) =>
                  value.provider === provider && value.accountAffinity === selected.affinity,
              ) ?? null)
            : null,
          policy:
            selected &&
            statuses.some(
              (value) =>
                value.provider === provider &&
                value.accountAffinity === selected.affinity &&
                value.verified,
            )
              ? this.ledger.policyFor(selected)
              : null,
        };
      }),
    });
  }
  async savePolicy(projectId: string, raw: unknown) {
    const input = clusterAccountPolicyUpdateSchema.parse(raw);
    return this.change(projectId, input.provider, input.expectedAccountAffinity, (account) =>
      this.ledger.savePolicy(account, input.update),
    );
  }
  async saveBudget(projectId: string, raw: unknown) {
    const input = clusterAccountBudgetUpdateSchema.parse(raw),
      record = this.projects.record(projectId);
    if (
      input.budget.projectId !== record.remoteProjectId ||
      input.budget.provider !== input.provider ||
      input.budget.taskId
    )
      throw new Conflict(
        'This budget must belong to the saved remote project/account; task budgets use manager coordination.',
      );
    return this.change(projectId, input.provider, input.expectedAccountAffinity, (account) =>
      this.ledger.saveBudget(account, input.budget),
    );
  }
  private async change(
    projectId: string,
    provider: ProviderId,
    expectedAccountAffinity: string,
    apply: (account: ClusterLedgerAccount) => unknown,
  ) {
    const verifyAccount = () => {
      const identity = this.accounts(projectId).find((value) => value.provider === provider);
      if (identity?.state !== 'ready' || !identity.affinity)
        throw new Conflict(
          'Verify the native cluster account before changing its allowance controls.',
        );
      if (identity.affinity !== expectedAccountAffinity)
        throw new Conflict(
          'The native cluster account changed. This saved change belongs to the earlier account. Refresh its controls before making a new change.',
        );
      return { ...identity, affinity: identity.affinity };
    };
    const identity = verifyAccount();
    const name = provider + ':' + identity.affinity;
    if (this.controlsChanging.has(name))
      throw new Conflict(
        'This account’s allowance controls are already changing. Retry the same saved request.',
      );
    this.controlsChanging.add(name);
    try {
      await Promise.all([...this.active.values()]);
      verifyAccount();
      for (const intent of this.intents().filter(
        (value) =>
          value.grant.provider === provider && value.grant.accountAffinity === identity.affinity,
      )) {
        verifyAccount();
        const revoked = z
          .object({
            state: z.enum(['consumed', 'unused']),
            receipt: remoteAdmissionReceiptSchema.nullable(),
          })
          .strict()
          .parse(
            await this.request(intent.projectId, 'POST', '/api/cluster/runtime/admission/revoke', {
              key: this.deliveryKey(`policy-revoke:${intent.grant.id}`),
              grant: intent.grant,
            }),
          );
        verifyAccount();
        if (revoked.state === 'unused' && revoked.receipt) {
          await this.ledger.settle(intent.identity, identity, revoked.receipt);
          verifyAccount();
          this.store.setSetting(`cluster-admission:delivery:${intent.grant.runId}`, null);
        }
      }
      verifyAccount();
      return apply({ provider, affinity: identity.affinity });
    } finally {
      this.controlsChanging.delete(name);
    }
  }
  private deliveryKey(name: string) {
    const path = `cluster-admission:key:${name}`;
    const saved = this.store.getSetting(path);
    if (saved) return z.uuid().parse(saved);
    const id = randomUUID();
    this.store.setSetting(path, id);
    return id;
  }
  close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return Promise.all([...this.active.values()]).then(() => {});
  }
}
