import { useEffect, useId, useRef, useState } from 'react';
import {
  managedGoalActionSchema,
  managedGoalViewSchema,
  type ManagedGoal,
  type ManagedGoalAction,
  type ManagedGoalView,
} from '@dock/shared';
import { api, apiScope, ApiError } from '../api';
import { Modal } from '../Modal';
import './ManagedGoalCard.css';

/** `draft` is the unsaved objective (null: not editing); `pending` is the exact unconfirmed request. */
type Saved = { draft: string | null; pending: ManagedGoalAction | null };

const statusLabel: Record<ManagedGoal['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  waiting: 'Waiting',
  blocked: 'Blocked',
  completed: 'Completed',
  stopped: 'Stopped',
};
const statusHelp: Record<ManagedGoal['status'], string> = {
  active: 'The manager continues this goal in turns admitted by QUARK.',
  paused: 'Queued goal work is held until you resume. A running reply is not interrupted.',
  waiting: 'The manager is waiting before its next step.',
  blocked: 'The manager needs help before it can continue.',
  completed: 'The manager reported this goal complete.',
  stopped: 'Stopped by you. Queued goal work was cancelled; the goal was not completed.',
};
const actionLabel: Record<ManagedGoalAction['action'], string> = {
  create: 'Starting the goal',
  replace: 'Saving the new objective',
  pause: 'Pausing',
  resume: 'Resuming',
  stop: 'Stopping',
};
const turnLabel: Record<string, string> = {
  queued: 'Waiting in QUARK',
  running: 'Working',
  paused: 'Held while paused',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};
const noGoal = 'No goal is set. Start one to continue toward an objective through QUARK.';
const inspectFirst =
  'Nothing was changed. The manager’s last turn needs attention first: inspect it in the chat, then send a message or choose Resume from history. Resume the goal after that.';
const ended = (status: ManagedGoal['status']) => status === 'completed' || status === 'stopped';
const short = 280;

/** A rejection the computer definitely answered; anything else may have been applied. */
const rejected = (error: unknown) =>
  error instanceof ApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![401, 408, 429].includes(error.status);

/**
 * An opt-in, app-managed goal for one project manager. Opening and reading never start
 * a model turn; goal turns use the project's existing QUARK allowance. A change is
 * recorded before it is sent and an unconfirmed one is only retried when asked.
 * Mount with `key={agentId}` so another conversation never receives this state.
 */
export function ManagedGoalCard({
  agentId,
  activity,
  open,
  onClose,
}: {
  agentId: string;
  /** The manager's status; a change (from app events) prompts a fresh reading. */
  activity?: string;
  open: boolean;
  onClose: () => void;
}) {
  const storageKey = `dock:managed-goal:${apiScope()}:${agentId}`;
  const path = `/agents/${encodeURIComponent(agentId)}/goal`;
  const restore = (): Saved => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      const pending = managedGoalActionSchema.safeParse(saved.pending);
      return {
        draft: typeof saved.draft === 'string' ? saved.draft : null,
        pending: pending.success ? pending.data : null,
      };
    } catch {
      return { draft: null, pending: null };
    }
  };
  const [initial] = useState(restore);
  const [draft, setDraft] = useState(initial.draft);
  const [pending, setPending] = useState(initial.pending);
  const [view, setView] = useState<ManagedGoalView | null>(null);
  const [missing, setMissing] = useState(false);
  const [readError, setReadError] = useState('');
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState('');
  const [attention, setAttention] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const objectiveId = useId();
  const notice = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  // Answers apply in launch order, and never to an older revision of the same goal.
  const order = useRef(0);
  const applied = useRef(0);
  const shown = useRef<ManagedGoalView | null>(null);
  const reads = useRef(0);

  function save(next: Saved) {
    localStorage.setItem(storageKey, JSON.stringify(next));
  }
  function accept(seq: number, value: ManagedGoalView) {
    const now = shown.current?.goal;
    const next = value.goal;
    const same = !!now && !!next && now.id === next.id;
    if (!mounted.current || (same && next.revision < now.revision)) return false;
    if (seq <= applied.current && !(same && next.revision > now.revision)) return false;
    applied.current = Math.max(applied.current, seq);
    shown.current = value;
    setView(value);
    setMissing(false);
    setReadError('');
    return true;
  }
  async function read() {
    const seq = ++order.current;
    reads.current += 1;
    setReading(true);
    try {
      const value = managedGoalViewSchema.parse(await api(path));
      if (value.goal && value.goal.agentId !== agentId) throw new Error('Wrong conversation.');
      accept(seq, value);
    } catch (error) {
      if (!mounted.current || seq <= applied.current) return;
      if (error instanceof ApiError && error.status === 404) setMissing(true);
      else setReadError('Could not read the goal. Your draft and any unconfirmed change are kept.');
    } finally {
      reads.current -= 1;
      if (mounted.current && !reads.current) setReading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void read();
  }, [activity]);
  useEffect(() => {
    // Bounded, read-only refresh while visible; a reading still in flight is never doubled.
    const quiet = () => {
      if (!document.hidden && !reads.current) void read();
    };
    const timer = window.setInterval(quiet, open ? 10_000 : 30_000);
    document.addEventListener('visibilitychange', quiet);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', quiet);
    };
  }, [open]);
  useEffect(() => {
    if (open) void read();
  }, [open]);
  const unconfirmed = !!pending && !busy;
  useEffect(() => {
    // A small landscape dialog may be scrolled to the objective; show the new outcome.
    if (message || unconfirmed) notice.current?.scrollIntoView({ block: 'nearest' });
  }, [message, unconfirmed]);

  function edit(value: string) {
    if (pending) return;
    setDraft(value);
    setAttention(false);
    try {
      save({ draft: value, pending: null });
    } catch {
      setMessage('This browser cannot keep the objective draft. Keep this page open.');
    }
  }
  function cancelEdit() {
    setDraft(null);
    setAttention(false);
    try {
      save({ draft: null, pending: null });
    } catch {
      /* Nothing else depends on the stored draft. */
    }
  }
  /** Close only this receipt; a newer draft or receipt from another tab is kept. */
  function settle(input: ManagedGoalAction, keepDraft: boolean) {
    const saved = restore();
    const draftDone =
      !keepDraft &&
      (input.action === 'create' || input.action === 'replace') &&
      saved.draft?.trim() === input.objective;
    const next = { draft: draftDone ? null : saved.draft, pending: null };
    try {
      if (saved.pending?.key === input.key) save(next);
    } catch {
      /* The answer below still shows the result. */
    }
    if (!mounted.current) return;
    setPending((current) => (current?.key === input.key ? null : current));
    if (draftDone) setDraft(null);
  }
  async function deliver(input: ManagedGoalAction) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    // Ordered by launch: an answer that arrives after a newer reading cannot replace it.
    const seq = ++order.current;
    try {
      const value = managedGoalViewSchema.parse(await api(path, input));
      // An answer about another conversation confirms nothing here.
      if (value.goal && value.goal.agentId !== agentId) throw new Error('Wrong conversation.');
      settle(input, false);
      if (!accept(seq, value) && mounted.current) void read();
    } catch (error) {
      // A definite, unapplied answer closes the receipt; anything else keeps it for Retry.
      const code = error instanceof ApiError ? error.code : undefined;
      if (!rejected(error)) return;
      settle(input, true);
      if (!mounted.current) return;
      setAttention(true);
      setMessage(
        code === 'GOAL_REVISION'
          ? 'The goal changed before this was saved, so nothing was changed. The latest goal is shown below and your text is kept; review it and save again.'
          : code === 'GOAL_INSPECT_RESUME'
            ? inspectFirst
            : `${(error as Error).message} Nothing was changed; your text is kept.`,
      );
      void read();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function start(kind: ManagedGoalAction['action']) {
    if (busyRef.current || pending || missing || !view?.supported) return;
    const goal = view.goal;
    const key = crypto.randomUUID();
    const objective = (draft ?? '').trim();
    const parsed = managedGoalActionSchema.safeParse(
      kind === 'create'
        ? { key, action: kind, expectedRevision: null, objective }
        : kind === 'replace'
          ? { key, action: kind, expectedRevision: goal?.revision, objective }
          : { key, action: kind, expectedRevision: goal?.revision },
    );
    if (!parsed.success) return;
    const input = parsed.data;
    try {
      // Never send a change this browser could not record for an explicit retry.
      if (restore().pending) throw new Error('Another change is awaiting confirmation.');
      save({ draft, pending: input });
    } catch {
      setMessage('This browser could not record the change, so nothing was sent.');
      return;
    }
    setPending(input);
    setAttention(false);
    setConfirmStop(false);
    void deliver(input);
  }

  const goal = view?.supported ? view.goal : null;
  const actionable = !!view?.supported && !missing && !busy && !pending;
  const editing = goal ? draft !== null : true;
  const continuation = view?.continuation;
  const long = goal && (goal.objective.length > short || goal.progress.summary.length > short);
  const clip = (text: string) =>
    text.length > short ? `${text.slice(0, short).trimEnd()}…` : text;
  return (
    <>
      {open && (
        <Modal title="Manager goal" close={onClose} className="managed-goal-dialog">
          <form
            className="managed-goal"
            onSubmit={(event) => {
              event.preventDefault();
              start(goal ? 'replace' : 'create');
            }}
          >
            {missing && (
              <p role="status">
                Goals are unavailable for this conversation. Your drafts are kept.
              </p>
            )}
            {!view && !readError && !missing && <p role="status">Reading the goal…</p>}
            {readError && (
              <p className="managed-goal-notice" role="status">
                {readError}
              </p>
            )}
            {(message || pending) && (
              <div ref={notice} className="managed-goal-outcome">
                {message && (
                  <p
                    className={attention ? 'managed-goal-notice' : 'managed-goal-receipt'}
                    role="status"
                  >
                    {message}
                  </p>
                )}
                {pending && (
                  <div className="managed-goal-pending">
                    <p>
                      {busy
                        ? `${actionLabel[pending.action]}…`
                        : `Not confirmed.${'objective' in pending ? ' Your text is saved.' : ''} Retry safely checks the same change.`}
                    </p>
                    {!busy && (
                      <button
                        type="button"
                        className="chat-small-button primary"
                        onClick={() => void deliver(pending)}
                      >
                        Retry same change
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {view && !view.supported && (
              <p className="managed-goal-note">
                {view.message || 'Goals are not available for this conversation.'}
              </p>
            )}
            {view?.supported && !goal && !pending && <p className="managed-goal-note">{noGoal}</p>}
            {goal && (
              <section className="managed-goal-current" aria-label="Current goal">
                <p className={`managed-goal-state ${goal.status}`}>
                  <strong>{statusLabel[goal.status]}</strong>{' '}
                  {view?.message || statusHelp[goal.status]}
                </p>
                <h3>Objective</h3>
                <p className="managed-goal-text">{clip(goal.objective)}</p>
                {goal.progress.summary && (
                  <>
                    <h3>Progress</h3>
                    <p className="managed-goal-text">{clip(goal.progress.summary)}</p>
                  </>
                )}
                {goal.progress.nextAction && (
                  <p>
                    <strong>Next:</strong> {goal.progress.nextAction}
                  </p>
                )}
                {long && (
                  <details className="managed-goal-details">
                    <summary>Full objective and progress</summary>
                    <h3>Objective</h3>
                    <p className="managed-goal-text">{goal.objective}</p>
                    <h3>Progress</h3>
                    <p className="managed-goal-text">{goal.progress.summary || 'None yet.'}</p>
                  </details>
                )}
                {continuation && !ended(goal.status) && (
                  <p className="managed-goal-queue" role="status">
                    <strong>
                      {continuation.status === 'queued' ? 'Next goal turn' : 'Goal turn'}:{' '}
                      {turnLabel[continuation.status] ?? continuation.status}
                    </strong>
                    {continuation.reason && <> · {continuation.reason}</>}
                  </p>
                )}
                {!editing && (
                  <div className="managed-goal-actions">
                    {(goal.status === 'active' ||
                      goal.status === 'waiting' ||
                      goal.status === 'blocked') && (
                      <button
                        type="button"
                        className="chat-small-button"
                        disabled={!actionable}
                        onClick={() => start('pause')}
                      >
                        Pause goal
                      </button>
                    )}
                    {(goal.status === 'paused' ||
                      goal.status === 'waiting' ||
                      goal.status === 'blocked') && (
                      <button
                        type="button"
                        className="chat-small-button primary"
                        disabled={!actionable}
                        onClick={() => start('resume')}
                      >
                        Resume goal
                      </button>
                    )}
                    <button
                      type="button"
                      className="chat-small-button"
                      disabled={!actionable}
                      onClick={() => edit(ended(goal.status) ? '' : goal.objective)}
                    >
                      {ended(goal.status) ? 'New objective' : 'Change objective'}
                    </button>
                    {!ended(goal.status) && !confirmStop && (
                      <button
                        type="button"
                        className="chat-small-button"
                        disabled={!actionable}
                        onClick={() => setConfirmStop(true)}
                      >
                        Stop goal
                      </button>
                    )}
                  </div>
                )}
                {confirmStop && !editing && (
                  <div className="managed-goal-confirm" role="group" aria-label="Stop goal">
                    <p>
                      Stop cancels queued goal work. It does not mark the goal complete. A reply
                      already running continues; end it with Stop reply in the chat.
                    </p>
                    <button
                      type="button"
                      className="chat-small-button primary"
                      disabled={!actionable}
                      onClick={() => start('stop')}
                    >
                      Stop goal
                    </button>
                    <button
                      type="button"
                      className="chat-small-button"
                      onClick={() => setConfirmStop(false)}
                    >
                      Keep goal
                    </button>
                  </div>
                )}
              </section>
            )}
            {view?.supported && editing && (
              <div className="managed-goal-edit">
                <label htmlFor={objectiveId}>
                  {pending
                    ? 'Objective awaiting confirmation'
                    : goal
                      ? ended(goal.status)
                        ? 'New objective'
                        : 'Replacement objective'
                      : 'What should this manager accomplish?'}
                </label>
                <textarea
                  id={objectiveId}
                  value={draft ?? ''}
                  rows={4}
                  maxLength={24000}
                  readOnly={!!pending}
                  aria-describedby={`${objectiveId}-help`}
                  onChange={(event) => edit(event.target.value)}
                />
                <p id={`${objectiveId}-help`} className="managed-goal-note" hidden={!!pending}>
                  {goal
                    ? 'The saved objective stays in place until you save this one.'
                    : 'Nothing starts until you press Start goal. The manager keeps its model and permissions.'}
                </p>
                {!pending && (
                  <div className="managed-goal-actions">
                    <button
                      type="submit"
                      className="chat-small-button primary"
                      disabled={!actionable || !(draft ?? '').trim()}
                    >
                      {goal ? 'Save objective' : 'Start goal'}
                    </button>
                    {goal && (
                      <button type="button" className="chat-small-button" onClick={cancelEdit}>
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="chat-small-button managed-goal-refresh"
              disabled={reading}
              onClick={() => void read()}
            >
              {reading ? 'Refreshing…' : 'Refresh'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
