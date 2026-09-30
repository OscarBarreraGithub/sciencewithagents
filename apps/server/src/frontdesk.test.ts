import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { frontdeskDeliverySchema } from '@dock/shared';
import { Store, now } from './store.js';
import { Frontdesk } from './frontdesk.js';
import { repoRoot } from './paths.js';

let root: string, store: Store, frontdesk: Frontdesk;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/frontdesk-'));
  store = new Store(join(root, 'dock.sqlite'));
  frontdesk = new Frontdesk(store, root);
});
afterEach(() => {
  frontdesk.close();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
function setup() {
  const project = store.register(join(root, 'project'), 'Owner project', 'Visible only by choice');
  const hidden = store.register(
    join(root, 'hidden'),
    'Other account’s private project',
    'Never implicitly share',
  );
  const created = frontdesk.create({ key: randomUUID() });
  frontdesk.save({
    key: randomUUID(),
    expectedRevision: 0,
    visibleProjectIds: [project.id],
    preferences: 'Concise explanations',
    priorities: 'Finish one bounded result',
    commitments: 'Remember the review check',
  });
  return { project, hidden, agentId: created.agentId! };
}
function ownerTurn(agentId: string) {
  const run = store.enqueue(
    agentId,
    randomUUID(),
    'Ask the selected project manager for one result.',
  );
  store.updateRun(run.id, { status: 'running' });
  store.updateAgent(agentId, { status: 'running' });
  return run;
}
function route(agentId: string, managerId: string, key = randomUUID()) {
  return frontdeskDeliverySchema.parse(
    frontdesk.tool(agentId, key, 'dock_frontdesk_route', {
      managerId,
      message: 'Delegate one bounded read-only investigation and report its evidence.',
    }),
  );
}
function completeReply(managerId: string, runId: string) {
  store.entry({
    id: `reply:${runId}`,
    agentId: managerId,
    runId,
    kind: 'assistant',
    title: 'Manager reply',
    text: 'I delegated a bounded investigation; it is still running.',
    status: 'complete',
    createdAt: now(),
  });
  store.updateRun(runId, { status: 'completed' });
  store.updateAgent(managerId, { status: 'idle' });
}

describe('thin personal front desk', () => {
  it('creates one fresh coordinator lazily without Git, tasks, a provider or a model turn', () => {
    expect(frontdesk.status().agentId).toBeNull();
    expect(store.projects()).toHaveLength(0);
    const key = randomUUID();
    const created = frontdesk.create({ key });
    expect(frontdesk.create({ key })).toEqual(created);
    expect(frontdesk.create({ key: randomUUID() })).toEqual(created);
    expect(created.settings.visibleProjectIds).toEqual([]);
    expect(store.agents()).toHaveLength(1);
    expect(store.projects()).toHaveLength(1);
    expect(store.tasks()).toEqual([]);
    expect(store.runs()).toEqual([]);
    expect(store.agent(created.agentId!)).toMatchObject({
      role: 'manager',
      threadId: null,
      name: 'Your assistant',
      permission: 'read-only',
    });
    const tools = frontdesk.definitionsFor(created.agentId!);
    expect(tools.map((tool) => tool.name)).toEqual([
      'dock_frontdesk_inspect',
      'dock_frontdesk_route',
      'dock_checkpoint',
    ]);
    expect(JSON.stringify(tools)).not.toContain('dock_delegate');
    frontdesk.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    frontdesk = new Frontdesk(store, root);
    expect(frontdesk.status()).toEqual(created);
    expect(store.runs()).toEqual([]);
  });

  it('recovers only its reserved unfinished internal setup and refuses substituted storage', () => {
    mkdirSync(join(root, 'frontdesk'));
    store.setSetting('frontdesk:creation', { requested: true });
    const saved = store.register(join(root, 'frontdesk'), 'Your assistant', 'Interrupted setup');
    expect(frontdesk.create({ key: randomUUID() }).agentId).toBe(saved.managerId);
    expect(store.projects()).toHaveLength(1);
    expect(store.runs()).toEqual([]);
  });

  it('does not adopt an unrelated registered directory or a symlink', () => {
    store.register(join(root, 'frontdesk'), 'Unrelated project', 'Must remain untouched');
    expect(() => frontdesk.create({ key: randomUUID() })).toThrow('already registered');
    expect(frontdesk.status().agentId).toBeNull();
    const separateRoot = join(root, 'second');
    mkdirSync(separateRoot);
    symlinkSync(root, join(separateRoot, 'frontdesk'));
    const other = new Frontdesk(store, separateRoot);
    try {
      expect(() => other.create({ key: randomUUID() })).toThrow('storage folder');
    } finally {
      other.close();
    }
  });

  it('keeps settings owner-edited, revision checked, idempotent, and scoped to selected host projects', () => {
    const { agentId, project, hidden } = setup();
    const context = frontdesk.readContext(agentId);
    expect(context.projects.map((item) => item.id)).toEqual([project.id]);
    expect(JSON.stringify(context)).not.toContain(hidden.name);
    expect(JSON.stringify(context)).not.toContain(root);
    const edit = {
      key: randomUUID(),
      expectedRevision: 1,
      visibleProjectIds: [project.id],
      preferences: 'New tone',
      priorities: 'One result',
      commitments: 'Review first',
    };
    const saved = frontdesk.save(edit);
    expect(frontdesk.save(edit)).toEqual(saved);
    expect(() => frontdesk.save({ ...edit, key: randomUUID() })).toThrow('another device');
    expect(() =>
      frontdesk.save({
        ...edit,
        key: randomUUID(),
        expectedRevision: 2,
        visibleProjectIds: [randomUUID()],
      }),
    ).toThrow('Project not found');
    expect(() =>
      frontdesk.tool(project.managerId, randomUUID(), 'dock_frontdesk_inspect', {}),
    ).toThrow('Only the designated');
    expect(() => frontdesk.tool(agentId, randomUUID(), 'dock_task_create', {})).toThrow(
      'cannot execute',
    );
    expect(() =>
      frontdesk.tool(agentId, randomUUID(), 'dock_frontdesk_inspect', { projectId: hidden.id }),
    ).toThrow('not shared');
    expect(() =>
      frontdesk.tool(agentId, randomUUID(), 'dock_frontdesk_inspect', {
        projectId: project.id,
        agentId: hidden.managerId,
      }),
    ).toThrow('outside');
    expect(() =>
      frontdesk.tool(agentId, randomUUID(), 'dock_frontdesk_route', {
        managerId: hidden.managerId,
        message: 'No',
      }),
    ).toThrow('not shared');
    expect(store.runs()).toEqual([]);
  });

  it('routes only an owner turn to a selected manager, keeps exact receipts and reports once without ping-pong', async () => {
    const { agentId, project } = setup();
    expect(() => route(agentId, project.managerId)).toThrow('owner-message turn');
    const owner = ownerTurn(agentId);
    const key = randomUUID();
    const delivery = route(agentId, project.managerId, key);
    expect(route(agentId, project.managerId, key)).toEqual(delivery);
    expect(store.runs()).toHaveLength(2);
    expect(store.run(delivery.managerRunId)).toMatchObject({
      agentId: project.managerId,
      sourceId: agentId,
      kind: 'message',
      status: 'queued',
    });
    const worker = store.addAgent({
      projectId: project.id,
      taskId: null,
      parentId: project.managerId,
      name: 'Worker',
      role: 'researcher',
      cwd: root,
    });
    expect(() => route(agentId, worker.id)).toThrow('existing project manager');
    expect(() =>
      frontdesk.tool(worker.id, randomUUID(), 'dock_frontdesk_route', {
        managerId: project.managerId,
        message: 'No',
      }),
    ).toThrow('Only the designated');
    store.updateRun(owner.id, { status: 'completed' });
    store.updateAgent(agentId, { status: 'idle' });
    completeReply(project.managerId, delivery.managerRunId);
    await setImmediate();
    frontdesk.reconcile();
    frontdesk.reconcile();
    const reports = store.runs().filter((run) => run.agentId === agentId && run.kind === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain(`reply:${delivery.managerRunId}`);
    expect(reports[0].text).toContain('still running');
    expect(reports[0].text).toContain('not proof that delegated tasks finished');
    store.updateRun(reports[0].id, { status: 'running' });
    expect(() => route(agentId, project.managerId)).toThrow('Report turns must summarize and stop');
    store.updateRun(reports[0].id, { status: 'completed' });
    await setImmediate();
    expect(store.runs()).toHaveLength(3);
  });

  it('derives attention from visible source state without copying private approval details or granting approval', () => {
    const { agentId, project, hidden } = setup();
    const allowed = store.addApproval(project.managerId, {
      kind: 'command',
      title: 'private-request-token',
      details: 'private-command-body',
      requestId: 'private-request-id',
      params: { secret: 'private-value' },
      questions: [],
    });
    store.addApproval(hidden.managerId, {
      kind: 'command',
      title: 'Hidden permission',
      details: 'Hidden command',
      requestId: 'hidden-request',
      params: {},
      questions: [],
    });
    const context = frontdesk.readContext(agentId);
    expect(context.attentionCount).toBe(1);
    expect(context.needsAttention[0]).toMatchObject({
      id: allowed.id,
      title: 'Permission request',
      kind: 'approval',
      projectId: project.id,
    });
    expect(JSON.stringify(context)).not.toContain('private-request-token');
    expect(JSON.stringify(context)).not.toContain('private-command-body');
    expect(JSON.stringify(context)).not.toContain('private-value');
    expect(JSON.stringify(context)).not.toContain('Hidden permission');
    expect(store.approval(allowed.id).status).toBe('pending');
  });

  it('forwards an already saved terminal outcome once after restart without replaying a manager turn', () => {
    const { agentId, project } = setup();
    const owner = ownerTurn(agentId);
    const delivery = route(agentId, project.managerId);
    store.updateRun(owner.id, { status: 'completed' });
    frontdesk.close();
    completeReply(project.managerId, delivery.managerRunId);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    frontdesk = new Frontdesk(store, root);
    frontdesk.reconcile();
    const before = store.runs();
    expect(before.filter((run) => run.agentId === project.managerId)).toHaveLength(1);
    expect(before.filter((run) => run.agentId === agentId && run.kind === 'report')).toHaveLength(
      1,
    );
    frontdesk.reconcile();
    expect(store.runs()).toEqual(before);
  });

  it('stops new evidence reads and withholds not-yet-delivered replies when visibility is removed', async () => {
    const { agentId, project } = setup();
    ownerTurn(agentId);
    const delivery = route(agentId, project.managerId);
    const inspectKey = randomUUID();
    const before = frontdesk.tool(agentId, inspectKey, 'dock_frontdesk_inspect', {
      projectId: project.id,
    });
    expect(before).toHaveProperty('agents');
    frontdesk.save({
      key: randomUUID(),
      expectedRevision: 1,
      visibleProjectIds: [],
      preferences: '',
      priorities: '',
      commitments: '',
    });
    expect(() =>
      frontdesk.tool(agentId, inspectKey, 'dock_frontdesk_inspect', { projectId: project.id }),
    ).toThrow('not shared');
    completeReply(project.managerId, delivery.managerRunId);
    await setImmediate();
    expect(store.runs().filter((run) => run.kind === 'report')).toHaveLength(0);
    expect(store.getSetting(`frontdesk:delivery:${delivery.managerRunId}`)).toMatchObject({
      state: 'withheld',
      reportRunId: null,
    });
    frontdesk.save({
      key: randomUUID(),
      expectedRevision: 2,
      visibleProjectIds: [project.id],
      preferences: '',
      priorities: '',
      commitments: '',
    });
    frontdesk.reconcile();
    expect(store.runs().filter((run) => run.kind === 'report')).toHaveLength(0);
  });

  it('bounds owner-turn routes and never forwards unrelated manager completions', async () => {
    const { agentId, project } = setup();
    ownerTurn(agentId);
    for (let index = 0; index < 8; index++) route(agentId, project.managerId);
    expect(() => route(agentId, project.managerId)).toThrow('Finish the current');
    const unrelated = store.enqueue(project.managerId, randomUUID(), 'An unrelated owner question');
    completeReply(project.managerId, unrelated.id);
    await setImmediate();
    expect(store.runs().filter((run) => run.kind === 'report')).toHaveLength(0);
  });

  it('cancels a not-yet-started assistant reply after visibility removal while retaining the actual archive', async () => {
    const { agentId, project } = setup();
    const owner = ownerTurn(agentId);
    const delivery = route(agentId, project.managerId);
    store.updateRun(owner.id, { status: 'completed' });
    store.updateAgent(agentId, { status: 'idle' });
    completeReply(project.managerId, delivery.managerRunId);
    await setImmediate();
    const report = store.runs().find((run) => run.kind === 'report')!;
    expect(report.status).toBe('queued');
    frontdesk.save({
      key: randomUUID(),
      expectedRevision: 1,
      visibleProjectIds: [],
      preferences: '',
      priorities: '',
      commitments: '',
    });
    expect(store.run(report.id).status).toBe('cancelled');
    expect(store.entries(agentId).find((entry) => entry.id === report.id)).toMatchObject({
      text: report.text,
      status: 'cancelled',
    });
    expect(store.agent(agentId).status).toBe('idle');
    expect(frontdesk.readContext(agentId).recentDeliveries).toEqual([]);
    expect(store.getSetting(`frontdesk:delivery:${delivery.managerRunId}`)).toMatchObject({
      state: 'withheld',
      reportRunId: report.id,
    });
  });
});
