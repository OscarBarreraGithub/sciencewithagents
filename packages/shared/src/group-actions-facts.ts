import { groupIdSchema } from './groups.js';
import {
  groupActionSchema,
  groupActionInstructionSchema,
  groupActionWorkSchema,
  groupActionProposalSchema,
  groupActionNoticeSchema,
  groupActionSourceFactsSchema,
  type GroupAction,
  type GroupActionInstruction,
  type GroupActionNotice,
  type GroupActionProposal,
  type GroupActionWork,
  type GroupActionSourceFacts,
} from './group-actions.js';

/** Read projection only: no SQL mutation, current-state lookup, summary reading,
 * native output copying or event/source identity substitution. */
export function groupActionSourceFacts(record: {
  sourceId: string;
  version: 1;
  kind: string;
  originalJson: string;
}): GroupActionSourceFacts {
  const parts = record.sourceId.split(':');
  if (
    parts.length !== 3 ||
    parts[0] !== 'group-action' ||
    !/^[1-9][0-9]*$/.test(parts[2]!) ||
    !Number.isSafeInteger(Number(parts[2]))
  )
    throw new Error('Exact namespaced action source identity required.');
  const sourceGroup = groupIdSchema.parse(parts[1]);
  const raw: unknown = JSON.parse(record.originalJson);
  let action: GroupAction | null = null;
  let proposal: GroupActionProposal | null = null;
  let work: GroupActionWork | null = null;
  let instruction: GroupActionInstruction | null = null;
  let notice: GroupActionNotice | null = null;
  switch (record.kind) {
    case 'instruction':
      instruction = groupActionInstructionSchema.parse(raw);
      break;
    case 'work':
      work = groupActionWorkSchema.parse(raw);
      break;
    case 'proposal':
      proposal = groupActionProposalSchema.parse(raw);
      break;
    case 'override-notice':
      notice = groupActionNoticeSchema.parse(raw);
      break;
    case 'confirmed':
    case 'pending-owner':
    case 'dispatching':
    case 'uncertain':
    case 'completed':
    case 'superseded':
    case 'revoked':
      action = groupActionSchema.parse(raw);
      if (record.kind !== 'confirmed' && action.state !== record.kind)
        throw new Error('Action source state differs from immutable record kind.');
      if (record.kind === 'confirmed' && action.state !== 'pending-owner')
        throw new Error('Confirmation must precede owner dispatch.');
      break;
    default:
      throw new Error('Unknown action source kind.');
  }
  proposal ??= action?.proposal ?? null;
  work ??= proposal?.observed ?? null;
  const origin = proposal?.origin ?? work?.latest.origin;
  const sourceActor = proposal?.actor ?? work?.latest.actor ?? instruction?.actor ?? notice?.actor;
  if (
    sourceActor?.groupId !== sourceGroup ||
    (work && (work.owner.groupId !== sourceGroup || work.latest.actor.groupId !== sourceGroup)) ||
    (proposal && proposal.workId !== work?.workId)
  )
    throw new Error('Action source group/work binding differs from immutable snapshot.');
  if (
    origin?.kind === 'autonomous' &&
    work &&
    (origin.managerId !== work.managerId || origin.sharedGoalId !== work.sharedGoalId)
  )
    throw new Error('Autonomous manager/goal differs from immutable work binding.');
  if (
    action &&
    (action.revision !== action.proposal.observed.revision + 1 ||
      (action.outcome && action.outcome.taskId !== work?.taskId))
  )
    throw new Error('Action revision/outcome differs from immutable work binding.');
  const originalIds: GroupActionSourceFacts['originalIds'] = {
    instructionEventId:
      origin?.kind === 'instruction' ? origin.eventId : (instruction?.eventId ?? null),
    proposalId: proposal?.proposalId ?? null,
    actionId: action?.actionId ?? notice?.actionId ?? null,
    sharedGoalId: work?.sharedGoalId ?? null,
    taskId: work?.taskId ?? null,
    managerId: work?.managerId ?? null,
    workerId: action?.outcome?.workerId ?? null,
    outcomeId: action?.outcome?.outcomeId ?? null,
    jobId: action?.outcome?.jobId ?? null,
    memberId:
      proposal?.actor.memberId ??
      work?.latest.actor.memberId ??
      instruction?.actor.memberId ??
      notice?.actor.memberId ??
      null,
  };
  const edges: GroupActionSourceFacts['edges'] = [];
  const edge = (
    fromId: string | null,
    toId: string | null,
    relation: GroupActionSourceFacts['edges'][number]['relation'],
  ) => {
    if (!fromId || !toId) return;
    if (
      !edges.some(
        (value) => value.fromId === fromId && value.toId === toId && value.relation === relation,
      )
    )
      edges.push({ fromId, toId, relation });
  };
  if (instruction) edge(record.sourceId, instruction.eventId, 'instruction');
  if (proposal) {
    edge(record.sourceId, proposal.proposalId, 'proposal');
    if (proposal.origin.kind === 'instruction')
      edge(proposal.origin.eventId, proposal.proposalId, 'proposal');
  }
  if (action || notice) edge(record.sourceId, originalIds.actionId, 'action');
  if (action) edge(originalIds.proposalId, originalIds.actionId, 'action');
  // Relation names identify the exact referenced target. They do not assert
  // that a worker/job ran, that a task is now active, or that an ID is an event.
  const subject = originalIds.actionId ?? originalIds.proposalId ?? record.sourceId;
  if (work) {
    edge(subject, work.taskId, 'task');
    edge(subject, work.sharedGoalId, 'goal');
    edge(work.taskId, work.managerId, 'manager');
  }
  if (action?.outcome) {
    edge(action.actionId, action.outcome.workerId, 'worker');
    edge(action.actionId, action.outcome.outcomeId, 'outcome');
    edge(action.outcome.outcomeId, action.outcome.jobId ?? null, 'evidence');
  }
  const kinds: GroupActionSourceFacts['kinds'] = instruction
    ? ['instruction']
    : work && !proposal
      ? ['responsibility']
      : ['action'];
  if (notice || proposal?.overrideRequired) kinds.push('conflict');
  if (action?.state === 'uncertain' || action?.outcome?.status === 'blocked') kinds.push('blocker');
  if (origin?.kind === 'autonomous') kinds.push('decision');
  return groupActionSourceFactsSchema.parse({
    sourceId: record.sourceId,
    sourceVersion: record.version,
    kinds: [...new Set(kinds)],
    subjectIds: [
      ...new Set(Object.values(originalIds).filter((value): value is string => value !== null)),
    ],
    paths: [],
    instructionIds: [],
    originalIds,
    edges,
    autonomous: origin ? origin.kind === 'autonomous' : instruction ? false : null,
    unresolved: null,
  });
}
