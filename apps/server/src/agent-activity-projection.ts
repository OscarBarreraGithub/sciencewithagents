import { agentRunActivitySchema, type Agent } from '@dock/shared';
import type { Store } from './store.js';

/** One indexed row per agent; no prompt/history payload or persisted second status. */
export function projectAgentActivity(store: Store, agent: Agent): Agent {
  const row = store.db
    .prepare(
      `SELECT id,status,json_extract(body,'$.createdAt') AS createdAt
       FROM runs WHERE agent_id=? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(agent.id);
  return { ...agent, latestRun: row ? agentRunActivitySchema.parse(row) : null };
}
