import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import {
  quarkFocusSchema,
  quarkFocusStatusSchema,
  type Project,
  type QuarkFocusRecord,
  type Snapshot,
} from '@dock/shared';
import { api, ApiError, apiScope } from '../api';
import './project-focus.css';

type Pending =
  | { kind: 'start'; key: string; projectId: string; projectName: string; at: string }
  | { kind: 'release'; key: string; focusId: string; projectName: string; at: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One focus exists per computer, so the unanswered request is shared by every chat on it.
const storageKey = () => `dock:quark-focus-pending:${apiScope()}`;
function readPending(): Pending | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) ?? 'null') as Record<
      string,
      unknown
    > | null;
    if (!value || typeof value.key !== 'string' || !uuid.test(value.key)) return null;
    const common = {
      key: value.key,
      projectName: typeof value.projectName === 'string' ? value.projectName.slice(0, 200) : '',
      at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
    };
    if (value.kind === 'start' && typeof value.projectId === 'string' && uuid.test(value.projectId))
      return { kind: 'start', projectId: value.projectId, ...common };
    if (value.kind === 'release' && typeof value.focusId === 'string' && uuid.test(value.focusId))
      return { kind: 'release', focusId: value.focusId, ...common };
  } catch {
    /* An unreadable entry is not a request; the server status stays authoritative. */
  }
  return null;
}
function writePending(value: Pending | null) {
  try {
    if (value) localStorage.setItem(storageKey(), JSON.stringify(value));
    else localStorage.removeItem(storageKey());
  } catch {
    /* Storage can be refused; the request identity stays in this page. */
  }
}
const when = (value: string) =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Names({ names }: { names: string[] }) {
  if (!names.length) return null;
  const shown = names.slice(0, 6);
  return (
    <p className="focus-names">
      {shown.join(', ')}
      {names.length > shown.length ? ` and ${names.length - shown.length} more` : ''}
    </p>
  );
}

/** Pause other real projects for one project, and return to normal, through QUARK's saved policy. */
export function ProjectFocus({ project, state }: { project: Project; state: Snapshot }) {
  const [status, setStatus] = useState<QuarkFocusRecord | null | undefined>(undefined);
  const [readError, setReadError] = useState('');
  const [pending, setPendingState] = useState<Pending | null>(readPending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; uncertain: boolean } | null>(null);
  const [released, setReleased] = useState<QuarkFocusRecord | null>(null);
  const alive = useRef(true);
  const read = async () => {
    try {
      const value = quarkFocusStatusSchema.parse(await api('/quark/focus'));
      if (!alive.current) return;
      setStatus(value.active);
      setReadError('');
    } catch (reason) {
      if (!alive.current) return;
      setReadError(
        reason instanceof ApiError && reason.status === 404
          ? 'Focus controls are not available from this computer yet.'
          : 'Could not read QUARK’s focus. Try again.',
      );
    }
  };
  useEffect(() => {
    alive.current = true;
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 15_000);
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey()) setPendingState(readPending());
    };
    window.addEventListener('storage', sync);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const setPending = (value: Pending | null) => {
    writePending(value);
    setPendingState(value);
  };
  // The request is saved before it is sent. Only an explicit check resends that same key.
  const send = async (request: Pending) => {
    setPending(request);
    setBusy(true);
    setError(null);
    try {
      const record = quarkFocusSchema.parse(
        await api(
          request.kind === 'start' ? '/quark/focus' : '/quark/focus/release',
          request.kind === 'start'
            ? { key: request.key, projectId: request.projectId }
            : { key: request.key, focusId: request.focusId },
        ),
      );
      if (!alive.current) return;
      setPending(null);
      setReleased(record.releasedAt ? record : null);
    } catch (reason) {
      if (!alive.current) return;
      // The host rolls back a rejected request, so nothing is left to check.
      const rejected = reason instanceof ApiError && reason.status >= 400 && reason.status < 500;
      if (rejected) setPending(null);
      setError({
        uncertain: !rejected,
        message:
          reason instanceof ApiError ? reason.message : 'The answer was lost or could not be read.',
      });
    } finally {
      if (alive.current) setBusy(false);
      await read();
    }
  };
  const start = () =>
    void send({
      kind: 'start',
      key: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      at: new Date().toISOString(),
    });
  const release = (focus: QuarkFocusRecord) =>
    void send({
      kind: 'release',
      key: crypto.randomUUID(),
      focusId: focus.id,
      projectName: focus.projectName,
      at: new Date().toISOString(),
    });
  const active = status ?? null;
  const mine = active?.projectId === project.id;
  const pausedHere = active?.projects.filter((p) => p.pausedRevision !== null) ?? [];
  const alreadyPaused = active?.projects.filter((p) => p.pausedRevision === null) ?? [];
  const focusManager = active && state.projects.find((p) => p.id === active.projectId)?.managerId;
  const note = (
    <p className="focus-note">
      Their chats, files and finished work stay saved; running turns stop and wait. Projects that
      were already paused stay paused. Allowance caps, budgets and other holds still apply to this
      project too.
    </p>
  );
  return (
    <div className={`focus-card${mine ? ' is-mine' : active ? ' is-other' : ''}`}>
      <h4>Focus this project</h4>
      {pending ? (
        <div className="focus-pending" role="status">
          <p>
            <strong>
              {pending.kind === 'start'
                ? `Your request to pause other projects for “${pending.projectName}”`
                : `Your request to return to normal from “${pending.projectName}”`}
            </strong>{' '}
            was sent {when(pending.at)}, but no answer arrived. Checking sends the exact same
            request, so it cannot pause or release anything twice.
          </p>
          <div className="focus-actions">
            <button
              type="button"
              className="chat-small-button primary"
              disabled={busy}
              onClick={() => void send(pending)}
            >
              {busy ? 'Checking…' : 'Check this request'}
            </button>
            <button
              type="button"
              className="chat-small-button"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              Forget it
            </button>
          </div>
        </div>
      ) : status === undefined ? (
        readError ? (
          <div className="focus-actions">
            <p className="chat-panel-error">{readError}</p>
            <button type="button" className="chat-small-button" onClick={() => void read()}>
              Try again
            </button>
          </div>
        ) : (
          <p className="focus-muted">Checking QUARK…</p>
        )
      ) : active && mine ? (
        <>
          <p className="focus-state" role="status">
            <strong>Other projects are paused for this project</strong>
            <span>
              Since {when(active.startedAt)} · this focus paused{' '}
              {plural(pausedHere.length, 'project')}
              {alreadyPaused.length
                ? ` · ${plural(alreadyPaused.length, 'project')} already paused, left as ${alreadyPaused.length === 1 ? 'it was' : 'they were'}`
                : ''}
            </span>
          </p>
          <Names names={pausedHere.map((p) => p.name)} />
          <div className="focus-actions">
            <button
              type="button"
              className="chat-small-button primary"
              disabled={busy}
              onClick={() => release(active)}
            >
              {busy ? 'Returning to normal…' : 'Return to normal'}
            </button>
          </div>
          <p className="focus-note">
            Returning resumes only the pauses this focus made, and only for projects nobody has
            changed since. Budgets, caps and other holds stay as they are.
          </p>
        </>
      ) : active ? (
        <>
          <p className="focus-state" role="status">
            <strong>QUARK is focused on “{active.projectName}”</strong>
            <span>
              Since {when(active.startedAt)} · {plural(pausedHere.length, 'project')} paused for it,
              possibly including this one. Return to normal before focusing here.
            </span>
          </p>
          <div className="focus-actions">
            {focusManager && (
              <a className="chat-small-button" href={`#/chat/${focusManager}`}>
                Open that project <ArrowUpRight size={15} />
              </a>
            )}
            <button
              type="button"
              className="chat-small-button"
              disabled={busy}
              onClick={() => release(active)}
            >
              {busy ? 'Returning to normal…' : 'Return to normal'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="focus-muted">
            Pause every other project so this one gets QUARK’s capacity, then return to normal when
            you are done.
          </p>
          <div className="focus-actions">
            <button type="button" className="chat-small-button" disabled={busy} onClick={start}>
              {busy ? 'Pausing other projects…' : 'Pause other projects'}
            </button>
          </div>
          {note}
        </>
      )}
      {released && !active && !pending && (
        <p className="focus-result" role="status">
          Back to normal since {when(released.releasedAt!)} ·{' '}
          {plural(released.projects.filter((p) => p.restored).length, 'project')} resumed
          {(() => {
            const kept = released.projects.filter((p) => p.pausedRevision !== null && !p.restored);
            return kept.length
              ? ` · ${plural(kept.length, 'project')} kept a later change and ${kept.length === 1 ? 'was' : 'were'} left as set`
              : '';
          })()}
          .
        </p>
      )}
      {error && (
        <p className="chat-panel-error" role="alert">
          {error.message}
          {error.uncertain
            ? ' The request is saved on this device; check it before trying anything else.'
            : ' Nothing was changed.'}
        </p>
      )}
    </div>
  );
}
