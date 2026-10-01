import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  recoveryCopiesSchema,
  recoveryCopySchema,
  type RecoveryCopies,
  type RecoveryCopy,
} from '@dock/shared';
import { api, apiScope } from './api';
import { Modal } from './Modal';
import './RecoveryBackups.css';

export function RecoveryBackups({
  close,
  embedded = false,
}: {
  close: () => void;
  embedded?: boolean;
}) {
  const [state, setState] = useState<RecoveryCopies | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const storageKey = `dock:recovery-copy:${apiScope()}`;
  const pending = useRef<string | null>(null);
  const savePending = (key: string | null) => {
    const previous = pending.current;
    pending.current = key;
    try {
      if (key) sessionStorage.setItem(storageKey, key);
      else if (sessionStorage.getItem(storageKey) === previous)
        sessionStorage.removeItem(storageKey);
    } catch {
      /* Server receipts still prevent duplicate sends in this open view. */
    }
  };
  const refresh = async () => {
    try {
      const value = recoveryCopiesSchema.parse(await api('/recovery-backups'));
      if (!mounted.current) return;
      setState(value);
      setLoadError('');
    } catch {
      if (mounted.current)
        setLoadError('Could not read recovery copies. Check the connection and try again.');
    }
  };
  useEffect(() => {
    mounted.current = true;
    try {
      pending.current = sessionStorage.getItem(storageKey);
    } catch {
      /* Optional browser storage. */
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);
  const perform = async (copy?: RecoveryCopy) => {
    if (busy || state?.creating) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!copy && !pending.current) savePending(crypto.randomUUID());
      const result = recoveryCopySchema.parse(
        await api(
          copy ? `/recovery-backups/${copy.id}/verify` : '/recovery-backups',
          copy ? {} : { key: pending.current },
        ),
      );
      if (!copy && result.state !== 'creating') savePending(null);
      if (!mounted.current) return;
      if (result.state === 'failed') setError(result.message);
      else setNotice(result.message);
      await refresh();
    } catch {
      if (mounted.current)
        setError(
          copy
            ? 'The check did not finish in this view. Refresh the list before trying again.'
            : 'The connection ended before we could confirm the copy. Try again to check the same request; it will not create a duplicate.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const content = (
    <div className="recovery-layout">
      <section className="recovery-panel recovery-main" aria-labelledby="saved-copies-title">
        <header className="recovery-section-heading">
          <h2 id="saved-copies-title">Saved copies</h2>
          {state && <span>{state.copies.length} recent</span>}
        </header>
        <p>Private snapshots of this computer’s managed conversations, records and saved images.</p>
        <p className="recovery-warning">
          Stored on this computer, not on GitHub or another backup drive.
        </p>
        {loadError && (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="recovery-notice" role="status">
            {notice}
          </p>
        )}
        <div className="recovery-actions">
          <button
            className="primary"
            disabled={busy || !state || state.creating}
            onClick={() => void perform()}
          >
            {busy || state?.creating
              ? 'Saving or checking…'
              : pending.current
                ? 'Try again'
                : 'Create recovery copy'}
          </button>
          <button className="secondary" disabled={busy} onClick={() => void refresh()}>
            Refresh list
          </button>
        </div>
        {!state ? (
          <p role="status">Reading saved copies…</p>
        ) : state.copies.length === 0 ? (
          <p>
            No recovery copies yet. Your managed conversations are already saved; a copy is an extra
            snapshot.
          </p>
        ) : (
          <ul className="recovery-list" aria-label="Recent recovery copies" tabIndex={0}>
            {state.copies.map((copy) => (
              <li key={copy.id}>
                <details className="recovery-copy">
                  <summary>
                    <ChevronRight size={18} aria-hidden="true" />
                    <span>
                      <strong>
                        {copy.state === 'verified'
                          ? 'Verified recovery copy'
                          : copy.state === 'creating'
                            ? 'Copy in progress'
                            : 'Copy needs attention'}
                      </strong>
                      <time dateTime={copy.createdAt}>
                        {new Date(copy.createdAt).toLocaleString()}
                      </time>
                    </span>
                  </summary>
                  <div className="recovery-copy-body">
                    {copy.checkedAt && (
                      <small>Last checked {new Date(copy.checkedAt).toLocaleString()}</small>
                    )}
                    {copy.counts && (
                      <p>
                        {copy.counts.conversations} conversations · {copy.counts.entries} archived
                        entries · {copy.counts.images} images
                      </p>
                    )}
                    <p>{copy.message}</p>
                    {copy.state === 'verified' && (
                      <button
                        className="secondary"
                        disabled={busy || state.creating}
                        onClick={() => void perform(copy)}
                      >
                        Check this copy
                      </button>
                    )}
                    <details>
                      <summary>Copy reference</summary>
                      <code>{copy.id}</code>
                    </details>
                    {embedded && copy.state === 'verified' && <UpdateRequest copy={copy} />}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside className="recovery-guidance">
        {embedded && (
          <section className="recovery-update" aria-labelledby="update-app-title">
            <h3 id="update-app-title">Update this app</h3>
            <p>
              Open a verified copy and choose <strong>Use this copy before updating</strong> for
              your setup agent’s instructions.
            </p>
            <p>
              The agent checks active work and preserves your records and settings. Preparing a copy
              does not install an update.
            </p>
            <div className="recovery-actions">
              <a className="flow-button secondary" href="#/welcome">
                Check this computer
              </a>
              <a className="flow-button secondary" href="#/work">
                See active work
              </a>
            </div>
          </section>
        )}
        <section className="recovery-panel recovery-coverage" aria-labelledby="recovery-help-title">
          <h2 id="recovery-help-title">Backup and restore</h2>
          <details className="recovery-help">
            <summary>What is included?</summary>
            <p>
              Managed conversation history, agent and task records, decisions, saved images, saved
              app views and drafts, delivery receipts, and private app security metadata.
            </p>
            <p>
              Not included: project files, unfinished work in task folders, Codex or Claude’s own
              session files, VS Code chat transcripts, browser-only drafts, provider sign-in files,
              or external setup files. A database check is not a full-machine restore test.
            </p>
          </details>
          <details className="recovery-help">
            <summary>Protect against losing this computer</summary>
            <p>
              Ask your setup agent to include these recovery copies, your project folders,
              unfinished task work and native agent history in a private backup stored somewhere
              else. Use your own secure backup service or drive; do not upload this private data to
              GitHub.
            </p>
            <p>
              This app does not currently set up or verify that separate off-device backup. GitHub
              source checkpoints protect reviewed code only.
            </p>
          </details>
          <details className="recovery-help">
            <summary>How do I restore a copy?</summary>
            <p>
              Ask your setup agent: “Help me restore a sciencewithagents recovery copy. Preserve my
              current data, check the copy and restore into a separate location. Do not overwrite
              the running workspace.” Give it the copy reference above.
            </p>
            <p>
              The agent must stop sciencewithagents before switching data, preserve the current
              files, restore into a separate location, check project and native session files, and
              review interrupted work before you continue. Restoring old security records also needs
              a review of phone access. No messages or uncertain work should be replayed.
            </p>
            <p>
              There is deliberately no live restore button. Recovery may also require separate
              project and provider-history backups. No copy is deleted automatically.
            </p>
          </details>
        </section>
      </aside>
    </div>
  );
  return embedded ? (
    <section className="recovery-dialog recovery-embedded" aria-label="Local recovery copies">
      {content}
    </section>
  ) : (
    <Modal title="Recovery copies" close={close} className="recovery-dialog">
      {content}
    </Modal>
  );
}

function UpdateRequest({ copy }: { copy: RecoveryCopy }) {
  const [notice, setNotice] = useState('');
  const request = `Update this sciencewithagents installation using docs/UPDATE_APP.md. My recovery copy reference is ${copy.id}, created ${copy.createdAt}. Locate it on the selected computer and recheck it; make a fresh copy if work has changed. Check prerequisites and active work before stopping the app. Preserve projects, conversations, drafts, phone trust, model choices and native provider history. Keep the same data directory and account settings. Explain any failed step and retry only that step; never replay model requests. Reopen the app and verify my records and existing connection before calling the update complete.`;
  return (
    <details className="recovery-update-request">
      <summary>Use this copy before updating</summary>
      <p>Give this request to the coding agent that set up the app on this computer.</p>
      <p className="recovery-request-text">{request}</p>
      <button
        className="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(request);
            setNotice('Request copied. Give it to your setup agent; the update has not started.');
          } catch {
            setNotice('Select and copy the request above, then give it to your setup agent.');
          }
        }}
      >
        Copy update request
      </button>
      <p className="recovery-copy-feedback" role="status">
        {notice || '\u00a0'}
      </p>
    </details>
  );
}
