import { useEffect, useId, useRef, useState } from 'react';
import { Target } from 'lucide-react';
import {
  mirrorResultSchema,
  nativeGoalActionSchema,
  nativeGoalViewSchema,
  type NativeGoal,
  type NativeGoalAction,
  type NativeGoalView,
} from '@dock/shared';
import { api, apiScope } from './api';
import { Modal } from './Modal';
import './NativeGoalCard.css';

type Result = ReturnType<typeof mirrorResultSchema.parse>;
type Saved = { objective: string; pending: NativeGoalAction | null };

const statusLabel: Record<NativeGoal['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limit',
  budgetLimited: 'Budget reached',
  complete: 'Complete',
};
const statusHelp: Record<NativeGoal['status'], string> = {
  active: 'Codex is working toward this goal.',
  paused: 'Paused. Resume to let Codex continue.',
  blocked: 'Codex reported this goal as blocked. Resume after you have helped it.',
  usageLimited: 'Stopped by a usage limit. Resume when usage is available again.',
  budgetLimited:
    'Codex reached this goal’s token budget. It cannot be resumed here, and its budget is not changed from this app.',
  complete: 'Codex marked this goal complete. It cannot be resumed.',
};
const resumable: NativeGoal['status'][] = ['paused', 'blocked', 'usageLimited'];

function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

/**
 * A native Codex goal for one conversation. Only the native goal view is shown:
 * the app keeps no shadow goal and never estimates how complete the objective is.
 * A started action is recorded before it is sent; an unconfirmed one is only inspected.
 */
export function NativeGoalCard({
  goalPath,
  deliveryPath = (key) => `/vscode/deliveries/${key}`,
  threadId,
  provider,
  online,
  place,
}: {
  /** GET returns the native view; POST sends one recorded action. */
  goalPath: string;
  deliveryPath?: (key: string) => string;
  threadId: string;
  provider: 'codex' | 'claude';
  online: boolean;
  /** Where the person can inspect the native conversation, e.g. "in VS Code". */
  place: string;
}) {
  const storageKey = `dock:native-goal:${apiScope()}:${provider}:${threadId}`;
  const objectiveKey = `${storageKey}:objective`;
  const supported = provider === 'codex';
  const restore = (): Saved => {
    let recovery = '';
    try {
      const value: unknown = JSON.parse(localStorage.getItem(objectiveKey) ?? 'null');
      if (typeof value === 'string') recovery = value;
    } catch {
      /* A denied recovery store does not replace the current tab's objective. */
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
      const pending = nativeGoalActionSchema.safeParse(saved.pending);
      return {
        objective: typeof saved.objective === 'string' ? saved.objective : recovery,
        pending:
          pending.success &&
          pending.data.threadId === threadId &&
          (pending.data.provider ?? 'codex') === provider
            ? pending.data
            : null,
      };
    } catch {
      return { objective: recovery, pending: null };
    }
  };
  const [initial] = useState(restore);
  const [objective, setObjective] = useState(initial.objective);
  const [pending, setPending] = useState(initial.pending);
  const [view, setView] = useState<NativeGoalView | null>(null);
  // Actions need a native reading taken after the last acknowledgement or reconnect.
  const [fresh, setFresh] = useState(false);
  const [readError, setReadError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const objectiveId = useId();
  const pendingRef = useRef(initial.pending);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const path = useRef(goalPath);
  // Reads apply in start order; reads started before an acknowledgement are stale.
  const reads = useRef(0);
  const applied = useRef(0);
  const fence = useRef(0);

  const write = (value: Saved) => sessionStorage.setItem(storageKey, JSON.stringify(value));
  async function read() {
    const seq = ++reads.current;
    const target = path.current;
    const current = () =>
      mounted.current && target === path.current && seq > applied.current && seq > fence.current;
    try {
      const value = nativeGoalViewSchema.parse(await api(target));
      if (!current()) return;
      applied.current = seq;
      if (
        (value.threadId !== null && value.threadId !== threadId) ||
        (value.goal && value.goal.threadId !== threadId)
      ) {
        setView(null);
        setFresh(false);
        setReadError(
          'This connection now reports a different conversation. No goal is shown or changed.',
        );
        return;
      }
      setView(value);
      setFresh(true);
      setReadError('');
    } catch {
      if (current()) setReadError('Could not read the native goal. Retrying automatically.');
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    // A reconnect can change the window, never the thread or provider.
    path.current = goalPath;
    fence.current = reads.current;
    setFresh(false);
    if (!supported || !online) return;
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) await read();
      if (!ended) timer = setTimeout(tick, 5000);
    };
    const visible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', visible);
    void tick();
    return () => {
      ended = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [goalPath, supported, online]);

  function edit(value: string) {
    if (pendingRef.current) return;
    setObjective(value);
    try {
      write({ objective: value, pending: null });
    } catch {
      setMessage('This browser cannot save the objective. Keep this page open.');
    }
    try {
      localStorage.setItem(objectiveKey, JSON.stringify(value));
    } catch {
      setMessage('This browser cannot keep an objective recovery copy. Keep this page open.');
    }
  }
  /** Close only this receipt, then require a new native reading before another action. */
  function close(input: NativeGoalAction, result: Result) {
    const created = result.state === 'sent' && input.action === 'create';
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
      if (saved.pending?.key === input.key)
        write({
          objective: created ? '' : typeof saved.objective === 'string' ? saved.objective : '',
          pending: null,
        });
    } catch {
      /* The live view below still retains the result. */
    }
    if (created) {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(objectiveKey) ?? 'null');
        // Do not clear a newer objective written in another tab.
        if (typeof value === 'string' && value.trim() === input.objective)
          localStorage.setItem(objectiveKey, JSON.stringify(''));
      } catch {
        /* The per-tab receipt still records the definitive result. */
      }
    }
    if (!mounted.current || pendingRef.current?.key !== input.key) return;
    pendingRef.current = null;
    setPending(null);
    if (created) setObjective('');
    fence.current = reads.current;
    setFresh(false);
    void read();
  }
  async function deliver(input: NativeGoalAction, inspect: boolean) {
    busyRef.current = true;
    setBusy(true);
    try {
      // An unconfirmed action is only inspected; it is never posted again.
      const result = mirrorResultSchema.parse(
        inspect ? await api(deliveryPath(input.key)) : await api(path.current, input),
      );
      if (result.state !== 'uncertain') close(input, result);
      if (mounted.current)
        setMessage(
          result.state === 'uncertain'
            ? `${result.message} Check its status again or inspect the conversation ${place}; nothing is repeated automatically.`
            : result.message,
        );
    } catch {
      if (mounted.current)
        setMessage(
          `The goal change was not confirmed. Check its status or inspect the conversation ${place}; nothing is repeated automatically.`,
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function start(kind: NativeGoalAction['action']) {
    if (busyRef.current || pendingRef.current || !fresh || !online || !view) return;
    if (kind === 'create' && view.goal) return;
    const base = { key: crypto.randomUUID(), threadId, provider };
    const parsed = nativeGoalActionSchema.safeParse(
      kind === 'create'
        ? { ...base, action: 'create', objective, expectedToken: null }
        : { ...base, action: kind, expectedToken: view.token },
    );
    if (!parsed.success) return;
    const input = parsed.data;
    try {
      // Never send an action this browser could not record for a later status check.
      const saved = restore();
      if (saved.pending) throw new Error('Another goal change is awaiting confirmation.');
      write({ objective, pending: input });
    } catch {
      setMessage('This browser could not record the goal change, so nothing was sent.');
      return;
    }
    pendingRef.current = input;
    setPending(input);
    setMessage('');
    void deliver(input, false);
  }
  const goal = view?.supported ? view.goal : null;
  const actionable = !!view && fresh && online && !busy && !pending;
  const showCreate = supported && view?.supported && (!goal || pending?.action === 'create');
  const chip = pending ? 'Unconfirmed' : goal ? statusLabel[goal.status] : null;
  return (
    <>
      <button
        type="button"
        className="secondary native-goal-entry"
        aria-haspopup="dialog"
        aria-label={chip ? `Goal: ${chip}` : 'Goal'}
        onClick={() => setOpen(true)}
      >
        <Target size={16} aria-hidden="true" />
        <span>Goal</span>
        {chip && (
          <span className={`native-goal-chip ${pending ? 'pending' : goal!.status}`}>{chip}</span>
        )}
      </button>
      {open && (
        <Modal
          title="Conversation goal"
          close={() => setOpen(false)}
          className="native-goal-dialog"
        >
          <form
            className="native-goal"
            onSubmit={(event) => {
              event.preventDefault();
              start('create');
            }}
          >
            {!supported ? (
              <p>
                Claude Code does not offer native goals in shared conversations. This app does not
                track or estimate one for it.
              </p>
            ) : !view ? (
              <p role="status">{readError || 'Reading the goal from Codex…'}</p>
            ) : (
              <>
                {readError && (
                  <p className="native-goal-notice" role="status">
                    {readError}
                  </p>
                )}
                {!view.supported && <p>{view.message || 'Native goals are unavailable here.'}</p>}
                {goal && (
                  <section className="native-goal-current" aria-label="Current goal">
                    <p className={`native-goal-state ${goal.status}`}>
                      <strong>{statusLabel[goal.status]}</strong> {statusHelp[goal.status]}
                    </p>
                    <h3>Objective</h3>
                    <p className="native-goal-objective">{goal.objective}</p>
                    <dl className="native-goal-measures">
                      <div>
                        <dt>Tokens used</dt>
                        <dd>{goal.tokensUsed.toLocaleString()}</dd>
                      </div>
                      <div>
                        <dt>Time used</dt>
                        <dd>{duration(goal.timeUsedSeconds)}</dd>
                      </div>
                      {goal.tokenBudget !== null && (
                        <div>
                          <dt>Native token budget</dt>
                          <dd>{goal.tokenBudget.toLocaleString()}</dd>
                        </div>
                      )}
                    </dl>
                    {goal.status === 'active' && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!actionable || !view.token}
                        onClick={() => start('pause')}
                      >
                        Pause goal
                      </button>
                    )}
                    {resumable.includes(goal.status) && (
                      <button
                        type="button"
                        className="primary"
                        disabled={!actionable || !view.token}
                        onClick={() => start('resume')}
                      >
                        Resume goal
                      </button>
                    )}
                    {goal.status !== 'active' && (
                      <div className="native-goal-clear">
                        <button
                          type="button"
                          className="secondary"
                          disabled={!actionable || !view.token}
                          onClick={() => {
                            if (
                              window.confirm(
                                'Clear this native goal? The conversation stays. You can then set a new goal.',
                              )
                            )
                              start('clear');
                          }}
                        >
                          Clear goal
                        </button>
                        <p className="native-goal-note">
                          Clears the native goal so you can set a new one. The conversation stays.
                        </p>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
            {showCreate && (
              <div className="native-goal-create">
                <label htmlFor={objectiveId}>
                  {goal ? 'Objective awaiting confirmation' : 'What should Codex accomplish?'}
                </label>
                <textarea
                  id={objectiveId}
                  value={objective}
                  rows={5}
                  maxLength={32000}
                  readOnly={!!pending}
                  aria-describedby={`${objectiveId}-help`}
                  onChange={(event) => edit(event.target.value)}
                />
                <p id={`${objectiveId}-help`} className="native-goal-note">
                  Codex keeps the goal and measures its own tokens and time. Its model, permissions
                  and any budget stay as set in Codex.
                </p>
                {!pending && (
                  <button
                    type="submit"
                    className="primary"
                    disabled={!actionable || !!goal || !objective.trim()}
                  >
                    Set goal
                  </button>
                )}
              </div>
            )}
            {message && (
              <p className="native-goal-receipt" role="status">
                {message}
              </p>
            )}
            {pending && (
              <div className="native-goal-pending">
                <p>
                  {pending.action === 'create'
                    ? 'Setting this goal was not confirmed yet.'
                    : `${pending.action === 'pause' ? 'Pausing' : pending.action === 'clear' ? 'Clearing' : 'Resuming'} was not confirmed yet.`}{' '}
                  Checking status never sends it again.
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void deliver(pending, true)}
                >
                  {busy ? 'Checking…' : 'Check status'}
                </button>
              </div>
            )}
            {supported && online && (
              <button
                type="button"
                className="secondary native-goal-refresh"
                onClick={() => void read()}
              >
                Refresh from Codex
              </button>
            )}
            {supported && !online && (
              <p className="native-goal-note">Reconnect this conversation to change its goal.</p>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}
