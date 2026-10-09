import { useEffect, useRef, useState } from 'react';
import {
  groupHostLocalModeSchema,
  groupHostSummarySchema,
  type GroupHostSummary,
} from '@dock/shared/dist/group-host.js';
import { api, apiScope, ApiError, connectionLost } from '../api';
import { Modal } from '../Modal';
import { DisplayName } from './DisplayName';

type Operation = ReturnType<typeof groupHostLocalModeSchema.parse>;
/** This selector reflects server admission, never just an unsaved browser preference. */
export function GroupContributionMode({
  group,
  refresh,
}: {
  group: GroupHostSummary;
  refresh: () => Promise<unknown>;
}) {
  const storage = `swa:${apiScope()}:group-local-mode:${group.handle}`;
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Operation | null>(null);
  const generation = useRef(0),
    inFlight = useRef(false);
  const mode = group.local?.mode ?? 'contribute';
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setOpen(false);
    setBusy(false);
    setError('');
    setNotice('');
    let saved: Operation | null = null;
    try {
      const raw = sessionStorage.getItem(storage);
      const parsed =
        raw && raw.length <= 4096 ? groupHostLocalModeSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success && parsed.data.handle === group.handle) saved = parsed.data;
    } catch {
      /* Untrusted browser metadata cannot select another group. */
    }
    setPending(saved);
    return () => {
      generation.current++;
    };
  }, [storage, group.handle]);
  const change = async (desired: Operation['mode']) => {
    if (inFlight.current) return;
    const operation = pending ?? {
      handle: group.handle,
      key: crypto.randomUUID(),
      revision: group.local?.modeRevision ?? 0,
      mode: desired,
    };
    const version = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      try {
        sessionStorage.setItem(storage, JSON.stringify(operation));
      } catch {
        throw new Error('This browser could not retain the retry key. No mode change was sent.');
      }
      setPending(operation);
      const receipt = groupHostSummarySchema.parse(await api('/groups/local-mode', operation));
      if (version !== generation.current) return;
      if (receipt.handle !== operation.handle || receipt.id !== group.id)
        throw new Error('The receipt did not match this group. Its exact retry is retained.');
      if (sessionStorage.getItem(storage) === JSON.stringify(operation))
        sessionStorage.removeItem(storage);
      setPending(null);
      setNotice('Saved mode change acknowledged. Reading the current mode…');
      await refresh();
      if (version === generation.current) setOpen(false);
    } catch (reason) {
      if (version !== generation.current) return;
      if (
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        !connectionLost(reason)
      ) {
        if (sessionStorage.getItem(storage) === JSON.stringify(operation))
          sessionStorage.removeItem(storage);
        setPending(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : 'The reply is uncertain. Retry only the exact saved mode change.',
      );
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const check = async () => {
    if (inFlight.current) return;
    const version = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await refresh();
      if (version === generation.current)
        setNotice('Current mode refreshed. Checking does not repeat or clear a saved change.');
    } catch (reason) {
      if (version === generation.current)
        setError(reason instanceof Error ? reason.message : 'The current mode could not be read.');
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <button
        type="button"
        className="secondary group-mode-button"
        aria-label={`Contribution mode: ${mode === 'read-only' ? 'Read-only' : 'Contribute'}${pending ? ', saved change pending' : ''}`}
        onClick={() => setOpen(true)}
      >
        {mode === 'read-only' ? 'Read-only' : 'Contribute'}
        {pending ? ' · check change' : ''}
      </button>
      {open && (
        <Modal
          title="Contribution mode on this computer"
          close={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p>
            <strong>
              <DisplayName value={group.name} />
            </strong>
          </p>
          <p>
            Current mode: <strong>{mode === 'read-only' ? 'Read-only' : 'Contribute'}</strong>.
          </p>
          <p>
            Read-only keeps messages, reports and Git sync available while preventing new
            contributions and model handoffs on this computer. Your drafts are retained. Already
            running work may finish.
          </p>
          <p>
            Contribute allows new messages and agent requests. Ask, Work and automatic agent
            summaries use your own provider allowance. Switching to Read-only makes no model
            request. Returning to Contribute may release already-authorized queued work using your
            allowance.
          </p>
          {pending && (
            <p>
              The reply to switching to {pending.mode === 'read-only' ? 'Read-only' : 'Contribute'}{' '}
              is uncertain. Retry that exact saved change, or check the current mode without
              repeating it.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="groups-list-actions">
            {pending ? (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void change(pending.mode)}
              >
                Retry saved mode change
              </button>
            ) : (
              <>
                <button
                  className="secondary"
                  type="button"
                  aria-pressed={mode === 'read-only'}
                  disabled={busy || mode === 'read-only'}
                  onClick={() => void change('read-only')}
                >
                  Read-only
                </button>
                <button
                  className="secondary"
                  type="button"
                  aria-pressed={mode === 'contribute'}
                  disabled={busy || mode === 'contribute'}
                  onClick={() => void change('contribute')}
                >
                  Contribute
                </button>
              </>
            )}
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void check()}
            >
              Check current mode
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
