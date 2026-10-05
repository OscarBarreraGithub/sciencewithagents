import { useRef, useState } from 'react';
import { RefreshCw, Download } from 'lucide-react';
import { appUpdateStartSchema, appUpdatesSchema } from '@dock/shared';
import { api, apiScope, ApiError } from '../api';
import { useReading } from './useHomeData';
import { FlowHeading } from './WorkspaceFlow';
import { PromptCard } from '../SetupPrompt';
import './app-updates.css';

const setupPrompt = `Update this existing sciencewithagents installation from https://github.com/OscarBarreraGithub/sciencewithagents using docs/UPDATE_APP.md. Find the correct source and private data directory. Preserve all chats, projects, drafts, settings, accounts, phone pairing, connected computers and local customizations. Prepare and verify recovery copies yourself; do not ask me to do a backup ritual. Compare the upstream changes with my current app, adapt them without discarding my work, and test in isolation. Never reset or clean away local changes, delete user data, replace credentials or replay model requests. Let running work finish before restarting through the existing launcher. Verify retained records and connections afterwards. If anything is incompatible, preserve it and explain the specific decision needed. Do not declare completion before checking the running app.`;

export function AppUpdates() {
  const reading = useReading('/app-updates', appUpdatesSchema.parse);
  const [busy, setBusy] = useState<'check' | 'start' | null>(null);
  const [error, setError] = useState('');
  const storageKey = `dock:${apiScope()}:app-update-request`;
  const request = useRef<ReturnType<typeof appUpdateStartSchema.parse> | null>(null);
  const [uncertain, setUncertain] = useState(() => {
    try {
      const saved = appUpdateStartSchema.safeParse(
        JSON.parse(localStorage.getItem(storageKey) ?? 'null'),
      );
      if (saved.success) {
        request.current = saved.data;
        return true;
      }
    } catch {
      /* Keep the in-memory request if storage is unavailable. */
    }
    return false;
  });
  const sending = useRef(false);
  const check = reading.data?.check,
    job = reading.data?.job;
  const active = !!job && job.state !== 'ready';
  async function act(action: 'check' | 'start') {
    if (sending.current) return;
    sending.current = true;
    setBusy(action);
    setError('');
    try {
      if (action === 'check') await api('/app-updates/check', {});
      else {
        if (!request.current) {
          if (!check) throw new Error('Check for updates first.');
          request.current = { key: crypto.randomUUID(), checkId: check.id };
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify(request.current));
        } catch {
          /* Optional storage. */
        }
        setUncertain(true);
        await api('/app-updates/start', request.current);
        request.current = null;
        setUncertain(false);
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* Optional storage. */
        }
      }
      reading.retry();
    } catch (reason) {
      if (reason instanceof ApiError && [400, 409].includes(reason.status)) {
        request.current = null;
        setUncertain(false);
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* Optional storage. */
        }
        reading.retry();
      }
      setError(
        reason instanceof Error ? reason.message : 'The connection was interrupted. Try again.',
      );
    } finally {
      sending.current = false;
      setBusy(null);
    }
  }
  return (
    <section className="flow-page connection-page app-updates-page">
      <FlowHeading label="APP UPDATES" title="App updates">
        Get changes from GitHub on the selected computer, keeping your workspace and customizations.
      </FlowHeading>
      <div className="flow-form-panel app-update-panel">
        <h2>sciencewithagents</h2>
        <p>
          Checking uses no AI allowance. Updating uses your maintenance agent and model preferences.
        </p>
        {reading.error ? (
          <p role="alert">
            Could not read update status. Reconnect and try again. Older installations can use the
            setup-agent instructions below.
          </p>
        ) : (
          <p role="status">{check?.message ?? 'Check GitHub when you want the latest fixes.'}</p>
        )}
        {check?.checkedAt && (
          <small>Last checked {new Date(check.checkedAt).toLocaleString()}</small>
        )}
        {check?.localChanges && (
          <p>There are local edits. The agent will preserve them and check how the update fits.</p>
        )}
        <div className="app-update-actions">
          <button
            className="flow-button"
            disabled={!!busy || uncertain}
            onClick={() => void act('check')}
          >
            <RefreshCw size={18} aria-hidden="true" />{' '}
            {busy === 'check' ? 'Checking…' : 'Check for updates'}
          </button>
          {(uncertain ||
            (!active &&
              check?.state === 'available' &&
              (!job || check.checkedAt > job.createdAt))) && (
            <button
              className="flow-button primary"
              disabled={!!busy}
              onClick={() => void act('start')}
            >
              <Download size={18} aria-hidden="true" />{' '}
              {busy === 'start'
                ? 'Preparing recovery copy…'
                : uncertain
                  ? 'Check the same update request'
                  : 'Update with an agent'}
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {uncertain && !busy && (
          <p>
            Your update request is retained. Retrying checks the same request without assigning it
            twice.
          </p>
        )}
      </div>
      {job && (
        <div className="flow-form-panel app-update-panel" aria-label="Update progress">
          <h2>{job.state === 'ready' ? 'Ready to reopen' : 'Update progress'}</h2>
          <p role="status">{job.message}</p>
          <a className="flow-button primary" href={`#/chat/${job.managerId}`}>
            Open update conversation
          </a>
        </div>
      )}
      <div className="app-update-preservation">
        <p>
          Chats, projects, accounts and settings stay on this computer. A verified database recovery
          copy is prepared before the agent starts. It also checks local files and customizations
          before changing code.
        </p>
        <p>
          The app stays available during preparation. When the agent says the update is ready, quit
          and reopen it through its usual launcher after active work finishes. Code can change; your
          saved data must be retained.
        </p>
      </div>
      <details className="flow-form-panel app-update-fallback">
        <summary>Use my own setup agent</summary>
        <p>
          Use this if the in-app agent is unavailable, or when updating an older installation. Paste
          it into Codex or Claude on the selected computer.
        </p>
        <PromptCard label="On the computer being updated" prompt={setupPrompt} />
      </details>
    </section>
  );
}
