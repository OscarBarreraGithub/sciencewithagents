import {
  GroupDocumentTransport,
  GroupDocumentTransportCapacity,
} from './group-document-transport.js';
import type { DocumentTransportResult } from '@dock/shared/dist/group-document-transport.js';
import { DeliveryStorage, type RevocationFailure } from './delivery.js';
import { type DeliveryEnvelope, type DeliveryResult } from '@dock/shared/dist/group-delivery.js';
import { DurableObject } from 'cloudflare:workers';
import {
  MEMBERSHIP_LIMITS as L,
  membershipEnvelopeSchema,
  membershipReplySchema,
  membershipIdentitySchema,
  type MembershipEnvelope,
  type MembershipIdentity,
  type MembershipReply,
  type MembershipResult,
  type MembershipFailure,
} from '@dock/shared/dist/group-membership.js';
import {
  capabilityHash,
  digest,
  equalHash,
  setupHash,
  hostingEnvironment,
  creationGroupId,
} from './crypto.js';
import { SCHEMA } from './schema.js';
import { MEMBERSHIP_CAPACITY as C } from './capacity.js';
import {
  GroupActionsService,
  groupActionEnvelopeSchema,
} from '@dock/shared/dist/group-actions-service.js';
import {
  GroupActionsCapacityExceeded,
  type GroupActionsSql,
} from '@dock/shared/dist/group-actions-authority.js';
import {
  verifyGroupOwnedTask,
  verifyGroupManager,
} from '@dock/shared/dist/group-actions-attestation.js';
import type { GroupActionResult } from '@dock/shared/dist/group-actions.js';
import { GroupPromotionHost, GroupPromotionHostCapacity } from './group-promotion-host.js';
import type { GroupPromotionHostResult } from '@dock/shared/dist/group-promotion-host.js';
import { verifyWorkerBetaAdmission } from './group-beta-admission.js';

type Enrollment = {
  position: number;
  member_id: string;
  installation_id: string;
  credential_hash: string;
  display_name: string;
  state: string;
  invite_id: string | null;
  confirmation_hash: string | null;
};
type Invite = { invite_id: string; issuer_id: string; expires_at: number; state: string };
type Metadata = { group_id: string; operations: number; day: number; day_mutations: number };
class Rejection extends Error {
  constructor(readonly code: MembershipFailure) {
    super(code);
  }
}
function reject(code: MembershipFailure): never {
  throw new Rejection(code);
}

export class GroupMembership extends DurableObject<Env> {
  private readonly deliveryStorage: DeliveryStorage;
  private actionsService?: GroupActionsService;
  private promotionService?: GroupPromotionHost;
  private documentsService?: GroupDocumentTransport;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(SCHEMA).toArray();
    });
    this.deliveryStorage = new DeliveryStorage(ctx.storage);
  }

  async deliver(input: DeliveryEnvelope): Promise<DeliveryResult> {
    try {
      if (!this.rows('SELECT singleton FROM metadata WHERE singleton=1')[0])
        return { ok: false, error: 'denied' };
    } catch {
      return { ok: false, error: 'unavailable' };
    }
    return this.deliveryStorage.execute(input, this.ctx, this.env);
  }

  async documents(input: unknown): Promise<DocumentTransportResult> {
    if (
      !hostingEnvironment(this.env) ||
      !input ||
      typeof input !== 'object' ||
      !('groupId' in input) ||
      typeof input.groupId !== 'string' ||
      !this.ctx.id.equals(this.env.GROUPS.idFromName(input.groupId))
    )
      return { ok: false, error: 'denied' };
    try {
      if (!this.rows('SELECT singleton FROM metadata WHERE singleton=1')[0])
        return { ok: false, error: 'denied' };
      this.documentsService ??= new GroupDocumentTransport(this.ctx.storage, {
        probe: () => this.deliveryStorage.probe(),
        admitMutation: () => {
          const now = Date.now(),
            day = Math.floor(now / 86400000);
          try {
            this.admit(this.rows<Metadata>('SELECT * FROM metadata WHERE singleton=1')[0], now);
          } catch (error) {
            if (error instanceof Rejection && error.code === 'limit')
              throw new GroupDocumentTransportCapacity();
            throw error;
          }
          this.rows(
            'UPDATE metadata SET operations=operations+1,day_mutations=CASE WHEN day=? THEN day_mutations+1 ELSE 1 END,day=? WHERE singleton=1',
            day,
            day,
          );
        },
      });
      const result = await this.documentsService.execute(input);
      await this.ctx.storage.sync();
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof GroupDocumentTransportCapacity ? 'limit' : 'unavailable',
      };
    }
  }

  async promote(input: unknown): Promise<GroupPromotionHostResult> {
    if (
      !hostingEnvironment(this.env) ||
      !input ||
      typeof input !== 'object' ||
      !('groupId' in input) ||
      typeof input.groupId !== 'string' ||
      !this.ctx.id.equals(this.env.GROUPS.idFromName(input.groupId))
    )
      return { ok: false, error: 'denied' };
    try {
      if (!this.rows('SELECT singleton FROM metadata WHERE singleton=1')[0])
        return { ok: false, error: 'denied' };
      this.promotionService ??= new GroupPromotionHost(this.ctx.storage, {
        probe: () => this.deliveryStorage.probe(),
        checkCapacity: () => {
          if (this.deliveryStorage.normalSize() > C.normalDatabaseBytes)
            throw new GroupPromotionHostCapacity();
        },
        admitMutation: () => {
          const now = Date.now(),
            day = Math.floor(now / 86_400_000);
          try {
            this.admit(this.rows<Metadata>('SELECT * FROM metadata WHERE singleton=1')[0], now);
          } catch (error) {
            if (error instanceof Rejection && error.code === 'limit')
              throw new GroupPromotionHostCapacity();
            throw error;
          }
          this.rows(
            'UPDATE metadata SET operations=operations+1,day_mutations=CASE WHEN day=? THEN day_mutations+1 ELSE 1 END,day=? WHERE singleton=1',
            day,
            day,
          );
        },
      });
      const result = await this.promotionService.execute(input);
      await this.ctx.storage.sync();
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof GroupPromotionHostCapacity ? 'limit' : 'unavailable',
      };
    }
  }

  /** Same object, membership ledger, SQL transaction and normal-write reserve
   * as delivery. No independent feature database or enrollment cache. */
  async actions(input: unknown): Promise<GroupActionResult> {
    const parsed = groupActionEnvelopeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    const groupId = parsed.data.groupId;
    if (!hostingEnvironment(this.env) || !this.ctx.id.equals(this.env.GROUPS.idFromName(groupId)))
      return { ok: false, error: 'denied' };
    try {
      if (!this.rows('SELECT singleton FROM metadata WHERE singleton=1')[0])
        return { ok: false, error: 'denied' };
      if (!this.actionsService) {
        const sql: GroupActionsSql = {
          rows: <T>(query: string, ...bindings: (string | number | null)[]) =>
            this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
          transaction: <T>(fn: () => T) =>
            this.ctx.storage.transactionSync(() => {
              const result = fn();
              if (this.deliveryStorage.normalSize() > C.normalDatabaseBytes)
                throw new GroupActionsCapacityExceeded();
              return result;
            }),
          initialize: (schema) => {
            this.ctx.storage.sql.exec(schema).toArray();
          },
        };
        this.actionsService = new GroupActionsService(groupId, {
          sql,
          credentialHash: (id, credential) => capabilityHash(id, 'installation', credential),
          hostingEnabled: () => hostingEnvironment(this.env),
          matchesObject: (id) => this.ctx.id.equals(this.env.GROUPS.idFromName(id)),
          probeDelivery: () => this.deliveryStorage.probe(),
          admitMutation: () => {
            const now = Date.now(),
              day = Math.floor(now / 86_400_000);
            const meta = this.rows<Metadata>('SELECT * FROM metadata WHERE singleton=1')[0];
            try {
              this.admit(meta, now);
            } catch (error) {
              if (error instanceof Rejection && error.code === 'limit')
                throw new GroupActionsCapacityExceeded();
              throw error;
            }
            this.rows(
              'UPDATE metadata SET operations=operations+1,day_mutations=CASE WHEN day=? THEN day_mutations+1 ELSE 1 END,day=? WHERE singleton=1',
              day,
              day,
            );
          },
          verifyOwnedTask: (command, actor) => verifyGroupOwnedTask(sql, command, actor),
          verifyManager: (origin, actor, work) => verifyGroupManager(sql, origin, actor, work),
        });
      }
      const result = await this.actionsService.execute(parsed.data);
      await this.ctx.storage.sync();
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof GroupActionsCapacityExceeded ? 'limit' : 'unavailable',
      };
    }
  }

  // Membership RPC entry. Input errors and storage exceptions never cross RPC as stacks.
  async execute(input: MembershipEnvelope): Promise<MembershipResult> {
    let failedRevoke: RevocationFailure | undefined;
    try {
      if (!hostingEnvironment(this.env)) return { ok: false, error: 'hosting_disabled' };
      // Bound internal callers as well as HTTP, before parsing/crypto/storage work.
      if (new TextEncoder().encode(JSON.stringify(input)).length > L.bodyBytes) reject('invalid');
      const parsed = membershipEnvelopeSchema.safeParse(input);
      if (!parsed.success) reject('invalid');
      const { groupId, credential, setupCapability, betaAdmission, command } = parsed.data;
      if (!this.ctx.id.equals(this.env.GROUPS.idFromName(groupId))) reject('denied');
      const beta =
        betaAdmission === undefined
          ? undefined
          : await verifyWorkerBetaAdmission(betaAdmission, this.env).catch(() => reject('denied'));
      if (beta && beta.payload.groupId !== groupId) reject('denied');
      const credentialHash = await capabilityHash(groupId, 'installation', credential);
      const secretHash =
        'inviteSecret' in command
          ? await capabilityHash(groupId, 'invite', command.inviteSecret)
          : null;
      const confirmationHash =
        'confirmation' in command
          ? await capabilityHash(groupId, 'confirmation', command.confirmation)
          : null;
      const setupDigest = setupCapability === undefined ? null : await setupHash(setupCapability);
      const setupValid =
        setupDigest !== null &&
        (beta
          ? equalHash(setupDigest, beta.payload.createCapabilityHash) &&
            command.kind === 'initialize' &&
            command.operationId === beta.payload.createOperationId
          : equalHash(setupDigest, this.env.GROUP_SETUP_HASH));
      if (
        command.kind === 'initialize' &&
        (!setupValid || groupId !== (await creationGroupId(setupDigest!, command.operationId)))
      )
        reject('denied');
      if (command.kind !== 'initialize' && setupCapability !== undefined) reject('denied');
      // Canonical parsed key order, hashed secret fields only. Never save the input envelope.
      const sanitized = { ...command };
      if ('inviteSecret' in sanitized) sanitized.inviteSecret = secretHash!;
      if ('confirmation' in sanitized) sanitized.confirmation = confirmationHash!;
      const requestHash = await digest(JSON.stringify([groupId, sanitized]));
      const now = Date.now();
      // Recovery may initialize/migrate delivery and cache its ready state. Commit
      // that schema independently so a later rejected membership transaction
      // cannot roll it back while leaving the in-memory cache ready.
      if (command.kind !== 'revoke') this.deliveryStorage.recover();
      const result = this.ctx.storage.transactionSync(() => {
        const meta = this.rows<Metadata>(
          'SELECT group_id,operations,day,day_mutations FROM metadata WHERE singleton=1',
        )[0];
        if (meta && meta.group_id !== groupId) reject('denied');
        const actor = this.rows<Enrollment>(
          'SELECT * FROM enrollments WHERE credential_hash=?',
          credentialHash,
        )[0];
        // Recheck authorization inside the transaction BEFORE considering a receipt.
        if (command.kind === 'initialize') {
          if (meta && actor?.state !== 'active') reject(beta ? 'conflict' : 'denied');
        } else if (command.kind === 'join') {
          if (!meta || actor?.state === 'revoked') reject('denied');
        } else if (command.kind === 'status') {
          if (!meta || !actor || actor.state === 'revoked') reject('denied');
        } else if (!meta || actor?.state !== 'active') reject('denied');

        if (command.kind !== 'revoke') {
          // Authorization is still checked before the transactional write probe.
          this.deliveryStorage.probe();
        }

        if ('operationId' in command) {
          const receipt = this.rows<{ request_hash: string; response: string }>(
            'SELECT request_hash,response FROM receipts WHERE credential_hash=? AND operation_id=?',
            credentialHash,
            command.operationId,
          )[0];
          if (receipt) {
            if (!equalHash(receipt.request_hash, requestHash)) reject('conflict');
            // Join receipts require the enrolled credential, including pending auth; no invite-only replay.
            if (!actor || actor.state === 'revoked') reject('denied');
            const response = membershipReplySchema.parse(JSON.parse(receipt.response));
            // Approval receipts cannot report a subsequently revoked enrollment as active.
            if (command.kind === 'approve') {
              const target = this.enrollment(command.installationId);
              if (!target || target.state !== 'active') reject('denied');
            }
            if (command.kind === 'revoke')
              this.deliveryStorage.resolveRevocation(command.installationId);
            return { ok: true as const, value: response };
          }
          if (command.kind === 'initialize' && meta) reject('denied');
          if (command.kind === 'initialize' && beta) {
            // Existing exact creator/body receipts above survive expiry and key retirement.
            if (beta.state !== 'create+route') reject('creation_expired');
            if (now < beta.payload.issuedAt) reject('unavailable');
            if (now > beta.payload.createExpiresAt) reject('creation_expired');
          }
          if (command.kind === 'join' && actor) reject('denied');
          // Only a new join authenticates its invitation. An authenticated same-ID
          // receipt above must remain recoverable after the invitation expires.
          if (command.kind === 'join') this.validInvite(secretHash!, now);
          // Each lifetime enrollment can transition to revoked only once. Invalid
          // targets and changed-key repeats fail atomically without consuming reserve.
          if (command.kind !== 'revoke') this.admit(meta, now);
        }

        let response: MembershipReply;
        let actorId = actor?.installation_id;
        let targetId: string | undefined;
        switch (command.kind) {
          case 'initialize': {
            this.rows(
              'INSERT INTO metadata(singleton,group_id,group_name,day) VALUES(1,?,?,?)',
              groupId,
              command.groupName,
              Math.floor(now / 86_400_000),
            );
            const created = this.insertEnrollment(
              credentialHash,
              command.displayName,
              'active',
              null,
              null,
            );
            actorId = created.installation_id;
            targetId = created.installation_id;
            response = { kind: 'identity', identity: this.identity(groupId, created) };
            break;
          }
          case 'invite': {
            this.boundCount(
              'SELECT count(*) AS n FROM invitations WHERE state IN (?,?) AND expires_at>?',
              L.openInvites,
              'open',
              'consumed',
              now,
            );
            const inviteId = crypto.randomUUID();
            const expiresAt = now + command.ttlSeconds * 1000;
            if (this.rows('SELECT invite_id FROM invitations WHERE secret_hash=?', secretHash!)[0])
              reject('conflict');
            this.rows(
              'INSERT INTO invitations(invite_id,secret_hash,issuer_id,expires_at,state) VALUES(?,?,?,?,?)',
              inviteId,
              secretHash!,
              actorId!,
              expiresAt,
              'open',
            );
            targetId = inviteId;
            response = { kind: 'invitation', inviteId, expiresAt };
            break;
          }
          case 'join': {
            const invite = this.validInvite(secretHash!, now);
            this.boundCount(
              'SELECT count(*) AS n FROM enrollments WHERE state=?',
              L.members,
              'active',
            );
            this.boundCount('SELECT count(*) AS n FROM enrollments', L.enrollments);
            const joined = this.insertEnrollment(
              credentialHash,
              command.displayName,
              'active',
              invite.invite_id,
              confirmationHash,
            );
            actorId = joined.installation_id;
            targetId = joined.installation_id;
            response = { kind: 'identity', identity: this.identity(groupId, joined) };
            break;
          }
          case 'approve': {
            const target = this.enrollment(command.installationId);
            if (
              !target ||
              target.state === 'revoked' ||
              !target.confirmation_hash ||
              !equalHash(target.confirmation_hash, confirmationHash!)
            )
              reject('denied');
            // Older hosts may still confirm an already accepted link. Preserve
            // their exact idempotent request without changing active membership.
            if (target.state === 'active') {
              targetId = target.installation_id;
              response = { kind: 'identity', identity: this.identity(groupId, target) };
              break;
            }
            const invite = this.rows<Invite>(
              'SELECT invite_id,issuer_id,expires_at,state FROM invitations WHERE invite_id=?',
              target.invite_id!,
            )[0];
            // Expiry gates the initial join. A consumed invitation already
            // admitted this exact pending enrollment; confirmation and revocation
            // checks still govern approval after that original join deadline.
            if (
              !invite ||
              invite.state !== 'consumed' ||
              this.enrollment(invite.issuer_id)?.state !== 'active'
            )
              reject('denied');
            this.boundCount(
              'SELECT count(*) AS n FROM enrollments WHERE state=?',
              L.members,
              'active',
            );
            this.rows(
              'UPDATE enrollments SET state=? WHERE installation_id=?',
              'active',
              target.installation_id,
            );
            targetId = target.installation_id;
            response = {
              kind: 'identity',
              identity: this.identity(groupId, { ...target, state: 'active' }),
            };
            break;
          }
          case 'revoke': {
            const target = this.enrollment(command.installationId);
            if (!target) reject('denied');
            const marker: RevocationFailure = {
              actorId: actor!.installation_id,
              credentialHash,
              operationId: command.operationId,
              requestHash,
              targetId: command.installationId,
            };
            if (target.state === 'revoked') {
              if (!this.deliveryStorage.recoveredRevocation(marker)) reject('denied');
              this.deliveryStorage.resolveRevocation(command.installationId);
              return {
                ok: true as const,
                value: membershipReplySchema.parse({
                  kind: 'identity',
                  identity: this.identity(groupId, target),
                }),
              };
            }
            failedRevoke = marker;
            this.rows(
              'UPDATE enrollments SET state=? WHERE installation_id=?',
              'revoked',
              target.installation_id,
            );
            // Issuer activity is also checked on every join and approval; bounded update of open invites.
            this.rows(
              'UPDATE invitations SET state=? WHERE issuer_id=? AND state=? AND expires_at>?',
              'revoked',
              target.installation_id,
              'open',
              now,
            );
            targetId = target.installation_id;
            response = {
              kind: 'identity',
              identity: this.identity(groupId, { ...target, state: 'revoked' }),
            };
            break;
          }
          case 'revokeInvite': {
            const invite = this.rows<Invite>(
              'SELECT invite_id,issuer_id,expires_at,state FROM invitations WHERE invite_id=?',
              command.inviteId,
            )[0];
            if (!invite || invite.state === 'revoked') reject('denied');
            this.rows(
              'UPDATE invitations SET state=? WHERE invite_id=?',
              'revoked',
              invite.invite_id,
            );
            targetId = invite.invite_id;
            response = { kind: 'revokedInvite', inviteId: invite.invite_id };
            break;
          }
          case 'status':
            response = {
              kind: 'identity',
              identity: this.identity(
                groupId,
                this.activateAccepted(actor!, actor!.installation_id, now),
              ),
            };
            break;
          case 'roster':
          case 'pending': {
            // Existing installations may already have accepted a link under the
            // previous approval flow. An active member's read reconciles at most
            // the bounded pending set, without reusing a revoked invitation.
            const legacy = this.rows<Enrollment>(
              'SELECT * FROM enrollments WHERE state=? ORDER BY position LIMIT ?',
              'pending',
              L.pending,
            );
            for (const target of legacy) {
              if (!this.acceptedInvitation(target)) continue;
              try {
                this.ctx.storage.transactionSync(() =>
                  this.activateAccepted(target, actor!.installation_id, now),
                );
              } catch (error) {
                if (error instanceof Rejection && error.code === 'limit') break;
                throw error;
              }
            }
            const entries = this.rows<Enrollment>(
              'SELECT * FROM enrollments WHERE state=? AND position>? ORDER BY position LIMIT ?',
              command.kind === 'pending' ? 'pending' : 'active',
              command.after,
              command.limit + 1,
            );
            const hasMore = entries.length > command.limit;
            const page = entries.slice(0, command.limit);
            response = {
              kind: 'members',
              entries: page.map((row) => ({
                position: row.position,
                identity: this.identity(groupId, row),
              })),
              next: hasMore ? page.at(-1)!.position : null,
            };
            break;
          }
          case 'audit': {
            const entries = this.rows<{
              sequence: number;
              kind: string;
              actor_installation_id: string;
              target_id: string;
              recorded_at: number;
            }>(
              'SELECT * FROM audit WHERE sequence>? ORDER BY sequence LIMIT ?',
              command.after,
              command.limit + 1,
            );
            const page = entries.slice(0, command.limit);
            response = membershipReplySchema.parse({
              kind: 'audit',
              entries: page.map((row) => ({
                sequence: row.sequence,
                kind: row.kind,
                actorInstallationId: row.actor_installation_id,
                targetId: row.target_id,
                recordedAt: row.recorded_at,
              })),
              next: entries.length > command.limit ? page.at(-1)!.sequence : null,
            });
            break;
          }
        }
        if (command.kind === 'revoke')
          this.deliveryStorage.resolveRevocation(command.installationId);
        response = membershipReplySchema.parse(response);
        if ('operationId' in command) {
          this.rows(
            'INSERT INTO receipts(credential_hash,operation_id,request_hash,response) VALUES(?,?,?,?)',
            credentialHash,
            command.operationId,
            requestHash,
            JSON.stringify(response),
          );
          this.accountMutation(command.kind, actorId!, targetId!, now);
        }
        return { ok: true as const, value: response };
      });
      await this.ctx.storage.sync();
      return result;
    } catch (error) {
      if (!(error instanceof Rejection)) await this.deliveryStorage.failClosed(failedRevoke);
      return { ok: false, error: error instanceof Rejection ? error.code : 'unavailable' };
    }
  }

  private acceptedInvitation(target: Enrollment): boolean {
    const invite = this.rows<Invite>(
      'SELECT invite_id,issuer_id,expires_at,state FROM invitations WHERE invite_id=?',
      target.invite_id!,
    )[0];
    return (
      !!invite &&
      (invite.state === 'open' || invite.state === 'consumed') &&
      this.enrollment(invite.issuer_id)?.state === 'active'
    );
  }
  private activateAccepted(target: Enrollment, actorId: string, now: number): Enrollment {
    if (target.state !== 'pending') return target;
    if (!this.acceptedInvitation(target)) reject('denied');
    const meta = this.rows<Metadata>('SELECT * FROM metadata WHERE singleton=1')[0];
    this.admit(meta, now);
    this.boundCount('SELECT count(*) AS n FROM enrollments WHERE state=?', L.members, 'active');
    this.rows(
      'UPDATE enrollments SET state=? WHERE installation_id=?',
      'active',
      target.installation_id,
    );
    // The durable pending->active transition makes repeated status/roster reads
    // idempotent. Historical receipts stay append-only; each conversion is audited.
    this.accountMutation('join', actorId, target.installation_id, now);
    return { ...target, state: 'active' };
  }
  private accountMutation(kind: string, actorId: string, targetId: string, now: number): void {
    this.rows(
      'INSERT INTO audit(kind,actor_installation_id,target_id,recorded_at) VALUES(?,?,?,?)',
      kind,
      actorId,
      targetId,
      now,
    );
    const day = Math.floor(now / 86_400_000);
    this.rows(
      'UPDATE metadata SET operations=operations+1,day_mutations=CASE WHEN day=? THEN day_mutations+1 ELSE 1 END,day=? WHERE singleton=1',
      day,
      day,
    );
    // Fence all normal-write growth inside the same rollback transaction.
    if (kind !== 'revoke' && this.deliveryStorage.normalSize() > C.normalDatabaseBytes)
      reject('limit');
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return this.ctx.storage.sql.exec<T>(sql, ...bindings).toArray();
  }
  private enrollment(id: string): Enrollment | undefined {
    return this.rows<Enrollment>('SELECT * FROM enrollments WHERE installation_id=?', id)[0];
  }
  private identity(groupId: string, row: Enrollment): MembershipIdentity {
    return membershipIdentitySchema.parse({
      groupId,
      memberId: row.member_id,
      installationId: row.installation_id,
      displayName: row.display_name,
      state: row.state,
    });
  }
  private insertEnrollment(
    hash: string,
    name: string,
    state: string,
    inviteId: string | null,
    confirmationHash: string | null,
  ): Enrollment {
    return this.rows<Enrollment>(
      'INSERT INTO enrollments(member_id,installation_id,credential_hash,display_name,state,invite_id,confirmation_hash) VALUES(?,?,?,?,?,?,?) RETURNING *',
      crypto.randomUUID(),
      crypto.randomUUID(),
      hash,
      name,
      state,
      inviteId,
      confirmationHash,
    )[0];
  }
  private boundCount(sql: string, limit: number, ...bindings: SqlStorageValue[]): void {
    if (this.rows<{ n: number }>(sql, ...bindings)[0].n >= limit) reject('limit');
  }
  private validInvite(hash: string, now: number): Invite {
    const invite = this.rows<Invite>(
      'SELECT invite_id,issuer_id,expires_at,state FROM invitations WHERE secret_hash=?',
      hash,
    )[0];
    if (
      !invite ||
      (invite.state !== 'open' && invite.state !== 'consumed') ||
      invite.expires_at <= now ||
      this.enrollment(invite.issuer_id)?.state !== 'active'
    )
      reject('denied');
    return invite;
  }
  private admit(meta: Metadata | undefined, now: number): void {
    if ((meta?.operations ?? 0) >= C.normalOperations) reject('limit');
    if (this.deliveryStorage.normalSize() >= C.normalDatabaseBytes) reject('limit');
    // The capacity derivation is for the installed workerd's 4 KiB pages.
    // Do not admit new normal writes if a future runtime changes that format.
    if (this.rows<{ page_size: number }>('PRAGMA page_size')[0].page_size !== C.pageBytes)
      reject('unavailable');
    if (meta?.day === Math.floor(now / 86_400_000) && meta.day_mutations >= L.dailyMutations)
      reject('limit');
  }
}
