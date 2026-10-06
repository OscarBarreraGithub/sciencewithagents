import type { SQLInputValue } from 'node:sqlite';
import { entrySchema, type AgentDetailChannel } from '@dock/shared';
import type { Store } from './store.js';

/** Presentation only: retain the complete transcript and derive provenance from every saved run. */
export function conversationEntries(
  store: Store,
  agentId: string,
  before?: string,
  channel: AgentDetailChannel = 'all',
) {
  const args: SQLInputValue[] = [agentId, agentId];
  if (before) args.push(before, agentId);
  // A mixed turn can keep updating an item created before steering. Preserve its
  // whole reply rather than pretend the retained item records a per-delta boundary.
  // The system marker is the original host-recorded steering format, also used by
  // owner-request recovery; it is not a guess about an assistant's title or text.
  const sql = `WITH owner_runs AS MATERIALIZED (
    SELECT DISTINCT json_extract(body,'$.runId') AS run_id FROM entries
    WHERE agent_id=? AND (json_extract(body,'$.kind')='user' OR
      (json_extract(body,'$.kind')='system' AND json_extract(body,'$.title')='Owner steering'))
  ), classified AS (
    SELECT e.rowid AS ordinal, e.body,
      CASE WHEN json_extract(r.body,'$.kind') IN ('message','report') AND
        (json_extract(e.body,'$.kind')='message' OR
          (json_extract(e.body,'$.kind') IN ('assistant','tool') AND o.run_id IS NULL AND g.key IS NULL))
        THEN json_extract(r.body,'$.kind') ELSE NULL END AS coordination_kind,
      json_extract(r.body,'$.sourceId') AS source_id
    FROM entries e
    LEFT JOIN runs r ON r.id=json_extract(e.body,'$.runId') AND r.agent_id=e.agent_id
    LEFT JOIN owner_runs o ON o.run_id=r.id
    -- Host-tagged goal reports are substantive owner work. Keep their output in
    -- the main conversation while their generated message input remains coordination.
    LEFT JOIN settings g ON g.key='managed-goal:run:'||r.id
      AND json_extract(r.body,'$.sourceId')=e.agent_id
      AND json_type(g.value)='text'
      AND r.key LIKE 'goal:'||json_extract(g.value,'$')||':after:%'
    WHERE e.agent_id=?${before ? ' AND e.rowid<(SELECT rowid FROM entries WHERE id=? AND agent_id=?)' : ''}${
      // Admission inputs are host-generated receipts, not a second owner message.
      // Keep them in all/raw history and filter before the conversation page limit.
      channel === 'conversation'
        ? " AND NOT COALESCE(e.id=r.id AND r.key LIKE 'native-admission:%' AND json_extract(r.body,'$.kind')='user' AND json_extract(e.body,'$.kind')='user',0)"
        : ''
    }
  ) SELECT body, coordination_kind, source_id FROM classified
    ${channel === 'all' ? '' : `WHERE coordination_kind IS ${channel === 'conversation' ? '' : 'NOT '}NULL`}
    ORDER BY ordinal DESC LIMIT 201`;
  const rows = store.db.prepare(sql).all(...args);
  return {
    entries: rows
      .slice(0, 200)
      .reverse()
      .map((row) =>
        entrySchema.parse({
          ...JSON.parse(String(row.body)),
          coordination: row.coordination_kind
            ? { kind: row.coordination_kind, sourceId: row.source_id }
            : undefined,
        }),
      ),
    hasMore: rows.length > 200,
  };
}
