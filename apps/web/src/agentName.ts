import type { Agent } from '@dock/shared';

/** Older installs appended a role to every project chat. Keep the saved name intact. */
export function agentName(agent: Pick<Agent, 'name' | 'role'>): string {
  return agent.role === 'manager' ? agent.name.replace(/ manager$/i, '') || agent.name : agent.name;
}
