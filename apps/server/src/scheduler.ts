import {
  schedulerSettingsSchema,
  schedulerStatusSchema,
  schedulerUpdateSchema,
} from '@dock/shared';
import { Store, type PrivateRun } from './store.js';
import { projectFollowsQuark } from './quark-project.js';

export function schedulerSettings(store: Store) {
  return schedulerSettingsSchema.parse(
    store.getSetting('scheduler:settings') ?? { paused: false, maxConcurrent: 4 },
  );
}
export function saveSchedulerSettings(store: Store, raw: unknown) {
  const input = schedulerUpdateSchema.parse(raw);
  return store.operation(
    input.key,
    { kind: 'scheduler.settings', settings: input.settings },
    () => {
      store.setSetting('scheduler:settings', input.settings);
      store.event('scheduler.settings_changed', null, null, input.settings);
      return input.settings;
    },
  );
}
// `hold` returns an existing authoritative QUARK refusal for a queued run, if any.
export function schedulerStatus(
  store: Store,
  externalControl: ReadonlySet<string>,
  hold: (run: PrivateRun) => string | null = () => null,
) {
  const settings = schedulerSettings(store);
  const agents = new Map(store.agents().map((agent) => [agent.id, agent]));
  const projects = new Map(store.projects().map((project) => [project.id, project]));
  const items = store
    .runs()
    .filter((run) => ['queued', 'running'].includes(run.status))
    .flatMap((run) => {
      const agent = agents.get(run.agentId),
        project = agent && projects.get(agent.projectId);
      if (!agent || !project || agent.nativeRootId) return [];
      const external =
        externalControl.has(agent.id) ||
        (agent.taskId &&
          [...agents.values()].some(
            (peer) => peer.taskId === agent.taskId && externalControl.has(peer.id),
          ));
      const explanation =
        run.status === 'running'
          ? 'Already started; queue settings do not interrupt it.'
          : run.queueEdit
            ? 'Held for editing. Return this message to the queue explicitly when ready.'
            : settings.paused
              ? 'New queued work is paused.'
              : external
                ? 'A native terminal controls this agent or task. Return it to chat to release queued work.'
                : (hold(run) ??
                  (['interrupted', 'failed', 'waiting'].includes(agent.status)
                    ? 'Inspect this agent’s pending request or stopped work before continuing.'
                    : !projectFollowsQuark(store, project.id)
                      ? 'QUARK scheduling is off. Waiting for this agent’s earlier work or task workspace ownership.'
                      : 'Waiting for an available slot and this agent’s earlier work. Task workspace ownership still applies.'));
      return [
        {
          id: run.id,
          agentId: agent.id,
          projectId: project.id,
          projectName: project.name,
          agentName: agent.name,
          status: run.status as 'queued' | 'running',
          createdAt: run.createdAt,
          explanation,
        },
      ];
    });
  return schedulerStatusSchema.parse({ settings, items });
}
