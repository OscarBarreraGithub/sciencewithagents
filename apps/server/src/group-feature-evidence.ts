import { groupOwnedTaskReceiptSchema } from '@dock/shared/dist/group-actions.js';
import { groupEvidenceFactsSchema } from '@dock/shared/dist/group-evidence.js';
import type { GroupHost } from './group-host.js';
import type { GroupEvidenceSourcePort } from './group-evidence.js';

/** Normal host source composition. Category/author come from committed hosted
 * headers. Task/manager responsibility comes only from a same-DO verified work
 * registration matching the exact native receipt, never prose extraction. */
export function groupFeatureEvidence(host: GroupHost): GroupEvidenceSourcePort {
  return {
    async readVerifiedShared(reader, eventId) {
      await reader.revalidate();
      const { event, compactOriginal, origin } = await host.sharedEvidenceHeader(
        reader.enrollmentHandle,
        eventId,
      );
      const category = {
        Instruction: 'instruction',
        Question: 'question',
        Idea: 'idea',
        Finding: 'finding',
        Decision: 'decision',
        Action: 'action',
        Conflict: 'conflict',
        Blocker: 'blocker',
      } as const;
      const facts = groupEvidenceFactsSchema.parse({
        sourceId: origin?.key.sourceId ?? `group-delivery:${event.eventId}`,
        sourceVersion: origin?.key.version ?? event.revision,
        kinds: [category[event.category]],
        subjectIds: [origin?.scope.memberId ?? event.scope.memberId],
        paths: [],
        instructionIds: [],
        originalIds: {
          memberId: origin?.scope.memberId ?? event.scope.memberId,
          ...(event.category === 'Instruction' ? { instructionEventId: event.eventId } : {}),
        },
        edges: [],
        autonomous: null,
        unresolved: null,
      });
      if (
        event.category === 'Decision' &&
        event.scope.source.provider !== 'owner' &&
        compactOriginal
      ) {
        let raw: unknown;
        try {
          raw = JSON.parse(compactOriginal);
        } catch {
          raw = null;
        }
        const parsed = groupOwnedTaskReceiptSchema.safeParse(raw);
        if (parsed.success) {
          const receipt = parsed.data;
          const board = await (
            await host.actionContextForEnrollment(reader.enrollmentHandle)
          ).command({ kind: 'board', after: 0, limit: 50 });
          if (
            board.ok &&
            board.value.kind === 'board' &&
            board.value.board.works.some(
              (work) =>
                work.taskId === receipt.taskId &&
                work.managerId === receipt.managerId &&
                work.sharedGoalId === receipt.sharedGoalId &&
                work.title === receipt.title &&
                work.owner.memberId === event.scope.memberId &&
                work.owner.installationId === event.scope.installationId,
            ) &&
            event.scope.causalRefs.includes(receipt.sharedGoalId)
          ) {
            facts.kinds.push('responsibility');
            facts.subjectIds.push(receipt.taskId, receipt.managerId);
            facts.instructionIds.push(receipt.sharedGoalId);
            Object.assign(facts.originalIds, {
              taskId: receipt.taskId,
              managerId: receipt.managerId,
              sharedGoalId: receipt.sharedGoalId,
            });
            facts.edges.push(
              { fromId: receipt.taskId, toId: receipt.sharedGoalId, relation: 'goal' },
              { fromId: receipt.taskId, toId: receipt.managerId, relation: 'manager' },
            );
          } else return { event, facts: null };
        }
      }
      await reader.revalidate();
      return { event, facts: groupEvidenceFactsSchema.parse(facts) };
    },
  };
}
