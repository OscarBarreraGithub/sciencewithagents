import { z } from 'zod';
import { groupPrivateEvidenceArgumentsSchema } from './group-evidence-private.js';
import { catchupFail, type GroupCatchupReader } from './group-catchup-context.js';
import type { GroupEvidenceIndex } from './group-evidence.js';

/** Shared Group manager reads only authenticated shared originals. Its local
 * offline position is separate from the preserved private aside receipts. */
export function createGroupSharedEvidenceQuery(ports: {
  resolve: () => Promise<GroupCatchupReader>;
  evidence: GroupEvidenceIndex;
}) {
  return async (raw: unknown) => {
    const input = groupPrivateEvidenceArgumentsSchema.parse(raw);
    const reader = await ports.resolve();
    if (reader.context.visibility !== 'shared')
      catchupFail('conflict', 'The current shared Group manager context is required.');
    if (!input.continuation) await ports.evidence.refreshShared(reader, input.queryId);
    const page = await ports.evidence.query(
      reader,
      input.query,
      input.limit,
      input.continuation,
      { acknowledged: (scope) => ports.evidence.sharedAcknowledged(scope) },
      input.queryId,
    );
    if (input.query.type === 'offline_changes' && !page.continuation)
      await ports.evidence.acknowledgeShared(reader, input.queryId, page);
    return page;
  };
}
export const GROUP_SHARED_EVIDENCE_TOOL = {
  name: 'group_evidence_query',
  description:
    'Read authenticated shared event headers and verified typed evidence/source IDs. Use dock_group_evidence_original for exact bodies. Follow continuation with the same queryId. Offline changes means since this Group manager last completed an offline evidence query. Missing facts and incomplete index coverage are unknown; a new queryId refreshes at most 16 more shared events. This tool cannot publish or launch work.',
  inputSchema: z.toJSONSchema(groupPrivateEvidenceArgumentsSchema),
} as const;
