import {
  effectiveProviderReserve,
  quarkProjectPolicySchema,
  type AdaptivePace,
  type CapacityWindow,
  type ProviderCapacity,
} from '@dock/shared';
import type { PrivateRun, Store } from './store.js';
import type { Quark } from './quark.js';
import { readCapacity } from './capacity.js';
import { isManagerCoordination } from './coordination-reviews.js';
import { projectFollowsQuark } from './quark-project.js';

type Provider = 'codex' | 'claude';
/** Only the owner can lift these; an automatic model turn cannot help the blocked work. */
const ownerCauses = new Set(['project', 'budget', 'hourly', 'manual', 'lease']);
const finishedTasks = new Set(['done', 'integrated', 'split', 'cancelled']);

export interface DemandRun {
  runId: string;
  provider: Provider;
  model: string | null;
  status: 'queued' | 'running';
}
export interface ProjectDemand {
  projectId: string;
  managerId: string;
  paused: boolean;
  runs: DemandRun[];
  unfinishedTasks: number;
  /** Saved 0%/hour, exhausted or paused project-wide grant for a general window. */
  blockedProviders: Set<Provider>;
}

function identity(store: Store, key: string) {
  const raw = store.getSetting(key) as { agentId?: unknown; projectId?: unknown } | null;
  return raw && typeof raw === 'object' ? raw : null;
}
export function coordinatorAgentId(store: Store) {
  const agentId = identity(store, 'quark:coordinator:identity')?.agentId;
  return typeof agentId === 'string' ? agentId : null;
}
/** QUARK's own scheduling reports (current or retired identity) are output, never project demand. */
export function isQuarkReport(store: Store, run: PrivateRun) {
  if (run.kind !== 'report') return false;
  const coordinator = coordinatorAgentId(store);
  if (run.sourceId)
    return (
      run.sourceId === coordinator ||
      store.getSetting('quark:coordinator:previous:' + run.sourceId) != null
    );
  if (!run.key.startsWith('coordination-review:')) return false;
  return Boolean(
    store.db
      .prepare(
        `SELECT 1 FROM coordination_review_sources s JOIN runs r ON r.id=s.source_run_id
    WHERE s.batch_run_id=? AND (json_extract(r.body,'$.sourceId')=? OR EXISTS
      (SELECT 1 FROM settings p WHERE p.key='quark:coordinator:previous:'||json_extract(r.body,'$.sourceId'))) LIMIT 1`,
      )
      .get(run.id, coordinator),
  );
}
function internalProjects(store: Store) {
  const ids = new Set(
    ['quark:coordinator:identity', 'frontdesk:identity', 'resources:identity']
      .map((key) => identity(store, key)?.projectId)
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const project of store.projects()) if (project.internal) ids.add(project.id);
  return ids;
}
function blockedProviders(store: Store, quark: Quark, projectId: string, now: number) {
  const blocked = new Set<Provider>();
  for (const b of quark.budgets()) {
    if (b.projectId !== projectId || b.taskId || !b.enabled) continue;
    const window = readCapacity(store, b.provider, now).windows.find((w) => w.id === b.windowId);
    // A model meter cap only stops matching models; it does not block the provider.
    if (window?.scope === 'model') continue;
    if (
      (b.period === 'hour' && b.limitPercent === 0) ||
      (b.period === 'window' && quark.budgetStatus(b).cause === 'budget')
    )
      blocked.add(b.provider);
  }
  return blocked;
}

/**
 * Material unfinished authorized work, per project. Excludes QUARK's own turns and
 * reports, internal desks, and work only the owner can unblock (pause, saved zero
 * rate, exhausted grant, manual/queue hold, edit hold). Never creates work.
 */
export function materialDemand(store: Store, quark: Quark, now: number) {
  const internal = internalProjects(store);
  const coordinator = coordinatorAgentId(store);
  const projects = new Map<string, ProjectDemand>();
  for (const project of store.projects()) {
    if (store.agent(project.managerId).executionMode === 'direct') continue;
    if (internal.has(project.id) || !projectFollowsQuark(store, project.id)) continue;
    const policy = quarkProjectPolicySchema.parse(
      store.getSetting(`quark:project:${project.id}`) ?? {},
    );
    projects.set(project.id, {
      projectId: project.id,
      managerId: project.managerId,
      paused: policy.paused,
      runs: [],
      unfinishedTasks: 0,
      blockedProviders: blockedProviders(store, quark, project.id, now),
    });
  }
  for (const task of store.tasks()) {
    const demand = projects.get(task.projectId);
    if (demand && !finishedTasks.has(task.status)) demand.unfinishedTasks++;
  }
  for (const run of store.runs(['queued', 'running'])) {
    const agent = store.agent(run.agentId);
    const demand = projects.get(agent.projectId);
    if (!demand || demand.paused || agent.id === coordinator || isQuarkReport(store, run)) continue;
    if (run.status === 'queued') {
      if (
        isManagerCoordination(store, run) ||
        ['failed', 'interrupted', 'waiting'].includes(agent.status)
      )
        continue;
      if (run.queueEdit || store.getSetting(`pulsar:held:${run.id}`) === true) continue;
      if (quark.taskIds(run).some((id) => store.getSetting(`pulsar:held-task:${id}`) === true))
        continue;
      // Pace-only waits remain demand; they are what the pace shares.
      const block = quark.block(run, true, false, false, true, false);
      if (block && ownerCauses.has(block.cause)) continue;
    }
    demand.runs.push({
      runId: run.id,
      provider: agent.provider,
      model: agent.model,
      status: run.status as 'queued' | 'running',
    });
  }
  return projects;
}

export function projectWeight(store: Store, projectId: string) {
  return quarkProjectPolicySchema.parse(store.getSetting(`quark:project:${projectId}`) ?? {})
    .weight;
}
/** Outstanding admission reservations, using the same retention rule as Pulsar admission. */
export function reservedPercent(
  quark: Quark,
  capacity: ProviderCapacity,
  window: CapacityWindow,
  now: number,
) {
  return quark.pulsar
    .allowanceReservations(now - 3600_000)
    .filter(
      (l) =>
        l.provider === capacity.provider &&
        (!l.finishedAt ||
          !capacity.observedAt ||
          Date.parse(l.finishedAt) + 30_000 > Date.parse(capacity.observedAt)) &&
        windowMatches(window, l.model),
    )
    .reduce((n, l) => n + l.estimate.quotaPercent, 0);
}

/**
 * Advice can only affect eligible work: active runs, or open tasks its manager may start.
 * The notice itself runs on the manager's provider, so an owner block there always wins,
 * even when another provider still has queued work.
 */
export function notifyRelevance(demand: ProjectDemand | undefined, managerProvider: Provider) {
  if (!demand) return 'Choose a work project from QUARK’s catalog.';
  if (demand.paused)
    return 'This project is paused by a saved owner decision; an automatic notice cannot help it.';
  if (demand.blockedProviders.has(managerProvider))
    return 'Only the owner can lift this project’s saved zero rate or exhausted grant for its manager; the manager could not act on a notice.';
  if (demand.runs.length || demand.unfinishedTasks) return null;
  return 'This project has no unfinished authorized work. Account-wide observations are not a reason to wake its manager.';
}

export function windowMatches(
  window: Pick<CapacityWindow, 'scope' | 'model'>,
  model: string | null,
) {
  return (
    window.scope === 'general' ||
    (window.scope === 'model' && !!window.model && !!model?.toLowerCase().includes(window.model))
  );
}

/**
 * Deterministic advisory pace for one actually reported window. Headroom after
 * the effective reserve and outstanding admission reservations is spread over the
 * time to this window's own reported reset (aiming 15 minutes early), then split by
 * project weight across projects with active or ready work on this window.
 * Percentages from different windows are never compared or pooled.
 */
export function adaptivePace(input: {
  now: number;
  capacity: ProviderCapacity;
  window: CapacityWindow;
  policy: Parameters<typeof effectiveProviderReserve>[0];
  reservedPercent: number;
  projectId: string;
  demand: Map<string, ProjectDemand>;
  weight: (projectId: string) => number;
  hourlyCapPercent: number | null;
  /** Admission currently follows this share (the window is projected to run fast). */
  enforced?: boolean;
}): AdaptivePace {
  const { now, capacity, window, demand, projectId } = input;
  const own = demand.get(projectId);
  const uses = (d: ProjectDemand) =>
    !d.paused &&
    !d.blockedProviders.has(capacity.provider) &&
    d.runs.some((r) => r.provider === capacity.provider && windowMatches(window, r.model));
  const sharing = [...demand.values()].filter(uses);
  const base = {
    demandProjects: sharing.length,
    observedAt: capacity.observedAt,
    resetsAt: window.resetsAt,
  };
  const hours = window.resetsAt ? (Date.parse(window.resetsAt) - now) / 3600_000 : null;
  if (capacity.state !== 'ready' || capacity.stale || !capacity.observedAt)
    return {
      ...base,
      state: 'unknown',
      percentPerHour: null,
      reason: 'Waiting for a fresh provider report; missing or stale usage is not spare capacity.',
    };
  if (hours === null || hours <= 0)
    return {
      ...base,
      state: 'unknown',
      percentPerHour: null,
      reason:
        hours === null
          ? 'This window reports no reset time, so no pace can be derived.'
          : 'The reported reset has passed. Waiting for a new report before assuming renewed capacity.',
    };
  if (own?.paused || own?.blockedProviders.has(capacity.provider) || input.hourlyCapPercent === 0)
    return {
      ...base,
      state: 'blocked',
      percentPerHour: 0,
      reason: own?.paused
        ? 'This project is paused by a saved decision.'
        : 'A saved zero rate or exhausted grant blocks this provider for the project. Only the owner can change it.',
    };
  const reserve = effectiveProviderReserve(input.policy, capacity, window, now).effectivePercent;
  const headroom = 100 - window.usedPercent - reserve - input.reservedPercent;
  if (window.usedPercent >= 100 || headroom <= 0)
    return {
      ...base,
      state: 'blocked',
      percentPerHour: 0,
      reason: `${window.label} has no headroom after the ${reserve}% reserve and ${input.reservedPercent.toFixed(1)}% admitted reservations. Waiting for the next verified reset.`,
    };
  if (!own || !uses(own))
    return {
      ...base,
      state: 'idle',
      percentPerHour: null,
      reason:
        'No active or ready authorized work for this window. No pace is suggested; spare allowance is not a reason to create work.',
    };
  // Advisory target only: finish 15 minutes before reset, never less than half the remaining time.
  const target = Math.max(hours - 0.25, hours / 2);
  const total = sharing.reduce((sum, d) => sum + input.weight(d.projectId), 0);
  const share = input.weight(projectId) / total;
  // Weekly shares can be small; keep three decimals rather than rounding them to zero.
  const percentPerHour = Math.round((headroom / target) * share * 1000) / 1000;
  // Reported readings are whole percentages: ±1 point of headroom over the same horizon.
  const uncertainty = (share / target).toFixed(share / target < 0.1 ? 3 : 2);
  return {
    ...base,
    state: 'ready',
    percentPerHour,
    reason:
      `${headroom.toFixed(1)}% of ${window.label} is above the ${reserve}% reserve and ${input.reservedPercent.toFixed(1)}% reservations, ` +
      `paced to about 15 minutes before its reported reset in ${hours.toFixed(1)} h and shared by weight across ${sharing.length} project${sharing.length === 1 ? '' : 's'} with ready work. ` +
      `About ±${uncertainty}%/h from whole-percent readings; external use shares this headroom. ` +
      (input.enforced
        ? 'The window is projected to reach its reserve before reset, so admission currently follows this share; a project idle for the past hour can still start one turn'
        : 'Admission is not paced while the window is on track; this is a suggestion') +
      (input.hourlyCapPercent !== null
        ? `. The saved ${input.hourlyCapPercent}%/hour cap stays authoritative.`
        : '. No cap is saved or changed.'),
  };
}
