import { z } from 'zod';
import { groupIdSchema, groupEventSchema } from './groups.js';
import {
  groupActionCommandSchema,
  type GroupActionActor,
  type GroupActionOrigin,
  type GroupActionWork,
  type GroupActionResult,
} from './group-actions.js';
import {
  GroupActionsAuthority,
  GroupActionsAccessDenied,
  type GroupActionsSql,
} from './group-actions-authority.js';

export const groupActionEnvelopeSchema = z.strictObject({
  groupId: groupIdSchema,
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  command: groupActionCommandSchema,
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
    const parsed = groupActionEnvelopeSchema.safeParse(raw);
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).length > 12_000)
      return { ok: false, error: 'invalid' };
    if (
      !this.ports.hostingEnabled() ||
      parsed.data.groupId !== this.groupId ||
      !this.ports.matchesObject(this.groupId)
    )
      return { ok: false, error: 'denied' };
    try {
      const hash = await this.ports.credentialHash(this.groupId, parsed.data.credential);
      // No awaits after hashing: membership+revocation+source+CAS all share txn.
      return this.authority.execute(parsed.data.command, {
        authorize: () => {
          this.ports.probeDelivery();
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
          this.ports.probeDelivery();
        },
        admitMutation: () => this.ports.admitMutation(),
        verifyWorkRegistration: (command, actor) => {
          this.ports.verifyOwnedTask(command, actor);
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
            this.ports.verifyManager(origin, actor, work);
          }
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
    if (header.event.scope.groupId !== this.groupId || header.event.scope.visibility !== 'shared')
      throw new GroupActionsAccessDenied();
    return { event: header.event, author: row };
  }
}
