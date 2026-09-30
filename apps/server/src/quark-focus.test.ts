import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { quarkFocusSchema, quarkFocusStatusSchema, type QuotaHold } from '@dock/shared';
import { Store, Conflict, Missing } from './store.js';
import { Pulsar } from './pulsar.js';
import { Quark } from './quark.js';
import { ModelPolicy } from './model-policy.js';
import { QuarkCoordinator } from './quark-coordinator.js';
import { QuarkFocus, registerQuarkFocusRoutes } from './quark-focus.js';

let root: string, store: Store, quark: Quark, coordinator: QuarkCoordinator, focus: QuarkFocus;
const catalog = vi.fn(async () => []);
function open() {
  store = new Store(join(root, 'dock.sqlite'));
  const pulsar = new Pulsar(store, () => null);
  quark = new Quark(store, pulsar);
  coordinator = new QuarkCoordinator(store, root, quark, pulsar, new ModelPolicy(store, catalog));
  focus = new QuarkFocus(store, coordinator);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quark-focus-'));
  catalog.mockClear();
  open();
});
afterEach(() => {
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const project = (name: string) => store.register(join(root, name), name, '');
function policy(
  projectId: string,
  changes: { paused?: boolean; priority?: 'high'; weight?: number },
) {
  return store.transaction(() =>
    coordinator.updateProjectPolicy(
      {
        action: 'project',
        projectId,
        expectedRevision: coordinator.projectPolicy(projectId).revision,
        ...changes,
        reason: 'A later owner decision.',
      },
      true,
    ),
  );
}

it('uses typed owner routes to pause only other work projects without a coordinator or model turn', async () => {
  const target = project('Selected chat');
  store.updateAgent(target.managerId, { surface: 'misc' });
  const work = project('Work');
  const prior = project('Already paused');
  policy(prior.id, { paused: true });
  const internals = [
    project('Other chat'),
    project('Native terminal'),
    project('Assistant'),
    project('Computer health'),
    project('Old QUARK'),
    project('Conversation finder'),
  ];
  store.updateAgent(internals[0].managerId, { surface: 'misc' });
  store.updateAgent(internals[1].managerId, { surface: 'terminal' });
  store.setSetting('frontdesk:identity', { projectId: internals[2].id });
  store.setSetting('resources:project', internals[3].id);
  store.setSetting(`quark:coordinator:previous:${internals[4].managerId}`, {
    projectId: internals[4].id,
  });
  store.setSetting('conversation-search:project', internals[5].id);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof ZodError
          ? 400
          : error instanceof Conflict
            ? 409
            : error instanceof Missing
              ? 404
              : 500,
      )
      .send({ error: error.message }),
  );
  const kick = vi.fn();
  registerQuarkFocusRoutes(app, focus, kick);
  try {
    const empty = await app.inject({ url: '/api/quark/focus' });
    expect(quarkFocusStatusSchema.parse(empty.json()).active).toBeNull();
    const response = await app.inject({
      method: 'POST',
      url: '/api/quark/focus',
      payload: { key: randomUUID(), projectId: target.id },
    });
    expect(response.statusCode).toBe(200);
    const receipt = quarkFocusSchema.parse(response.json());
    expect(receipt.projects).toEqual([
      { projectId: work.id, name: work.name, pausedRevision: 1, restored: false },
      { projectId: prior.id, name: prior.name, pausedRevision: null, restored: false },
    ]);
    expect(coordinator.projectPolicy(target.id).paused).toBe(false);
    for (const internal of internals)
      expect(coordinator.projectPolicy(internal.id).paused).toBe(false);
    expect(coordinator.projectPolicy(prior.id).revision).toBe(1);
    expect(coordinator.identity()).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
    expect(store.runs()).toHaveLength(0);
    expect(store.entries(work.managerId)[0].text).toContain('The owner is focusing');
    expect(store.getSetting(`quark:decision:focus:${receipt.id}:${work.id}:pause`)).toMatchObject({
      source: 'owner',
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/quark/focus',
          payload: { key: randomUUID(), projectId: target.id, paused: false },
        })
      ).statusCode,
    ).toBe(400);
    const released = await app.inject({
      method: 'POST',
      url: '/api/quark/focus/release',
      payload: { key: randomUUID(), focusId: receipt.id },
    });
    expect(quarkFocusSchema.parse(released.json()).projects[0].restored).toBe(true);
    expect(
      quarkFocusStatusSchema.parse((await app.inject({ url: '/api/quark/focus' })).json()).active,
    ).toBeNull();
    expect(coordinator.projectPolicy(prior.id).paused).toBe(true);
  } finally {
    await app.close();
  }
});

it('retains exact creation and release receipts across restart without capturing new projects or replacing a newer focus', () => {
  const target = project('Target');
  const other = project('Other');
  const input = { key: randomUUID(), projectId: target.id };
  const receipt = focus.start(input);
  const later = project('Created later');
  expect(focus.start(input)).toEqual(receipt);
  expect(() => focus.start({ ...input, projectId: other.id })).toThrow('different input');
  expect(() => focus.start({ ...input, key: randomUUID() })).toThrow('Return to normal');
  store.close();
  open();
  expect(focus.status().active).toEqual(receipt);
  expect(focus.start(input)).toEqual(receipt);
  expect(coordinator.projectPolicy(later.id).paused).toBe(false);
  const release = { key: randomUUID(), focusId: receipt.id };
  const released = focus.release(release);
  expect(released.projects).toEqual([
    { projectId: other.id, name: other.name, pausedRevision: 1, restored: true },
  ]);
  expect(focus.start(input)).toEqual(receipt); // Retry is its receipt, not another start.
  expect(focus.status().active).toBeNull();
  store.close();
  open();
  expect(focus.release(release)).toEqual(released);
  const next = focus.start({ key: randomUUID(), projectId: target.id });
  expect(focus.release({ key: randomUUID(), focusId: receipt.id })).toEqual(released);
  expect(focus.status().active?.id).toBe(next.id);
  expect(store.events().filter((event) => event.type === 'quark.focus_released')).toHaveLength(1);
});

it('preserves target state, preexisting pauses and every later owner/coordinator policy edit', () => {
  const target = project('Target');
  policy(target.id, { paused: true, weight: 7 });
  const rePaused = project('Owner paused again');
  const reprioritized = project('Owner changed priority');
  const resumed = project('Owner resumed');
  const untouched = project('Unchanged pause');
  const before = coordinator.projectPolicy(target.id);
  const receipt = focus.start({ key: randomUUID(), projectId: target.id });
  policy(rePaused.id, { paused: true });
  policy(reprioritized.id, { priority: 'high' });
  policy(resumed.id, { paused: false });
  const latest = [rePaused, reprioritized, resumed].map((p) => coordinator.projectPolicy(p.id));
  const released = focus.release({ key: randomUUID(), focusId: receipt.id });
  expect(coordinator.projectPolicy(target.id)).toEqual(before);
  expect([rePaused, reprioritized, resumed].map((p) => coordinator.projectPolicy(p.id))).toEqual(
    latest,
  );
  expect(released.projects.filter((p) => p.restored).map((p) => p.projectId)).toEqual([
    untouched.id,
  ]);
  expect(store.getSetting(`quark:resume-project:${rePaused.id}`)).toBeNull();
});

it('releases existing project holds without starting QUARK and retains independent manual and budget holds', () => {
  const target = project('Target');
  const held = (name: string, cause: QuotaHold['cause']) => {
    const p = project(name);
    const queued = store.enqueue(p.managerId, randomUUID(), 'Retained work');
    const run = store.updateRun(queued.id, { status: 'interrupted' });
    store.updateAgent(p.managerId, { status: 'interrupted' });
    quark.hold(run, name, false, cause);
    quark.acknowledgeStop(run.id);
    return { p, run };
  };
  const resumable = held('Focus stopped work', 'project');
  const manual = held('Owner stopped work', 'manual');
  const budget = held('Allowance exhausted', 'budget');
  const protectedHolds = quark.holds().filter((h) => h.cause !== 'project');
  const receipt = focus.start({ key: randomUUID(), projectId: target.id });
  focus.release({ key: randomUUID(), focusId: receipt.id });
  coordinator.tick();
  expect(coordinator.identity()).toBeNull();
  expect(catalog).not.toHaveBeenCalled();
  expect(quark.holds()).toEqual(protectedHolds);
  expect(
    store
      .runs()
      .filter((r) => r.kind === 'resume')
      .map((r) => r.agentId),
  ).toEqual([resumable.p.managerId]);
  expect(store.agent(manual.p.managerId).status).toBe('interrupted');
  expect(store.agent(budget.p.managerId).status).toBe('interrupted');
});

it('rolls back partial focus writes and retries the same request once the failure is repaired', () => {
  const target = project('Target');
  const a = project('A');
  const b = project('B');
  const input = { key: randomUUID(), projectId: target.id };
  const update = coordinator.updateProjectPolicy.bind(coordinator);
  const failure = vi
    .spyOn(coordinator, 'updateProjectPolicy')
    .mockImplementation((action, owner) => {
      if (action.projectId === b.id) throw new Error('Interrupted local save');
      return update(action, owner);
    });
  expect(() => focus.start(input)).toThrow('Interrupted local save');
  expect(focus.status().active).toBeNull();
  expect(coordinator.projectPolicy(a.id).paused).toBe(false);
  expect(store.entries(a.managerId)).toHaveLength(0);
  failure.mockRestore();
  expect(focus.start(input).projects).toHaveLength(2);
  expect(store.entries(a.managerId)).toHaveLength(1);
});
