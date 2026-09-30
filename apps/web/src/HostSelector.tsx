import { useEffect, useState } from 'react';
import { hostsStatusSchema, type HostsStatus } from '@dock/shared';
import { api } from './api';

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
          <option value="local">{state?.local.label ?? 'This computer'}</option>
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
      <details>
        <summary>Connect another computer</summary>
        <p>
          Ask your setup agent to connect this computer to your other sciencewithagents
          installations. Each computer keeps its own Codex sign-in, tools, projects and
          conversations.
        </p>
        <p className="muted">
          A selected computer must be on, signed in and running sciencewithagents. Switching
          computers does not move work or share one account’s history with another.
        </p>
      </details>
    </section>
  );
}
