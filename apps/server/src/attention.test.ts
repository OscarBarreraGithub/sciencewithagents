import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { attention, agentSchema, approvalSchema, taskSchema, type Snapshot } from '@dock/shared';

function fixture(): Snapshot {
  const projectId = randomUUID(),
    managerId = randomUUID(),
    createdAt = new Date().toISOString();
  return {
    eventId: 42,
    provider: { ready: true, version: 'fixture', message: '' },
    projects: [{ id: projectId, name: 'Project one', description: '', managerId, createdAt }],
    agents: [
      agentSchema.parse({
        id: managerId,
        projectId,
        name: 'Manager',
        parentId: null,
        taskId: null,
        role: 'manager',
        status: 'idle',
        model: null,
        effort: 'medium',
        permission: 'read-only',
        checkpoint: '',
        createdAt,
        updatedAt: createdAt,
      }),
    ],
    tasks: [],
    approvals: [],
    decisions: [],
    backups: [],
  };
}
describe('cross-project attention read model', () => {
  it('combines exact pending sources across projects, orders consistently and does not mutate them', () => {
    const value = fixture(),
      other = fixture();
    value.projects.push(...other.projects);
    value.agents.push(...other.agents);
    const agent = value.agents[0],
      project = value.projects[1];
    const approval = approvalSchema.parse({
      id: randomUUID(),
      agentId: agent.id,
      kind: 'command',
      title: 'Permission needed',
      details: 'Private command details stay on original card',
      status: 'pending',
      createdAt: agent.createdAt,
    });
    value.approvals.push(approval);
    value.tasks.push(
      taskSchema.parse({
        id: randomUUID(),
        projectId: project.id,
        managerId: project.managerId,
        parentId: null,
        title: 'Reviewed work',
        goal: 'One outcome',
        acceptance: 'Evidence',
        status: 'done',
        revisions: 0,
        review: null,
        hasReviewedChanges: true,
        createdAt: agent.createdAt,
        updatedAt: agent.createdAt,
      }),
    );
    value.backups.push({
      projectId: project.id,
      configured: true,
      state: 'needs_attention',
      commit: null,
      checkedAt: null,
      message: 'Transport failed',
    });
    const original = JSON.stringify(value),
      result = attention(value);
    expect(result.eventId).toBe(42);
    expect(result.items.map((item) => item.kind)).toEqual(['approval', 'integration', 'backup']);
    expect(result.items[0].id).toBe(approval.id);
    expect(result.items[1].agentId).toBe(project.managerId);
    expect(JSON.stringify(result)).not.toContain(approval.details);
    expect(JSON.stringify(value)).toBe(original);
    expect(attention(value)).toEqual(result);
  });
  it('removes resolved requests and transcript-only results automatically, without dismissal records', () => {
    const value = fixture(),
      agent = value.agents[0];
    value.approvals.push(
      approvalSchema.parse({
        id: randomUUID(),
        agentId: agent.id,
        kind: 'input',
        title: 'Resolved',
        details: '',
        status: 'accepted',
        createdAt: agent.createdAt,
      }),
    );
    value.tasks.push(
      taskSchema.parse({
        id: randomUUID(),
        projectId: agent.projectId,
        managerId: agent.id,
        parentId: null,
        title: 'Transcript result',
        goal: 'One outcome',
        acceptance: 'Evidence',
        status: 'done',
        revisions: 0,
        review: null,
        createdAt: agent.createdAt,
        updatedAt: agent.createdAt,
      }),
    );
    value.backups.push({
      projectId: agent.projectId,
      configured: false,
      state: 'not_configured',
      commit: null,
      checkedAt: null,
      message: 'Optional setup',
    });
    expect(attention(value).items).toEqual([]);
    value.tasks[0].status = 'needs_decision';
    expect(attention(value).items[0].kind).toBe('decision');
    value.tasks[0].status = 'split';
    expect(attention(value).items).toEqual([]);
  });
  it('routes stopped native helpers through their controlling parent without duplicate cards or cross-project targets', () => {
    const value = fixture(),
      root = value.agents[0];
    root.status = 'interrupted';
    value.agents.push({ ...root, id: randomUUID(), parentId: root.id, nativeRootId: root.id });
    expect(attention(value).items).toHaveLength(1);
    expect(attention(value).items[0].agentId).toBe(root.id);
    value.agents[1].projectId = randomUUID();
    value.agents[0].status = 'idle';
    expect(attention(value).items).toEqual([]);
  });
});
