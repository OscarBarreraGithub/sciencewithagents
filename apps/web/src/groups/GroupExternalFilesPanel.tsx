import { useEffect, useRef, useState } from 'react';
import {
  groupExternalFilesRequestSchema,
  groupExternalFilesViewSchema,
  groupExternalFilePreviewSchema,
  type GroupExternalFilePreview,
  type GroupExternalFilesView,
} from '@dock/shared/dist/group-external-files.js';
import { api, apiScope, ApiError, connectionLost } from '../api';
import './group-git-panel.css';
type Input = ReturnType<typeof groupExternalFilesRequestSchema.parse>;
export function GroupExternalFilesPanel({ handle }: { handle: string }) {
  const [view, setView] = useState<GroupExternalFilesView>({ proposals: [], preview: null });
  const [preview, setPreview] = useState<GroupExternalFilePreview | null>(null);
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pending, setPending] = useState<Input | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false),
    [statusError, setStatusError] = useState('');
  const section = useRef<HTMLElement>(null),
    active = useRef(false),
    generation = useRef(0);
  const storage = `swa:${apiScope()}:groups:${handle}:external-file-review`;
  async function control(input: Input) {
    if (active.current) return;
    const current = generation.current;
    active.current = true;
    setBusy(true);
    if (input.action !== 'status') setError('');
    try {
      if (
        input.action === 'approve' &&
        (!preview || preview.id !== input.id || preview.fingerprint !== input.fingerprint)
      )
        throw new Error('The exact saved file display is unavailable. Nothing was approved.');
      if ('key' in input) {
        localStorage.setItem(storage, JSON.stringify({ input, preview }));
        setPending(input);
      }
      const result = groupExternalFilesViewSchema.parse(await api('/groups/files', input));
      if (current !== generation.current) return;
      setView(result);
      setStatusLoaded(true);
      setStatusError('');
      if (input.action === 'preview') {
        setPreview(result.preview);
        setAck(false);
      }
      if ('key' in input) {
        localStorage.removeItem(storage);
        setPending(null);
        setPreview(null);
        setAck(false);
      }
    } catch (reason) {
      if (current !== generation.current) return;
      const message =
        reason instanceof Error ? reason.message : 'File checkpoint status is unavailable.';
      if (input.action === 'status') {
        setStatusLoaded(true);
        setStatusError(message);
      } else setError(message);
      if (
        'key' in input &&
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        !connectionLost(reason)
      ) {
        localStorage.removeItem(storage);
        setPending(null);
        setAck(false);
      }
    } finally {
      if (current === generation.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    // Each setup owns its own request flight, including StrictMode's setup replay.
    generation.current++;
    active.current = false;
    setBusy(false);
    setView({ proposals: [], preview: null });
    setPreview(null);
    setAck(false);
    setPending(null);
    setError('');
    setStatusLoaded(false);
    setStatusError('');
    try {
      const saved = localStorage.getItem(storage);
      if (saved && saved.length <= 4_000_000) {
        const value = JSON.parse(saved),
          input = groupExternalFilesRequestSchema.parse(value.input);
        if (input.handle === handle && 'key' in input) {
          setPending(input);
          const display = groupExternalFilePreviewSchema.safeParse(value.preview);
          if (display.success) setPreview(display.data);
        }
      }
    } catch {
      /* A corrupt browser display cannot authorize an approval. */
    }
    void control({ action: 'status', handle });
    const read = () => {
      if (!document.hidden && section.current?.closest('dialog')?.open && !active.current)
        void control({ action: 'status', handle });
    };
    const timer = window.setInterval(read, 30000);
    window.addEventListener('focus', read);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [handle]);
  return (
    <section
      ref={section}
      className="group-git-panel group-external-files"
      aria-label="Claude file checkpoints"
      hidden={statusLoaded && !view.proposals.length && !pending && !error && !statusError}
    >
      <h3>Files from your Claude</h3>
      <p>
        Claude proposes committed changes from your chosen folder. Review the exact checkpoint here;
        later edits need another review. This uses no model.
      </p>
      {!statusLoaded && <p role="status">Checking Claude file checkpoints…</p>}
      {statusError && (
        <div>
          <p role="alert">{statusError}</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void control({ action: 'status', handle })}
          >
            Retry file checkpoint status
          </button>
        </div>
      )}
      {view.proposals.map((proposal) => (
        <div key={proposal.id}>
          <p>
            <code>{proposal.head.slice(0, 12)}</code> · {proposal.message}
          </p>
          {proposal.state === 'review' && (
            <button
              className="secondary"
              disabled={busy || !!pending}
              onClick={() => void control({ action: 'preview', handle, id: proposal.id })}
            >
              Review Claude’s checkpoint
            </button>
          )}
          {proposal.retryable && (
            <button
              className="secondary"
              disabled={busy || !!pending}
              onClick={() =>
                void control({ action: 'retry', handle, id: proposal.id, key: crypto.randomUUID() })
              }
            >
              Retry this file checkpoint
            </button>
          )}
        </div>
      ))}
      {preview && (
        <section
          className="group-native-review group-external-closure"
          aria-label="Exact Claude file checkpoint"
        >
          <p>Repository: {preview.repository}</p>
          <p>
            Only commit <code>{preview.head}</code> and its new history will be shared. Working
            files and local branches stay in place.
          </p>
          <p>
            Inspect every binary version in native Git history before approving, including files
            deleted by later commits. Ask Claude to show those committed versions locally. The saved
            text below includes every new commit.
          </p>
          <ul className="group-native-review-files">
            {preview.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <pre
            className="group-native-review-patch"
            tabIndex={0}
            aria-label="Complete Claude checkpoint history"
          >
            {preview.patch}
          </pre>
          {!pending && (
            <>
              <label>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
                reviewed this exact history and any binary files. Share this checkpoint with the
                group’s private repository.
              </label>
              <div className="group-git-buttons">
                <button
                  className="secondary"
                  disabled={busy || !ack}
                  onClick={() =>
                    void control({
                      action: 'approve',
                      handle,
                      id: preview.id,
                      key: crypto.randomUUID(),
                      fingerprint: preview.fingerprint,
                    })
                  }
                >
                  Approve this file checkpoint
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void control({
                      action: 'reject',
                      handle,
                      id: preview.id,
                      key: crypto.randomUUID(),
                    })
                  }
                >
                  Decline this checkpoint
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {pending && (
        <div role="status">
          <p>
            The original acknowledgement is unconfirmed. Check the same saved request; it never
            approves later edits.
          </p>
          <button
            className="secondary"
            disabled={
              busy ||
              (pending.action === 'approve' &&
                (!preview ||
                  preview.id !== pending.id ||
                  preview.fingerprint !== pending.fingerprint))
            }
            onClick={() => void control(pending)}
          >
            Check saved file request
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
