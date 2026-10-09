import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  delegateSchema,
  pauseWorkerSchema,
  taskCreateSchema,
  type GroupContext,
} from '@dock/shared';
import {
  groupActionCommandSchema,
  groupActionResultSchema,
  type GroupAction,
  type GroupActionActor,
  type GroupActionOrigin,
  type GroupActionResult,
  type GroupActionWork,
} from '@dock/shared/dist/group-actions.js';
import type { ClaudeHostTool } from './claude-session.js';

/** Host-issued approved resource mapping. Never browser-selectable paths,
 * provider/account IDs, executable, RPC method or shell arguments. */
export interface GroupCoordinationResource {
  work: GroupActionWork;
  owner: GroupActionActor;
  start: z.infer<typeof delegateSchema>;
  stop: z.infer<typeof pauseWorkerSchema>;
  /** Exact owner-side Start receipt. Never resolve Stop by a worker's current turn. */
  stopRunId?: string;
}
export type GroupCoordinationOutcome = NonNullable<GroupAction['outcome']>;
/** A definite admission refusal before any native worker effect. */
export class GroupCoordinationBlocked extends Error {
  constructor(readonly outcome: GroupCoordinationOutcome) {
    super(outcome.message);
    if (outcome.status !== 'blocked' || outcome.workerId !== null || outcome.jobId !== undefined)
      throw new Error('A blocked outcome must prove no worker/job effect.');
  }
}
export interface GroupCoordinationLane {
  readonly owner: GroupActionActor;
  /** Existing owner-side durable operation receipt, NOT provider probing.
   * absent is returned only after authoritative reconciliation proves no effect. */
  inspect(
    actionId: string,
  ): Promise<
    | { state: 'absent' }
    | { state: 'pending' }
    | { state: 'completed'; outcome: GroupCoordinationOutcome }
  >;
  /** Revalidates resource grant/QUARK/manager lease using original owner's
   * allowance/account. The implementation owns atomic idempotent dispatch. */
  delegate(
    actionId: string,
    input: z.infer<typeof delegateSchema>,
    causal: GroupAction,
  ): Promise<GroupCoordinationOutcome>;
  pauseWorker(
    actionId: string,
    input: z.infer<typeof pauseWorkerSchema>,
    causal: GroupAction,
  ): Promise<GroupCoordinationOutcome>;
}
/** Specific normal manager tools under host-issued group resource authority.
 * Implementations call the existing admitted coordination contracts and register
 * their causal work resource at the service, never forward arbitrary Runtime RPC. */
export interface GroupCoordinationNormalTools {
  createTask(
    key: string,
    input: z.infer<typeof taskCreateSchema>,
    origin: GroupActionOrigin,
  ): Promise<GroupActionWork>;
  prepareDelegate(
    key: string,
    input: z.infer<typeof delegateSchema>,
    origin: GroupActionOrigin,
  ): Promise<GroupActionWork>;
  workForWorker(agentId: string): Promise<GroupActionWork>;
}
export interface GroupCoordinationPorts {
  /** Compiled receipt-only original-owner reconciliation; no new effect. */
  retained?(action: GroupAction): Promise<GroupAction | null>;
  command(command: z.infer<typeof groupActionCommandSchema>): Promise<GroupActionResult>;
  resolve(workId: string): Promise<GroupCoordinationResource>;
  ownerLane(owner: GroupActionActor): Promise<GroupCoordinationLane | null>;
  revalidate(): Promise<void>;
  normal: GroupCoordinationNormalTools;
}
const same = (a: GroupActionActor, b: GroupActionActor) =>
  a.groupId === b.groupId && a.memberId === b.memberId && a.installationId === b.installationId;
const resultAction = (result: GroupActionResult): GroupAction => {
  const r = groupActionResultSchema.parse(result);
  if (!r.ok || r.value.kind !== 'action')
    throw new Error('Action authority refused dispatch. Refresh its current revision.');
  return r.value.action;
};
/** No provider queue, process control, worker creation or output storage here.
 * All effects belong to the original admitted manager lane. */
export async function dispatchGroupAction(
  action: GroupAction,
  ports: GroupCoordinationPorts,
): Promise<GroupAction> {
  if (['completed', 'superseded', 'revoked'].includes(action.state)) return action;
  const resource = await ports.resolve(action.proposal.workId),
    owner = action.proposal.observed.owner;
  if (
    !same(resource.owner, owner) ||
    !same(resource.work.owner, owner) ||
    resource.work.taskId !== action.proposal.observed.taskId ||
    resource.work.managerId !== action.proposal.observed.managerId
  )
    throw new Error('Original owner/task binding changed.');
  const lane = await ports.ownerLane(owner);
  if (!lane) return action; // durable pending-owner; NEVER pick a reachable alternate
  if (!same(lane.owner, owner)) throw new Error('Another member cannot execute this action.');
  await ports.revalidate();
  const receipt = await lane.inspect(action.actionId);
  if (receipt.state === 'completed') {
    return resultAction(
      await ports.command({
        kind: 'complete',
        operationId: action.actionId,
        actionId: action.actionId,
        outcome: receipt.outcome,
      }),
    );
  }
  if (receipt.state === 'pending') return action;
  // Different deterministic operations must not share one idempotency key.
  const claim = resultAction(
    await ports.command({
      kind: 'claim',
      operationId: phaseId(action.actionId, 1),
      actionId: action.actionId,
    }),
  );
  if (!['dispatching', 'uncertain'].includes(claim.state)) return claim;
  await ports.revalidate();
  try {
    // Existing lane must persist actionId before native effects and reconcile
    // repeat/lost-ack calls against this SAME ID. No replacement job is requested.
    const outcome =
      claim.proposal.kind === 'start'
        ? await lane.delegate(claim.actionId, delegateSchema.parse(resource.start), claim)
        : await lane.pauseWorker(claim.actionId, pauseWorkerSchema.parse(resource.stop), claim);
    return resultAction(
      await ports.command({
        kind: 'complete',
        operationId: action.actionId,
        actionId: action.actionId,
        outcome,
      }),
    );
  } catch (error) {
    if (error instanceof GroupCoordinationBlocked)
      return resultAction(
        await ports.command({
          kind: 'complete',
          operationId: action.actionId,
          actionId: action.actionId,
          outcome: error.outcome,
        }),
      );
    await ports.command({
      kind: 'uncertain',
      operationId: phaseId(action.actionId, 2),
      actionId: action.actionId,
    });
    throw error;
  }
}
// UUID variant retained; deterministic receipt namespaces for the same action.
export function phaseId(actionId: string, phase: 1 | 2) {
  z.uuid().parse(actionId);
  return actionId.slice(0, -1) + (parseInt(actionId.at(-1)!, 16) ^ phase).toString(16);
}
const readSchema = z.strictObject({
  after: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(50).default(25),
});
const proposeSchema = groupActionCommandSchema.options.find(
  (s) => s.shape.kind.value === 'propose',
)!;
const confirmSchema = groupActionCommandSchema.options.find(
  (s) => s.shape.kind.value === 'confirm',
)!;
/** Compatible with registerGroupNativeCapabilities(...,'coordination', factory).
 * It exposes concrete scoped board/proposal tools, never Runtime.tool forwarding. */
export function groupCoordinationTools(
  context: GroupContext,
  ports: GroupCoordinationPorts,
  origin: () => Promise<GroupActionOrigin>,
  readOnly = false,
): ClaudeHostTool[] {
  const tool = (
    name: string,
    description: string,
    input: z.ZodType,
    invoke: (raw: unknown, key: string) => Promise<unknown>,
  ): ClaudeHostTool => ({
    name,
    description,
    inputSchema: z.toJSONSchema(input),
    invoke: async (raw, callContext) => {
      await ports.revalidate();
      const result = await invoke(
        raw,
        coordinationKey(context.sessionId, callContext.requestId, name),
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  });
  const tools = [
    tool(
      'dock_inspect',
      'Read this group’s normal task/worker board and action receipts.',
      readSchema,
      async (raw) => ports.command({ kind: 'board', ...readSchema.parse(raw) }),
    ),
  ];
  if (context.visibility === 'private' || readOnly) return tools;
  tools.push(
    tool(
      'dock_task_create',
      'Create a normal owned task under this shared goal and group resource grant.',
      taskCreateSchema,
      async (raw, key) => {
        return ports.normal.createTask(key, taskCreateSchema.parse(raw), await origin());
      },
    ),
    tool(
      'dock_delegate',
      'Prepare the normal owned worker instruction, then return a shared start proposal for confirmation.',
      delegateSchema,
      async (raw, key) => {
        const causal = await origin(),
          work = await ports.normal.prepareDelegate(key, delegateSchema.parse(raw), causal);
        return ports.command({
          kind: 'propose',
          operationId: coordinationKey(key, 'proposal', 'start'),
          workId: work.workId,
          expectedRevision: work.revision,
          action: 'start',
          origin: work.latest.origin,
        });
      },
    ),
    tool(
      'dock_pause_worker',
      'Propose stopping this group’s owned worker; confirmation revalidates the current revision.',
      pauseWorkerSchema,
      async (raw, key) => {
        const input = pauseWorkerSchema.parse(raw),
          work = await ports.normal.workForWorker(input.agentId);
        if (work.owner.groupId !== context.groupId)
          throw new Error('Worker is outside this group resource grant.');
        return ports.command({
          kind: 'propose',
          operationId: key,
          workId: work.workId,
          expectedRevision: work.revision,
          action: 'stop',
          origin: await origin(),
        });
      },
    ),
  );
  tools.push(
    tool(
      'dock_propose_action',
      'Propose shared start/stop at the current work revision; no execution until confirmation.',
      proposeSchema,
      async (raw) => {
        const c = groupActionCommandSchema.parse(raw);
        if (c.kind !== 'propose') throw new Error('Proposal required.');
        // Origin comes from verified native source/shared goal, not model-selected evidence.
        const causal = await origin(); // Exact current Work grant is required.
        return ports.command({ ...c, origin: causal });
      },
    ),
    tool(
      'dock_confirm_action',
      'Confirm your shared proposal against its exact observed revision. Stale confirmation is refused.',
      confirmSchema,
      async (raw) => {
        const c = groupActionCommandSchema.parse(raw);
        if (c.kind !== 'confirm') throw new Error('Confirmation required.');
        await origin(); // A native Ask turn cannot acquire Work authority.
        if (c.override)
          throw new Error('A competing override requires human confirmation in the group board.');
        return ports.command(c);
      },
    ),
  );
  return tools;
}

function coordinationKey(...parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
