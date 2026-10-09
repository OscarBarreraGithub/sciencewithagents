import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSchema } from '@dock/shared';
import { Store } from './store.js';
import { projectAgentActivity } from './agent-activity-projection.js';

let store: Store | undefined;
let root: string | undefined;
afterEach(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'swa-agent-activity-'));
  store = new Store(join(root, 'dock.sqlite'));
  const project = store.register(root, 'Activity fixture', 'Retained fixture');
  const agent = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: null,
    name: 'Fixture worker',
    role: 'researcher',
    cwd: root,
  });
  return { project, agent };
}

it('projects exact latest retained run state without prompts, writes or fabricated checkpoint dates', () => {
  const { agent } = fixture();
  store!.updateAgent(agent.id, { checkpoint: 'An old checkpoint says work is continuing.' });
  const raw = () => store!.db.prepare('SELECT body FROM agents WHERE id=?').get(agent.id)!.body;
  expect(projectAgentActivity(store!, store!.agent(agent.id)).latestRun).toBeNull();
  const run = store!.enqueue(agent.id, randomUUID(), 'Private fixture input never projected.');
  expect(projectAgentActivity(store!, store!.agent(agent.id)).latestRun).toEqual({
    id: run.id,
    status: 'queued',
    createdAt: run.createdAt,
  });
  store!.updateRun(run.id, { status: 'completed' });
  store!.updateAgent(agent.id, { status: 'idle' });
  const before = raw();
  const eventsBefore = store!.events().length;
  const activity = projectAgentActivity(store!, store!.agent(agent.id));
  expect(activity.latestRun).toEqual({ id: run.id, status: 'completed', createdAt: run.createdAt });
  expect(JSON.stringify(activity)).not.toContain('Private fixture input');
  expect(activity).not.toHaveProperty('checkpointAt');
  expect(raw()).toBe(before);
  expect(store!.events()).toHaveLength(eventsBefore);
  // Older hosts can omit the projection; existing native and saved agent contracts remain valid.
  expect(agentSchema.parse(agent).latestRun).toBeUndefined();
});

it('uses the existing agent index and newest inserted request even at identical timestamps', () => {
  const { project, agent } = fixture();
  const first = store!.enqueue(agent.id, randomUUID(), 'First request');
  store!.updateRun(first.id, { status: 'completed' });
  const second = store!.enqueue(agent.id, randomUUID(), 'Second request');
  store!.updateRun(second.id, { createdAt: first.createdAt, status: 'interrupted' });
  const other = store!.enqueue(project.managerId, randomUUID(), 'Unrelated later request');
  store!.updateRun(other.id, { status: 'running' });
  expect(projectAgentActivity(store!, agent).latestRun).toEqual({
    id: second.id,
    status: 'interrupted',
    createdAt: first.createdAt,
  });
  const plan = store!.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id,status,json_extract(body,'$.createdAt') AS createdAt
     FROM runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 1`,
    )
    .all(agent.id);
  expect(plan.map((row) => row.detail).join(' ')).toContain('USING INDEX runs_agent');
  expect(plan.map((row) => row.detail).join(' ')).not.toContain('TEMP B-TREE');
});

it('retains completed, cancelled and failed receipts across reopening without changing agent activity', () => {
  const { agent } = fixture();
  const run = store!.enqueue(agent.id, randomUUID(), 'Retained request');
  store!.updateAgent(agent.id, { status: 'idle' });
  for (const status of ['completed', 'cancelled', 'failed'] as const) {
    store!.updateRun(run.id, { status });
    store!.close();
    store = new Store(join(root!, 'dock.sqlite'));
    expect(projectAgentActivity(store, store.agent(agent.id)).latestRun?.status).toBe(status);
    expect(store.agent(agent.id).status).toBe('idle');
  }
});
