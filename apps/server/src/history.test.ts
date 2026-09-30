import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { historyQuerySchema } from '@dock/shared';
import { Store } from './store.js';
import { repoRoot } from './paths.js';
import {
  historyPage,
  historyRead,
  latestRecovery,
  projectContextEvidence,
  projectCatalog,
  recordRecovery,
} from './history.js';

let root: string, store: Store;
beforeEach(() => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/history-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});

function entry(agentId: string, index: number, text = `Saved message ${index}`) {
  const value = {
    id: `entry-${randomUUID()}`,
    agentId,
    runId: null,
    kind: 'assistant' as const,
    title: 'Saved reply',
    text,
    status: 'complete',
    createdAt: '2026-09-13T12:00:00.000Z',
  };
  store.entry(value);
  return value;
}

describe('project-scoped durable history', () => {
  it('catalogs old agents and tasks even without conversations, with isolated bounded filters and cursors', () => {
    const project = store.register(root, 'Catalog', '');
    const other = store.register(join(root, 'other'), 'Other', '');
    const agents = Array.from({ length: 57 }, (_, index) =>
      store.addAgent({
        projectId: project.id,
        parentId: project.managerId,
        taskId: null,
        name: `Researcher ${index}`,
        role: 'researcher',
        cwd: root,
      }),
    );
    store.updateAgent(agents[0].id, { status: 'interrupted' });
    let page = projectCatalog(store, project.id, { kind: 'agents', limit: 9 });
    const cursor = page.nextCursor!;
    const ids = page.items.map((item) => item.id);
    while (page.nextCursor) {
      page = projectCatalog(store, project.id, {
        kind: 'agents',
        limit: 9,
        cursor: page.nextCursor,
      });
      ids.push(...page.items.map((item) => item.id));
    }
    expect(new Set(ids).size).toBe(58);
    expect(ids).not.toContain(other.managerId);
    expect(
      projectCatalog(store, project.id, { kind: 'agents', status: 'active' }).items.map(
        (item) => item.id,
      ),
    ).toEqual([agents[0].id]);
    expect(
      projectCatalog(store, project.id, { kind: 'agents', query: 'RESEARCHER 0' }).items.map(
        (item) => item.id,
      ),
    ).toEqual([agents[0].id]);
    expect(() => projectCatalog(store, other.id, { kind: 'agents', cursor })).toThrow(
      'different project or search',
    );
    expect(() => projectCatalog(store, project.id, { kind: 'tasks', cursor })).toThrow(
      'different project or search',
    );
    expect(() => projectCatalog(store, project.id, { kind: 'agents', status: 'done' })).toThrow(
      'does not apply',
    );
    const task = store.addTask(project.id, {
      title: 'Unusual active task',
      goal: 'Full task remains inspectable',
      acceptance: 'Exact evidence',
      parentId: null,
    });
    const completed = store.addTask(project.id, {
      title: 'Completed task',
      goal: 'Already done',
      acceptance: 'Passed',
      parentId: null,
    });
    store.updateTask(completed.id, { status: 'done' });
    const active = projectCatalog(store, project.id, { kind: 'tasks', status: 'active' });
    expect(active.items.map((item) => item.id)).toEqual([task.id]);
    expect(active.items[0]).toMatchObject({ managerId: project.managerId, status: 'open' });
    expect(
      projectCatalog(store, project.id, { kind: 'tasks', status: 'done' }).items.map(
        (item) => item.id,
      ),
    ).toEqual([completed.id]);
    expect(JSON.stringify(active)).not.toContain(root);
  });

  it('pages every old item without duplicates and excludes later arrivals until refresh', () => {
    const project = store.register(root, 'Archive', '');
    const saved = Array.from({ length: 71 }, (_, index) => entry(project.managerId, index));
    let page = historyPage(store, project.id, { limit: 7 });
    const firstCursor = page.nextCursor;
    const found = page.items.map((item) => item.id);
    const throughEventId = page.throughEventId;
    const arriving = entry(project.managerId, 72);
    while (page.nextCursor) {
      page = historyPage(store, project.id, { limit: 7, cursor: page.nextCursor });
      expect(page.throughEventId).toBe(throughEventId);
      found.push(...page.items.map((item) => item.id));
    }
    expect(found).toEqual(saved.toReversed().map((item) => item.id));
    expect(new Set(found).size).toBe(71);
    expect(historyPage(store, project.id, { limit: 7 }).items[0].id).toBe(arriving.id);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(historyPage(store, project.id, { limit: 7, cursor: firstCursor }).items[0].id).toBe(
      saved[63].id,
    );
  });

  it('searches source-linked decisions and peer messages, not URL or private JSON fields', () => {
    const project = store.register(root, 'Project', '');
    const worker = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: null,
      role: 'researcher',
      name: 'Researcher',
      cwd: root,
    });
    const message = store.enqueue(
      worker.id,
      randomUUID(),
      'Earlier measured concurrency 20%_ evidence',
      'message',
      project.managerId,
    );
    store.decision({
      projectId: project.id,
      taskId: null,
      agentId: project.managerId,
      kind: 'accept',
      rationale: 'Accept this measured tradeoff',
      evidence: 'Earlier measured concurrency agrees with the check',
    });
    const link = entry(worker.id, 1, 'Allowed the original URL request.');
    store.entry({
      ...link,
      urlRequest: {
        serverName: 'private',
        url: 'https://example.invalid/?state=secret-search-value',
      },
    });
    const body = store.db.prepare('SELECT body FROM entries WHERE id=?').get(link.id)!;
    store.db.prepare('UPDATE entries SET body=? WHERE id=?').run(
      JSON.stringify({
        ...JSON.parse(String(body.body)),
        privateToolSecret: 'secret-search-value',
      }),
      link.id,
    );
    const page = historyPage(store, project.id, { query: 'MEASURED concurrency' });
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((item) => item.source))).toEqual(new Set(['entry', 'decision']));
    const peer = page.items.find((item) => item.id === message.id)!;
    expect(peer).toMatchObject({
      agentId: worker.id,
      senderId: project.managerId,
      runId: message.id,
      kind: 'message',
    });
    expect(historyPage(store, project.id, { query: '20%_' }).items).toHaveLength(1);
    expect(historyPage(store, project.id, { query: "' OR 1=1 --" }).items).toEqual([]);
    expect(historyPage(store, project.id, { query: 'secret-search-value' }).items).toEqual([]);
    expect(
      JSON.stringify(historyRead(store, project.id, { source: 'entry', id: link.id })),
    ).not.toContain('secret-search-value');
    expect(
      historyPage(store, project.id, { source: 'messages' }).items.map((item) => item.id),
    ).toEqual([message.id]);
  });

  it('refuses cross-project identities, source reads and mismatched search cursors', () => {
    const project = store.register(root, 'First', '');
    const other = store.register(join(root, 'other'), 'Other', '');
    const foreign = entry(other.managerId, 0, 'Private project evidence');
    entry(project.managerId, 0);
    entry(project.managerId, 1);
    const cursor = historyPage(store, project.id, { limit: 1 }).nextCursor!;
    expect(historyPage(store, project.id, {}).items).toHaveLength(2);
    expect(() => historyRead(store, project.id, { source: 'entry', id: foreign.id })).toThrow(
      'not found in this project',
    );
    expect(() => historyPage(store, project.id, { agentId: other.managerId })).toThrow(
      'outside this project',
    );
    expect(() => historyPage(store, other.id, { cursor })).toThrow('different project or search');
    expect(() => historyPage(store, project.id, { query: 'changed', cursor })).toThrow(
      'different project or search',
    );
    expect(() => historyPage(store, project.id, { cursor: 'broken' })).toThrow('no longer valid');
    expect(historyQuerySchema.safeParse({ path: '/private/history.jsonl' }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
  });

  it('filters by exact task and reads long retained evidence in complete bounded chunks', () => {
    const project = store.register(root, 'Long archive', '');
    const task = store.addTask(project.id, {
      title: 'Atomic task',
      goal: 'One result',
      acceptance: 'Saved evidence',
      parentId: null,
    });
    const worker = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: task.id,
      role: 'researcher',
      name: 'Researcher',
      cwd: root,
    });
    const saved = entry(
      worker.id,
      1,
      'x'.repeat(50_000) + 'find this old result 🦊' + 'y'.repeat(50_000),
    );
    entry(project.managerId, 2, 'Other task evidence');
    const page = historyPage(store, project.id, { taskId: task.id, query: 'old result' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].text).toContain('find this old result');
    expect(page.items[0].offset).toBeGreaterThan(0);
    let offset = 0;
    let retained = '';
    for (;;) {
      const item = historyRead(store, project.id, {
        source: 'entry',
        id: saved.id,
        offset,
        limit: 7000,
      });
      retained += item.text;
      expect(item.text.length).toBeLessThanOrEqual(7000);
      if (item.nextOffset === null) break;
      offset = item.nextOffset;
    }
    expect(retained).toBe(saved.text);
    expect(() =>
      historyRead(store, project.id, {
        source: 'entry',
        id: saved.id,
        offset: saved.text.length + 1,
      }),
    ).toThrow('changed');
  });
});

describe('host-authored recovery evidence', () => {
  it('records restart evidence without optional checkpoints, losing provider IDs, or replaying work', () => {
    const project = store.register(root, 'Recovery', '');
    const task = store.addTask(project.id, {
      title: 'Atomic work',
      goal: 'One result',
      acceptance: 'Prove it',
      parentId: null,
    });
    const agent = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: task.id,
      role: 'implementer',
      name: 'Builder',
      cwd: root,
    });
    store.updateAgent(agent.id, { threadId: 'provider-existing-thread' });
    const run = store.enqueue(
      agent.id,
      randomUUID(),
      'Original assignment',
      'delegation',
      project.managerId,
    );
    store.updateRun(run.id, { status: 'running', turnId: 'provider-existing-turn' });
    store.updateAgent(agent.id, { status: 'running', turnId: 'provider-existing-turn' });
    const approval = store.addApproval(agent.id, {
      kind: 'command',
      title: 'Original approval',
      details: 'Private command',
      questions: [],
      requestId: 'provider-request',
      params: { secret: 'do-not-copy' },
    });
    const saved = entry(agent.id, 1, 'Actual tool output retained without checkpoint');
    // A second queued message must not hide the earlier uncertain run.
    store.enqueue(agent.id, randomUUID(), 'Later queued message');
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    store.recover();
    const record = recordRecovery(store, agent.id, 'host_restart');
    expect(record).toMatchObject({
      author: 'host',
      checkpointAvailable: false,
      threadId: 'provider-existing-thread',
      status: 'interrupted',
      nextAction: 'inspect_interruption',
      historyOrigin: 'managed',
      queuedRunCount: 1,
      unsettledRunCount: 1,
    });
    expect(record.recentEntryIds).toContain(saved.id);
    expect(record.unsettledRuns[0]).toMatchObject({
      id: run.id,
      status: 'interrupted',
      turnId: 'provider-existing-turn',
    });
    expect(record.approvals).toContainEqual({
      id: approval.id,
      kind: 'command',
      status: 'expired',
      createdAt: approval.createdAt,
    });
    expect(JSON.stringify(record)).not.toContain('do-not-copy');
    expect(JSON.stringify(record)).not.toContain(root);
    expect(store.agent(agent.id).checkpoint).toBe('');
    expect(store.runs()).toHaveLength(2);
    expect(store.run(run.id).status).toBe('interrupted');
    const eventHead = store.head;
    expect(recordRecovery(store, agent.id, 'host_restart')).toEqual(record);
    expect(store.head).toBe(eventHead);
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    expect(latestRecovery(store, project.id, agent.id)).toEqual(record);
    expect(() =>
      store.db.prepare("DELETE FROM events WHERE type='recovery.recorded'").run(),
    ).toThrow('append-only');
  });

  it('works inside an existing transaction, rolls back atomically, and labels imported or native history honestly', () => {
    const project = store.register(root, 'Source', '');
    const agent = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: null,
      role: 'researcher',
      name: 'Imported',
      cwd: root,
    });
    store.updateAgent(agent.id, { threadId: 'saved-codex-thread' });
    store.event('session.imported', project.id, agent.id, { turns: 9 });
    expect(() =>
      store.transaction(() => {
        recordRecovery(store, agent.id, 'manual');
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(latestRecovery(store, project.id, agent.id)).toBeNull();
    const recovered = store.transaction(() => recordRecovery(store, agent.id, 'manual'));
    expect(recovered.historyOrigin).toBe('imported');
    expect(recovered.notice).toContain('does not reconstruct');
    store.updateAgent(agent.id, { nativeRootId: project.managerId });
    expect(recordRecovery(store, agent.id, 'context_changed').nextAction).toBe('parent_controls');
    const other = store.register(join(root, 'other'), 'Other', '');
    expect(() => latestRecovery(store, other.id, agent.id)).toThrow('outside this project');
  });

  it('keeps old active tasks and agents ahead of recent completed history with honest omitted counts', () => {
    const project = store.register(root, 'Active first', '');
    const active = store.addTask(project.id, {
      title: 'Old unresolved task',
      goal: 'Still matters',
      acceptance: 'Resolve it',
      parentId: null,
    });
    const worker = store.addAgent({
      projectId: project.id,
      parentId: project.managerId,
      taskId: active.id,
      role: 'researcher',
      name: 'Old interrupted worker',
      cwd: root,
    });
    store.updateAgent(worker.id, { status: 'interrupted' });
    for (let index = 0; index < 45; index++) {
      const task = store.addTask(project.id, {
        title: `Completed ${index}`,
        goal: 'Done',
        acceptance: 'Passed',
        parentId: null,
      });
      store.updateTask(task.id, { status: 'done' });
      store.addAgent({
        projectId: project.id,
        parentId: project.managerId,
        taskId: task.id,
        role: 'researcher',
        name: `Idle ${index}`,
        cwd: root,
      });
    }
    const context = projectContextEvidence(store, project.id, project.managerId);
    expect(context.tasks[0].id).toBe(active.id);
    expect(context.agents.some((agent) => agent.id === worker.id)).toBe(true);
    expect(context.omitted).toEqual({ tasks: 16, agents: 7, activeTasks: 0 });
    expect(JSON.stringify(context)).not.toContain(root);
  });
});
