import { groupContextSchema, type GroupContext } from '@dock/shared';
import {
  groupActionSchema,
  type GroupAction,
  type GroupActionCommand,
  type GroupActionResult,
} from '@dock/shared/dist/group-actions.js';
import {
  dispatchGroupAction,
  groupCoordinationTools,
  type GroupCoordinationPorts,
} from './group-coordination.js';
import {
  createGroupCoordinationRuntime,
  type GroupCoordinationNativePort,
} from './group-coordination-runtime.js';
import { registerGroupNativeCapabilities } from './group-native-connector.js';
import type { GroupHost } from './group-host.js';
import type { Runtime } from './runtime.js';
import type { ClaudeHostTool } from './claude-session.js';

const owners = new WeakMap<GroupHost, GroupFeatureCoordination>();
export const groupFeatureCoordination = (host: GroupHost) => owners.get(host);
const same = (a: GroupContext, b: GroupAction['proposal']['observed']['owner']) =>
  a.groupId === b.groupId && a.memberId === b.memberId && a.installationId === b.installationId;
/** Normal host owns confirmed-action delivery. Only provisioned native managers
 * can bind this immutable index; browser inputs cannot choose runtime identities. */
export class GroupFeatureCoordination {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closing = false;
  private position = 0;
  readonly tools: (context: GroupContext) => ClaudeHostTool[];
  constructor(
    readonly runtime: Runtime,
    readonly host: GroupHost,
    readonly native: GroupCoordinationNativePort,
  ) {
    host.db
      .exec(`CREATE TABLE IF NOT EXISTS gh_coordination_owners(manager_id TEXT PRIMARY KEY,context_json TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,action_cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gh_coordination_actions(action_id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,body_json TEXT NOT NULL,sequence INTEGER NOT NULL,active INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS gh_coordination_owner_identity BEFORE UPDATE OF manager_id,context_json ON gh_coordination_owners BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER IF NOT EXISTS gh_coordination_owner_no_delete BEFORE DELETE ON gh_coordination_owners BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
    owners.set(host, this);
    this.tools = (context) => {
      const identity = native.identity(context);
      if (context.visibility === 'shared' && identity.agentId === identity.managerId) {
        const saved = host.db
          .prepare('SELECT context_json FROM gh_coordination_owners WHERE manager_id=?')
          .get(identity.managerId);
        if (saved && String(saved.context_json) !== JSON.stringify(context))
          throw new Error('Original native manager context changed.');
        host.db
          .prepare(
            'INSERT OR IGNORE INTO gh_coordination_owners(manager_id,context_json) VALUES(?,?)',
          )
          .run(identity.managerId, JSON.stringify(context));
      }
      // Tool catalogs are synchronous; the authoritative membership and owner
      // ports resolve only when the actual native tool is invoked.
      let resolved: Promise<GroupCoordinationPorts> | undefined;
      const get = () => (resolved ??= this.ports(context));
      const deferred: GroupCoordinationPorts = {
        command: async (command) => this.after(await (await get()).command(command), command),
        resolve: async (id) => (await get()).resolve(id),
        ownerLane: async (owner) => (await get()).ownerLane(owner),
        revalidate: async () => (await get()).revalidate(),
        normal: {
          createTask: async (key, input, origin) =>
            (await get()).normal.createTask(key, input, origin),
          prepareDelegate: async (key, input, origin) =>
            (await get()).normal.prepareDelegate(key, input, origin),
          workForWorker: async (id) => (await get()).normal.workForWorker(id),
        },
      };
      return groupCoordinationTools(
        context,
        deferred,
        async () => {
          const who = native.identity(context);
          if (!who.requestId || who.agentId !== who.managerId)
            throw new Error('An original shared Work request is required.');
          return { kind: 'instruction', eventId: await host.sharedGoalForRequest(who.requestId) };
        },
        identity.agentId !== identity.managerId,
      );
    };
    registerGroupNativeCapabilities(runtime, 'coordination', this.tools);
  }
  private async ports(context: GroupContext) {
    const feature = await this.host.nativeFeatureContext(context);
    const shared = await this.host.actionContextForEnrollment(feature.enrollmentHandle);
    return createGroupCoordinationRuntime(this.runtime, this.native, context, {
      owner: {
        groupId: context.groupId,
        memberId: context.memberId,
        installationId: context.installationId,
        displayName: feature.enrollment.displayName,
      },
      command: shared.command,
      revalidate: feature.revalidate,
      publishOwnedTask: (key, binding, actual) => this.host.publishOwnedTask(key, binding, actual),
    });
  }
  async after(result: GroupActionResult, command: GroupActionCommand): Promise<GroupActionResult> {
    if (command.kind !== 'confirm' || !result.ok || result.value.kind !== 'action') return result;
    try {
      return {
        ok: true,
        value: { kind: 'action', action: await this.dispatch(result.value.action) },
      };
    } catch {
      // Confirmation remains durable. The original owner's finite pass retries
      // this exact action; an offline/held owner never becomes another owner.
      return result;
    }
  }
  private async dispatch(action: GroupAction) {
    if (!['pending-owner', 'dispatching', 'uncertain'].includes(action.state)) return action;
    const row = this.host.db
      .prepare('SELECT context_json FROM gh_coordination_owners WHERE manager_id=?')
      .get(action.proposal.observed.managerId);
    if (!row) return action;
    const context = groupContextSchema.parse(JSON.parse(String(row.context_json)));
    if (!same(context, action.proposal.observed.owner))
      throw new Error('Original action owner changed.');
    const identity = this.native.identity(context);
    if (
      identity.managerId !== action.proposal.observed.managerId ||
      identity.agentId !== identity.managerId
    )
      throw new Error('Original native manager binding unavailable.');
    return dispatchGroupAction(action, await this.ports(context));
  }
  start() {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      void this.pass();
    }, 20_000);
    this.timer.unref();
  }
  pass(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runPass()
      .catch(() => {})
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async runPass() {
    let row = this.host.db
      .prepare(
        'SELECT rowid AS position,manager_id,context_json,cursor,action_cursor FROM gh_coordination_owners WHERE rowid>? ORDER BY rowid LIMIT 1',
      )
      .get(this.position);
    if (!row) {
      this.position = 0;
      row = this.host.db
        .prepare(
          'SELECT rowid AS position,manager_id,context_json,cursor,action_cursor FROM gh_coordination_owners ORDER BY rowid LIMIT 1',
        )
        .get();
    }
    if (!row) return;
    this.position = Number(row.position);
    const context = groupContextSchema.parse(JSON.parse(String(row.context_json)));
    const ports = await this.ports(context);
    const result = await ports.command({ kind: 'evidence', after: Number(row.cursor), limit: 25 });
    if (!result.ok || result.value.kind !== 'evidence') return;
    // Consume the durable evidence stream, not the board's latest-50 snapshot.
    // Older pending actions stay locally indexed until exact current authority
    // proves completion/supersession; later unrelated updates cannot hide them.
    for (const record of result.value.records) {
      const parsed = groupActionSchema.safeParse(JSON.parse(record.originalJson));
      if (
        !parsed.success ||
        parsed.data.proposal.observed.managerId !== row.manager_id ||
        !same(context, parsed.data.proposal.observed.owner)
      )
        continue;
      const action = parsed.data;
      this.host.db
        .prepare(
          `INSERT INTO gh_coordination_actions VALUES(?,?,?,?,?)
        ON CONFLICT(action_id) DO UPDATE SET body_json=excluded.body_json,sequence=excluded.sequence,active=excluded.active WHERE excluded.sequence>gh_coordination_actions.sequence`,
        )
        .run(
          action.actionId,
          String(row.manager_id),
          JSON.stringify(action),
          record.sequence,
          Number(['pending-owner', 'dispatching', 'uncertain'].includes(action.state)),
        );
    }
    const cursor = result.value.records.at(-1)?.sequence ?? Number(row.cursor);
    let pending = this.host.db
      .prepare(
        'SELECT rowid AS position,body_json FROM gh_coordination_actions WHERE manager_id=? AND active=1 AND rowid>? ORDER BY rowid LIMIT 2',
      )
      .all(String(row.manager_id), Number(row.action_cursor));
    if (!pending.length)
      pending = this.host.db
        .prepare(
          'SELECT rowid AS position,body_json FROM gh_coordination_actions WHERE manager_id=? AND active=1 ORDER BY rowid LIMIT 2',
        )
        .all(String(row.manager_id));
    for (const entry of pending) {
      try {
        const action = await this.dispatch(
          groupActionSchema.parse(JSON.parse(String(entry.body_json))),
        );
        if (!['pending-owner', 'dispatching', 'uncertain'].includes(action.state))
          this.host.db
            .prepare('UPDATE gh_coordination_actions SET active=0 WHERE action_id=?')
            .run(action.actionId);
      } catch {
        /* Retain exact action for next authoritative retry. */
      }
    }
    this.host.db
      .prepare('UPDATE gh_coordination_owners SET cursor=?,action_cursor=? WHERE manager_id=?')
      .run(cursor, Number(pending.at(-1)?.position ?? 0), String(row.manager_id));
  }

  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    owners.delete(this.host);
  }
}
