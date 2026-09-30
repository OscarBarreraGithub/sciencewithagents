import { useEffect, useRef, useState } from 'react';
import { schedulerStatusSchema, type SchedulerStatus } from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';
import { PulsarPanel } from './PulsarPanel';

export function SchedulerPanel({
  close,
  open,
  openLocalJobs,
  embedded = false,
  openJob,
}: {
  embedded?: boolean;
  openJob?: (runId: string) => void;
  close: () => void;
  open: (agentId: string) => void;
  openLocalJobs: () => void;
}) {
  const [state, setState] = useState<SchedulerStatus | null>(null);
  const [limit, setLimit] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const pending = useRef<{
    key: string;
    settings: { paused: boolean; maxConcurrent: number };
  } | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const readingRevision = revision.current;
      try {
        const value = schedulerStatusSchema.parse(await api('/scheduler'));
        if (active && readingRevision === revision.current && !pending.current) {
          setState(value);
          setError((prior) => (prior === 'Could not read the work queue.' ? '' : prior));
        }
      } catch (e) {
        if (active && readingRevision === revision.current && !pending.current)
          setError('Could not read the work queue.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (state) setLimit(state.settings.maxConcurrent);
  }, [state?.settings.maxConcurrent]);
  const save = async (settings: { paused: boolean; maxConcurrent: number }) => {
    if (busy) return;
    revision.current++;
    setBusy(true);
    setError('');
    if (!pending.current || JSON.stringify(pending.current.settings) !== JSON.stringify(settings))
      pending.current = { key: crypto.randomUUID(), settings };
    try {
      setState(schedulerStatusSchema.parse(await api('/scheduler/settings', pending.current)));
      pending.current = null;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not update the queue. Check its current status before retrying.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Work queue" close={close} embedded={embedded}>
      <p>
        Control new queued work across all projects. Running work keeps going, and its original
        permission requests stay in place.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {pending.current && !busy && (
        <button className="secondary" onClick={() => void save(pending.current!.settings)}>
          Retry queue change
        </button>
      )}
      {!state ? (
        <p role="status">Reading the queue…</p>
      ) : (
        <>
          <p role="status">
            {state.settings.paused
              ? 'New queued work is paused.'
              : 'New queued work can start when a slot is available.'}
          </p>
          <button
            className="secondary"
            disabled={busy || pending.current !== null}
            onClick={() => void save({ ...state.settings, paused: !state.settings.paused })}
          >
            {state.settings.paused ? 'Resume queued work' : 'Pause new work'}
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save({ ...state.settings, maxConcurrent: limit });
            }}
          >
            <label>
              Concurrent work groups
              <select
                value={limit}
                disabled={busy || pending.current !== null}
                onChange={(event) => setLimit(Number(event.target.value))}
              >
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary"
              disabled={busy || pending.current !== null || limit === state.settings.maxConcurrent}
            >
              Save work limit
            </button>
          </form>
          <p className="muted">
            Lowering the limit lets current work finish. Native terminal turns use these same slots;
            helpers share their parent’s group. Local compute jobs use these same slots. This is not
            a spending limit or a machine-wide model quota.
          </p>
          {!embedded &&
            (state.items.length === 0 ? (
              <p>No queued or running agent turns.</p>
            ) : (
              <ul className="attention-list">
                {state.items.map((item) => (
                  <li key={item.id}>
                    <small>
                      {item.projectName} · {item.status === 'running' ? 'In progress' : 'Queued'}
                    </small>
                    <h3>{item.agentName}</h3>
                    <p>{item.explanation}</p>
                    <button className="secondary" onClick={() => open(item.agentId)}>
                      Open conversation
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
      <PulsarPanel open={open} openJob={openJob} />
      <button className="secondary" onClick={openLocalJobs}>
        Open local compute jobs
      </button>
    </Modal>
  );
}
