import { useState } from 'react';
import { Globe, RefreshCw, ArrowUpRight } from 'lucide-react';
import { browserSetupSchema, type BrowserSetupStatus } from '@dock/shared';
import { api } from '../api';
import { Modal } from '../Modal';
import { PromptCard } from '../SetupPrompt';
import { useReading } from './useHomeData';

export function BrowserStatus() {
  const reading = useReading('/browser/setup', browserSetupSchema.parse);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<BrowserSetupStatus | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // Prefer the poll once it has caught up, including when the host marks a result stale.
  const status =
    checked &&
    (!reading.data?.checkedAt ||
      Date.parse(checked.checkedAt ?? '') > Date.parse(reading.data.checkedAt))
      ? checked
      : reading.data;
  const label = busy
    ? 'Checking'
    : error || reading.error
      ? 'Check needed'
      : status?.state === 'connected'
        ? 'Connected'
        : status?.state === 'setup-needed'
          ? 'Set up'
          : status?.state === 'unavailable'
            ? 'Check needed'
            : 'Check';
  async function check() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setChecked(browserSetupSchema.parse(await api('/browser/check', {})));
      reading.retry();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Browser check failed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function nativeSetup(action: 'codex' | 'claude') {
    setError('');
    try {
      setMessage((await api<{ message: string }>('/browser/open-setup', { action })).message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Open the setup guide on your computer.');
    }
  }
  return (
    <>
      <button
        type="button"
        className={`connection-check ${status?.state === 'connected' ? 'tone-ok' : ''}`}
        aria-label={`Browser on this computer: ${label}. Show connection setup`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Globe size={16} aria-hidden="true" />
        <span>Browser</span>
        <span className="connection-check-state">{label}</span>
      </button>
      {open && (
        <Modal
          title="Browser connection"
          close={() => setOpen(false)}
          className="home-editor-setup browser-setup"
        >
          <p>
            Agents use the browser on the selected computer, including when you message from your
            phone.
          </p>
          <div className="browser-connection-result" role="status">
            <strong>{label}</strong>
            <p>
              {status?.message ?? 'Check whether Codex can find its native browser connection.'}
            </p>
            {status?.checkedAt && (
              <small>
                Checked{' '}
                {new Date(status.checkedAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </small>
            )}
          </div>
          <button
            type="button"
            className="flow-button"
            disabled={busy}
            onClick={() => void check()}
          >
            <RefreshCw size={16} />
            {busy ? 'Checking setup…' : 'Check browser setup'}
          </button>
          <p className="browser-check-note">
            This check uses no AI tokens. A connection does not confirm permission for every
            website.
          </p>
          <details open>
            <summary>Connect Codex</summary>
            <ol>
              <li>
                On this computer, open ChatGPT → Settings → Computer Use. Install the browser
                integration if requested.
              </li>
              <li>
                Install and enable the ChatGPT extension in the browser profile you use. The browser
                should show <strong>Manage</strong> in Computer Use settings.
              </li>
              <li>
                Allow the websites needed for your workflow. Start a new Codex chat and select{' '}
                <strong>@Chrome</strong> to verify the connection.
              </li>
            </ol>
            <div className="browser-setup-actions">
              <button className="flow-button" onClick={() => void nativeSetup('codex')}>
                Open ChatGPT on computer
              </button>
              <a
                href="https://learn.chatgpt.com/docs/chrome-extension"
                target="_blank"
                rel="noreferrer"
              >
                Browser setup guide <ArrowUpRight size={14} />
              </a>
            </div>
          </details>
          <details>
            <summary>Connect Claude</summary>
            <p>
              Claude uses its own Claude in Chrome extension and permissions. The Codex check above
              does not verify Claude.
            </p>
            <ol>
              <li>Install Claude in Chrome and sign in with your Claude account.</li>
              <li>
                In Claude Code on this computer, run <code>/chrome</code>. Connect your browser and
                choose <strong>Enabled by default</strong> if you want future sessions to inherit
                it.
              </li>
              <li>
                Use the native panel to check the connection and site permissions. Existing sessions
                may need reconnecting.
              </li>
            </ol>
            <a href="https://code.claude.com/docs/en/chrome" target="_blank" rel="noreferrer">
              Claude browser setup guide <ArrowUpRight size={14} />
            </a>
          </details>
          <details>
            <summary>Check a workflow with your agent</summary>
            <PromptCard
              label="Browser connection check"
              prompt="Check your native browser connection on this computer. Report whether the browser extension is connected and whether you can access the site needed for this project. Do not modify any page, submit a form, extract credentials or change permissions. If setup is missing, name the exact native setting I need to enable and continue other unblocked work. Do not repeatedly retry a denied browser action."
            />
          </details>
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
    </>
  );
}
