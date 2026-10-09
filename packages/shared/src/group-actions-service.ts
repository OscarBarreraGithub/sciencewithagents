import { z } from 'zod';
import { groupIdSchema, groupEventSchema, type GroupEvent } from './groups.js';
import {
  groupActionCommandSchema,
  type GroupActionActor,
  type GroupActionOrigin,
  type GroupActionWork,
  type GroupActionResult,
  type GroupActionHumanConfirmation,
  type GroupActionProposal,
  groupActionHumanConfirmationSchema,
  groupActionRetainedReceiptSchema,
  groupActionActorSchema,
} from './group-actions.js';
import {
  GroupActionsAuthority,
  GroupActionsAccessDenied,
  groupActionsSynchronous,
  type GroupActionsSql,
  type GroupActionsAccountingIntent,
} from './group-actions-authority.js';

export const groupActionEnvelopeSchema = z.strictObject({
  groupId: groupIdSchema,
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  command: groupActionCommandSchema,
});
export const groupActionRetainedEnvelopeSchema = z.strictObject({
  groupId: groupIdSchema,
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: groupActionRetainedReceiptSchema,
});
/** Concrete same-membership-storage adapter. The hosted owner supplies its
 * existing hash/hosting/object/revocation/quota methods, not new auth policy. */
export interface GroupActionsServicePorts {
  sql: GroupActionsSql;
  credentialHash(groupId: string, credential: string): Promise<string>;
  hostingEnabled(): boolean;
  matchesObject(groupId: string): boolean;
  probeDelivery(): void;
  admitMutation(): void;
  /** Same-transaction shared delivery accounting, including first-use DDL. */
  accountStorage<T>(operation: () => T, intent: GroupActionsAccountingIntent): T;
  reserveLifecycle(actionId: string, logicalBytes: number, physicalBytes: number): void;
  releaseLifecycle(actionId: string): void;
  /** Resolve immutable registered source aliases/ownership and committed original
   * hash proof in this DO. A valid header or author UUID alone is insufficient.
   * Called synchronously inside the authoritative transaction, never browser RPC. */
  verifyCommittedSource(
    event: GroupEvent,
    remoteAuthor: Readonly<Pick<GroupActionActor, 'groupId' | 'memberId' | 'installationId'>>,
  ): void;
  /** Required trusted binding of actual normal manager/task to shared native
   * source/goal. No source/session UUID shape is sufficient attestation. */
  verifyManager(
    origin: Extract<GroupActionOrigin, { kind: 'autonomous' }>,
    actor: GroupActionActor,
    work?: GroupActionWork,
  ): void;
  verifyOwnedTask(
    command: Extract<z.infer<typeof groupActionCommandSchema>, { kind: 'register-work' }>,
    actor: GroupActionActor,
  ): void;
}
type Enrollment = {
  member_id: string;
  installation_id: string;
  display_name: string;
  state: string;
};
export class GroupActionsService {
  readonly authority: GroupActionsAuthority;
  constructor(
    private readonly groupId: string,
    private readonly ports: GroupActionsServicePorts,
  ) {
    groupIdSchema.parse(groupId);
    this.authority = new GroupActionsAuthority(ports.sql, groupId);
  }
  async execute(raw: unknown): Promise<GroupActionResult> {
    return this.executeInternal(raw, false);
  }
  /** Mounted only by the protected host's authenticated owner/paired-device
   * confirmation route. Generic native commands cannot mint this receipt. */
  async confirmHuman(raw: unknown): Promise<GroupActionResult> {
    const parsed = groupActionEnvelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.command.kind !== 'confirm')
      return { ok: false, error: 'invalid' };
    return this.executeInternal(parsed.data, true);
  }
  private humanProof(
    proposal: GroupActionProposal,
    command: Extract<z.infer<typeof groupActionCommandSchema>, { kind: 'confirm' }>,
    actor: GroupActionActor,
    create: boolean,
  ): GroupActionHumanConfirmation {
    const request = JSON.stringify([proposal, command, actor]);
    const prior = this.ports.sql.rows<{ request: string; body: string }>(
      'SELECT request,body FROM ga_human_confirmations WHERE installation_id=? AND operation_id=?',
      actor.installationId,
      command.operationId,
    )[0];
    if (prior) {
      if (prior.request !== request) throw new GroupActionsAccessDenied();
      return groupActionHumanConfirmationSchema.parse(JSON.parse(prior.body));
    }
    if (
      !create ||
      !command.override ||
      proposal.actor.memberId !== actor.memberId ||
      proposal.actor.installationId !== actor.installationId
    )
      throw new GroupActionsAccessDenied();
    const proof = groupActionHumanConfirmationSchema.parse({
      receiptId: crypto.randomUUID(),
      proposalId: proposal.proposalId,
      revision: command.expectedRevision,
      operationId: command.operationId,
      confirmedBy: actor,
      at: new Date().toISOString(),
    });
    this.ports.sql.rows(
      'INSERT INTO ga_human_confirmations VALUES(?,?,?,?)',
      actor.installationId,
      command.operationId,
      request,
      JSON.stringify(proof),
    );
    return proof;
  }
  private async executeInternal(raw: unknown, human: boolean): Promise<GroupActionResult> {
    const parsed = groupActionEnvelopeSchema.safeParse(raw);
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).length > 12_000)
      return { ok: false, error: 'invalid' };
    if (parsed.data.groupId !== this.groupId) return { ok: false, error: 'denied' };
    try {
      if (
        !groupActionsSynchronous(this.ports.hostingEnabled()) ||
        !groupActionsSynchronous(this.ports.matchesObject(this.groupId))
      )
        return { ok: false, error: 'denied' };
      const hash = await this.ports.credentialHash(this.groupId, parsed.data.credential);
      // No awaits after hashing: membership+revocation+source+CAS all share txn.
      return this.authority.execute(parsed.data.command, {
        authorize: () => {
          if (
            !groupActionsSynchronous(this.ports.hostingEnabled()) ||
            !groupActionsSynchronous(this.ports.matchesObject(this.groupId))
          )
            throw new GroupActionsAccessDenied();
          groupActionsSynchronous(this.ports.probeDelivery());
          const meta = this.ports.sql.rows<{ group_id: string }>(
            'SELECT group_id FROM metadata WHERE singleton=1',
          )[0];
          const row = this.ports.sql.rows<Enrollment>(
            'SELECT member_id,installation_id,display_name,state FROM enrollments WHERE credential_hash=?',
            hash,
          )[0];
          if (meta?.group_id !== this.groupId || !row || row.state !== 'active')
            throw new GroupActionsAccessDenied();
          return {
            groupId: parsed.data.groupId,
            memberId: row.member_id as GroupActionActor['memberId'],
            installationId: row.installation_id as GroupActionActor['installationId'],
            displayName: row.display_name,
          };
        },
        requireActive: (actor) => {
          const row = this.ports.sql.rows<Enrollment>(
            'SELECT member_id,installation_id,display_name,state FROM enrollments WHERE installation_id=?',
            actor.installationId,
          )[0];
          if (
            actor.groupId !== this.groupId ||
            row?.member_id !== actor.memberId ||
            row.state !== 'active'
          )
            throw new GroupActionsAccessDenied();
          groupActionsSynchronous(this.ports.probeDelivery());
        },
        admitMutation: () => this.ports.admitMutation(),
        accountStorage: (operation, intent) => this.ports.accountStorage(operation, intent),
        reserveLifecycle: (...args) => this.ports.reserveLifecycle(...args),
        releaseLifecycle: (actionId) => this.ports.releaseLifecycle(actionId),
        requireHumanConfirmation: (...args) => this.humanProof(...args, human),
        membership: (actor) => {
          groupActionsSynchronous(this.ports.probeDelivery());
          const row = this.ports.sql.rows<Enrollment>(
            'SELECT member_id,installation_id,display_name,state FROM enrollments WHERE installation_id=?',
            actor.installationId,
          )[0];
          if (actor.groupId !== this.groupId || row?.member_id !== actor.memberId)
            return 'unavailable';
          return row.state === 'active'
            ? 'active'
            : row.state === 'revoked'
              ? 'revoked'
              : 'unavailable';
        },
        verifyWorkRegistration: (command, actor) => {
          groupActionsSynchronous(this.ports.verifyOwnedTask(command, actor));
          if (this.sharedEvidence(command.sharedGoalId).event.category !== 'Instruction')
            throw new GroupActionsAccessDenied();
        },
        verifyOrigin: (origin, actor, work) => {
          const source = this.sharedEvidence(origin.eventId);
          if (
            source.author.installation_id !== actor.installationId ||
            source.author.member_id !== actor.memberId
          )
            throw new GroupActionsAccessDenied();
          if (origin.kind === 'instruction') {
            if (source.event.category !== 'Instruction') throw new GroupActionsAccessDenied();
          } else {
            if (
              !['Decision', 'Action'].includes(source.event.category) ||
              source.event.scope.source.provider === 'owner' ||
              !source.event.scope.causalRefs.includes(origin.sharedGoalId) ||
              (work &&
                (origin.sharedGoalId !== work.sharedGoalId || origin.managerId !== work.managerId))
            )
              throw new GroupActionsAccessDenied();
            this.sharedEvidence(origin.sharedGoalId);
            groupActionsSynchronous(this.ports.verifyManager(origin, actor, work));
          }
        },
      });
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  }
  /** Receipt-only lane: the exact retained enrollment capability identifies the
   * original owner even after revocation. It grants no new native operation. */
  async reconcile(raw: unknown): Promise<GroupActionResult> {
    const parsed = groupActionRetainedEnvelopeSchema.safeParse(raw);
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).length > 12000)
      return { ok: false, error: 'invalid' };
    if (parsed.data.groupId !== this.groupId) return { ok: false, error: 'denied' };
    try {
      const hash = await this.ports.credentialHash(this.groupId, parsed.data.credential);
      const membership = (actor: GroupActionActor) => {
        groupActionsSynchronous(this.ports.probeDelivery());
        const row = this.ports.sql.rows<Enrollment>(
          'SELECT * FROM enrollments WHERE installation_id=?',
          actor.installationId,
        )[0];
        return actor.groupId !== this.groupId || row?.member_id !== actor.memberId
          ? ('unavailable' as const)
          : row.state === 'active'
            ? ('active' as const)
            : row.state === 'revoked'
              ? ('revoked' as const)
              : ('unavailable' as const);
      };
      return this.authority.reconcileRetained(parsed.data.receipt.actionId, {
        authorize: () => {
          if (
            !groupActionsSynchronous(this.ports.hostingEnabled()) ||
            !groupActionsSynchronous(this.ports.matchesObject(this.groupId))
          )
            throw new GroupActionsAccessDenied();
          groupActionsSynchronous(this.ports.probeDelivery());
          const meta = this.ports.sql.rows<{ group_id: string }>(
            'SELECT group_id FROM metadata WHERE singleton=1',
          )[0];
          const row = this.ports.sql.rows<Enrollment>(
            'SELECT * FROM enrollments WHERE credential_hash=?',
            hash,
          )[0];
          if (meta?.group_id !== this.groupId || !row || !['active', 'revoked'].includes(row.state))
            throw new GroupActionsAccessDenied();
          return groupActionActorSchema.parse({
            groupId: this.groupId,
            memberId: row.member_id,
            installationId: row.installation_id,
            displayName: row.display_name,
          });
        },
        membership,
        accountStorage: (operation, intent) => this.ports.accountStorage(operation, intent),
        releaseLifecycle: (id) => this.ports.releaseLifecycle(id),
        verifyOwnerReceipt: (action, work, owner) => {
          const proof = parsed.data.receipt;
          if (
            proof.actionId !== action.actionId ||
            proof.revision !== action.revision ||
            proof.owner.groupId !== owner.groupId ||
            proof.owner.memberId !== owner.memberId ||
            proof.owner.installationId !== owner.installationId ||
            proof.outcome.taskId !== work.taskId
          )
            throw new GroupActionsAccessDenied();
          const body = JSON.stringify(proof);
          const prior = this.ports.sql.rows<{ body: string }>(
            'SELECT body FROM ga_retained_receipts WHERE receipt_id=? OR action_id=?',
            proof.receiptId,
            proof.actionId,
          )[0];
          if (prior && prior.body !== body) throw new GroupActionsAccessDenied();
          if (!prior)
            this.ports.sql.rows(
              'INSERT INTO ga_retained_receipts VALUES(?,?,?)',
              proof.receiptId,
              proof.actionId,
              body,
            );
          return proof;
        },
      });
    } catch {
      return { ok: false, error: 'unavailable' };
    }
  }
  private sharedEvidence(eventId: string) {
    const row = this.ports.sql.rows<{ header: string; installation_id: string; member_id: string }>(
      `SELECT o.header,a.installation_id,a.member_id FROM delivery_operations o JOIN delivery_authors a ON a.operation_id=o.operation_id WHERE o.event_id=? AND o.state='committed'`,
      eventId,
    )[0];
    if (!row) throw new GroupActionsAccessDenied();
    const header = z.object({ event: groupEventSchema }).parse(JSON.parse(row.header));
    if (header.event.eventId !== eventId || header.event.scope.visibility !== 'shared')
      throw new GroupActionsAccessDenied();
    groupActionsSynchronous(
      this.ports.verifyCommittedSource(header.event, {
        groupId: groupIdSchema.parse(this.groupId),
        memberId: row.member_id as GroupActionActor['memberId'],
        installationId: row.installation_id as GroupActionActor['installationId'],
      }),
    );
    return { event: header.event, author: row };
  }
}
