import { useEffect, useRef, useState } from 'react';
import { Cloud, ArrowUpRight, Check, RefreshCw } from 'lucide-react';
import { backupSetupSchema, type BackupSetup, type BackupStatus } from '@dock/shared';
import { api } from '../api';
import './source-backup.css';

export function SourceBackup({
  projectId,
  status,
  refresh,
}: {
  projectId: string;
  status?: BackupStatus;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<BackupSetup | null>(null);
  const [choice, setChoice] = useState<'create' | 'existing'>('create');
  const [repository, setRepository] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signInStarted, setSignInStarted] = useState(false);
  const canSignIn = useRef(false);
  const alive = useRef(true);
  const retryKey = useRef<string | null>(null);
  const current = status?.configured ? status : (setup?.status ?? status);
  const base = `/projects/${projectId}/backup`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function request(path: string, body?: object) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = backupSetupSchema.parse(await api(`${base}/${path}`, body));
      if (path === 'setup') canSignIn.current = value.canSignIn;
      if (alive.current) {
        setSetup(value);
        setConfirmed(false);
        refresh();
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Could not check the backup. Try again.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError('');
    setNotice('');
    retryKey.current ??= crypto.randomUUID();
    try {
      await api(`${base}/retry`, { key: retryKey.current });
      if (alive.current) {
        retryKey.current = null;
        setNotice('Checking reviewed source checkpoints. The status below will update.');
        refresh();
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not retry.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const preview = setup?.preview;
  return (
    <section className="flow-panel source-backup" aria-label="Private source backup">
      <div className="flow-section-title">
        <h2>
          <Cloud size={20} /> Private source backup
        </h2>
        <button
          className="flow-button"
          disabled={busy}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open) void request('setup');
          }}
        >
          {open
            ? 'Close backup details'
            : current?.configured
              ? 'View backup details'
              : 'Set up source backup'}
        </button>
      </div>
      <p className="source-backup-state">
        {current?.message ??
          'Source backup is not connected yet. Your work stays on this computer.'}
      </p>
      {current?.configured && (
        <button
          className="flow-button"
          disabled={busy || current.state === 'saving'}
          onClick={() => void retry()}
        >
          <RefreshCw size={16} /> Retry source backup
        </button>
      )}
      {error && (
        <p className="flow-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <div className="source-backup-details">
          <p>
            Keep reviewed source checkpoints in a private GitHub repository. This includes their
            committed history. Conversations, credentials, unsaved edits and native agent histories
            need a separate backup.
          </p>
          {!setup?.destination && canSignIn.current && (
            <details className="source-backup-login">
              <summary>Need to connect GitHub?</summary>
              <p>
                GitHub handles sign-in in its own Terminal and browser windows on this Mac. Finish
                its prompts, then preview your backup here. Credentials stay with GitHub CLI.
              </p>
              {signInStarted ? (
                <p role="status">
                  Check Terminal and your browser for GitHub sign-in. When finished, preview the
                  backup again.
                </p>
              ) : (
                <button
                  className="flow-button"
                  disabled={busy}
                  onClick={async () => {
                    setSignInStarted(true);
                    setBusy(true);
                    setError('');
                    try {
                      await api(`${base}/sign-in`, { key: crypto.randomUUID() });
                    } catch (e) {
                      if (alive.current)
                        setError(
                          e instanceof Error
                            ? e.message
                            : 'Check Terminal before opening another sign-in window.',
                        );
                    } finally {
                      if (alive.current) setBusy(false);
                    }
                  }}
                >
                  Open GitHub sign-in
                </button>
              )}
            </details>
          )}
          {!setup ? (
            <button className="flow-button" disabled={busy} onClick={() => void request('setup')}>
              {busy ? 'Checking settings…' : 'Check backup settings'}
            </button>
          ) : setup.destination ? (
            <div className="source-backup-destination">
              <Check size={19} />
              <div>
                <strong>Connected destination</strong>
                <a
                  href={`https://github.com/${setup.destination.repository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {setup.destination.repository} <ArrowUpRight size={15} />
                </a>
                <p>
                  Applied changes go to <strong>{setup.destination.branch}</strong>. Reviewed task
                  results keep separate branches. A connection is not proof that source has been
                  saved: check the status above.
                </p>
              </div>
            </div>
          ) : preview ? (
            <div className="source-backup-preview">
              <p className="home-eyebrow">
                {preview.attempted ? 'SAVED CONNECTION REQUEST' : 'CHECK THE DESTINATION'}
              </p>
              <h3>
                {preview.choice === 'create'
                  ? 'Create a private source backup'
                  : 'Connect your private repository'}
              </h3>
              <strong className="source-backup-address">github.com/{preview.repository}</strong>
              <p>
                Applied changes go to <strong>{preview.branch}</strong>. Earlier reviewed results
                and future checkpoints become eligible for backup. Sensitive-file checks run before
                export; unreviewed work stays local.
              </p>
              <p>
                {preview.attempted
                  ? 'A previous attempt may have created this destination. Continue checks this exact address first; it does not choose another name.'
                  : 'Nothing has been created, connected or uploaded by this preview.'}
              </p>
              <label className="source-backup-consent">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={busy}
                />
                <span>Back up this project’s reviewed source to this private destination.</span>
              </label>
              <div className="source-backup-actions">
                <button
                  className="flow-button primary"
                  disabled={busy || !confirmed}
                  onClick={() =>
                    void request('connect', {
                      key: preview.id,
                      previewId: preview.id,
                      confirm: true,
                    })
                  }
                >
                  {busy
                    ? 'Connecting…'
                    : preview.attempted
                      ? 'Continue this connection'
                      : 'Confirm private backup'}
                </button>
                <button
                  className="flow-button"
                  disabled={busy}
                  onClick={() => void request('setup')}
                >
                  Check connection
                </button>
                {!preview.attempted && (
                  <button
                    className="flow-button"
                    disabled={busy}
                    onClick={() => {
                      setSetup({ ...setup, preview: null });
                      setConfirmed(false);
                      setError('');
                    }}
                  >
                    Choose again
                  </button>
                )}
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void request(
                  'preview',
                  choice === 'create' ? { choice } : { choice, repository: repository.trim() },
                );
              }}
            >
              <fieldset disabled={busy}>
                <legend>Where should reviewed source go?</legend>
                <label className="source-backup-choice">
                  <input
                    type="radio"
                    name={`backup-${projectId}`}
                    checked={choice === 'create'}
                    onChange={() => setChoice('create')}
                  />
                  <span>
                    <strong>Create a new private backup</strong>
                    <small>Use the GitHub account already signed in on this computer.</small>
                  </span>
                </label>
                <label className="source-backup-choice">
                  <input
                    type="radio"
                    name={`backup-${projectId}`}
                    checked={choice === 'existing'}
                    onChange={() => setChoice('existing')}
                  />
                  <span>
                    <strong>Connect an existing private repository</strong>
                    <small>We check your write access and keep its existing history.</small>
                  </span>
                </label>
                {choice === 'existing' && (
                  <label className="source-backup-field">
                    GitHub owner/repository
                    <input
                      value={repository}
                      onChange={(e) => setRepository(e.target.value)}
                      placeholder="your-name/project-name"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                      maxLength={140}
                    />
                  </label>
                )}
              </fieldset>
              <button className="flow-button primary" disabled={busy}>
                {busy ? 'Checking GitHub…' : 'Preview private backup'}
              </button>
              <p className="flow-note">
                GitHub CLI must be installed and signed in on this computer. Your setup agent can
                connect it using your own account. No password or token belongs in this app.
              </p>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
