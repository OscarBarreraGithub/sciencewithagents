import { z } from 'zod';
import type { Snapshot } from './index.js';

export const attentionItemSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['approval', 'decision', 'failed', 'interrupted', 'integration', 'backup']),
    projectId: z.string().uuid(),
    projectName: z.string(),
    agentId: z.string().uuid(),
    taskId: z.string().uuid().nullable(),
    title: z.string(),
    description: z.string(),
    updatedAt: z.string(),
    destination: z.enum(['conversation', 'workspace']),
  })
  .strict();
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export const attentionSchema = z
  .object({ eventId: z.number().int(), items: z.array(attentionItemSchema) })
  .strict();

/** Deterministic cross-project read model. No new decisions, agents, actions or stored flags. */
export function attention(snapshot: Snapshot): z.infer<typeof attentionSchema> {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const items: AttentionItem[] = [];
  const add = (item: Omit<AttentionItem, 'projectName'>) => {
    const project = projects.get(item.projectId),
      agent = agents.get(item.agentId);
    if (
      project &&
      agent?.projectId === project.id &&
      !items.some((other) => other.kind === item.kind && other.id === item.id)
    )
      items.push({ ...item, projectName: project.name });
  };
  for (const approval of snapshot.approvals) {
    const agent = agents.get(approval.agentId);
    if (approval.status !== 'pending' || !agent) continue;
    add({
      id: approval.id,
      kind: 'approval',
      projectId: agent.projectId,
      agentId: agent.id,
      taskId: agent.taskId,
      title: approval.title,
      description: 'Review the original request before allowing or declining it.',
      updatedAt: approval.createdAt,
      destination: 'conversation',
    });
  }
  for (const task of snapshot.tasks) {
    const kind =
      task.status === 'needs_decision'
        ? 'decision'
        : task.status === 'done' && task.hasReviewedChanges && !task.reconciliationTaskId
          ? 'integration'
          : null;
    if (!kind) continue;
    add({
      id: task.id,
      kind,
      projectId: task.projectId,
      agentId: task.managerId,
      taskId: task.id,
      title: task.title,
      description:
        kind === 'decision'
          ? 'Ask the responsible manager to resolve or split the current task.'
          : 'Reviewed changes are ready for your exact preview and confirmation.',
      updatedAt: task.updatedAt,
      destination: kind === 'integration' ? 'workspace' : 'conversation',
    });
  }
  for (const agent of snapshot.agents) {
    if (!['failed', 'interrupted'].includes(agent.status)) continue;
    const controller = agent.nativeRootId ? agents.get(agent.nativeRootId) : agent;
    if (!controller || controller.projectId !== agent.projectId) continue;
    add({
      id: controller.id,
      kind: agent.status as 'failed' | 'interrupted',
      projectId: agent.projectId,
      agentId: controller.id,
      taskId: controller.taskId,
      title: `${controller.name}: stopped work`,
      description:
        'Inspect the last saved result before explicitly resuming. Nothing is replayed automatically.',
      updatedAt: agent.updatedAt,
      destination: 'conversation',
    });
  }
  for (const backup of snapshot.backups) {
    const project = projects.get(backup.projectId);
    if (backup.state !== 'needs_attention' || !project) continue;
    add({
      id: project.id,
      kind: 'backup',
      projectId: project.id,
      agentId: project.managerId,
      taskId: null,
      title: 'Source backup needs attention',
      description: 'Local work is kept. Open the project to inspect or retry its source backup.',
      updatedAt: backup.checkedAt ?? project.createdAt,
      destination: 'conversation',
    });
  }
  const order = ['approval', 'decision', 'failed', 'interrupted', 'integration', 'backup'];
  items.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      a.updatedAt.localeCompare(b.updatedAt) ||
      a.id.localeCompare(b.id),
  );
  return attentionSchema.parse({ eventId: snapshot.eventId, items });
}
