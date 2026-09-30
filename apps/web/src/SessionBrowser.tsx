import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { agentSchema, sessionListSchema, type Agent, type SavedSession } from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';

export function SessionBrowser({
  projectId,
  managers,
  initialManagerId,
  close,
  onOpen,
}: {
  projectId: string;
  managers: Agent[];
  initialManagerId: string;
  close: () => void;
  onOpen: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<SavedSession | null>(null);
  const [managerId, setManagerId] = useState(initialManagerId);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const receipt = useRef({ key: crypto.randomUUID(), input: '' });
  const load = async (after?: string) => {
    setBusy(true);
    setError('');
    try {
      const page = sessionListSchema.parse(
        await api(
          `/projects/${projectId}/sessions${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
        ),
      );
      setSessions((old) =>
        [...(after ? old : []), ...page.data].filter(
          (t, i, all) => all.findIndex((a) => a.id === t.id) === i,
        ),
      );
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read saved sessions.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [projectId]);
  const importSession = async () => {
    if (!selected || !confirmed || busy) return;
    setBusy(true);
    setError('');
    const input = JSON.stringify({ threadId: selected.id, managerId });
    if (receipt.current.input !== input) receipt.current = { key: crypto.randomUUID(), input };
    try {
      const agent = agentSchema.parse(
        await api(`/projects/${projectId}/sessions/import`, {
          key: receipt.current.key,
          threadId: selected.id,
          managerId,
          confirmedStopped: confirmed,
        }),
      );
      onOpen(agent.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import this session.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Existing Codex sessions" close={close}>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {selected ? (
        <>
          <button
            className="secondary"
            onClick={() => {
              setSelected(null);
              setConfirmed(false);
            }}
            disabled={busy}
          >
            <ArrowLeft size={15} /> Back to sessions
          </button>
          <h3>{selected.title}</h3>
          <p>
            Bring this conversation into sciencewithagents without starting work. It will begin with
            permission to read files, not change them.
          </p>
          <label>
            Responsible manager
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="session-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I have stopped this conversation in its original Codex window.
          </label>
          <p className="muted">
            Don’t run this conversation in two places at once. sciencewithagents cannot check
            whether you’ve stopped it in another window.
          </p>
          <details>
            <summary>What happens to existing subagents?</summary>
            <p>
              The saved conversation is imported, but links between its previous subagents are not
              rebuilt. Delegate new work here to see it in Your team.
            </p>
          </details>
          <button
            className="primary"
            disabled={busy || !confirmed}
            onClick={() => void importSession()}
          >
            {busy ? 'Reading history…' : 'Import history'}
          </button>
        </>
      ) : (
        <>
          <p>
            Find Codex conversations previously saved for this project. Looking through them does
            not start any work or take over another window.
          </p>
          <details>
            <summary>Which conversations appear here?</summary>
            <p>
              Sessions must have been started from this project’s main folder. Terminal, editor and
              App Server sessions are included when Codex makes their history available.
            </p>
          </details>
          <button className="secondary" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={15} /> {busy ? 'Reading sessions…' : 'Refresh sessions'}
          </button>
          {!busy && !error && !sessions.length && (
            <p>
              No saved conversations found for this project yet. You can start a new one with your
              manager.
            </p>
          )}
          <div className="saved-sessions">
            {sessions.map((session) => (
              <button
                key={session.id}
                className="saved-session"
                onClick={() => {
                  if (session.agentId) onOpen(session.agentId);
                  else {
                    setSelected(session);
                    setConfirmed(false);
                    setError('');
                  }
                }}
              >
                <span>
                  <strong>{session.title}</strong>
                  <small>
                    {session.agentId ? 'Already in sciencewithagents' : 'Import saved history'} ·{' '}
                    {new Date(session.updatedAt * 1000).toLocaleDateString()}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          {cursor && (
            <button className="secondary" disabled={busy} onClick={() => void load(cursor)}>
              Load older sessions
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
