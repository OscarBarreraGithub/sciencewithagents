import { createHash, randomUUID } from 'node:crypto';
import {
  managedGoalActionSchema,
  managedGoalSchema,
  managedGoalUpdateSchema,
  managedGoalViewSchema,
  type ManagedGoal,
  type ManagedGoalUpdate,
} from '@dock/shared';
import { Conflict, Store, now, type PrivateRun } from './store.js';
import type { WorkItems } from './work-items.js';

type SavedGoal = {
  goal: ManagedGoal;
  mode: ManagedGoalUpdate['action'] | null;
  progressRunId: string | null;
  lastQueuedAfterRunId: string | null;
  lastProgressFingerprint: string | null;
  excludedRunId: string | null;
  yieldedContinuationRunId?: string | null;
  message: string;
};
const terminalTasks = new Set(['done', 'integrated', 'cancelled', 'split']);

/** Explicit host lifecycle on the existing queue; no provider API, timer or polling turn. */
export class ManagedGoals {
  constructor(
    readonly store: Store,
    readonly workItems: WorkItems,
    private readonly isInternalProject: (projectId: string) => boolean,
  ) {}
  supported(agentId: string) {
    const agent = this.store.agent(agentId);
    return (
      agent.role === 'manager' &&
      !agent.parentId &&
      !agent.surface &&
      !agent.nativeRootId &&
      !agent.interview &&
      !agent.archivedAt &&
      !this.isInternalProject(agent.projectId)
    );
  }
  saved(agentId: string): SavedGoal | null {
    return this.store.getSetting(`managed-goal:${agentId}`) as SavedGoal | null;
  }
  private save(value: SavedGoal) {
    // Progress is retained in full; the short status message has a separate public limit.
    value.message = value.message.slice(0, 2000);
    value.goal = managedGoalSchema.parse({
      ...value.goal,
      revision: value.goal.revision + 1,
      updatedAt: now(),
    });
    this.store.setSetting(`managed-goal:${value.goal.agentId}`, value);
    this.store.event(
      'managed_goal.updated',
      this.store.agent(value.goal.agentId).projectId,
      value.goal.agentId,
      value.goal,
    );
    return value;
  }
  view(agentId: string, admissionReason: string | null = null) {
    const value = this.saved(agentId);
    const run = value?.goal.continuationRunId ? this.store.run(value.goal.continuationRunId) : null;
    return managedGoalViewSchema.parse({
      supported: this.supported(agentId),
      goal: value?.goal ?? null,
      continuation: run
        ? {
            runId: run.id,
            status: run.status,
            reason: run.status === 'queued' ? (this.admissionReason(run) ?? admissionReason) : null,
          }
        : null,
      message:
        value?.message ??
        (this.supported(agentId)
          ? 'Goal continuation is off. Creating a goal explicitly queues its first ordinary manager request.'
          : 'Managed goals are available only for app-owned project root managers.'),
    });
  }
  /** Small retained context; full objective/evidence stays available on explicit inspection. */
  context(agentId: string) {
    if (!this.supported(agentId)) return null;
    const value = this.view(agentId),
      goal = value.goal;
    if (!goal) return null;
    const preview = (text: string, size: number) =>
      text.length > size ? `${text.slice(0, size)}…` : text;
    return {
      id: goal.id,
      revision: goal.revision,
      status: goal.status,
      objectivePreview: preview(goal.objective, 600),
      progressPreview: preview(goal.progress.summary, 800),
      nextActionPreview: goal.progress.nextAction ? preview(goal.progress.nextAction, 400) : null,
      lastRunId: goal.lastRunId,
      continuation: value.continuation
        ? {
            ...value.continuation,
            reason: value.continuation.reason ? preview(value.continuation.reason, 240) : null,
          }
        : null,
      message: preview(value.message, 240),
      retrieval: 'dock_inspect {goal:true} reads the full saved goal and current revision.',
      instructions:
        'Keep adjacent owner asks additive. Record useful progress with dock_goal_update in this admitted turn. Wait for dependent workers/human replies rather than polling; advance independent useful work. Complete only after reconciling this manager’s scoped open work and owner requests.',
    };
  }
  private ownedWork(agentId: string) {
    const agent = this.store.agent(agentId);
    const items = this.workItems
      .list({ projectId: agent.projectId })
      .items.filter(
        (item) => item.managerId === agentId && ['internal', 'human'].includes(item.kind),
      );
    const tasks = this.store.tasks().filter((task) => task.managerId === agentId);
    return { items, tasks };
  }
  private completionProblem(agentId: string) {
    const { items, tasks } = this.ownedWork(agentId);
    if (items.some((item) => item.status !== 'done'))
      return 'Reconcile the manager’s open internal and human work items before completing the goal.';
    if (tasks.some((task) => !terminalTasks.has(task.status)))
      return 'Reconcile the manager’s unfinished tasks before completing the goal.';
    const children = this.store
      .agents()
      .filter(
        (child) =>
          child.id !== agentId && (child.parentId === agentId || child.nativeRootId === agentId),
      );
    const childIds = new Set(children.map((child) => child.id));
    if (
      children.some((child) => ['queued', 'running', 'waiting'].includes(child.status)) ||
      this.store.runs(['queued', 'running']).some((run) => childIds.has(run.agentId))
    )
      return 'Reconcile the manager’s active or pending children, including native helpers, before completing the goal.';
    if (this.workItems.ownerRequests(agentId, { limit: 1 }).total)
      return 'Read and triage the remaining owner requests before completing the goal.';
    return this.waitProblem(agentId);
  }
  private waitProblem(agentId: string) {
    const agent = this.store.agent(agentId);
    if (['failed', 'interrupted', 'waiting'].includes(agent.status))
      return 'Inspect saved work and use the existing conversation resume controls before continuing this goal.';
    if (
      this.store.approvals().some((item) => item.agentId === agentId && item.status === 'pending')
    )
      return 'Waiting for an owner permission or question response.';
    if (
      this.store
        .runs(['queued'])
        .some(
          (run) => run.agentId === agentId && !this.store.getSetting(`managed-goal:run:${run.id}`),
        )
    )
      return 'Saved owner input or a team report already supplies the next manager turn.';
    return null;
  }
  admissionReason(run: PrivateRun): string | null {
    const goalId = this.store.getSetting(`managed-goal:run:${run.id}`);
    if (!goalId || run.status !== 'queued') return null;
    const value = this.saved(run.agentId);
    if (!value || value.goal.id !== goalId || !this.supported(run.agentId))
      return 'This goal is no longer active for this manager.';
    if (value.goal.status !== 'active')
      return value.goal.status === 'paused'
        ? 'Goal paused. Resume keeps this same queued continuation.'
        : value.message;
    return this.waitProblem(run.agentId);
  }
  /** Ordinary owner/team input must not get stuck behind an older automatic receipt. */
  queued(run: PrivateRun) {
    if (this.store.getSetting(`managed-goal:run:${run.id}`)) return;
    const value = this.saved(run.agentId);
    if (!value?.goal.continuationRunId || value.goal.continuationRunId === run.id) return;
    if (this.store.run(value.goal.continuationRunId).status !== 'queued') return;
    const continuation = this.unstartedContinuation(value);
    if (continuation && ['active', 'waiting', 'paused'].includes(value.goal.status)) {
      value.yieldedContinuationRunId = continuation.id;
      if (value.goal.status === 'active') value.goal.status = 'waiting';
      value.message =
        'Owner input or a team report takes the next turn. The already authorized, unstarted continuation remains saved under the same goal controls and QUARK admission.';
      this.save(value);
      return;
    }
    value.yieldedContinuationRunId = null;
    this.cancelQueued(value);
    if (value.goal.status === 'active') value.goal.status = 'waiting';
    value.message =
      'Saved owner input or a team report supplies the next turn. The unstarted automatic continuation was cancelled, preserving its receipt.';
    this.save(value);
  }
  /** Only a checkpoint-backed receipt that has never started can be yielded/restored. */
  isYieldedContinuation(run: PrivateRun) {
    if (run.status !== 'queued' || !this.store.getSetting(`managed-goal:run:${run.id}`))
      return false;
    const value = this.saved(run.agentId);
    return !!(
      value &&
      value.yieldedContinuationRunId === run.id &&
      this.unstartedContinuation(value)?.id === run.id &&
      this.store
        .runs(['queued'])
        .some(
          (input) =>
            input.agentId === run.agentId && !this.store.getSetting(`managed-goal:run:${input.id}`),
        )
    );
  }
  private unstartedContinuation(value: SavedGoal) {
    const id = value.goal.continuationRunId;
    if (
      !id ||
      value.mode !== 'continue' ||
      !value.progressRunId ||
      value.lastQueuedAfterRunId !== value.progressRunId ||
      this.store.run(value.progressRunId).status !== 'completed' ||
      this.store.getSetting(`managed-goal:run:${id}`) !== value.goal.id
    )
      return null;
    const run = this.store.run(id);
    return run.status === 'queued' && run.kind === 'report' && run.sourceId === value.goal.agentId
      ? run
      : null;
  }
  ownerAction(agentId: string, raw: unknown) {
    const input = managedGoalActionSchema.parse(raw);
    this.store.operation(input.key, { kind: 'managed-goal.owner', agentId, input }, () => {
      if (!this.supported(agentId))
        throw new Conflict('This manager does not support app-managed goals.');
      let value = this.saved(agentId);
      if ((value?.goal.revision ?? null) !== input.expectedRevision)
        throw new Conflict('The goal changed. Refresh before choosing an action.', 'GOAL_REVISION');
      if (input.action === 'create' || input.action === 'replace') {
        if (value) this.cancelQueued(value);
        const id = randomUUID(),
          stamp = now();
        value = {
          goal: {
            id,
            agentId,
            revision: 1,
            objective: input.objective,
            status: 'active',
            progress: { summary: '', nextAction: null },
            lastRunId: null,
            continuationRunId: null,
            createdAt: stamp,
            updatedAt: stamp,
          },
          mode: null,
          progressRunId: null,
          lastQueuedAfterRunId: null,
          lastProgressFingerprint: null,
          excludedRunId:
            this.store.runs(['running']).find((run) => run.agentId === agentId)?.id ?? null,
          message:
            'The first request uses this manager’s ordinary queue, model and QUARK admission.',
        };
        this.store.setSetting(`managed-goal:${agentId}`, value);
        const first = this.store.enqueue(
          agentId,
          `goal:${id}:owner:${input.key}`,
          input.objective,
          'user',
        );
        value.goal.continuationRunId = first.id;
        this.store.setSetting(`managed-goal:run:${first.id}`, id);
        this.store.setSetting(`managed-goal:${agentId}`, value);
        this.store.event(
          'managed_goal.created',
          this.store.agent(agentId).projectId,
          agentId,
          value.goal,
        );
        return { goalId: id };
      }
      if (!value) throw new Conflict('Create a goal before changing it.');
      if (['completed', 'stopped'].includes(value.goal.status))
        throw new Conflict('This goal has ended. Explicitly replace it to start a new objective.');
      if (input.action === 'resume') {
        const agent = this.store.agent(agentId);
        if (['failed', 'interrupted', 'waiting'].includes(agent.status))
          throw new Conflict(
            'Inspect saved work and use the existing conversation resume controls first.',
            'GOAL_INSPECT_RESUME',
          );
        value.goal.status = 'active';
        value.message =
          'Goal resumed. Existing provider, allowance holds and automatic-turn limits are retained.';
      } else if (input.action === 'pause') {
        value.goal.status = 'paused';
        value.message =
          'Automatic continuation paused. An active reply remains supervised; Stop reply can stop it.';
      } else {
        value.yieldedContinuationRunId = null;
        this.cancelQueued(value);
        value.goal.status = 'stopped';
        value.message =
          'Goal stopped without claiming completion. An active reply and all saved work remain.';
      }
      this.save(value);
      if (input.action === 'resume' && value.goal.lastRunId) {
        const run = this.store.run(value.goal.lastRunId);
        if (run.status === 'completed') this.afterSuccess(value, run);
      }
      return { goalId: value.goal.id };
    });
    return this.view(agentId);
  }
  private cancelQueued(value: SavedGoal) {
    if (!value.goal.continuationRunId) return;
    const run = this.store.run(value.goal.continuationRunId);
    if (run.status === 'queued') {
      this.store.updateRun(run.id, { status: 'cancelled' });
      const agent = this.store.agent(run.agentId);
      if (
        agent.status === 'queued' &&
        !this.store.runs(['queued', 'running']).some((other) => other.agentId === agent.id)
      )
        this.store.updateAgent(agent.id, { status: 'idle' });
    }
  }
  update(
    agentId: string,
    key: string,
    raw: unknown,
    run: PrivateRun,
    receipt: unknown = { agentId, name: 'dock_goal_update', raw },
  ) {
    const input = managedGoalUpdateSchema.parse(raw);
    return this.store.operation(key, receipt, () => {
      const value = this.saved(agentId);
      if (!value || !this.supported(agentId) || value.goal.id !== input.goalId)
        throw new Conflict('This turn has no matching owner-enabled goal.');
      if (value.goal.revision !== input.expectedRevision)
        throw new Conflict(
          'The goal changed. Inspect the current goal before updating progress.',
          'GOAL_REVISION',
        );
      if (run.agentId !== agentId || run.status !== 'running')
        throw new Conflict('Goal progress belongs to this manager’s admitted turn.');
      if (!this.belongs(value, run))
        throw new Conflict('This turn began before the current goal was enabled.');
      if (['completed', 'stopped'].includes(value.goal.status))
        throw new Conflict('This goal has ended.');
      if (input.action === 'complete') {
        const problem = this.completionProblem(agentId);
        if (problem) throw new Conflict(problem, 'GOAL_OPEN_WORK');
      }
      if (value.yieldedContinuationRunId) {
        this.cancelQueued(value);
        value.yieldedContinuationRunId = null;
      }
      value.mode = input.action;
      value.progressRunId = run.id;
      value.goal.progress = { summary: input.summary, nextAction: input.nextAction ?? null };
      if (value.goal.status !== 'paused')
        value.goal.status =
          input.action === 'blocked' ? 'blocked' : input.action === 'wait' ? 'waiting' : 'active';
      value.message =
        input.action === 'complete'
          ? 'Completion evidence saved; waiting for this native turn to finish successfully.'
          : input.action === 'continue'
            ? 'Next action saved; continuation waits for a successful native turn boundary.'
            : input.summary;
      return this.save(value).goal;
    });
  }
  private belongs(value: SavedGoal, run: PrivateRun) {
    const tagged = this.store.getSetting(`managed-goal:run:${run.id}`);
    return tagged
      ? tagged === value.goal.id
      : run.id !== value.excludedRunId && run.createdAt >= value.goal.createdAt;
  }
  /** Reconcile restart interruption without creating or replaying work. */
  recover() {
    this.store.transaction(() => {
      for (const agent of this.store.agents()) {
        const value = this.saved(agent.id);
        if (!value || !['failed', 'interrupted'].includes(agent.status)) continue;
        const last = this.store
          .runs()
          .filter(
            (run) =>
              run.agentId === agent.id &&
              run.createdAt >= value.goal.createdAt &&
              ['failed', 'interrupted'].includes(run.status),
          )
          .at(-1);
        if (last) this.finish(last, false);
      }
    });
  }
  /** Existing successful turn boundaries are the only automatic enqueue trigger. */
  finish(run: PrivateRun, success: boolean) {
    const value = this.saved(run.agentId);
    if (
      !value ||
      !this.supported(run.agentId) ||
      !this.belongs(value, run) ||
      ['completed', 'stopped'].includes(value.goal.status)
    )
      return;
    const receipt = `managed-goal:finished:${value.goal.id}:${run.id}`;
    if (value.goal.lastRunId === run.id || this.store.getSetting(receipt)) return;
    this.store.setSetting(receipt, true);
    value.goal.lastRunId = run.id;
    if (!success) {
      if (value.yieldedContinuationRunId) this.cancelQueued(value);
      value.yieldedContinuationRunId = null;
      if (value.goal.status !== 'paused') value.goal.status = 'blocked';
      value.mode = null;
      value.message =
        'This turn did not finish successfully. Inspect retained work and use the existing conversation resume controls; no action is replayed.';
      this.save(value);
      return;
    }
    this.save(value);
    if (value.goal.status === 'paused') return;
    this.afterSuccess(value, run);
  }
  private afterSuccess(value: SavedGoal, run: PrivateRun) {
    if (value.progressRunId !== run.id) {
      const continuation = this.unstartedContinuation(value);
      if (
        continuation &&
        run.status === 'completed' &&
        !this.store.getSetting(`managed-goal:run:${run.id}`) &&
        continuation.id === value.yieldedContinuationRunId &&
        ['active', 'waiting'].includes(value.goal.status)
      ) {
        const problem = this.waitProblem(run.agentId);
        value.goal.status = problem ? 'waiting' : 'active';
        if (!problem) value.yieldedContinuationRunId = null;
        value.message =
          problem ??
          'The intervening input finished. The same authorized, unstarted continuation remains in the ordinary queue under QUARK admission.';
        this.save(value);
        return;
      }
      value.yieldedContinuationRunId = null;
      value.goal.status = 'waiting';
      value.message =
        'No useful next-action checkpoint was recorded in this turn. Waiting for an existing report or owner input.';
      this.save(value);
      return;
    }
    if (value.mode === 'wait' || value.mode === 'blocked') {
      value.goal.status = value.mode === 'wait' ? 'waiting' : 'blocked';
      value.message = value.goal.progress.summary;
      this.save(value);
      return;
    }
    if (value.mode === 'complete') {
      const problem = this.completionProblem(run.agentId);
      value.goal.status = problem ? 'waiting' : 'completed';
      value.message =
        problem ??
        'The manager reconciled its scoped work and recorded completion in a successful turn.';
      this.save(value);
      return;
    }
    this.queueAfter(value, run);
  }
  private queueAfter(value: SavedGoal, run: PrivateRun) {
    if (
      value.goal.status !== 'active' ||
      value.mode !== 'continue' ||
      value.progressRunId !== run.id ||
      run.status !== 'completed'
    )
      return;
    if (value.lastQueuedAfterRunId === run.id) return;
    const problem = this.waitProblem(run.agentId);
    if (problem) {
      value.goal.status = 'waiting';
      value.message = problem;
      this.save(value);
      return;
    }
    const work = this.ownedWork(run.agentId);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          value.goal.progress,
          work.items.map((item) => [item.id, item.revision, item.status]),
          work.tasks.map((task) => [task.id, task.status, task.revisions, task.reviewedCommit]),
        ]),
      )
      .digest('hex');
    if (!value.goal.progress.nextAction || value.lastProgressFingerprint === fingerprint) {
      value.goal.status = 'waiting';
      value.message =
        'No new progress or useful next action was recorded. Waiting instead of spending another polling turn.';
      this.save(value);
      return;
    }
    const queued = this.store.enqueue(
      run.agentId,
      `goal:${value.goal.id}:after:${run.id}`,
      `Continue the same owner goal from retained evidence, without replaying uncertain actions.\nNext action: ${value.goal.progress.nextAction}\nRead dock_inspect {goal:true} for the full retained objective and progress. Record the next useful checkpoint with dock_goal_update; wait for dependencies instead of polling.`,
      'report',
      run.agentId,
    );
    value.goal.continuationRunId = queued.id;
    value.lastQueuedAfterRunId = run.id;
    value.lastProgressFingerprint = fingerprint;
    value.message =
      'One continuation is saved in the ordinary queue and must pass QUARK admission.';
    this.store.setSetting(`managed-goal:run:${queued.id}`, value.goal.id);
    this.save(value);
  }
}
