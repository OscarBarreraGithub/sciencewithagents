import { useEffect, useState } from 'react';
import { hostsStatusSchema, type HostsStatus } from '@dock/shared';
import { api } from './api';
import { PromptCard } from './SetupPrompt';
import './host-selector.css';

const newComputerPrompt = `Set up sciencewithagents on this new computer from https://github.com/OscarBarreraGithub/sciencewithagents, following docs/CONTRIBUTOR_SETUP.md. Find and preserve any existing installation, accounts and files. For a new installation, use a local folder outside iCloud or other cloud sync. Check platform support and prerequisites. Install my chosen provider CLI if missing or update its existing installation, then verify its version and available models; a desktop app alone is not enough. Use this computer's own Codex or Claude sign-in; I do not need both. Install the Applications launcher on Mac, open Welcome and verify the available models. Keep phone access, VS Code sharing and private GitHub backup optional. Do not start project work or run the full developer test suite for ordinary setup.

I want to select this computer from an existing sciencewithagents installation. Read docs/MULTI_COMPUTER_SETUP.md and prepare this computer as the destination, preserving its own projects and history. Check whether an authorized private SSH route already exists. Ask only for the machine details, account sign-in or device steps you actually need. Do not copy another installation's data or provider credentials, expose the app port publicly, or print connection secrets in chat. Finish by telling me how to open this app and give me a short, non-secret handoff for the setup agent on my main computer. Distinguish installation complete from connection still needing setup.`;

const connectComputerPrompt = `Connect my additional sciencewithagents computer to this main installation, following docs/MULTI_COMPUTER_SETUP.md. Ask me which computer to add and for its setup agent's non-secret handoff if needed. Preserve every existing connection, project, sign-in and saved conversation. Use the authorized private SSH route, verify the destination's identity, and transfer only the app-specific host credential privately as the guide describes; never request secrets in chat. If no working route exists, explain the device step needed rather than guessing or weakening security. Finish the connection record on this main computer, reopen only when active work can safely continue, and verify that selecting the new computer shows its own projects and accounts. Check reconnect and switching back without sending a project message. Tell me clearly if any step remains incomplete.`;

/** Selection changes the UI scope, never the account, tools or files on either computer. */
export function HostSelector({
  selected,
  onChange,
}: {
  selected: string;
  onChange: (id: string) => void;
}) {
  const [state, setState] = useState<HostsStatus | null>(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const value = hostsStatusSchema.parse(await api('/hosts'));
        if (active) {
          setState(value);
          setError('');
        }
      } catch (error) {
        if (active)
          setError(error instanceof Error ? error.message : 'Could not read your computers.');
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const connect = async (id: string) => {
    if (connecting) return;
    setConnecting(id);
    setError('');
    try {
      setState(hostsStatusSchema.parse(await api(`/hosts/${id}/connect`, {})));
      window.dispatchEvent(new Event('dock:host-connected'));
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not connect. Try again when this computer is ready.',
      );
    } finally {
      setConnecting(null);
    }
  };
  const host = state?.hosts.find((item) => item.id === selected);
  return (
    <section className="host-selector" aria-label="Computer connection">
      <label>
        Computer
        <select
          aria-label="Computer"
          value={selected}
          disabled={connecting !== null}
          onChange={(event) => {
            const id = event.target.value;
            // Switch immediately: never leave another computer's history/input visible under the new label.
            onChange(id);
            if (id !== 'local') void connect(id);
          }}
        >
          <option value="local">{state?.local.label ?? 'Computer'}</option>
          {state?.hosts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} · {item.accountLabel}
            </option>
          ))}
          {selected !== 'local' && !host && <option value={selected}>Computer needs setup</option>}
        </select>
      </label>
      {(error || state?.setupError) && (
        <p className="form-error" role="alert">
          {error || state?.setupError}
        </p>
      )}
      {host && (
        <>
          <p className="muted" role="status">
            {connecting === host.id || host.status === 'connecting'
              ? `Connecting to ${host.label}…`
              : host.status === 'connected'
                ? `${host.label} is connected. ${host.accountLabel} stays on that computer.`
                : `${host.label} is not connected. Saved work stays on that computer.`}
          </p>
          {host.error && !error && (
            <p className="form-error" role="alert">
              {host.error}
            </p>
          )}
          {host.status !== 'connected' && (
            <button
              className="secondary"
              disabled={connecting !== null}
              onClick={() => void connect(host.id)}
            >
              {connecting === host.id ? 'Connecting…' : 'Try connection again'}
            </button>
          )}
        </>
      )}
      <details className="host-connect-guide">
        <summary>Connect another computer</summary>
        <p>
          Open Codex or Claude on the new computer and paste this prompt. Its setup agent installs
          the app and prepares it to connect here.
        </p>
        <p>
          Tailscale setup can be tricky. Let the setup agents exchange connection details and
          troubleshoot together—paste their handoffs between computers when needed. They can handle
          the configuration and tell you when an account or network approval is needed.
        </p>
        <PromptCard label="On the new computer" prompt={newComputerPrompt} />
        <details className="host-connect-finish">
          <summary>Then finish linking from your main computer</summary>
          <p>
            Once the new computer is ready, paste this into your setup agent on the computer you
            normally open sciencewithagents from. Give it the new computer’s setup handoff.
          </p>
          <PromptCard label="On your main computer" prompt={connectComputerPrompt} />
        </details>
        <p className="muted">
          Sign in to Codex or Claude normally on each computer. You can use your own account on
          both; credentials are not copied. Projects, conversations and QUARK queues stay on the
          computer running them. Linking computers lets you switch between them; it does not combine
          their histories or coordinate one shared allowance across machines.
        </p>
        <p className="muted">
          Both computers must be on and running the app. Copying a prompt does not start setup or
          transfer any account or history.
        </p>
      </details>
    </section>
  );
}
