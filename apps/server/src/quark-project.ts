import { projectQuarkPolicySchema } from '@dock/shared';
import type { Store } from './store.js';

export const projectSchedulerKey = (projectId: string) => `quark:project-scheduler:${projectId}`;
export function projectFollowsQuark(store: Store, projectId: string) {
  return projectQuarkPolicySchema.parse(
    store.getSetting(projectSchedulerKey(projectId)) ?? { projectId },
  ).enabled;
}
