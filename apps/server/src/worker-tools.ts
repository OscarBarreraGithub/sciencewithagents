import {
  projectToolsSchema,
  workerToolsSchema,
  type ProviderId,
  type WorkerTools,
} from '@dock/shared';
import { Conflict, type Store } from './store.js';

export function projectTools(store: Store, projectId: string) {
  store.project(projectId);
  return projectToolsSchema.parse(
    store.getSetting(`worker-tools:${projectId}`) ?? { toolPolicy: 'native' },
  );
}

/** Only new delegations use this ceiling. Saved conversations keep their explicit settings. */
export function delegationTools(
  store: Store,
  projectId: string,
  provider: ProviderId,
  requested?: WorkerTools,
) {
  const policy = projectTools(store, projectId);
  if (requested === undefined && policy.toolPolicy === 'native')
    return {
      tools: workerToolsSchema.parse({}),
      revision: policy.revision,
      toolPolicy: 'native' as const,
    };
  const tools = workerToolsSchema.parse(requested ?? {});
  const requestedAny =
    tools.mcpServers.length ||
    tools.pluginsEnabled ||
    tools.imageGeneration ||
    tools.webSearch !== 'disabled';
  if (provider !== 'codex' && requestedAny)
    throw new Conflict(
      'These delegated tools currently require a Codex worker. Choose an owner-enabled Codex provider explicitly, or ask the owner; no provider was changed.',
    );
  const allowed = policy.codex;
  const webAllowed =
    tools.webSearch === 'disabled' ||
    allowed.webSearch === 'live' ||
    (['cached', 'indexed'].includes(tools.webSearch) &&
      ['cached', 'indexed'].includes(allowed.webSearch));
  if (
    tools.mcpServers.some((name) => !allowed.mcpServers.includes(name)) ||
    (tools.pluginsEnabled && !allowed.pluginsEnabled) ||
    (tools.imageGeneration && !allowed.imageGeneration) ||
    !webAllowed
  )
    throw new Conflict(
      'Requested tools exceed this project’s worker allowance. Ask the owner to review Tools for new workers in the project overview.',
    );
  return { tools, revision: policy.revision, toolPolicy: 'restricted' as const };
}
