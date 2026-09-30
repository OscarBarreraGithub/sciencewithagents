import type { Agent } from '@dock/shared';

// Compatible with the backend's optional durable identity, including older hosts.
export function resourceAssistantOf(agent: Agent) {
  const value = (agent as Agent & { resourceAssistant?: { mode: string; reason?: string } })
    .resourceAssistant;
  if (
    !value ||
    !['interactive', 'snapshot'].includes(value.mode) ||
    (value.reason !== undefined && !['asked', 'checkpoint', 'pressure'].includes(value.reason))
  )
    return null;
  return value;
}
export const automaticResourceChat = (agent: Agent) => {
  const identity = resourceAssistantOf(agent);
  return identity?.reason === 'checkpoint' || identity?.reason === 'pressure';
};
