import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  quarkFocusSchema,
  quarkFocusStartSchema,
  quarkFocusReleaseSchema,
  quarkFocusStatusSchema,
  type QuarkFocusRecord,
} from '@dock/shared';
import { Conflict, Store } from './store.js';
import type { QuarkCoordinator } from './quark-coordinator.js';

const activeKey = 'quark:focus:active';
const identitySchema = z.object({ projectId: z.string().uuid() });

/** Owner intent over existing project policies, not another scheduler or model session. */
export class QuarkFocus {
  constructor(
    readonly store: Store,
    readonly coordinator: QuarkCoordinator,
  ) {}

  status() {
    const id = this.store.getSetting(activeKey);
    const active = id === null ? null : this.read(z.string().uuid().parse(id));
    return quarkFocusStatusSchema.parse({ active });
  }

  private read(id: string) {
    const raw = this.store.getSetting(`quark:focus:${id}`);
    if (!raw) throw new Conflict('This focus period is not available. Refresh before continuing.');
    return quarkFocusSchema.parse(raw);
  }

  start(raw: unknown) {
    const input = quarkFocusStartSchema.parse(raw);
    return this.store.operation(`quark:focus:start:${input.key}`, input, () => {
      if (this.status().active)
        throw new Conflict('Return to normal work before choosing another focus.');
      const target = this.store.project(input.projectId);
      const hidden = new Set(
        ['frontdesk:identity', 'quark:coordinator:identity']
          .map((key) => identitySchema.safeParse(this.store.getSetting(key)))
          .filter((result) => result.success)
          .map((result) => result.data!.projectId),
      );
      for (const key of ['resources:project', 'conversation-search:project']) {
        const internal = z.string().uuid().safeParse(this.store.getSetting(key));
        if (internal.success) hidden.add(internal.data);
      }
      const focus: QuarkFocusRecord = {
        id: randomUUID(),
        projectId: target.id,
        projectName: target.name,
        startedAt: new Date().toISOString(),
        releasedAt: null,
        projects: [],
      };
      // Capture once inside the receipt transaction. New projects are never added on retry.
      for (const project of this.store.projects()) {
        if (
          project.id === target.id ||
          hidden.has(project.id) ||
          this.store.agent(project.managerId).surface ||
          this.coordinator.isRetired(project.managerId)
        )
          continue;
        const policy = this.coordinator.projectPolicy(project.id);
        const pausedRevision = policy.paused
          ? null
          : this.change(focus, project.id, policy.revision, true);
        focus.projects.push({
          projectId: project.id,
          name: project.name,
          pausedRevision,
          restored: false,
        });
      }
      this.store.setSetting(`quark:focus:${focus.id}`, focus);
      this.store.setSetting(activeKey, focus.id);
      this.store.event('quark.focus_started', target.id, null, focus);
      return quarkFocusSchema.parse(focus);
    });
  }

  release(raw: unknown) {
    const input = quarkFocusReleaseSchema.parse(raw);
    return this.store.operation(`quark:focus:release:${input.key}`, input, () => {
      const focus = this.read(input.focusId);
      if (focus.releasedAt) return focus;
      if (this.status().active?.id !== focus.id)
        throw new Conflict(
          'This focus no longer owns the active pause. Refresh before continuing.',
        );
      for (const project of focus.projects) {
        if (project.pausedRevision === null) continue;
        const policy = this.coordinator.projectPolicy(project.projectId);
        // Any later owner/coordinator edit wins, even another pause of the same project.
        if (!policy.paused || policy.revision !== project.pausedRevision) continue;
        this.change(focus, project.projectId, policy.revision, false);
        project.restored = true;
      }
      focus.releasedAt = new Date().toISOString();
      this.store.setSetting(`quark:focus:${focus.id}`, focus);
      this.store.setSetting(activeKey, null);
      this.store.event('quark.focus_released', focus.projectId, null, focus);
      return quarkFocusSchema.parse(focus);
    });
  }

  private change(
    focus: QuarkFocusRecord,
    projectId: string,
    expectedRevision: number,
    paused: boolean,
  ) {
    const projectName = focus.projectName.slice(0, 255);
    const instruction = paused
      ? `The owner is focusing on “${projectName}”. Pause this project until that focus is released; later scheduling changes take precedence.`
      : `The owner ended focus on “${projectName}”. Release only this focus's project pause; other holds and budgets still apply.`;
    const action = {
      action: 'project' as const,
      projectId,
      expectedRevision,
      paused,
      reason: instruction,
    };
    const policy = this.coordinator.updateProjectPolicy(action, true);
    const key = `focus:${focus.id}:${projectId}:${paused ? 'pause' : 'release'}`;
    const at = new Date().toISOString();
    const decision = { key, at, source: 'owner', instruction, action };
    this.store.setSetting(`quark:decision:${key}`, decision);
    this.store.event('quark.decision', projectId, null, decision);
    this.store.entry({
      id: randomUUID(),
      agentId: this.store.project(projectId).managerId,
      runId: null,
      kind: 'system',
      title: paused ? 'Project paused for focus' : 'Focus pause released',
      text: instruction,
      status: 'completed',
      createdAt: at,
    });
    return policy.revision;
  }
}

export function registerQuarkFocusRoutes(
  app: FastifyInstance,
  focus: QuarkFocus,
  kick: () => void,
) {
  app.get('/api/quark/focus', async () => focus.status());
  app.post('/api/quark/focus', async (request) => {
    const result = focus.start(request.body);
    kick();
    return result;
  });
  app.post('/api/quark/focus/release', async (request) => {
    const result = focus.release(request.body);
    kick();
    return result;
  });
}
