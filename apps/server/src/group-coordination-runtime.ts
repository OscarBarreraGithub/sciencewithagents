import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  delegateSchema,
  pauseWorkerSchema,
  taskCreateSchema,
  type GroupContext,
} from '@dock/shared';
import {
  groupActionSchema,
  groupActionResultSchema,
  type GroupAction,
  type GroupActionActor,
  type GroupActionOrigin,
  type GroupActionWork,
  type GroupActionRetainedReceipt,
} from '@dock/shared/dist/group-actions.js';
import type { Runtime } from './runtime.js';
import { captureGroupManagerAction } from './group-native-activity-producers.js';
import { GroupCoordinationBlocked } from './group-coordination.js';
import type {
  GroupCoordinationLane,
  GroupCoordinationOutcome,
  GroupCoordinationPorts,
  GroupCoordinationResource,
} from './group-coordination.js';

export interface GroupCoordinationNativePort {
  identity(context: GroupContext): { managerId: string; agentId: string; requestId: string | null };
  bindTask?(context: GroupContext, taskId: string, sharedGoalId: string): void;
  delegate(
    context: GroupContext,
    actionId: string,
    input: z.infer<typeof delegateSchema>,
    causal?: GroupAction,
  ): Promise<{ workerId: string; runId: string }>;
  inspect(context: GroupContext, actionId: string): { workerId: string; runId: string } | null;
}
export interface GroupOwnedTaskBinding {
  kind: 'group-owned-task';
  taskId: string;
  managerId: string;
  sharedGoalId: GroupActionWork['sharedGoalId'];
  title: string;
}
export interface GroupCoordinationHostPort {
  owner: GroupActionActor;
  command: GroupCoordinationPorts['command'];
  revalidate(): Promise<void>;
  reconcile?(
    receipt: GroupActionRetainedReceipt,
  ): Promise<import('@dock/shared/dist/group-actions.js').GroupActionResult>;
  publishOwnedTask(
    key: string,
    binding: GroupOwnedTaskBinding,
    nativeContext: GroupContext,
  ): Promise<{ eventId: GroupActionWork['sharedGoalId'] }>;
}
export const groupCoordinationId = (...parts: string[]) => {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sameOwner = (a: GroupActionActor, b: GroupActionActor) =>
  a.groupId === b.groupId && a.memberId === b.memberId && a.installationId === b.installationId;
/** Actual original-owner lane. Only this capability's native journal can resolve
 * its manager or launch children; ordinary Runtime.tool/delegate is never used. */
export function createGroupCoordinationRuntime(
  runtime: Runtime,
  native: GroupCoordinationNativePort,
  context: GroupContext,
  host: GroupCoordinationHostPort,
): GroupCoordinationPorts {
  const store = runtime.store,
    prefix = `group:coordination:${context.sessionId}:`;
  const identity = () => native.identity(context);
  const revalidate = async () => {
    await host.revalidate();
    if (!sameOwner(host.owner, { ...host.owner, ...context }))
      throw new Error('Group owner scope changed.');
    identity();
  };
  const originalManager = () => {
    if (context.visibility !== 'shared') throw new Error('Private context is read-only.');
    const who = identity(),
      id = who.managerId,
      a = store.agent(id);
    if (who.agentId !== who.managerId)
      throw new Error('Only the original group manager can mutate coordination.');
    if (a.role !== 'manager') throw new Error('Original group manager binding changed.');
    return a;
  };
  const manager = (expectedRunId?: string) => {
    const a = originalManager(),
      run = store.runs(['running']).find((r) => r.agentId === a.id);
    if (!run || (expectedRunId && run.id !== expectedRunId))
      throw new Error('Original group manager is not admitted.');
    runtime.quark.requireManagerLease(run);
    return a;
  };
  const resource = (id: string) => {
    const r = store.getSetting(`${prefix}work:${id}`) as GroupCoordinationResource | null;
    if (!r || !sameOwner(r.owner, host.owner) || r.work.managerId !== identity().managerId)
      throw new Error('Work is outside this group manager resource grant.');
    const task = store.task(r.work.taskId);
    if (task.managerId !== r.work.managerId) throw new Error('Task owner changed.');
    return r;
  };
  const refresh = async (id: string) => {
    const r = resource(id),
      result = groupActionResultSchema.parse(await host.command({ kind: 'work', workId: id }));
    if (!result.ok || result.value.kind !== 'work')
      throw new Error('Current owner work unavailable.');
    const current = result.value.work;
    if (
      !current ||
      current.workId !== id ||
      current.taskId !== r.work.taskId ||
      current.managerId !== r.work.managerId ||
      !sameOwner(current.owner, r.owner)
    )
      throw new Error('Current work binding changed.');
    r.work = current;
    store.setSetting(`${prefix}work:${id}`, r);
    return r;
  };
  const saveWork = async (
    key: string,
    taskId: string,
    origin: GroupActionOrigin,
    start?: z.infer<typeof delegateSchema>,
    expectedRunId?: string,
  ) => {
    const a = manager(expectedRunId),
      task = store.task(taskId);
    if (task.managerId !== a.id || task.projectId !== a.projectId)
      throw new Error('Task is outside original manager.');
    const binding: GroupOwnedTaskBinding = {
      kind: 'group-owned-task',
      taskId,
      managerId: a.id,
      sharedGoalId: origin.kind === 'autonomous' ? origin.sharedGoalId : origin.eventId,
      title: task.title,
    };
    native.bindTask?.(context, taskId, binding.sharedGoalId);
    const publication = await host.publishOwnedTask(
      groupCoordinationId(key, 'attestation'),
      binding,
      context,
    );
    await revalidate();
    manager(expectedRunId);
    const result = groupActionResultSchema.parse(
      await host.command({
        kind: 'register-work',
        operationId: groupCoordinationId(key, 'register'),
        title: task.title,
        taskId,
        managerId: a.id,
        sharedGoalId: binding.sharedGoalId,
        origin: {
          kind: 'autonomous',
          eventId: publication.eventId,
          managerId: a.id,
          sharedGoalId: binding.sharedGoalId,
        },
      }),
    );
    if (!result.ok || result.value.kind !== 'work')
      throw new Error('Owned task registration refused.');
    const work = result.value.work,
      old = store.getSetting(`${prefix}work:${work.workId}`) as GroupCoordinationResource | null;
    const r: GroupCoordinationResource = {
      work,
      owner: host.owner,
      start: start ??
        old?.start ?? {
          taskId,
          role: 'implementer',
          name: task.title.slice(0, 80),
          instruction: task.goal,
        },
      stop: old?.stop ?? { agentId: a.id, reason: 'Shared owner stop' },
      ...(old?.stopRunId ? { stopRunId: old.stopRunId } : {}),
    };
    store.setSetting(`${prefix}work:${work.workId}`, r);
    return work;
  };
  const receiptKey = (id: string) => `${prefix}action:${id}`;
  const recoverLegacyStopRun = (r: GroupCoordinationResource, requireProof = false) => {
    if ((r.stopRunId && !requireProof) || r.stop.agentId === r.work.managerId) return;
    const missing = () => {
      throw new Error('Exact legacy Start run cannot be proven; inspect its retained receipt.');
    };
    const rows = store.db
      .prepare(
        `SELECT key,value FROM settings WHERE key >= ? AND key < ?
         AND json_extract(value,'$.kind')='start' AND json_extract(value,'$.taskId')=?
         AND json_extract(value,'$.outcome.status')='started'
         AND json_extract(value,'$.outcome.workerId')=? LIMIT 2`,
      )
      .all(`${prefix}action:`, `${prefix}action;`, r.work.taskId, r.stop.agentId);
    if (rows.length !== 1) return missing();
    const row = rows[0]!,
      actionId = String(row.key).slice(receiptKey('').length),
      receipt = z
        .object({
          workId: z.uuid().optional(),
          outcome: groupActionSchema.shape.outcome.unwrap(),
        })
        .safeParse(JSON.parse(String(row.value))),
      child = z
        .object({
          contextId: z.uuid(),
          sharedContextId: z.uuid(),
          managerId: z.uuid(),
          taskId: z.uuid(),
        })
        .safeParse(store.getSetting(`group:native-child:${r.stop.agentId}`));
    if (
      !receipt.success ||
      !receipt.data.outcome.jobId ||
      receipt.data.outcome.taskId !== r.work.taskId ||
      (receipt.data.workId && receipt.data.workId !== r.work.workId) ||
      store.getSetting(`${prefix}worker:${r.stop.agentId}`) !== r.work.workId ||
      !child.success ||
      child.data.sharedContextId !== context.sessionId ||
      child.data.managerId !== r.work.managerId ||
      child.data.taskId !== r.work.taskId ||
      store.getSetting(`group:native-request:${receipt.data.outcome.jobId}`) !== actionId
    )
      return missing();
    const worker = store.agent(r.stop.agentId),
      run = store.run(receipt.data.outcome.jobId);
    if (
      worker.parentId !== r.work.managerId ||
      worker.taskId !== r.work.taskId ||
      run.agentId !== worker.id ||
      (r.stopRunId !== undefined && r.stopRunId !== run.id)
    )
      return missing();
    r.stopRunId = run.id;
    store.setSetting(`${prefix}work:${r.work.workId}`, r);
  };
  const recordActivity = (
    r: GroupCoordinationResource,
    causal: GroupAction,
    outcome: GroupCoordinationOutcome | null,
  ) => {
    const origin = store.db
      .prepare('SELECT result FROM operations WHERE key=?')
      .get(`group:host-coordination-task:${r.work.taskId}:${r.work.sharedGoalId}`);
    if (!origin) return;
    const requestId = z
        .object({ requestId: z.uuid() })
        .parse(JSON.parse(String(origin.result))).requestId,
      original = store.db.prepare('SELECT id FROM runs WHERE key=?').get(requestId);
    if (original) {
      const retained =
        outcome?.status === 'blocked'
          ? store.operation(
              `group:activity-blocked:${causal.actionId}`,
              { action: causal },
              () => ({ taskId: r.work.taskId, causal, outcome }),
            )
          : null;
      captureGroupManagerAction(store, String(original.id), causal, retained?.outcome ?? outcome);
    }
  };
  const inspect: GroupCoordinationLane['inspect'] = async (id) => {
    const saved = store.getSetting(receiptKey(id)) as {
      input: string;
      outcome?: GroupCoordinationOutcome;
      kind: 'start' | 'stop';
      taskId: string;
      workId?: string;
      workerId?: string;
      runId?: string;
      causal?: GroupAction;
    } | null;
    if (saved?.outcome) {
      if (saved.workId && saved.causal)
        recordActivity(resource(saved.workId), saved.causal, saved.outcome);
      return { state: 'completed', outcome: saved.outcome };
    }
    if (!saved) return { state: 'absent' };
    const child = native.inspect(context, id);
    if (saved.kind === 'start' && child) {
      if (saved.workId) {
        const r = resource(saved.workId);
        if (r.work.taskId !== saved.taskId) throw new Error('Recovered action task changed.');
        r.stop = { agentId: child.workerId, reason: 'Shared owner stop' };
        r.stopRunId = child.runId;
        store.setSetting(`${prefix}work:${r.work.workId}`, r);
        store.setSetting(`${prefix}worker:${child.workerId}`, r.work.workId);
      }
      const outcome: GroupCoordinationOutcome = {
        taskId: saved.taskId,
        workerId: child.workerId,
        outcomeId: groupCoordinationId(id, 'outcome'),
        jobId: child.runId,
        status: 'started',
        message: 'Original owner native worker queued under QUARK in the shared group boundary.',
      };
      store.setSetting(receiptKey(id), { ...saved, outcome });
      if (saved.workId && saved.causal)
        recordActivity(resource(saved.workId), saved.causal, outcome);
      return { state: 'completed', outcome };
    }
    if (saved.kind === 'start' && !child) return { state: 'absent' }; // authoritative Store: no queued native effect
    if (saved.kind === 'stop' && saved.workerId) {
      const run = saved.runId ? store.run(saved.runId) : null;
      if (
        (!run || !['running', 'queued'].includes(run.status)) &&
        (!run || !store.getSetting(`group:native-stop-unverified:${run.id}`))
      ) {
        const outcome: GroupCoordinationOutcome = {
          taskId: saved.taskId,
          workerId: saved.workerId,
          outcomeId: groupCoordinationId(id, 'outcome'),
          ...(run ? { jobId: run.id } : {}),
          status: 'stopped',
          message: 'Exact original worker turn is stopped; no retargeting.',
        };
        store.setSetting(receiptKey(id), { ...saved, outcome });
        if (saved.workId && saved.causal)
          recordActivity(resource(saved.workId), saved.causal, outcome);
        return { state: 'completed', outcome };
      }
    }
    return { state: 'pending' };
  };
  const effect = async (
    id: string,
    kind: 'start' | 'stop',
    input: unknown,
    causal: GroupAction,
  ): Promise<GroupCoordinationOutcome> => {
    await revalidate();
    const r = resource(causal.proposal.workId);
    if (
      causal.actionId !== id ||
      causal.proposal.kind !== kind ||
      causal.revision !== r.work.revision ||
      causal.proposal.observed.taskId !== r.work.taskId ||
      !sameOwner(causal.proposal.observed.owner, host.owner)
    )
      throw new Error('Action/resource binding changed.');
    if (kind === 'stop') recoverLegacyStopRun(r);
    const old = store.getSetting(receiptKey(id)) as {
      input: string;
      outcome?: GroupCoordinationOutcome;
      kind?: 'start' | 'stop';
      taskId?: string;
      workerId?: string;
      runId?: string;
    } | null;
    const fingerprintInput = {
      kind,
      input,
      taskId: r.work.taskId,
      managerId: r.work.managerId,
    };
    const fingerprint = JSON.stringify({
      ...fingerprintInput,
      ...(kind === 'stop' ? { stopRunId: r.stopRunId ?? null } : {}),
    });
    if (old) {
      if (old.input !== fingerprint) {
        if (
          kind !== 'stop' ||
          old.kind !== 'stop' ||
          old.taskId !== r.work.taskId ||
          old.workerId !== r.stop.agentId ||
          !r.stopRunId ||
          old.runId !== r.stopRunId ||
          old.input !== JSON.stringify(fingerprintInput)
        )
          throw new Error('Action retry changed input.');
        // Older uncertain Stop receipts predate stopRunId in the fingerprint.
        // Accept their exact saved input only with independently retained Start
        // proof; inspect the original Stop without rewriting or replaying it.
        recoverLegacyStopRun(r, true);
      }
      const status = await inspect(id);
      if (status.state === 'completed') return status.outcome;
      if (status.state === 'pending')
        throw new Error('Existing action outcome is uncertain; inspect same receipt.');
    }
    let entered = false;
    const apply = async (runId?: string) => {
      entered = true;
      await revalidate();
      if (kind === 'start') manager(runId);
      else originalManager();
      // Start persists after admission; exact Stop requires no usage/resource admission.
      store.setSetting(receiptKey(id), {
        input: fingerprint,
        kind,
        taskId: r.work.taskId,
        workId: r.work.workId,
        causal,
      });
      store.event('group.action_intent', store.task(r.work.taskId).projectId, r.work.managerId, {
        actionId: id,
        workId: r.work.workId,
        kind,
        owner: host.owner,
      });
      let outcome: GroupCoordinationOutcome;
      if (kind === 'start') {
        const v = delegateSchema.parse(input),
          child = await native.delegate(context, id, v, causal);
        r.stop = { agentId: child.workerId, reason: 'Shared owner stop' };
        r.stopRunId = child.runId;
        store.setSetting(`${prefix}work:${r.work.workId}`, r);
        store.setSetting(`${prefix}worker:${child.workerId}`, r.work.workId);
        outcome = {
          taskId: r.work.taskId,
          workerId: child.workerId,
          outcomeId: groupCoordinationId(id, 'outcome'),
          jobId: child.runId,
          status: 'started',
          message: 'Original owner native worker queued under QUARK in the shared group boundary.',
        };
      } else {
        const v = pauseWorkerSchema.parse(input);
        if (v.agentId !== r.stop.agentId)
          throw new Error('Stop worker differs from the retained Start receipt.');
        if (v.agentId === r.work.managerId) {
          outcome = {
            taskId: r.work.taskId,
            workerId: null,
            outcomeId: groupCoordinationId(id, 'outcome'),
            status: 'stopped',
            message: 'No worker has been started for this shared work.',
          };
        } else {
          const worker = store.agent(v.agentId);
          if (
            worker.parentId !== r.work.managerId ||
            worker.taskId !== r.work.taskId ||
            (!store.getSetting(`group:native-child:${worker.id}`) &&
              !store.getSetting(`group:host-native-agent:${worker.id}`))
          )
            throw new Error('Worker is outside the native group boundary.');
          if (!r.stopRunId)
            throw new Error('Exact Start run is unavailable; reconcile its original receipt.');
          const run = store.run(r.stopRunId);
          if (run.agentId !== worker.id)
            throw new Error('Stop run differs from the retained Start worker.');
          store.setSetting(receiptKey(id), {
            input: fingerprint,
            kind,
            taskId: r.work.taskId,
            workId: r.work.workId,
            causal,
            workerId: worker.id,
            runId: run.id,
          });
          await runtime.stopGroupCoordinationWorker(
            worker.id,
            run.id,
            `Shared owner stop: ${v.reason}`,
          );
          outcome = {
            taskId: r.work.taskId,
            workerId: worker.id,
            outcomeId: groupCoordinationId(id, 'outcome'),
            jobId: run.id,
            status: 'stopped',
            message: 'Original owner native worker stopped; owned namespace closure verified.',
          };
        }
      }
      store.transaction(() => {
        store.setSetting(receiptKey(id), {
          input: fingerprint,
          kind,
          taskId: r.work.taskId,
          workId: r.work.workId,
          outcome,
          causal,
        });
        store.event('group.action_outcome', store.task(r.work.taskId).projectId, r.work.managerId, {
          actionId: id,
          outcome,
        });
        recordActivity(r, causal, outcome);
      });
      return outcome;
    };
    try {
      return await (kind === 'start'
        ? runtime.withGroupCoordinationControl(r.work.managerId, id, apply)
        : runtime.withGroupCoordinationStopControl(r.work.managerId, apply));
    } catch (error) {
      if (!entered) {
        const outcome: GroupCoordinationOutcome = {
          taskId: r.work.taskId,
          workerId: null,
          outcomeId: groupCoordinationId(id, 'outcome'),
          status: 'blocked',
          message:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : 'Original owner admission held.',
        };
        recordActivity(r, causal, outcome);
        throw new GroupCoordinationBlocked(outcome);
      }
      recordActivity(r, causal, error instanceof GroupCoordinationBlocked ? error.outcome : null);
      throw error;
    }
  };
  const lane: GroupCoordinationLane = {
    owner: host.owner,
    inspect,
    delegate: (id, input, causal) => effect(id, 'start', input, causal),
    pauseWorker: (id, input, causal) => effect(id, 'stop', input, causal),
  };
  return {
    retained: async (action) => {
      if (!host.reconcile || !['pending-owner', 'dispatching', 'uncertain'].includes(action.state))
        return null;
      const r = resource(action.proposal.workId);
      if (
        !sameOwner(action.proposal.observed.owner, host.owner) ||
        r.work.taskId !== action.proposal.observed.taskId ||
        r.work.managerId !== action.proposal.observed.managerId
      )
        throw new Error('Original retained action binding changed.');
      const receipt = await inspect(action.actionId);
      if (receipt.state === 'pending') return null;
      const outcome =
        receipt.state === 'completed'
          ? receipt.outcome
          : {
              taskId: r.work.taskId,
              workerId: null,
              outcomeId: groupCoordinationId(action.actionId, 'retained-absent'),
              status: 'blocked' as const,
              message:
                'Original owner journal proves no native effect; retained action closed without executing work.',
            };
      const result = await host.reconcile({
        receiptId: groupCoordinationId(action.actionId, 'retained-receipt'),
        actionId: action.actionId,
        revision: action.revision,
        owner: host.owner,
        effect:
          receipt.state === 'completed' && outcome.status !== 'blocked' ? 'completed' : 'absent',
        outcome,
      });
      if (!result.ok || result.value.kind !== 'action') return null;
      return result.value.action;
    },
    command: host.command,
    revalidate,
    resolve: async (id) => refresh(id),
    ownerLane: async (owner) => {
      await revalidate();
      return sameOwner(owner, host.owner) ? lane : null;
    },
    normal: {
      createTask: async (key, input, origin) => {
        await revalidate();
        const a = manager(),
          runId = store.runs(['running']).find((r) => r.agentId === a.id)!.id,
          v = taskCreateSchema.parse(input);
        const task = store.operation(
          `${prefix}task:${key}`,
          { managerId: a.id, input: v, origin },
          () => {
            if (
              store
                .tasks()
                .filter(
                  (t) =>
                    t.managerId === a.id &&
                    !['done', 'integrated', 'split', 'cancelled'].includes(t.status),
                ).length >= 12
            )
              throw new Error('Finish or split existing tasks before opening more.');
            return store.addTask(a.projectId, {
              ...v,
              managerId: a.id,
              parentId: v.parentId ?? null,
            });
          },
        );
        return saveWork(key, task.id, origin, undefined, runId);
      },
      prepareDelegate: async (key, input, origin) => {
        await revalidate();
        const a = manager(),
          runId = store.runs(['running']).find((r) => r.agentId === a.id)!.id;
        const v = store.operation(
          `${prefix}delegate-input:${key}`,
          { input: delegateSchema.parse(input), origin },
          () => delegateSchema.parse(input),
        );
        return saveWork(key, v.taskId, origin, v, runId);
      },
      workForWorker: async (id) => {
        await revalidate();
        const workId = store.getSetting(`${prefix}worker:${id}`);
        if (typeof workId !== 'string') throw new Error('Worker is outside this group.');
        return (await refresh(workId)).work;
      },
    },
  };
}
