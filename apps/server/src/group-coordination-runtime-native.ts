import { delegationTools } from './worker-tools.js';
import { GroupIsolationBlocked } from './group-isolation.js';
import type { Runtime } from './runtime.js';
import type { GroupNativeContext, GroupNativeJournal, GroupNativeBridge } from './group-native.js';
import type { GroupNativeExecution, GroupExecutionResources } from './group-native-execution.js';
import type { GroupNativeHostRoute } from './group-native-connector.js';
import type { GroupCoordinationNativePort } from './group-coordination-runtime.js';
export interface GroupCoordinationNativeLive {
  handle: GroupNativeContext;
  agentId: string;
  execution?: GroupNativeExecution;
  processing?: Promise<void>;
}
/** Owner-native child dispatch only. All processes remain in the original
 * accepted shared guest account/resource scope, never an ordinary host launch. */
export function createGroupNativeCoordination({
  runtime,
  journal,
  bridge,
  route,
  resources,
  active,
  pendingText,
  runTurn,
}: {
  runtime: Runtime;
  journal: GroupNativeJournal;
  bridge: GroupNativeBridge;
  route: () => GroupNativeHostRoute;
  resources: (handle: GroupNativeContext) => GroupExecutionResources;
  active: Map<string, GroupCoordinationNativeLive>;
  pendingText: Map<string, string>;
  runTurn: (requestId: string, text: string) => Promise<void>;
}): GroupCoordinationNativePort {
  const identity: GroupCoordinationNativePort['identity'] = (context) => {
    const row = journal.resolve(journal.reopen(context.sessionId));
    if (JSON.stringify(row.context) !== JSON.stringify(context))
      throw new GroupIsolationBlocked('Exact provisioned native context required.');
    const agent = runtime.store.agent(row.agentId);
    const child = runtime.store.getSetting(`group:native-child:${agent.id}`) as {
      contextId?: string;
      managerId?: string;
    } | null;
    if (
      context.visibility === 'shared' &&
      agent.role !== 'manager' &&
      (!child || child.contextId !== context.sessionId || child.managerId !== agent.parentId)
    )
      throw new GroupIsolationBlocked('This native context has no original group manager binding.');
    const run = runtime.store.runs(['running']).find((r) => r.agentId === agent.id);
    const request = run ? runtime.store.getSetting(`group:native-request:${run.id}`) : null;
    return {
      managerId: child?.managerId ?? agent.id,
      agentId: agent.id,
      requestId: typeof request === 'string' ? request : null,
    };
  };
  const coordination: GroupCoordinationNativePort = {
    identity,
    inspect(context, actionId) {
      const saved = runtime.store.getSetting(`group:native-action:${actionId}`) as {
        workerId: string;
        contextId: string;
        managerContextId: string;
      } | null;
      if (!saved) return null;
      if (saved.managerContextId !== context.sessionId)
        throw new GroupIsolationBlocked('Action belongs to another native group context.');
      const owner = identity(context),
        handle = journal.reopen(saved.contextId),
        child = journal.resolve(handle),
        worker = runtime.store.agent(saved.workerId),
        marker = runtime.store.getSetting(`group:native-child:${worker.id}`) as {
          contextId?: string;
          sharedContextId?: string;
          managerId?: string;
          taskId?: string;
        } | null;
      if (
        child.agentId !== worker.id ||
        child.context.groupId !== context.groupId ||
        child.context.memberId !== context.memberId ||
        child.context.installationId !== context.installationId ||
        child.context.visibility !== 'shared' ||
        child.context.provider !== context.provider ||
        worker.parentId !== owner.managerId ||
        marker?.contextId !== saved.contextId ||
        marker.sharedContextId !== context.sessionId ||
        marker.managerId !== owner.managerId ||
        marker.taskId !== worker.taskId
      )
        throw new GroupIsolationBlocked('Retained native action child binding changed.');
      const runId = journal.requestRunId(handle, actionId);
      if (!runId)
        throw new GroupIsolationBlocked('Exact retained native action run is unavailable.');
      const run = runtime.store.run(runId);
      if (
        run.agentId !== worker.id ||
        runtime.store.getSetting(`group:native-request:${run.id}`) !== actionId
      )
        throw new GroupIsolationBlocked('Retained native action run binding changed.');
      return { workerId: saved.workerId, runId: run.id };
    },
    async delegate(context, actionId, input) {
      const owner = identity(context),
        manager = runtime.store.agent(owner.managerId);
      if (owner.agentId !== owner.managerId)
        throw new GroupIsolationBlocked('Only the original group manager can delegate.');
      const originalRun = runtime.store.runs(['running']).find((r) => r.agentId === manager.id)?.id;
      const requireLease = () => {
        const run = runtime.store.runs(['running']).find((r) => r.agentId === manager.id);
        if (!originalRun || run?.id !== originalRun)
          throw new GroupIsolationBlocked('Original manager control turn changed.');
        return runtime.quark.requireManagerLease(run);
      };
      requireLease();
      const existing = coordination.inspect(context, actionId);
      if (existing) {
        runtime.store.operation(`group:native-child:${actionId}`, { context, input }, () => {
          throw new GroupIsolationBlocked('Native child receipt is missing.');
        });
        return existing;
      }
      const task = runtime.store.task(input.taskId);
      if (
        context.visibility !== 'shared' ||
        task.managerId !== manager.id ||
        task.projectId !== manager.projectId ||
        ['done', 'cancelled', 'integrated', 'split', 'needs_decision'].includes(task.status)
      )
        throw new GroupIsolationBlocked('Open original group-manager task required.');
      const children = runtime.store.agents().filter((a) => a.taskId === task.id);
      if (
        children.length >= 12 ||
        children.some(
          (a) => a.role === 'implementer' && ['queued', 'running', 'waiting'].includes(a.status),
        )
      )
        throw new GroupIsolationBlocked(
          'Task worker concurrency/limit requires current work to finish.',
        );
      if (
        ['implementer', 'reviewer', 'planner'].includes(input.role) &&
        ['routine', 'bulk'].includes(input.execution?.taskClass ?? 'reasoning')
      )
        throw new GroupIsolationBlocked(
          'Planning, implementation and review require grad students or above.',
        );
      const assignment = await runtime.modelPolicy.resolveWorker(
        manager.projectId,
        input.role,
        input.execution,
      );
      const grant = delegationTools(
        runtime.store,
        manager.projectId,
        assignment.provider,
        input.tools,
      );
      if (assignment.provider !== context.provider || grant.toolPolicy !== 'native')
        throw new GroupIsolationBlocked(
          'Selected provider/restricted policy has no accepted native route in this group account scope; no provider or permission fallback.',
        );
      const lease = requireLease();
      const parent = journal.reopen(context.sessionId),
        savedHome = journal.savedContainer(parent);
      if (!savedHome)
        throw new GroupIsolationBlocked('Original group native account scope is not initialized.');
      const configured = route();
      const accountGrant = runtime.store.getSetting(`group:native-resources:${manager.id}`);
      if (
        JSON.stringify(accountGrant) !==
        JSON.stringify({ image: configured.image, resources: configured.resources })
      )
        throw new GroupIsolationBlocked('Original shared account resource grant changed.');
      const saved = runtime.store.operation(
        `group:native-child:${actionId}`,
        { context, input },
        () => {
          const worker = runtime.store.addAgent({
            projectId: manager.projectId,
            parentId: manager.id,
            taskId: task.id,
            role: input.role,
            name: input.name,
            cwd: manager.cwd,
            provider: assignment.provider,
          });
          runtime.store.updateAgent(worker.id, {
            model: assignment.model,
            effort: assignment.effort,
            assignment,
            modelSelection:
              !input.execution?.model && !input.execution?.effort ? 'policy' : 'exact',
            toolPolicy: 'native',
            permission: input.role === 'implementer' ? 'workspace-write' : 'read-only',
          });
          runtime.store.setSetting(
            `model-policy:follow:${worker.id}`,
            !input.execution?.model && !input.execution?.effort,
          );
          runtime.store.setSetting(`worker-tools:grant:${worker.id}`, {
            projectId: manager.projectId,
            revision: grant.revision,
            tools: grant.tools,
          });
          const handle = journal.issue(context, worker.id, assignment.provider),
            child = journal.resolve(handle);
          runtime.store.setSetting(`group:native-child:${worker.id}`, {
            contextId: child.context.sessionId,
            sharedContextId: context.sessionId,
            managerId: manager.id,
            taskId: task.id,
            managerRunId: lease.runId,
            leaseId: lease.id,
            volume: savedHome.volume,
            image: configured.image,
            resources: { ...configured.resources },
          });
          const result = {
            workerId: worker.id,
            contextId: child.context.sessionId,
            managerContextId: context.sessionId,
          };
          runtime.store.setSetting(`group:native-action:${actionId}`, result);
          return result;
        },
      );
      // Any orphan issuance is burned before process start. Only this dedicated
      // bridge queues the worker; generic Runtime delegation is never invoked.
      const handle = journal.reopen(saved.contextId);
      journal.beginRequest(handle, actionId, input.instruction);
      const queued = runtime.queueGroupNativeRequest(bridge, handle, resources(handle));
      journal.requestEvent(handle, actionId, { runId: queued.runId });
      runtime.store.setSetting(`model-policy:run:${queued.runId}`, assignment);
      runtime.store.setSetting(`quark:dispatch:${queued.runId}`, {
        managerRunId: lease.runId,
        leaseId: lease.id,
        managerId: manager.id,
        taskId: task.id,
      });
      runtime.store.setSetting(`group:native-request:${queued.runId}`, actionId);
      runtime.store.updateTask(task.id, {
        status: input.role === 'reviewer' ? 'review' : 'working',
      });
      const live: {
        handle: GroupNativeContext;
        agentId: string;
        execution?: GroupNativeExecution;
        processing?: Promise<void>;
      } = { handle, agentId: saved.workerId };
      active.set(actionId, live);
      live.processing = queued.admitted
        .then(async (execution) => {
          live.execution = execution;
          journal.requestEvent(handle, actionId, { state: 'admitted' });
          // Shared group HOME is the already authorized guest scope. A missing
          // provider authorization is a real hold, never a host account import.
          if ((await execution.authentication()) !== 'authenticated') {
            journal.requestEvent(handle, actionId, {
              state: 'pending-consent',
              reason: 'Original shared group native account needs renewal.',
            });
            pendingText.set(actionId, input.instruction);
            return;
          }
          await runTurn(actionId, input.instruction);
        })
        .catch(() => {
          journal.requestEvent(handle, actionId, {
            state: 'failed',
            reason: 'Owned group worker preparation failed; no ordinary native fallback.',
          });
          active.delete(actionId);
        });
      return { workerId: saved.workerId, runId: queued.runId };
    },
  };
  return coordination;
}
