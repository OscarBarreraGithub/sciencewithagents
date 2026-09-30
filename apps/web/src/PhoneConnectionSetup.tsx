import { useRef, useState } from 'react';
import { phoneSetupStatusSchema, phoneStatusSchema, type PhoneSetupStatus } from '@dock/shared';
import { api } from './api';
import './phone-connection-setup.css';

export function PhoneConnectionSetup({ connected }: { connected: () => Promise<void> }) {
  const [choice, setChoice] = useState('private');
  const [status, setStatus] = useState<PhoneSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  async function checkExisting() {
    setBusy(true);
    setError('');
    try {
      await connected();
      setError('If setup is still in progress, finish with your setup agent, then check again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the connection. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    setError('');
    try {
      const value = phoneSetupStatusSchema.parse(await api('/phone/setup/check', {}));
      key.current = crypto.randomUUID();
      setStatus(value);
      if (value.state === 'configured') await connected();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check this computer. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!status?.previewId || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/phone/setup/confirm', {
        key: key.current,
        previewId: status.previewId,
        confirm: true,
      });
      await connected();
    } catch (e) {
      // A lost response can follow successful setup. Read before offering another write.
      try {
        if (phoneStatusSchema.parse(await api('/phone/status')).configured) {
          await connected();
          return;
        }
      } catch {
        /* Keep the original attempt key for a deliberate retry. */
      }
      setError(
        e instanceof Error
          ? e.message
          : 'Could not finish setup. Check the connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="phone-connection-setup">
      <h3>Bring your workspace to your phone.</h3>
      <p>Your computer keeps the work. Choose a connection, then pair your phone with a passkey.</p>
      <fieldset disabled={busy}>
        <legend>How would you like to connect?</legend>
        <label>
          <input
            type="radio"
            name="phone-connection"
            value="private"
            checked={choice === 'private'}
            onChange={() => setChoice('private')}
          />{' '}
          Private connection · no domain needed
        </label>
        <label>
          <input
            type="radio"
            name="phone-connection"
            value="domain"
            checked={choice === 'domain'}
            onChange={() => setChoice('domain')}
          />{' '}
          Use a domain I already have
        </label>
      </fieldset>
      {choice === 'private' ? (
        <>
          <p>
            Tailscale connects your devices privately. It offers a free personal plan; workplace
            plans may differ.
          </p>
          <ol>
            <li>
              Install or open Tailscale on this computer and your phone.{' '}
              <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                Get Tailscale
              </a>
            </li>
            <li>Connect both devices to the same Tailscale account or private network.</li>
            <li>Check this computer below. If HTTPS needs enabling, we’ll show you where.</li>
          </ol>
          <p className="muted">
            Your device’s HTTPS address appears in a public certificate log. The app remains
            reachable only through your private network, and still requires phone pairing.
          </p>
          {status && (
            <div className="phone-setup-result" role="status">
              <p>{status.message}</p>
              {status.state === 'https' && (
                <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">
                  Open Tailscale HTTPS settings
                </a>
              )}
              {status.state === 'ready' && (
                <>
                  <p>Your private app address</p>
                  <code>{status.origin}</code>
                  <p>
                    Save this address, then turn on phone access to connect. Tailscale stays in
                    charge of its own sign-in.
                  </p>
                </>
              )}
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="phone-setup-actions">
            <button className="secondary" disabled={busy} onClick={() => void check()}>
              {busy ? 'Working…' : status ? 'Check again' : 'Check this computer'}
            </button>
            {status?.state === 'ready' && (
              <button disabled={busy} onClick={() => void confirm()}>
                Use this private address
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <h4>Connect an existing domain</h4>
          <p>
            Your setup agent can connect a domain you control through Cloudflare. You complete its
            account sign-in and consent; the agent handles the connection. A new domain may cost
            money.
          </p>
          <p>
            Ask your setup agent to follow the sciencewithagents phone setup guide for your existing
            domain. When it has finished, check the connection here.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="secondary" disabled={busy} onClick={() => void checkExisting()}>
            {busy ? 'Checking…' : 'Check existing-domain setup'}
          </button>
        </>
      )}
    </section>
  );
}
