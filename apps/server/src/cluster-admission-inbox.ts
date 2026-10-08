import { z } from 'zod';
import {
  remoteAdmissionAcceptedSchema,
  remoteAdmissionGrantSchema,
  remoteAdmissionPushSchema,
  remoteRuntimeIdentitySchema,
  remoteAdmissionReceiptSchema,
  type RemoteRuntimeIdentity,
  type RemoteAccountIdentity,
  type RemoteAdmissionGrant,
  type RemoteAdmissionReceipt,
  type ProviderId,
  type TokenCounts,
  type RemoteAdmissionCandidate,
} from '@dock/shared';
import { Conflict, type PrivateRun, type Store } from './store.js';
import { remoteRequestHash } from './cluster-admission-request.js';

const savedGrant = z
  .object({
    grant: remoteAdmissionGrantSchema,
    consumedAt: z.string().datetime().nullable(),
    retired: z.boolean().default(false),
  })
  .strict();
const savedReceipt = z
  .object({ grant: remoteAdmissionGrantSchema, receipt: remoteAdmissionReceiptSchema })
  .strict();
/** Durable gateway grants. Reading admission never consumes a grant or starts a turn. */
export class ClusterAdmissionInbox {
  readonly identity: RemoteRuntimeIdentity;
  constructor(
    private readonly store: Store,
    identity: RemoteRuntimeIdentity,
    private readonly account: (provider: ProviderId) => RemoteAccountIdentity | null,
    private readonly now: () => number = Date.now,
    private readonly candidate: (run: PrivateRun) => RemoteAdmissionCandidate | null = () => null,
  ) {
    this.identity = remoteRuntimeIdentitySchema.parse(identity);
  }
  private name(runId: string) {
    return `cluster-admission:run:${z.uuid().parse(runId)}`;
  }
  private current(runId: string) {
    const raw = this.store.getSetting(this.name(runId));
    return raw ? savedGrant.parse(raw) : null;
  }
  grant(runId: string) {
    return this.current(runId)?.grant ?? null;
  }
  private matches(grant: RemoteAdmissionGrant) {
    const id = this.identity;
    return (
      grant.controllerHostId === id.controllerHostId &&
      grant.remoteHostId === id.remoteHostId &&
      grant.clusterProjectId === id.clusterProjectId &&
      grant.jobId === id.jobId &&
      grant.leaseToken === id.leaseToken
    );
  }
  private saveReceipt(grant: RemoteAdmissionGrant, receipt: RemoteAdmissionReceipt) {
    this.store.setSetting(`cluster-admission:receipt:${grant.id}`, receipt);
    this.store.setSetting(`cluster-admission:final:${grant.id}`, { grant, receipt });
  }
  private dispositionBinding(grant: RemoteAdmissionGrant) {
    if (!this.matches(grant))
      throw new Conflict('Unused disposition belongs to another allocation or controller.');
    const current = this.current(grant.runId);
    const final = this.store.getSetting(`cluster-admission:final:${grant.id}`);
    const saved = final
      ? savedReceipt.parse(final).grant
      : current?.grant.id === grant.id
        ? current.grant
        : null;
    if (saved && JSON.stringify(saved) !== JSON.stringify(grant))
      throw new Conflict('The disposition does not match the exact saved grant.');
    return current;
  }
  push(raw: unknown) {
    const input = remoteAdmissionPushSchema.parse(raw),
      grant = input.grant;
    if (!this.matches(grant))
      throw new Conflict(
        'This admission grant belongs to a different controller, runtime or allocation.',
      );
    return this.store.operation(`cluster-admission:push:${input.key}`, input, () => {
      const run = this.store.run(grant.runId),
        agent = this.store.agent(run.agentId),
        account = this.account(agent.provider);
      if (
        this.candidate(run)?.projectId !== this.identity.remoteProjectId ||
        grant.provider !== agent.provider ||
        account?.state !== 'ready' ||
        account.affinity !== grant.accountAffinity
      )
        throw new Conflict(
          'Admission account or project identity changed. No native turn was authorized.',
        );
      const current = this.current(run.id);
      const candidate = this.candidate(run);
      if (!candidate || remoteRequestHash(candidate) !== grant.requestHash)
        throw new Conflict('The prepared request/model changed before this grant arrived.');
      if (
        this.store.getSetting(`cluster-admission:receipt:${grant.id}`) ||
        (current?.retired && current.grant.id === grant.id)
      )
        throw new Conflict(
          'This grant already has a final disposition and cannot authorize work again.',
        );
      if (
        current &&
        !current.retired &&
        current.grant.decision === 'allow' &&
        current.grant.id !== grant.id
      )
        throw new Conflict('Reconcile the existing grant before replacing its saved admission.');
      if (current?.grant.id === grant.id && JSON.stringify(current.grant) !== JSON.stringify(grant))
        throw new Conflict('A saved native grant identity cannot be changed.');
      if (current?.consumedAt && current.grant.id !== grant.id)
        throw new Conflict(
          'This run already consumed an admission grant. Reconcile its native result before issuing another.',
        );
      if (!current?.consumedAt && run.status !== 'queued')
        throw new Conflict('Only an existing queued run can receive a new admission grant.');
      if (
        Date.parse(grant.expiresAt) <= this.now() ||
        Date.parse(grant.expiresAt) > this.now() + 60000
      )
        throw new Conflict('Admission grants need a fresh lifetime of at most one minute.');
      this.store.setSetting(this.name(run.id), {
        grant,
        consumedAt: current?.consumedAt ?? null,
        retired: false,
      });
      this.store.event('cluster.admission.received', agent.projectId, agent.id, {
        runId: run.id,
        grantId: grant.id,
        decision: grant.decision,
      });
      return remoteAdmissionAcceptedSchema.parse({
        key: input.key,
        accepted: true,
        grantId: grant.id,
        runId: run.id,
        decision: grant.decision,
      });
    });
  }
  reason(run: PrivateRun): string | null {
    const agent = this.store.agent(run.agentId),
      account = this.account(agent.provider),
      current = this.current(run.id);
    if (account?.state !== 'ready' || !account.affinity)
      return account?.message ?? 'This cluster provider account needs native setup.';
    if (
      !current ||
      !this.matches(current.grant) ||
      current.grant.provider !== agent.provider ||
      current.grant.accountAffinity !== account.affinity
    )
      return 'Waiting for controller QUARK admission for this cluster account.';
    if (current.grant.decision !== 'allow')
      return current.grant.reason || 'Controller QUARK is holding this work.';
    if (current.retired)
      return 'This unused grant was retired. Waiting for fresh controller admission.';
    const candidate = this.candidate(run);
    if (!candidate || remoteRequestHash(candidate) !== current.grant.requestHash)
      return 'The prepared request changed. Waiting for matching controller admission.';
    if (current.consumedAt)
      return run.status === 'running'
        ? null
        : 'This native admission was already consumed. Inspect its saved outcome.';
    if (Date.parse(current.grant.expiresAt) <= this.now() + 1000)
      return 'Controller QUARK admission expired. The saved input is waiting for a fresh grant.';
    return null;
  }
  /** Called in the same Store transaction as local reservation, immediately before native dispatch. */
  consume(run: PrivateRun): boolean {
    if (this.reason(run)) return false;
    const current = this.current(run.id)!;
    if (current.consumedAt || run.status !== 'queued') return false;
    this.store.setSetting(this.name(run.id), {
      ...current,
      consumedAt: new Date(this.now()).toISOString(),
    });
    this.store.event(
      'cluster.admission.consumed',
      this.store.agent(run.agentId).projectId,
      run.agentId,
      { runId: run.id, grantId: current.grant.id },
    );
    return true;
  }
  receipts(
    usage: (run: PrivateRun) => { tokens: TokenCounts; basis: 'measured' | 'partial' | 'unknown' },
  ): RemoteAdmissionReceipt[] {
    const id = this.identity;
    const final = this.store.db
      .prepare(
        "SELECT a.value FROM settings a WHERE a.key LIKE ? AND json_extract(a.value,'$.grant.controllerHostId')=? AND json_extract(a.value,'$.grant.remoteHostId')=? AND json_extract(a.value,'$.grant.clusterProjectId')=? AND json_extract(a.value,'$.grant.jobId')=? AND json_extract(a.value,'$.grant.leaseToken')=? AND NOT EXISTS (SELECT 1 FROM settings b WHERE b.key='cluster-admission:ack:' || json_extract(a.value,'$.grant.id')) ORDER BY a.rowid LIMIT 64",
      )
      .all(
        'cluster-admission:final:%',
        id.controllerHostId,
        id.remoteHostId,
        id.clusterProjectId,
        id.jobId,
        id.leaseToken,
      )
      .map((row) => savedReceipt.parse(JSON.parse(String(row.value))).receipt);
    const active = this.store.db
      .prepare(
        "SELECT a.value FROM settings a WHERE a.key LIKE ? AND json_extract(a.value,'$.consumedAt') IS NOT NULL AND json_extract(a.value,'$.grant.controllerHostId')=? AND json_extract(a.value,'$.grant.remoteHostId')=? AND json_extract(a.value,'$.grant.clusterProjectId')=? AND json_extract(a.value,'$.grant.jobId')=? AND json_extract(a.value,'$.grant.leaseToken')=? AND NOT EXISTS (SELECT 1 FROM settings b WHERE b.key IN ('cluster-admission:ack:' || json_extract(a.value,'$.grant.id'),'cluster-admission:final:' || json_extract(a.value,'$.grant.id'))) ORDER BY json_extract(a.value,'$.consumedAt') LIMIT ?",
      )
      .all(
        'cluster-admission:run:%',
        id.controllerHostId,
        id.remoteHostId,
        id.clusterProjectId,
        id.jobId,
        id.leaseToken,
        64 - final.length,
      )
      .flatMap((row) => {
        const saved = savedGrant.parse(JSON.parse(String(row.value)));
        if (!this.matches(saved.grant)) return [];
        const run = this.store.run(saved.grant.runId);
        const previous = this.store.getSetting(`cluster-admission:receipt:${saved.grant.id}`);
        if (previous) return [remoteAdmissionReceiptSchema.parse(previous)];
        if (!saved.consumedAt) return [];
        const state =
          run.status === 'completed'
            ? 'complete'
            : ['failed', 'cancelled'].includes(run.status)
              ? 'failed'
              : run.status === 'running'
                ? 'running'
                : 'interrupted';
        const measured = usage(run);
        const receipt = remoteAdmissionReceiptSchema.parse({
          grantId: saved.grant.id,
          runId: run.id,
          provider: saved.grant.provider,
          accountAffinity: saved.grant.accountAffinity,
          state,
          startedAt: saved.consumedAt,
          finishedAt: state === 'running' ? null : new Date(this.now()).toISOString(),
          usage: measured.tokens,
          basis: measured.basis,
        });
        if (state !== 'running')
          this.store.transaction(() => this.saveReceipt(saved.grant, receipt));
        return [receipt];
      });
    return [...final, ...active];
  }
  revoke(raw: unknown) {
    const input = remoteAdmissionPushSchema.parse(raw);
    const current = this.dispositionBinding(input.grant);
    if (current?.grant.id === input.grant.id && current.consumedAt)
      return { state: 'consumed' as const, receipt: null };
    return { state: 'unused' as const, receipt: this.dispose(raw, true) };
  }
  dispose(raw: unknown, revokeLive = false) {
    const input = remoteAdmissionPushSchema.parse(raw),
      grant = input.grant;
    this.dispositionBinding(grant);
    return this.store.operation(
      `cluster-admission:${revokeLive ? 'revoke' : 'dispose'}:${input.key}`,
      input,
      () => {
        const current = this.dispositionBinding(grant),
          run = this.store.run(grant.runId);
        if (
          (this.store.agent(run.agentId).projectId !== this.identity.remoteProjectId &&
            this.candidate(run)?.projectId !== this.identity.remoteProjectId) ||
          (current?.consumedAt && current.grant.id === grant.id)
        )
          throw new Conflict(
            'This grant may already have started native work. Reconcile its result.',
          );
        if (
          !['queued', 'cancelled', 'coalesced'].includes(run.status) ||
          (run.status === 'queued' && !revokeLive && Date.parse(grant.expiresAt) > this.now())
        )
          throw new Conflict(
            'Unused disposition requires a cancelled/coalesced run or an expired unconsumed grant.',
          );
        const previous = this.store.getSetting(`cluster-admission:receipt:${grant.id}`);
        if (previous) return remoteAdmissionReceiptSchema.parse(previous);
        if (!current || current.grant.id === grant.id)
          this.store.setSetting(this.name(run.id), { grant, consumedAt: null, retired: true });
        const zeros = {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        };
        const receipt = remoteAdmissionReceiptSchema.parse({
          grantId: grant.id,
          runId: run.id,
          provider: grant.provider,
          accountAffinity: grant.accountAffinity,
          state: 'unused',
          startedAt: null,
          finishedAt: new Date(this.now()).toISOString(),
          usage: zeros,
          basis: 'measured',
        });
        this.saveReceipt(grant, receipt);
        return receipt;
      },
    );
  }
  acknowledge(raw: unknown) {
    const input = z
      .object({ key: z.uuid(), grantIds: z.array(z.uuid()).max(64) })
      .strict()
      .parse(raw);
    return this.store.operation(`cluster-admission:acknowledge:${input.key}`, input, () => {
      for (const id of input.grantIds) {
        if (!this.store.getSetting(`cluster-admission:receipt:${id}`))
          throw new Conflict('Only a saved final receipt can be acknowledged.');
        this.store.setSetting(`cluster-admission:ack:${id}`, true);
      }
      return { key: input.key, acknowledged: input.grantIds };
    });
  }
}
