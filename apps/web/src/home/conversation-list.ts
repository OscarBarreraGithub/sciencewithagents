import type { Agent, Snapshot } from '@dock/shared';
import { surfaceOf } from './chat-contracts';
import { resourceAssistantOf } from './resource-chat';

export type ConversationContext = {
  personalId?: string | null;
  personalProjectId?: string | null;
  resourceProjectId?: string | null;
};

/** Keep Home counts and the conversation list on the same provenance rules. */
export function chatAgentKind(
  agent: Agent,
  state: Snapshot,
  context: ConversationContext,
): 'manager' | 'misc' | null {
  const surface = surfaceOf(agent);
  if (agent.archivedAt || agent.nativeRootId || surface === 'terminal') return null;
  if (resourceAssistantOf(agent) || agent.projectId === context.resourceProjectId) return null;
  if (
    state.projects.find((project) => project.id === agent.projectId)?.internal &&
    surface !== 'misc' &&
    agent.id !== context.personalId
  )
    return null;
  return agent.interview || surface === 'misc' || agent.projectId === context.personalProjectId
    ? 'misc'
    : agent.role === 'manager'
      ? 'manager'
      : null;
}
