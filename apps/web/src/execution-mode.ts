import type { Agent } from '@dock/shared';

/** Missing historical choices are managed; reading never converts an existing record. */
export const managedExecution = (agent?: Agent | null) => agent?.executionMode !== 'direct';
