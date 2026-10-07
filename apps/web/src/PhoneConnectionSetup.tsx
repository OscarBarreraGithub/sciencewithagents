import { useState } from 'react';
import { phoneStatusSchema } from '@dock/shared';
import { api } from './api';
import { PromptCard } from './SetupPrompt';
import { cloudflarePhoneSetupPrompt } from './phone-setup-prompt';
import './phone-connection-setup.css';

export function PhoneConnectionSetup({ connected }: { connected: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function check() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const status = phoneStatusSchema.parse(await api('/phone/status'));
      if (status.configured || status.setupIssue) await connected();
      else
        setMessage(
          'Cloudflare setup is not ready yet. Finish with your setup agent, including safely reopening the app, then check again.',
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the connection. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="phone-connection-setup">
      <div className="phone-settings-panel">
        <h3>Set up a phone connection</h3>
        <p>
          Your phone connects through your own Cloudflare account. Your computer keeps running your
          agents and holds your work. Give the prompt below to Codex or Claude on that computer;
          your setup agent handles the technical work.
        </p>
        <h4>Your to-do list</h4>
        <ol>
          <li>
            Create or sign in to your own{' '}
            <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noreferrer">
              Cloudflare account
            </a>{' '}
            when your agent opens the sign-in page. Complete any account verification yourself.
          </li>
          <li>
            Choose a domain you control and approve the phone address. Your agent checks the domain
            and guides any required ownership or nameserver step. A new domain may cost money.
          </li>
          <li>
            After setup, turn on phone access here, scan the pairing code, save the passkey on your
            phone and confirm its matching number on this computer.
          </li>
        </ol>
        <p className="muted">
          Keep this computer awake, online and running the app. GitHub is not required for phone
          access. Your phone uses the app’s pairing; it needs no separate Cloudflare sign-in.
        </p>
      </div>
      <div className="phone-settings-panel">
        <h3>Give this to your setup agent</h3>
        <p>Copy this prompt into Codex or Claude on the computer you want to reach.</p>
        <PromptCard label="Cloudflare phone setup prompt" prompt={cloudflarePhoneSetupPrompt} />
        {message && <p role="status">{message}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="secondary" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check phone setup'}
        </button>
      </div>
    </section>
  );
}
