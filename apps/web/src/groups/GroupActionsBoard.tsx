import { useCallback, useEffect, useState } from 'react';
import {
  groupActionResultSchema,
  type GroupActionCommand,
  type GroupActionProposal,
  type GroupActionWork,
} from '@dock/shared/dist/group-actions.js';
import { api, apiScope } from '../api';
import './group-actions.css';

type Board = Extract<
  import('@dock/shared/dist/group-actions.js').GroupActionReply,
  { kind: 'board' }
>['board'];
type Pending = {
  workId: string;
  revision: number;
  action: 'start' | 'stop';
  instruction: Extract<GroupActionCommand, { kind: 'instruction' }>;
  proposal?: Extract<GroupActionCommand, { kind: 'propose' }>;
};
class ActionRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (result: ReturnType<typeof groupActionResultSchema.parse>) => {
  if (!result.ok)
    throw new ActionRefused(
      result.error,
      result.error === 'stale'
        ? `Work changed. ${result.current ? `${result.current.latest.actor.displayName} requested ${result.current.desired} at ${new Date(result.current.latest.at).toLocaleString()} (revision ${result.current.revision}). ` : ''}Refresh the board and make a new proposal before confirming.`
        : result.error === 'denied'
          ? 'Your shared action permission is unavailable. Reopen the group.'
          : result.error === 'conflict'
            ? 'A competing or uncertain action needs resolution. Refresh the board.'
            : 'Action unavailable. Retry the same request after reconnecting.',
    );
  return result.value;
};
/** Mount only for selected normal Groups handle. Endpoint resolves saved identity. */
export function GroupActionsBoard({
  handle,
  actor,
  request = (command) => api('/groups/actions', { handle, command }),
}: {
  handle: string;
  actor?: { memberId: string; installationId: string };
  request?: (command: GroupActionCommand) => Promise<unknown>;
}) {
  const storage = `swa:group-actions:${apiScope()}:${handle}`;
  const [board, setBoard] = useState<Board | null>(null),
    [proposal, setProposal] = useState<GroupActionProposal | null>(
      () =>
        JSON.parse(
          sessionStorage.getItem(`${storage}:proposal`) ?? 'null',
        ) as GroupActionProposal | null,
    );
  const [text, setText] = useState(() => sessionStorage.getItem(`${storage}:draft`) ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // The default request captures the same normal pinned computer API scope.
  const call = async (command: GroupActionCommand) =>
    fail(groupActionResultSchema.parse(await request(command)));
  const refresh = useCallback(async () => {
    const result = fail(
      groupActionResultSchema.parse(await request({ kind: 'board', after: 0, limit: 50 })),
    );
    if (result.kind === 'board') setBoard(result.board);
  }, [handle]);
  useEffect(() => {
    let alive = true;
    void request({ kind: 'board', after: 0, limit: 50 })
      .then((raw) => {
        const result = fail(groupActionResultSchema.parse(raw));
        if (alive && result.kind === 'board') setBoard(result.board);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : 'Board unavailable.');
      });
    return () => {
      alive = false;
    };
  }, [handle]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Action unavailable. Retry.');
    } finally {
      setBusy(false);
    }
  };
  const propose = async (work: GroupActionWork, action: 'start' | 'stop') => {
    const saved = JSON.parse(
      sessionStorage.getItem(`${storage}:pending`) ?? 'null',
    ) as Pending | null;
    if (
      saved &&
      (saved.workId !== work.workId || saved.action !== action || saved.instruction.text !== text)
    )
      throw new Error('An acknowledgement is pending. Retry your exact saved instruction first.');
    const pending: Pending = saved ?? {
      workId: work.workId,
      revision: work.revision,
      action,
      instruction: { kind: 'instruction', operationId: crypto.randomUUID(), text: text },
    };
    sessionStorage.setItem(`${storage}:pending`, JSON.stringify(pending));
    const instruction = await call(pending.instruction);
    if (instruction.kind !== 'instruction') throw new Error('Instruction receipt unavailable.');
    pending.proposal ??= {
      kind: 'propose',
      operationId: crypto.randomUUID(),
      workId: pending.workId,
      expectedRevision: pending.revision,
      action: pending.action,
      origin: { kind: 'instruction', eventId: instruction.instruction.eventId },
    };
    sessionStorage.setItem(`${storage}:pending`, JSON.stringify(pending));
    let result;
    try {
      result = await call(pending.proposal);
    } catch (reason) {
      if (reason instanceof ActionRefused && reason.code === 'stale')
        sessionStorage.removeItem(`${storage}:pending`);
      throw reason;
    }
    if (result.kind !== 'proposal') throw new Error('Proposal receipt unavailable.');
    sessionStorage.setItem(`${storage}:proposal`, JSON.stringify(result.proposal));
    setProposal(result.proposal);
    sessionStorage.removeItem(`${storage}:pending`);
    await refresh();
  };
  const confirm = async () => {
    if (!proposal) return;
    const command = JSON.parse(sessionStorage.getItem(`${storage}:confirm`) ?? 'null') as Extract<
      GroupActionCommand,
      { kind: 'confirm' }
    > | null;
    const exact = command ?? {
      kind: 'confirm' as const,
      operationId: crypto.randomUUID(),
      proposalId: proposal.proposalId,
      expectedRevision: proposal.observed.revision,
      override: proposal.overrideRequired,
    };
    sessionStorage.setItem(`${storage}:confirm`, JSON.stringify(exact));
    try {
      await call(exact);
    } catch (reason) {
      if (reason instanceof ActionRefused && ['stale', 'denied'].includes(reason.code))
        sessionStorage.removeItem(`${storage}:confirm`);
      throw reason;
    }
    sessionStorage.removeItem(`${storage}:confirm`);
    sessionStorage.removeItem(`${storage}:proposal`);
    setProposal(null);
    await refresh();
  };
  return (
    <section className="group-actions" aria-label="Shared work board">
      <div className="group-actions-heading">
        <h2>Shared work</h2>
        <button disabled={busy} onClick={() => void act(refresh)}>
          Refresh board
        </button>
      </div>
      <p>
        Start and stop requests are shared instructions. Review the proposal before confirming. Work
        runs on its original owner’s computer and account.
      </p>
      {error && <p role="alert">{error}</p>}
      {!board ? (
        <p role="status">Loading shared work…</p>
      ) : (
        <>
          {board.notices.map((n) => (
            <p role="status" key={n.noticeId}>
              {n.text}
            </p>
          ))}
          {board.works.length === 0 && (
            <p>No shared tasks yet. Your group manager can register an owned task here.</p>
          )}
          <label>
            Shared instruction
            <textarea
              value={text}
              maxLength={8000}
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value);
                sessionStorage.setItem(`${storage}:draft`, e.target.value);
              }}
              placeholder="Explain the start or stop you want"
            />
          </label>
          {board.works.map((work) => (
            <article key={work.workId}>
              <h3>{work.title}</h3>
              <p>
                Owner: {work.owner.displayName} · Requested state: {work.desired}
              </p>
              <p>
                {work.latest.actor.displayName} requested {work.desired} at{' '}
                <time dateTime={work.latest.at}>{new Date(work.latest.at).toLocaleString()}</time>.
                Revision {work.revision}.
              </p>
              <p className="group-actions-ref">Task {work.taskId}</p>
              <div className="group-actions-buttons">
                <button
                  disabled={busy || !text.trim() || Boolean(proposal)}
                  onClick={() => void act(() => propose(work, 'start'))}
                >
                  Propose start
                </button>
                <button
                  disabled={busy || !text.trim() || Boolean(proposal)}
                  onClick={() => void act(() => propose(work, 'stop'))}
                >
                  Propose stop
                </button>
              </div>
            </article>
          ))}
          {board.proposals
            .filter(
              (candidate) =>
                actor &&
                candidate.actor.memberId === actor.memberId &&
                candidate.actor.installationId === actor.installationId &&
                board.works.some(
                  (work) =>
                    work.workId === candidate.workId &&
                    work.revision === candidate.observed.revision,
                ) &&
                !board.actions.some(
                  (action) => action.proposal.proposalId === candidate.proposalId,
                ),
            )
            .map((candidate) => (
              <article key={candidate.proposalId}>
                <h3>
                  Proposed {candidate.kind}: {candidate.observed.title}
                </h3>
                <p>
                  {candidate.origin.kind === 'autonomous'
                    ? 'Your group manager'
                    : candidate.actor.displayName}{' '}
                  proposed this at{' '}
                  <time dateTime={candidate.at}>{new Date(candidate.at).toLocaleString()}</time>.
                </p>
                <button
                  disabled={busy || Boolean(proposal)}
                  onClick={() => {
                    sessionStorage.setItem(`${storage}:proposal`, JSON.stringify(candidate));
                    setProposal(candidate);
                  }}
                >
                  Review {candidate.kind} proposal
                </button>
              </article>
            ))}
          {board.actions.map((a) => (
            <p key={a.actionId}>
              Requested {a.proposal.kind} ·{' '}
              {a.state === 'pending-owner'
                ? 'Waiting for original owner'
                : a.state === 'uncertain'
                  ? 'Checking previous dispatch'
                  : a.state}
              {a.outcome ? ` · ${a.outcome.message}` : ''}
            </p>
          ))}
          {proposal && (
            <article aria-label="Confirm shared action" className="group-actions-confirm">
              <h3>
                Confirm {proposal.kind}: {proposal.observed.title}
              </h3>
              <p>
                {proposal.actor.displayName} proposed this at{' '}
                <time>{new Date(proposal.at).toLocaleString()}</time>.
              </p>
              {proposal.overrideRequired && (
                <p role="alert">
                  This overrides {proposal.observed.latest.actor.displayName}’s{' '}
                  {proposal.observed.desired} request from{' '}
                  {new Date(proposal.observed.latest.at).toLocaleString()}. They will be notified.
                </p>
              )}
              <p>
                Confirmation checks revision {proposal.observed.revision} again. The original owner
                executes the action when available.
              </p>
              <button disabled={busy} onClick={() => void act(confirm)}>
                {proposal.overrideRequired ? 'Confirm override' : `Confirm ${proposal.kind}`}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (sessionStorage.getItem(`${storage}:confirm`)) {
                    setError(
                      'A confirmation acknowledgement is pending. Retry it before discarding the proposal.',
                    );
                    return;
                  }
                  sessionStorage.removeItem(`${storage}:proposal`);
                  setProposal(null);
                }}
              >
                Discard proposal
              </button>
            </article>
          )}
        </>
      )}
    </section>
  );
}
