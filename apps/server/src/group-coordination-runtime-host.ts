import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './workspaces.js';
import { delegateSchema, type GroupContext } from '@dock/shared';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { GroupCoordinationBlocked } from './group-coordination.js';
import { groupCoordinationId } from './group-coordination-runtime.js';
import type { GroupCoordinationNativePort } from './group-coordination-runtime.js';
import { Conflict } from './store.js';
import { groupHostStopKey, groupHostTurnSchema } from './group-host-work-continuation.js';
import { publicationCanonical } from './group-publication-protocol.js';

type Binding = { context: GroupContext; agentId: string; enrollmentHandle: string; cwd: string };
const actionKey = (id: string) => `group:host-coordination-action:${z.uuid().parse(id)}`;
/** Original local account, ordinary delegation/worktrees/review. No guest or provider lane. */
export function createGroupHostCoordination(
  runtime: Runtime,
  resolve: (context: GroupContext) => Binding,
): GroupCoordinationNativePort {
  const store = runtime.store;
  const binding = (context: GroupContext) => {
    const saved = resolve(context),
      manager = store.agent(saved.agentId);
    if (manager.executionMode !== 'managed')
      throw new Conflict(
        'Managed task coordination is unavailable in a direct native Group conversation.',
        'GROUP_MANAGED_COORDINATION_REQUIRED',
      );
    if (
      context.visibility !== 'shared' ||
      manager.role !== 'manager' ||
      publicationCanonical(saved.context) !== publicationCanonical(context) ||
      store.getSetting(`group:native-auth-agent:${manager.id}`)
    )
      throw new Conflict('Exact original host-native shared manager required.');
    return saved;
  };
  const identity: GroupCoordinationNativePort['identity'] = (context) => {
    const owner = binding(context),
      run = store.runs(['running']).find((r) => r.agentId === owner.agentId);
    const turn = run
      ? groupHostTurnSchema.safeParse(store.getSetting(`group:host-native-run:${run.id}`))
      : null;
    return {
      managerId: owner.agentId,
      agentId: owner.agentId,
      requestId: turn?.success && turn.data.intent === 'work' ? turn.data.requestId : null,
    };
  };
  const port: GroupCoordinationNativePort = {
    identity,
    bindTask(context, taskId, sharedGoalId) {
      const owner = binding(context),
        who = identity(context),
        task = store.task(taskId);
      if (!who.requestId || task.managerId !== owner.agentId)
        throw new Conflict('Original Work task required.');
      store.operation(
        `group:host-coordination-task:${taskId}:${sharedGoalId}`,
        { context, requestId: who.requestId, taskId, sharedGoalId },
        () => ({ context, requestId: who.requestId }),
      );
    },
    inspect(context, actionId) {
      const owner = binding(context),
        key = actionKey(actionId);
      const row = store.db.prepare('SELECT input,result FROM operations WHERE key=?').get(key);
      if (!row) return null;
      const input = JSON.parse(String(row.input)) as {
        agentId: string;
        name: string;
        raw: z.infer<typeof delegateSchema>;
      };
      const worker = store.agent(
        z.object({ id: z.uuid() }).parse(JSON.parse(String(row.result))).id,
      );
      const runRow = store.db.prepare('SELECT id FROM runs WHERE key=?').get(`delegate:${key}`);
      const marker = store.getSetting(`group:host-native-agent:${worker.id}`) as {
        context?: GroupContext;
        enrollmentHandle?: string;
      } | null;
      if (
        input.agentId !== owner.agentId ||
        input.name !== 'dock_delegate' ||
        worker.parentId !== owner.agentId ||
        worker.taskId !== input.raw.taskId ||
        !runRow ||
        marker?.enrollmentHandle !== owner.enrollmentHandle ||
        publicationCanonical(marker.context) !== publicationCanonical(context)
      )
        throw new Conflict('Retained native action effect binding changed.');
      return { workerId: worker.id, runId: String(runRow.id) };
    },
    async delegate(context, actionId, input, causal) {
      const owner = binding(context),
        v = delegateSchema.parse(input),
        key = actionKey(actionId);
      try {
        if (
          !causal ||
          causal.actionId !== actionId ||
          causal.proposal.observed.taskId !== v.taskId ||
          causal.proposal.observed.managerId !== owner.agentId
        )
          throw new Conflict('Exact action task authority required.');
        const existing = port.inspect(context, actionId);
        if (existing) {
          store.operation(
            key,
            { agentId: owner.agentId, name: 'dock_delegate', raw: v },
            () => null,
          );
          return existing;
        }
        const task = store.task(v.taskId),
          sharedGoalId = causal.proposal.observed.sharedGoalId;
        const originRow = store.db
          .prepare('SELECT result FROM operations WHERE key=?')
          .get(`group:host-coordination-task:${task.id}:${sharedGoalId}`);
        const origin = originRow
          ? (JSON.parse(String(originRow.result)) as { context: GroupContext; requestId: string })
          : null;
        const run = store.runs(['running']).find((r) => r.agentId === owner.agentId);
        if (
          !run ||
          task.managerId !== owner.agentId ||
          !origin ||
          publicationCanonical(origin.context) !== publicationCanonical(context) ||
          store.getSetting(groupHostStopKey(origin.requestId))
        )
          throw new Conflict('Original admitted Work task authority unavailable.');
        const original = store.db
          .prepare('SELECT id,agent_id FROM runs WHERE key=?')
          .get(origin.requestId);
        if (!original || original.agent_id !== owner.agentId)
          throw new Conflict('Original Work receipt unavailable.');
        if (store.getSetting(`group:native-control:${run.id}`)) {
          store.setSetting(`group:host-native-run:${run.id}`, {
            requestId: origin.requestId,
            intent: 'work',
            context,
            originRunId: String(original.id),
            parentRunId: String(original.id),
          });
        }
        const turn = groupHostTurnSchema.parse(store.getSetting(`group:host-native-run:${run.id}`));
        if (
          turn.intent !== 'work' ||
          publicationCanonical(turn.context) !== publicationCanonical(context)
        )
          throw new Conflict('Ask cannot authorize a shared action effect.');
        if (turn.requestId !== origin.requestId)
          throw new Conflict('Another Work turn cannot lend its request authority to this action.');
        await runtime.groupHostNativeAdmission!(owner.agentId, run.id);
        store.operation(
          `group:host-coordination-origin:${actionId}`,
          { context, actionId },
          () => ({
            origin: causal.proposal.origin,
            workId: causal.proposal.workId,
            taskId: task.id,
            sharedGoalId,
          }),
        );
        if (v.role === 'implementer' && !existsSync(join(owner.cwd, '.git'))) {
          // Only this connector's fresh private workspace: no user files are staged.
          await git(owner.cwd, ['init', '--initial-branch=main']);
          await git(owner.cwd, [
            '-c',
            'user.name=sciencewithagents',
            '-c',
            'user.email=noreply@localhost',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--allow-empty',
            '-m',
            'Initialize local group task workspace',
          ]);
        }
        // Filesystem preparation may await I/O; recheck membership and the exact turn.
        if (store.runs(['running']).find((r) => r.agentId === owner.agentId)?.id !== run.id)
          throw new Conflict('Original manager control turn changed.');
        await runtime.groupHostNativeAdmission!(owner.agentId, run.id);
        await runtime.delegateGroupHostCoordinationWorker(owner.agentId, key, v);
        return port.inspect(context, actionId)!;
      } catch (error) {
        // The ordinary Store operation atomically saves worker + queue + receipt.
        // Only an authoritative absence can settle a refusal; unknown effects stay held.
        let existing: ReturnType<GroupCoordinationNativePort['inspect']>;
        try {
          existing = port.inspect(context, actionId);
        } catch {
          throw error;
        }
        if (!existing)
          throw new GroupCoordinationBlocked({
            taskId: v.taskId,
            workerId: null,
            outcomeId: groupCoordinationId(actionId, 'outcome'),
            status: 'blocked',
            message:
              error instanceof Error
                ? error.message.slice(0, 2000)
                : 'Original owner action held before queueing.',
          });
        throw error;
      }
    },
  };
  return port;
}
