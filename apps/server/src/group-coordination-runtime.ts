import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  delegateSchema,
  pauseWorkerSchema,
  taskCreateSchema,
  type GroupContext,
} from '@dock/shared';
import {
  groupActionResultSchema,
  type GroupAction,
  type GroupActionActor,
  type GroupActionOrigin,
  type GroupActionWork,
} from '@dock/shared/dist/group-actions.js';
import type { Runtime } from './runtime.js';
import type {
  GroupCoordinationLane,
  GroupCoordinationOutcome,
  GroupCoordinationPorts,
  GroupCoordinationResource,
} from './group-coordination.js';

export interface GroupCoordinationNativePort {
  identity(context: GroupContext): { managerId: string; agentId: string; requestId: string | null };
  delegate(
    context: GroupContext,
    actionId: string,
    input: z.infer<typeof delegateSchema>,
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
    };
    store.setSetting(`${prefix}work:${work.workId}`, r);
    return work;
  };
  const receiptKey = (id: string) => `${prefix}action:${id}`;
  const inspect: GroupCoordinationLane['inspect'] = async (id) => {
    const saved = store.getSetting(receiptKey(id)) as {
      input: string;
      outcome?: GroupCoordinationOutcome;
      kind: 'start' | 'stop';
      taskId: string;
      workerId?: string;
      runId?: string;
    } | null;
    if (saved?.outcome) return { state: 'completed', outcome: saved.outcome };
    if (!saved) return { state: 'absent' };
    const child = native.inspect(context, id);
    if (saved.kind === 'start' && child) {
      const outcome: GroupCoordinationOutcome = {
        taskId: saved.taskId,
        workerId: child.workerId,
        outcomeId: groupCoordinationId(id, 'outcome'),
        jobId: child.runId,
        status: 'started',
        message: 'Original owner native worker queued under QUARK in the shared group boundary.',
      };
      store.setSetting(receiptKey(id), { ...saved, outcome });
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
    const old = store.getSetting(receiptKey(id)) as {
      input: string;
      outcome?: GroupCoordinationOutcome;
    } | null;
    const fingerprint = JSON.stringify({
      kind,
      input,
      taskId: r.work.taskId,
      managerId: r.work.managerId,
    });
    if (old) {
      if (old.input !== fingerprint) throw new Error('Action retry changed input.');
      const status = await inspect(id);
      if (status.state === 'completed') return status.outcome;
      if (status.state === 'pending')
        throw new Error('Existing action outcome is uncertain; inspect same receipt.');
    }
    const apply = async (runId?: string) => {
      await revalidate();
      if (kind === 'start') manager(runId);
      else originalManager();
      // Start persists after admission; exact Stop requires no usage/resource admission.
      store.setSetting(receiptKey(id), { input: fingerprint, kind, taskId: r.work.taskId });
      store.event('group.action_intent', store.task(r.work.taskId).projectId, r.work.managerId, {
        actionId: id,
        workId: r.work.workId,
        kind,
        owner: host.owner,
      });
      let outcome: GroupCoordinationOutcome;
      if (kind === 'start') {
        const v = delegateSchema.parse(input),
          child = await native.delegate(context, id, v);
        r.stop = { agentId: child.workerId, reason: 'Shared owner stop' };
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
        const v = pauseWorkerSchema.parse(input),
          worker = store.agent(v.agentId);
        if (
          worker.parentId !== r.work.managerId ||
          worker.taskId !== r.work.taskId ||
          !store.getSetting(`group:native-child:${worker.id}`)
        )
          throw new Error('Worker is outside the native group boundary.');
        const run = store.runs(['running', 'queued']).find((x) => x.agentId === worker.id);
        store.setSetting(receiptKey(id), {
          input: fingerprint,
          kind,
          taskId: r.work.taskId,
          workerId: worker.id,
          ...(run ? { runId: run.id } : {}),
        });
        if (run)
          await runtime.stopGroupCoordinationWorker(
            worker.id,
            run.id,
            `Shared owner stop: ${v.reason}`,
          );
        outcome = {
          taskId: r.work.taskId,
          workerId: worker.id,
          outcomeId: groupCoordinationId(id, 'outcome'),
          ...(run ? { jobId: run.id } : {}),
          status: 'stopped',
          message: 'Original owner native worker stopped; owned namespace closure verified.',
        };
      }
      store.setSetting(receiptKey(id), {
        input: fingerprint,
        kind,
        taskId: r.work.taskId,
        outcome,
      });
      store.event('group.action_outcome', store.task(r.work.taskId).projectId, r.work.managerId, {
        actionId: id,
        outcome,
      });
      return outcome;
    };
    return kind === 'start'
      ? runtime.withGroupCoordinationControl(r.work.managerId, id, apply)
      : runtime.withGroupCoordinationStopControl(r.work.managerId, apply);
  };
  const lane: GroupCoordinationLane = {
    owner: host.owner,
    inspect,
    delegate: (id, input, causal) => effect(id, 'start', input, causal),
    pauseWorker: (id, input, causal) => effect(id, 'stop', input, causal),
  };
  return {
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
