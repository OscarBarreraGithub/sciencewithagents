import { z } from 'zod';
import {
  groupEvidenceQuerySchema,
  GROUP_EVIDENCE_LIMITS,
} from '@dock/shared/dist/group-evidence.js';
import type { GroupCatchupReader } from './group-catchup-context.js';
import { catchupFail } from './group-catchup-context.js';
import type { GroupCatchupStore } from './group-catchup.js';
import type { GroupEvidenceIndex } from './group-evidence.js';
export const groupPrivateEvidenceArgumentsSchema = z.strictObject({
  queryId: z.uuid(),
  query: groupEvidenceQuerySchema,
  limit: z.number().int().min(1).max(GROUP_EVIDENCE_LIMITS.pageSize),
  continuation: z.uuid().nullable(),
});
/** Concrete native tool handler. Native owner binds resolve to the persisted private
 * context's authenticated host handle, never model/browser identity fields. Calling it
 * does not fork/resume a shared session, launch a model, or write a shared event/outbox. */
export function createGroupPrivateEvidenceQuery(ports: {
  resolve: () => Promise<GroupCatchupReader>;
  evidence: GroupEvidenceIndex;
  catchup: GroupCatchupStore;
}) {
  return async (raw: unknown) => {
    const input = groupPrivateEvidenceArgumentsSchema.parse(raw);
    const reader = await ports.resolve();
    if (reader.context.visibility !== 'private')
      catchupFail(
        'private_required',
        'Private shared-evidence queries require the owning fresh private context.',
      );
    await reader.revalidate();
    return ports.evidence.query(
      reader,
      input.query,
      input.limit,
      input.continuation,
      ports.catchup,
      input.queryId,
    );
  };
}
export const GROUP_PRIVATE_EVIDENCE_TOOL = {
  name: 'group_evidence_query',
  description:
    'Read bounded original shared evidence privately. Choose a typed query and follow its continuation; missing facts/causality are unknown. This tool cannot publish or mutate work.',
  inputSchema: z.toJSONSchema(groupPrivateEvidenceArgumentsSchema),
} as const;
