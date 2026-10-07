import {
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
  /** Verify immutable shared Instruction, or manager Decision under this goal.
   * Question/Idea/private/unrelated evidence MUST be rejected here. */
  verifyWorkRegistration(
    command: Extract<GroupActionCommand, { kind: 'register-work' }>,
    actor: GroupActionActor,
  ): void;
  requireActive(actor: GroupActionActor): void;
  verifyOrigin(origin: GroupActionOrigin, actor: GroupActionActor, work?: GroupActionWork): void;
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
export class GroupActionsCapacityExceeded extends Error {}
class Rejected extends Error {
  constructor(
    readonly error: 'denied' | 'conflict' | 'stale' | 'limit',
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
  ) {
    sql.transaction(() => sql.initialize(schema));
  }
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
    this.sql.rows(
      'INSERT INTO ga_events(kind,entity_id,body) VALUES(?,?,?)',
      kind,
      entityId,
      JSON.stringify(body),
    );
  }
  private save(action: GroupAction) {
    this.sql.rows(
      'UPDATE ga_actions SET body=? WHERE action_id=?',
      JSON.stringify(action),
      action.actionId,
    );
    this.event(action.state, action.actionId, action);
  }
  execute(raw: unknown, access: GroupActionsAuthorityAccess): GroupActionResult {
    const parsed = groupActionCommandSchema.safeParse(raw);
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).length > 12_000)
      return { ok: false, error: 'invalid' };
    try {
      return this.sql.transaction(() => {
        const actor = access.authorize(),
          command = parsed.data;
        if (actor.groupId !== this.groupId) reject('denied');
        // Auth before receipt lookup; revoked callers can never replay effects/results.
        const request = JSON.stringify([actor.groupId, actor.memberId, command]);
        if (command.kind === 'claim') {
          const a = this.record<GroupAction>('ga_actions', 'action_id', command.actionId);
          const w = this.record<GroupActionWork>('ga_work', 'work_id', a.proposal.workId);
          if (!sameOwner(w.owner, actor)) reject('denied');
          access.requireActive(a.proposal.actor);
          if (w.revision !== a.revision || w.latest.actionId !== a.actionId) reject('stale', w);
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
              result.action = this.record('ga_actions', 'action_id', result.action.actionId);
            return { ok: true as const, value: result };
          }
          const count = this.sql.rows<{ n: number }>('SELECT count(*) AS n FROM ga_receipts')[0].n;
          if (count >= 512) reject('limit');
        }
        if (!['board', 'work', 'evidence'].includes(command.kind)) access.admitMutation();
        const value = this.apply(command, actor, access);
        if ('operationId' in command)
          this.sql.rows(
            'INSERT INTO ga_receipts VALUES(?,?,?,?)',
            actor.installationId,
            command.operationId,
            request,
            JSON.stringify(value),
          );
        return { ok: true as const, value };
      });
    } catch (e) {
      if (e instanceof GroupActionsAccessDenied) return { ok: false, error: 'denied' };
      if (e instanceof GroupActionsCapacityExceeded) return { ok: false, error: 'limit' };
      if (e instanceof Rejected)
        return { ok: false, error: e.error, ...(e.current ? { current: e.current } : {}) };
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
    access.verifyOrigin(origin, actor, work);
  }
  private apply(
    c: GroupActionCommand,
    actor: GroupActionActor,
    access: GroupActionsAuthorityAccess,
  ): GroupActionReply {
    if (c.kind === 'work')
      return { kind: 'work', work: this.record<GroupActionWork>('ga_work', 'work_id', c.workId) };
    if (c.kind === 'evidence') {
      const rows = this.sql.rows<{
        position: number;
        kind: string;
        entity_id: string;
        body: string;
      }>(
        'SELECT position,kind,entity_id,body FROM ga_events WHERE position>? ORDER BY position LIMIT ?',
        c.after,
        c.limit + 1,
      );
      const records = rows.slice(0, c.limit).map((r) => {
        const value = JSON.parse(r.body) as
          | GroupAction
          | GroupActionWork
          | GroupActionProposal
          | GroupActionInstruction;
        const a = 'proposal' in value ? (value as GroupAction) : null;
        const p = a?.proposal ?? ('observed' in value ? (value as GroupActionProposal) : null);
        const w = p?.observed ?? ('taskId' in value ? (value as GroupActionWork) : null);
        const origin = p?.origin ?? w?.latest.origin;
        return {
          sourceId: `group-action:${this.groupId}:${r.position}`,
          version: 1 as const,
          groupId: actor.groupId,
          sequence: r.position,
          kind: r.kind,
          originalJson: r.body,
          instructionEventId: origin?.eventId ?? ('eventId' in value ? value.eventId : null),
          proposalId: p?.proposalId ?? null,
          actionId: a?.actionId ?? ('actionId' in value ? value.actionId : null),
          sharedGoalId: w?.sharedGoalId ?? null,
          taskId: w?.taskId ?? null,
          managerId: w?.managerId ?? null,
          workerId: a?.outcome?.workerId ?? null,
          outcomeId: a?.outcome?.outcomeId ?? null,
          jobId: a?.outcome?.jobId ?? null,
          gitEventId: a?.outcome?.gitEventId ?? null,
        };
      });
      return {
        kind: 'evidence',
        records,
        continuation: rows.length > c.limit ? records.at(-1)!.sequence : null,
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
        .rows<{ body: string }>('SELECT body FROM ga_work ORDER BY work_id LIMIT 50')
        .map((r) => JSON.parse(r.body) as GroupActionWork);
      const proposals = this.sql
        .rows<{ body: string }>('SELECT body FROM ga_proposals ORDER BY rowid DESC LIMIT 50')
        .map((r) => JSON.parse(r.body) as GroupActionProposal);
      const actions = this.sql
        .rows<{ body: string }>('SELECT body FROM ga_actions ORDER BY rowid DESC LIMIT 50')
        .map((r) => JSON.parse(r.body) as GroupAction);
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
      if (this.sql.rows<{ n: number }>('SELECT count(*) AS n FROM ga_instructions')[0].n >= 50)
        reject('limit');
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
      access.verifyWorkRegistration(c, actor);
      this.verify(access, c.origin, actor);
      if (this.sql.rows<{ n: number }>('SELECT count(*) AS n FROM ga_work')[0].n >= 50)
        reject('limit');
      const work: GroupActionWork = {
        workId: this.id(),
        title: c.title,
        owner: actor,
        taskId: c.taskId,
        managerId: c.managerId,
        sharedGoalId: c.sharedGoalId,
        revision: 0,
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
      this.verify(access, c.origin, actor, work);
      if (work.revision !== c.expectedRevision) reject('stale', work);
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
      this.verify(access, p.origin, actor, work);
      if (c.expectedRevision !== p.observed.revision || work.revision !== p.observed.revision)
        reject('stale', work);
      if (p.overrideRequired && !c.override) reject('conflict', work);
      const action: GroupAction = {
        actionId: this.id(),
        proposal: p,
        revision: work.revision + 1,
        state: 'pending-owner',
        outcome: null,
      };
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
        const prior = JSON.parse(r.body) as GroupAction;
        if (prior.state === 'dispatching' || prior.state === 'uncertain') reject('conflict', work);
        if (prior.state === 'pending-owner') this.save({ ...prior, state: 'superseded' });
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
          text: `${actor.displayName} confirmed ${p.kind} for ${work.title}, overriding your ${work.desired} request from ${work.latest.at}.`,
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
    const action = this.record<GroupAction>('ga_actions', 'action_id', c.actionId),
      work = this.record<GroupActionWork>('ga_work', 'work_id', action.proposal.workId);
    if (!sameOwner(work.owner, actor)) reject('denied');
    if (c.kind === 'claim') {
      // This is the final service CAS before effect, after owner reconnect/admission.
      access.requireActive(action.proposal.actor);
      this.verify(access, action.proposal.origin, action.proposal.actor, work);
      if (work.revision !== action.revision || work.latest.actionId !== action.actionId)
        reject('stale', work);
      if (action.state === 'pending-owner') {
        action.state = 'dispatching';
        this.save(action);
      }
    } else if (c.kind === 'complete') {
      if (!['dispatching', 'uncertain'].includes(action.state) || c.outcome.taskId !== work.taskId)
        reject('conflict', work);
      action.state = 'completed';
      action.outcome = c.outcome;
      this.save(action);
    } else {
      if (!['dispatching', 'uncertain'].includes(action.state)) reject('conflict', work);
      action.state = 'uncertain';
      this.save(action);
    }
    return { kind: 'action', action };
  }
}
