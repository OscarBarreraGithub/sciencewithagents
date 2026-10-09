import { groupActionSourceFacts } from './group-actions-facts.js';
import {
  groupActionActorSchema,
  groupActionSchema,
  groupActionHumanConfirmationSchema,
  groupActionLifecycleOperationId,
  GROUP_ACTION_LIMITS,
  groupActionMembershipSchema,
  groupActionRetainedReceiptSchema,
  groupActionCommandSchema,
  groupActionReplySchema,
  type GroupActionActor,
  type GroupActionOrigin,
  type GroupActionWork,
  type GroupActionProposal,
  type GroupAction,
  type GroupActionCommand,
  type GroupActionReply,
  type GroupActionResult,
  type GroupActionInstruction,
  type GroupActionHumanConfirmation,
  type GroupActionMembership,
  type GroupActionRetainedReceipt,
} from './group-actions.js';

/** Synchronous SQL/authorization in ONE authoritative group transaction. The
 * hosted adapter supplies the same membership DO storage, never a local mirror. */
export interface GroupActionsSql {
  rows<T>(sql: string, ...bindings: (string | number | null)[]): T[];
  transaction<T>(fn: () => T): T;
  initialize(schema: string): void;
}
export interface GroupActionsAuthorityAccess {
  authorize(): GroupActionActor;
  admitMutation(): void;
  /** REQUIRED private shared-delivery accounting hook. Called inside transaction
   * after current authorization; measures/charges ALL schema, index, row, receipt
   * and notice growth against the existing shared pools and aggregate fence.
   * Throw on excess so the whole transaction rolls back. No separate pool or
   * spending of the membership reserve; lifecycle capacity shares these pools.
   * Must invoke this fixed internal operation synchronously, exactly once. */
  accountStorage<T>(operation: () => T, intent: GroupActionsAccountingIntent): T;
  /** Current exact REMOTE tuple status. Failed probes remain unavailable, never
   * inferred revocation. This read must share the enclosing transaction. */
  membership(actor: GroupActionActor): GroupActionMembership;
  /** Shared pool reservation persists atomically with confirmation, not a new
   * pool. Lifecycle accounting consumes this reserve; admission cannot spend it. */
  reserveLifecycle(actionId: string, logicalBytes: number, physicalBytes: number): void;
  releaseLifecycle(actionId: string): void;
  /** Existing owner UI's trusted durable human receipt, exact revision/request.
   * An agent/model/browser boolean is NOT this proof. */
  requireHumanConfirmation(
    proposal: GroupActionProposal,
    command: Extract<GroupActionCommand, { kind: 'confirm' }>,
    actor: GroupActionActor,
  ): GroupActionHumanConfirmation;
  /** Verify immutable shared Instruction, or manager Decision under this goal.
   * Question/Idea/private/unrelated evidence MUST be rejected here. */
  verifyWorkRegistration(
    command: Extract<GroupActionCommand, { kind: 'register-work' }>,
    actor: GroupActionActor,
  ): void;
  requireActive(actor: GroupActionActor): void;
  verifyOrigin(origin: GroupActionOrigin, actor: GroupActionActor, work?: GroupActionWork): void;
}
export type GroupActionsAccountingIntent =
  | { kind: 'read' | 'admission' }
  | { kind: 'lifecycle'; actionId: string };
/** Compiled server-only receipt reconciliation. No execution grant, browser
 * command, RPC selector or membership bypass for new work. Original owner's
 * verified retained receipt is required even if that enrollment is now revoked. */
export interface GroupActionsRetainedReceiptAccess {
  authorize(): GroupActionActor;
  membership(actor: GroupActionActor): GroupActionMembership;
  accountStorage<T>(operation: () => T, intent: GroupActionsAccountingIntent): T;
  releaseLifecycle(actionId: string): void;
  verifyOwnerReceipt(
    action: GroupAction,
    work: GroupActionWork,
    owner: GroupActionActor,
  ): GroupActionRetainedReceipt | null;
}
const schema = `
CREATE TABLE IF NOT EXISTS ga_instructions(event_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ga_manager_bindings(manager_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, member_id TEXT NOT NULL, provider TEXT NOT NULL, native_session_id TEXT NOT NULL, session_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS ga_manager_bindings_no_update BEFORE UPDATE ON ga_manager_bindings BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_manager_bindings_no_delete BEFORE DELETE ON ga_manager_bindings BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER IF NOT EXISTS ga_instructions_no_update BEFORE UPDATE ON ga_instructions BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_instructions_no_delete BEFORE DELETE ON ga_instructions BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE IF NOT EXISTS ga_work(work_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ga_proposals(proposal_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ga_actions(action_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ga_actions_work ON ga_actions(work_id);
CREATE TABLE IF NOT EXISTS ga_receipts(installation_id TEXT NOT NULL, operation_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(installation_id,operation_id));
CREATE TABLE IF NOT EXISTS ga_events(position INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ga_notices(notice_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, action_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ga_human_confirmations(installation_id TEXT NOT NULL,operation_id TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(installation_id,operation_id));
CREATE TRIGGER IF NOT EXISTS ga_human_confirmations_no_update BEFORE UPDATE ON ga_human_confirmations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_human_confirmations_no_delete BEFORE DELETE ON ga_human_confirmations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE IF NOT EXISTS ga_retained_receipts(receipt_id TEXT PRIMARY KEY,action_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS ga_retained_receipts_no_update BEFORE UPDATE ON ga_retained_receipts BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_retained_receipts_no_delete BEFORE DELETE ON ga_retained_receipts BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE INDEX IF NOT EXISTS ga_notices_member ON ga_notices(member_id);
CREATE TRIGGER IF NOT EXISTS ga_events_no_update BEFORE UPDATE ON ga_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_events_no_delete BEFORE DELETE ON ga_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_proposals_no_update BEFORE UPDATE ON ga_proposals BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_proposals_no_delete BEFORE DELETE ON ga_proposals BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_receipts_no_update BEFORE UPDATE ON ga_receipts BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_receipts_no_delete BEFORE DELETE ON ga_receipts BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_notices_no_update BEFORE UPDATE ON ga_notices BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER IF NOT EXISTS ga_notices_no_delete BEFORE DELETE ON ga_notices BEGIN SELECT RAISE(ABORT,'immutable'); END;
`;
export class GroupActionsAccessDenied extends Error {}
export class GroupActionsStorageLimit extends Error {}
/** Retained name for existing membership/host adapters. */
export class GroupActionsCapacityExceeded extends GroupActionsStorageLimit {}
/** Reject accidental asynchronous trusted adapters before proceeding to SQL.
 * Absorb a rejected Promise from a broken adapter without awaiting it. */
export function groupActionsSynchronous<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value
  ) {
    if (value instanceof Promise) void value.catch(() => {});
    throw new Error('Group actions adapters must be synchronous');
  }
  return value;
}
function fixedSynchronousOperation<T>(hook: (operation: () => T) => T, operation: () => T): T {
  let open = true;
  let calls = 0;
  let completed = false;
  let expected: T;
  try {
    const actual = groupActionsSynchronous(
      hook(() => {
        if (!open || calls++ !== 0) throw new Error('Invalid internal operation invocation');
        expected = operation();
        completed = true;
        return expected;
      }),
    );
    if (calls !== 1 || !completed || actual !== expected!)
      throw new Error('Internal hook did not return its successful operation');
    return actual;
  } finally {
    // Broken adapters cannot defer or retain an operation beyond this sync call.
    open = false;
  }
}
class Rejected extends Error {
  constructor(
    readonly error: 'denied' | 'conflict' | 'stale' | 'limit' | 'invalid' | 'unavailable',
    readonly current?: GroupActionWork,
  ) {
    super(error);
  }
}
const reject = (code: Rejected['error'], current?: GroupActionWork): never => {
  throw new Rejected(code, current);
};
const sameOwner = (a: GroupActionActor, b: GroupActionActor) =>
  a.groupId === b.groupId && a.memberId === b.memberId && a.installationId === b.installationId;
/** This engine is inert until installed at the authoritative service. */
export class GroupActionsAuthority {
  constructor(
    private readonly sql: GroupActionsSql,
    private readonly groupId: string,
    private readonly now = () => new Date().toISOString(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}
  private record<T>(
    table: 'ga_work' | 'ga_proposals' | 'ga_actions',
    key: string,
    value: string,
  ): T {
    const row = this.sql.rows<{ body: string }>(
      `SELECT body FROM ${table} WHERE ${key}=?`,
      value,
    )[0];
    if (!row) reject('denied');
    return JSON.parse(row.body) as T;
  }
  private event(kind: string, entityId: string, body: unknown) {
    const json = JSON.stringify(body);
    if (new TextEncoder().encode(json).length > 24_000) reject('limit');
    return this.sql.rows<{ position: number }>(
      'INSERT INTO ga_events(kind,entity_id,body) VALUES(?,?,?) RETURNING position',
      kind,
      entityId,
      json,
    )[0]!.position;
  }
  private save(action: GroupAction) {
    const position = this.event(action.state, action.actionId, action);
    const body = ['completed', 'superseded', 'revoked'].includes(action.state)
      ? JSON.stringify({
          compacted: true,
          actionId: action.actionId,
          workId: action.proposal.workId,
          state: action.state,
          revision: action.revision,
          position,
        })
      : JSON.stringify(action);
    this.sql.rows('UPDATE ga_actions SET body=? WHERE action_id=?', body, action.actionId);
  }
  private actionBody(body: string): GroupAction {
    const raw = JSON.parse(body) as {
      compacted?: boolean;
      position?: number;
      actionId?: string;
      state?: string;
    };
    if (!raw.compacted) return groupActionSchema.parse(raw);
    const record = this.sql.rows<{ body: string; entity_id: string; kind: string }>(
      'SELECT body,entity_id,kind FROM ga_events WHERE position=?',
      raw.position ?? null,
    )[0];
    if (!record || record.entity_id !== raw.actionId || record.kind !== raw.state) reject('denied');
    return groupActionSchema.parse(JSON.parse(record.body));
  }
  private storedAction(actionId: string): GroupAction {
    const row = this.sql.rows<{ body: string }>(
      'SELECT body FROM ga_actions WHERE action_id=?',
      actionId,
    )[0];
    if (!row) reject('denied');
    return this.actionBody(row.body);
  }
  private status(access: Pick<GroupActionsAuthorityAccess, 'membership'>, actor: GroupActionActor) {
    return groupActionMembershipSchema.parse(groupActionsSynchronous(access.membership(actor)));
  }
  private project(
    action: GroupAction,
    access: Pick<GroupActionsAuthorityAccess, 'membership'>,
  ): GroupAction {
    const authorization = {
      owner: this.status(access, action.proposal.observed.owner),
      requester: this.status(access, action.proposal.actor),
    };
    return {
      ...action,
      authorization,
      state:
        action.state === 'pending-owner' && Object.values(authorization).includes('revoked')
          ? 'revoked'
          : action.state,
    };
  }
  execute(raw: unknown, access: GroupActionsAuthorityAccess): GroupActionResult {
    const parsed = groupActionCommandSchema.safeParse(raw);
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).length > 12_000)
      return { ok: false, error: 'invalid' };
    try {
      return fixedSynchronousOperation(
        (operation) => this.sql.transaction(operation),
        () => {
          const actor = groupActionActorSchema.parse(groupActionsSynchronous(access.authorize())),
            command = parsed.data;
          if (actor.groupId !== this.groupId) reject('denied');
          groupActionsSynchronous(access.requireActive(actor));
          const lifecycle =
            command.kind === 'claim' || command.kind === 'complete' || command.kind === 'uncertain';
          if (
            lifecycle &&
            command.operationId !== groupActionLifecycleOperationId(command.actionId, command.kind)
          )
            reject('invalid');
          // Construction is inert: even first-use DDL requires current authorization
          // and the same shared accounting fence as mutations and receipt writes.
          return fixedSynchronousOperation(
            (operation) =>
              access.accountStorage(
                operation,
                lifecycle
                  ? { kind: 'lifecycle', actionId: command.actionId }
                  : {
                      kind: ['board', 'evidence', 'owner-pending', 'work'].includes(command.kind)
                        ? 'read'
                        : 'admission',
                    },
              ),
            () => {
              groupActionsSynchronous(this.sql.initialize(schema));
              // Auth before receipt lookup; revoked callers can never replay effects/results.
              const request = JSON.stringify([actor.groupId, actor.memberId, command]);
              if (command.kind === 'claim') {
                const a = this.storedAction(command.actionId);
                const w = this.record<GroupActionWork>('ga_work', 'work_id', a.proposal.workId);
                if (!sameOwner(w.owner, actor)) reject('denied');
                groupActionsSynchronous(access.requireActive(a.proposal.actor));
                if (w.revision !== a.revision || w.latest.actionId !== a.actionId)
                  reject('stale', w);
                if (a.proposal.overrideRequired) {
                  const saved = a.humanConfirmation ?? reject('denied');
                  const proof = groupActionHumanConfirmationSchema.parse(
                    groupActionsSynchronous(
                      access.requireHumanConfirmation(
                        a.proposal,
                        {
                          kind: 'confirm',
                          operationId: saved.operationId,
                          proposalId: a.proposal.proposalId,
                          expectedRevision: a.proposal.observed.revision,
                          override: true,
                        },
                        a.proposal.actor,
                      ),
                    ),
                  );
                  groupActionsSynchronous(access.requireActive(proof.confirmedBy));
                  if (
                    proof.receiptId !== saved.receiptId ||
                    proof.operationId !== saved.operationId ||
                    proof.proposalId !== a.proposal.proposalId ||
                    proof.revision !== a.proposal.observed.revision ||
                    !sameOwner(proof.confirmedBy, a.proposal.actor)
                  )
                    reject('denied');
                }
              }
              if ('operationId' in command) {
                const receipt = this.sql.rows<{ request: string; response: string }>(
                  'SELECT request,response FROM ga_receipts WHERE installation_id=? AND operation_id=?',
                  actor.installationId,
                  command.operationId,
                )[0];
                if (receipt) {
                  if (receipt.request !== request) reject('conflict');
                  const result = groupActionReplySchema.parse(JSON.parse(receipt.response));
                  if (result.kind === 'action')
                    result.action = this.storedAction(result.action.actionId);
                  return { ok: true as const, value: result };
                }
                if (!lifecycle) {
                  const counts = this.sql.rows<{ n: number; member: number }>(
                    `SELECT count(*) AS n, coalesce(sum(CASE WHEN json_extract(request,'$[1]')=? THEN 1 ELSE 0 END),0) AS member FROM ga_receipts WHERE json_extract(request,'$[2].kind') NOT IN ('claim','complete','uncertain')`,
                    actor.memberId,
                  )[0]!;
                  if (
                    counts.n >= GROUP_ACTION_LIMITS.retainedAdmissionReceipts ||
                    counts.member >= GROUP_ACTION_LIMITS.memberAdmissionReceipts
                  )
                    reject('limit');
                }
              }
              if (
                !lifecycle &&
                !['board', 'evidence', 'owner-pending', 'work'].includes(command.kind)
              )
                groupActionsSynchronous(access.admitMutation());
              const value = groupActionReplySchema.parse(this.apply(command, actor, access));
              if ('operationId' in command)
                this.sql.rows(
                  'INSERT INTO ga_receipts VALUES(?,?,?,?)',
                  actor.installationId,
                  command.operationId,
                  request,
                  JSON.stringify(value),
                );
              return { ok: true as const, value };
            },
          );
        },
      );
    } catch (e) {
      if (e instanceof GroupActionsAccessDenied) return { ok: false, error: 'denied' };
      if (e instanceof GroupActionsStorageLimit) return { ok: false, error: 'limit' };
      if (e instanceof Rejected)
        return { ok: false, error: e.error, ...(e.current ? { current: e.current } : {}) };
      return { ok: false, error: 'unavailable' };
    }
  }
  /** Receipt-only reconciliation for a retained original owner, including after
   * revocation. This private compiled port cannot start/pause native work. */
  reconcileRetained(
    actionId: string,
    access: GroupActionsRetainedReceiptAccess,
  ): GroupActionResult {
    try {
      groupActionLifecycleOperationId(actionId, 'complete');
      return fixedSynchronousOperation(
        (operation) => this.sql.transaction(operation),
        () => {
          const owner = groupActionActorSchema.parse(groupActionsSynchronous(access.authorize()));
          if (owner.groupId !== this.groupId) reject('denied');
          const status = this.status(access, owner);
          if (status === 'unavailable') reject('unavailable');
          return fixedSynchronousOperation(
            (operation) => access.accountStorage(operation, { kind: 'lifecycle', actionId }),
            () => {
              groupActionsSynchronous(this.sql.initialize(schema));
              const action = this.storedAction(actionId);
              const work = this.record<GroupActionWork>(
                'ga_work',
                'work_id',
                action.proposal.workId,
              );
              if (!sameOwner(work.owner, owner)) reject('denied');
              if (
                !['pending-owner', 'dispatching', 'uncertain', 'completed', 'revoked'].includes(
                  action.state,
                )
              )
                reject('conflict');
              const proof = groupActionRetainedReceiptSchema.parse(
                groupActionsSynchronous(access.verifyOwnerReceipt(action, work, owner)),
              );
              if (
                proof.actionId !== action.actionId ||
                proof.revision !== action.revision ||
                !sameOwner(proof.owner, owner)
              )
                reject('denied');
              if (action.state === 'completed' || action.state === 'revoked') {
                if (
                  (action.reconciliationReceiptId &&
                    action.reconciliationReceiptId !== proof.receiptId) ||
                  JSON.stringify(action.outcome) !== JSON.stringify(proof.outcome)
                )
                  reject('conflict');
                return { ok: true as const, value: { kind: 'action' as const, action } };
              }
              const outcome = proof.outcome;
              if (
                outcome.taskId !== work.taskId ||
                (outcome.status !== 'blocked' &&
                  outcome.status !== (action.proposal.kind === 'start' ? 'started' : 'stopped'))
              )
                reject('conflict');
              if (
                outcome.status === 'blocked' &&
                (outcome.workerId !== null || outcome.jobId !== undefined)
              )
                reject('conflict');
              if ((proof.effect === 'absent') !== (outcome.status === 'blocked'))
                reject('conflict');
              const pending = action.state === 'pending-owner';
              if (
                pending &&
                (proof.effect !== 'absent' ||
                  (status !== 'revoked' &&
                    this.status(access, action.proposal.actor) !== 'revoked'))
              )
                reject('conflict');
              const command = {
                kind: 'complete' as const,
                operationId: actionId,
                actionId,
                outcome,
              };
              const request = JSON.stringify([owner.groupId, owner.memberId, command]);
              action.state = pending ? 'revoked' : 'completed';
              action.outcome = outcome;
              action.reconciliationReceiptId = proof.receiptId;
              this.save(action);
              const value = groupActionReplySchema.parse({ kind: 'action', action });
              this.sql.rows(
                'INSERT INTO ga_receipts VALUES(?,?,?,?)',
                owner.installationId,
                actionId,
                request,
                JSON.stringify(value),
              );
              groupActionsSynchronous(access.releaseLifecycle(actionId));
              return { ok: true as const, value };
            },
          );
        },
      );
    } catch (error) {
      if (error instanceof GroupActionsAccessDenied) return { ok: false, error: 'denied' };
      if (error instanceof Rejected) return { ok: false, error: error.error };
      if (error instanceof GroupActionsStorageLimit) return { ok: false, error: 'limit' };
      return { ok: false, error: 'unavailable' };
    }
  }
  private verify(
    access: GroupActionsAuthorityAccess,
    origin: GroupActionOrigin,
    actor: GroupActionActor,
    work?: GroupActionWork,
  ) {
    if (origin.kind === 'instruction') {
      const row = this.sql.rows<{ body: string }>(
        'SELECT body FROM ga_instructions WHERE event_id=?',
        origin.eventId,
      )[0];
      if (row) {
        const instruction = JSON.parse(row.body) as GroupActionInstruction;
        if (!sameOwner(instruction.actor, actor)) reject('denied');
        return;
      }
    }
    groupActionsSynchronous(access.verifyOrigin(origin, actor, work));
  }
  private apply(
    c: GroupActionCommand,
    actor: GroupActionActor,
    access: GroupActionsAuthorityAccess,
  ): GroupActionReply {
    if (c.kind === 'work') {
      const work = this.record<GroupActionWork>('ga_work', 'work_id', c.workId),
        status = this.status(access, work.owner);
      return {
        kind: 'work',
        work: {
          ...work,
          availability:
            status === 'active'
              ? 'available'
              : status === 'revoked'
                ? 'owner-revoked'
                : 'unavailable',
        },
      };
    }
    if (c.kind === 'evidence') {
      const rows = this.sql.rows<{
        position: number;
        kind: string;
        entity_id: string;
        body: string;
      }>(
        `SELECT position,kind,entity_id,body FROM ga_events WHERE position>?
         AND kind<>'override-notice' ORDER BY position LIMIT ?`,
        c.after,
        c.limit + 1,
      );
      const records = rows.slice(0, c.limit).map((r) => {
        const sourceId = `group-action:${this.groupId}:${r.position}`;
        const facts = groupActionSourceFacts({
          sourceId,
          version: 1,
          kind: r.kind,
          originalJson: r.body,
        });
        // Retain the legacy Git evidence identity verbatim; E's frozen facts
        // contract has no gitEventId field, so it is not relabelled as another ID.
        const value = JSON.parse(r.body) as {
          outcome?: { gitEventId?: GroupActionWork['sharedGoalId'] } | null;
          proposal?: { origin?: GroupActionOrigin };
          latest?: { origin?: GroupActionOrigin };
          origin?: GroupActionOrigin;
        };
        const origin = value.proposal?.origin ?? value.latest?.origin ?? value.origin;
        return {
          sourceId,
          version: 1 as const,
          groupId: actor.groupId,
          sequence: r.position,
          kind: r.kind,
          originalJson: r.body,
          facts,
          instructionEventId: facts.originalIds.instructionEventId,
          autonomousEventId: origin?.kind === 'autonomous' ? origin.eventId : null,
          proposalId: facts.originalIds.proposalId,
          actionId: facts.originalIds.actionId,
          sharedGoalId: facts.originalIds.sharedGoalId,
          taskId: facts.originalIds.taskId,
          managerId: facts.originalIds.managerId,
          workerId: facts.originalIds.workerId,
          outcomeId: facts.originalIds.outcomeId,
          jobId: facts.originalIds.jobId,
          gitEventId: value.outcome?.gitEventId ?? null,
        };
      });
      return {
        kind: 'evidence',
        records,
        continuation: rows.length > c.limit ? records.at(-1)!.sequence : null,
      };
    }
    if (c.kind === 'owner-pending') {
      const rows = this.sql.rows<{ rowid: number; body: string }>(
        `SELECT a.rowid,a.body FROM ga_actions a JOIN ga_work w ON w.work_id=a.work_id WHERE a.rowid>? AND json_extract(w.body,'$.owner.memberId')=? AND json_extract(w.body,'$.owner.installationId')=? AND json_extract(a.body,'$.state') IN ('pending-owner','dispatching','uncertain') ORDER BY a.rowid LIMIT ?`,
        c.after,
        actor.memberId,
        actor.installationId,
        c.limit + 1,
      );
      return {
        kind: 'owner-pending',
        actions: rows
          .slice(0, c.limit)
          .map((row) => this.project(this.actionBody(row.body), access)),
        continuation: rows.length > c.limit ? rows[c.limit - 1]!.rowid : null,
      };
    }
    if (c.kind === 'board') {
      const events = this.sql.rows<{ position: number; kind: string; body: string }>(
        'SELECT position,kind,body FROM ga_events WHERE position>? ORDER BY position LIMIT ?',
        c.after,
        c.limit + 1,
      );
      const page = events.slice(0, c.limit),
        after = page.at(-1)?.position ?? c.after;
      // Snapshot is bounded independently; continuation explicitly covers evidence.
      const instructions = this.sql
        .rows<{ body: string }>('SELECT body FROM ga_instructions ORDER BY rowid DESC LIMIT 50')
        .map((r) => JSON.parse(r.body) as GroupActionInstruction);
      const works = this.sql
        .rows<{
          body: string;
        }>(
          `SELECT body FROM ga_work w ORDER BY CASE WHEN EXISTS(SELECT 1 FROM ga_actions a WHERE a.work_id=w.work_id AND json_extract(a.body,'$.state') IN ('pending-owner','dispatching','uncertain')) THEN 0 ELSE 1 END,w.work_id LIMIT 50`,
        )
        .map((r) => {
          const work = JSON.parse(r.body) as GroupActionWork;
          const status = this.status(access, work.owner);
          return {
            ...work,
            availability:
              status === 'active'
                ? ('available' as const)
                : status === 'revoked'
                  ? ('owner-revoked' as const)
                  : ('unavailable' as const),
          };
        });
      const proposals = this.sql
        .rows<{ body: string }>('SELECT body FROM ga_proposals ORDER BY rowid DESC LIMIT 50')
        .map((r) => JSON.parse(r.body) as GroupActionProposal);
      const actions = this.sql
        .rows<{ body: string }>(
          `SELECT body FROM ga_actions WHERE json_extract(body,'$.state') IN ('pending-owner','dispatching','uncertain') ORDER BY rowid DESC LIMIT ?`,
          GROUP_ACTION_LIMITS.unfinishedActions,
        )
        .concat(
          this.sql.rows<{ body: string }>(
            `SELECT body FROM ga_actions WHERE json_extract(body,'$.state') NOT IN ('pending-owner','dispatching','uncertain') ORDER BY rowid DESC LIMIT ?`,
            GROUP_ACTION_LIMITS.recentTerminalActions,
          ),
        )
        .map((r) => this.project(this.actionBody(r.body), access));
      const notices = this.sql
        .rows<{
          body: string;
        }>(
          'SELECT body FROM ga_notices WHERE member_id=? ORDER BY rowid DESC LIMIT 50',
          actor.memberId,
        )
        .map((r) => JSON.parse(r.body));
      return {
        kind: 'board',
        board: {
          instructions,
          works,
          proposals,
          actions,
          notices,
          after,
          continuation: events.length > c.limit ? after : null,
        },
      };
    }
    if (c.kind === 'instruction') {
      const instruction: GroupActionInstruction = {
        eventId: this.id() as GroupActionInstruction['eventId'],
        actor,
        text: c.text,
        at: this.now(),
      };
      this.sql.rows(
        'INSERT INTO ga_instructions VALUES(?,?)',
        instruction.eventId,
        JSON.stringify(instruction),
      );
      this.event('instruction', instruction.eventId, instruction);
      return { kind: 'instruction', instruction };
    }
    if (c.kind === 'register-work') {
      groupActionsSynchronous(access.verifyWorkRegistration(c, actor));
      this.verify(access, c.origin, actor);
      const work: GroupActionWork = {
        workId: this.id(),
        title: c.title,
        owner: actor,
        taskId: c.taskId,
        managerId: c.managerId,
        sharedGoalId: c.sharedGoalId,
        revision: 0,
        availability: 'available',
        desired: 'stop',
        latest: { actionId: null, actor, at: this.now(), origin: c.origin },
      };
      this.sql.rows('INSERT INTO ga_work VALUES(?,?)', work.workId, JSON.stringify(work));
      this.event('work', work.workId, work);
      return { kind: 'work', work };
    }
    if (c.kind === 'propose') {
      const work = this.record<GroupActionWork>('ga_work', 'work_id', c.workId);
      if (work.owner.groupId !== actor.groupId) reject('denied');
      groupActionsSynchronous(access.requireActive(work.owner));
      this.verify(access, c.origin, actor, work);
      if (work.revision !== c.expectedRevision) reject('stale', work);
      const open = this.sql.rows<{ n: number }>(
        `SELECT count(*) AS n FROM ga_proposals p JOIN ga_work w ON w.work_id=json_extract(p.body,'$.workId') WHERE p.member_id=? AND json_extract(p.body,'$.observed.revision')=json_extract(w.body,'$.revision') AND NOT EXISTS(SELECT 1 FROM ga_actions a WHERE json_extract(a.body,'$.proposal.proposalId')=p.proposal_id)`,
        actor.memberId,
      )[0]!.n;
      if (open >= GROUP_ACTION_LIMITS.memberOpenProposals) reject('limit');
      const proposal: GroupActionProposal = {
        proposalId: this.id(),
        workId: c.workId,
        kind: c.action,
        origin: c.origin,
        actor,
        at: this.now(),
        observed: work,
        overrideRequired:
          work.latest.actionId !== null &&
          work.desired !== c.action &&
          work.latest.actor.memberId !== actor.memberId,
      };
      this.sql.rows(
        'INSERT INTO ga_proposals VALUES(?,?,?)',
        proposal.proposalId,
        actor.memberId,
        JSON.stringify(proposal),
      );
      this.event('proposal', proposal.proposalId, proposal);
      return { kind: 'proposal', proposal };
    }
    if (c.kind === 'confirm') {
      const p = this.record<GroupActionProposal>('ga_proposals', 'proposal_id', c.proposalId),
        work = this.record<GroupActionWork>('ga_work', 'work_id', p.workId);
      if (!sameOwner(p.actor, actor)) reject('denied');
      groupActionsSynchronous(access.requireActive(work.owner));
      this.verify(access, p.origin, actor, work);
      if (c.expectedRevision !== p.observed.revision || work.revision !== p.observed.revision)
        reject('stale', work);
      if (p.overrideRequired && !c.override) reject('conflict', work);
      let humanConfirmation: GroupActionHumanConfirmation | null = null;
      if (p.overrideRequired) {
        humanConfirmation = groupActionHumanConfirmationSchema.parse(
          groupActionsSynchronous(access.requireHumanConfirmation(p, c, actor)),
        );
        groupActionsSynchronous(access.requireActive(humanConfirmation.confirmedBy));
        if (
          humanConfirmation.proposalId !== p.proposalId ||
          humanConfirmation.revision !== work.revision ||
          humanConfirmation.operationId !== c.operationId ||
          !sameOwner(humanConfirmation.confirmedBy, actor)
        )
          reject('denied');
      }
      const active = this.sql.rows<{ n: number; member: number }>(
        `SELECT count(*) AS n,coalesce(sum(CASE WHEN json_extract(body,'$.proposal.actor.memberId')=? THEN 1 ELSE 0 END),0) AS member FROM ga_actions WHERE json_extract(body,'$.state') IN ('pending-owner','dispatching','uncertain') AND work_id<>?`,
        actor.memberId,
        work.workId,
      )[0]!;
      if (
        active.n >= GROUP_ACTION_LIMITS.unfinishedActions ||
        active.member >= GROUP_ACTION_LIMITS.memberUnfinishedActions
      )
        reject('limit');
      const action: GroupAction = {
        actionId: this.id(),
        proposal: p,
        revision: work.revision + 1,
        state: 'pending-owner',
        outcome: null,
        humanConfirmation,
      };
      groupActionsSynchronous(
        access.reserveLifecycle(
          action.actionId,
          GROUP_ACTION_LIMITS.lifecycleLogicalReserve,
          GROUP_ACTION_LIMITS.lifecyclePhysicalReserve,
        ),
      );
      const next: GroupActionWork = {
        ...work,
        revision: action.revision,
        desired: p.kind,
        latest: { actionId: action.actionId, actor, at: this.now(), origin: p.origin },
      };
      this.sql.rows('UPDATE ga_work SET body=? WHERE work_id=?', JSON.stringify(next), work.workId);
      // Previously pending work cannot execute after a newer confirmation.
      for (const r of this.sql.rows<{ body: string }>(
        'SELECT body FROM ga_actions WHERE work_id=?',
        work.workId,
      )) {
        const prior = this.actionBody(r.body);
        if (prior.state === 'dispatching' || prior.state === 'uncertain') reject('conflict', work);
        if (prior.state === 'pending-owner') {
          this.save({
            ...prior,
            state:
              this.status(access, prior.proposal.actor) === 'revoked' ? 'revoked' : 'superseded',
          });
          groupActionsSynchronous(access.releaseLifecycle(prior.actionId));
        }
      }
      this.sql.rows(
        'INSERT INTO ga_actions VALUES(?,?,?)',
        action.actionId,
        p.workId,
        JSON.stringify(action),
      );
      this.event('confirmed', action.actionId, action);
      if (p.overrideRequired) {
        const notice = {
          noticeId: this.id(),
          affectedMemberId: work.latest.actor.memberId,
          actionId: action.actionId,
          actor,
          at: this.now(),
          visibility: 'private' as const,
          requesterOrigin: p.origin,
          text: `${p.origin.kind === 'autonomous' ? `${actor.displayName}’s agent (manager ${p.origin.managerId}) requested` : `${actor.displayName} requested`} ${p.kind} for ${work.title}; ${humanConfirmation!.confirmedBy.displayName} confirmed the override of your ${work.desired} request from ${work.latest.at}.`.slice(
            0,
            500,
          ),
        };
        this.sql.rows(
          'INSERT INTO ga_notices VALUES(?,?,?,?)',
          notice.noticeId,
          notice.affectedMemberId,
          action.actionId,
          JSON.stringify(notice),
        );
        this.event('override-notice', notice.noticeId, notice);
      }
      return { kind: 'action', action };
    }
    const action = this.storedAction(c.actionId),
      work = this.record<GroupActionWork>('ga_work', 'work_id', action.proposal.workId);
    if (!sameOwner(work.owner, actor)) reject('denied');
    if (c.kind === 'claim') {
      // This is the final service CAS before effect, after owner reconnect/admission.
      groupActionsSynchronous(access.requireActive(action.proposal.actor));
      this.verify(access, action.proposal.origin, action.proposal.actor, work);
      if (work.revision !== action.revision || work.latest.actionId !== action.actionId)
        reject('stale', work);
      if (action.state === 'pending-owner') {
        action.state = 'dispatching';
        this.save(action);
      }
    } else if (c.kind === 'complete') {
      if (
        !['dispatching', 'uncertain'].includes(action.state) ||
        c.outcome.taskId !== work.taskId ||
        (c.outcome.status !== 'blocked' &&
          c.outcome.status !== (action.proposal.kind === 'start' ? 'started' : 'stopped')) ||
        (c.outcome.status === 'blocked' &&
          (c.outcome.workerId !== null || c.outcome.jobId !== undefined))
      )
        reject('conflict', work);
      action.state = 'completed';
      action.outcome = c.outcome;
      this.save(action);
      groupActionsSynchronous(access.releaseLifecycle(action.actionId));
    } else {
      if (!['dispatching', 'uncertain'].includes(action.state)) reject('conflict', work);
      action.state = 'uncertain';
      this.save(action);
    }
    return { kind: 'action', action };
  }
}
