import { z } from 'zod';
import type { GroupContext } from '@dock/shared';
import type { Store } from './store.js';
import type { GroupNativeContext, GroupNativeJournal } from './group-native.js';
import type { GroupExecutionResources } from './group-native-execution.js';
import { GroupIsolationBlocked } from './group-isolation.js';

export const groupNativeChildSchema = z.strictObject({
  contextId: z.uuid(),
  sharedContextId: z.uuid(),
  managerId: z.uuid(),
  taskId: z.uuid(),
  managerRunId: z.uuid(),
  leaseId: z.uuid(),
  volume: z.string().regex(/^swa-group-[a-f0-9-]{36}$/),
  image: z.string(),
  resources: z.unknown(),
});
const sameScope = (a: GroupContext, b: GroupContext) =>
  a.visibility === 'shared' &&
  b.visibility === 'shared' &&
  a.groupId === b.groupId &&
  a.memberId === b.memberId &&
  a.installationId === b.installationId &&
  a.provider === b.provider;
/** Guest HOME/account is scoped to original owner+group+shared visibility. A
 * child gets a fresh native journal/thread and its own task cwd/container. It
 * cannot borrow a private HOME, another member or a different provider route. */
export function groupNativeChildScope(
  store: Store,
  journal: GroupNativeJournal,
  handle: GroupNativeContext,
  resources: GroupExecutionResources,
) {
  const row = journal.resolve(handle),
    agent = store.agent(row.agentId);
  const raw = store.getSetting(`group:native-child:${agent.id}`);
  if (!raw) {
    if (agent.taskId || agent.parentId)
      throw new GroupIsolationBlocked('Native child binding missing.');
    return null;
  }
  const child = groupNativeChildSchema.parse(raw),
    parentHandle = journal.reopen(child.sharedContextId),
    parent = journal.resolve(parentHandle),
    manager = store.agent(child.managerId);
  const saved = journal.savedContainer(parentHandle),
    task = store.task(child.taskId);
  const granted = {
    workspace: resources.workspace,
    stateBase: resources.stateBase,
    readResources: [...resources.readResources],
    forbiddenPaths: [...resources.forbiddenPaths],
    outbound: resources.outbound,
  };
  if (
    child.contextId !== row.context.sessionId ||
    parent.agentId !== manager.id ||
    manager.role !== 'manager' ||
    manager.parentId ||
    manager.taskId ||
    agent.parentId !== manager.id ||
    agent.taskId !== task.id ||
    task.managerId !== manager.id ||
    task.projectId !== manager.projectId ||
    agent.projectId !== manager.projectId ||
    !sameScope(parent.context, row.context) ||
    !saved ||
    saved.volume !== child.volume ||
    resources.image !== child.image ||
    JSON.stringify(granted) !== JSON.stringify(child.resources)
  )
    throw new GroupIsolationBlocked(
      'Original shared group native account/resource binding changed.',
    );
  return {
    context: parent.context,
    volume: child.volume,
    workspace: `/workspace/tasks/${child.taskId}`,
  };
}
