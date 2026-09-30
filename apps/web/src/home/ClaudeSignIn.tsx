import { useEffect, useRef, useState } from 'react';
import { claudeSignInStatusSchema, type ClaudeSignInStatus } from '@dock/shared';
import { api } from '../api';

/** The native provider owns authentication; this UI only opens and checks it. */
export function ClaudeSignIn({ checked, checking }: { checked(): void; checking: boolean }) {
  const [value, setValue] = useState<ClaudeSignInStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  async function read() {
    setBusy(true);
    setError('');
    try {
      const next = claudeSignInStatusSchema.parse(await api('/setup/claude-sign-in'));
      if (active.current) setValue(next);
    } catch {
      if (active.current)
        setError('Could not read sign-in progress. Check again before opening a window.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void read();
    return () => {
      active.current = false;
    };
  }, []);
  async function open() {
    if (!value?.available || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = claudeSignInStatusSchema.parse(
        await api('/setup/claude-sign-in', { key: crypto.randomUUID() }),
      );
      if (active.current) setValue(next);
    } catch (e) {
      if (active.current) {
        // A lost response can mean the native window opened. Read the saved
        // attempt before offering a deliberate new opening, never replay it.
        setValue(null);
        setError(e instanceof Error ? e.message : 'Check sign-in progress before trying again.');
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="welcome-sign-in">
      {error && <p role="alert">{error}</p>}
      {!value ? (
        <button className="flow-button" disabled={busy} onClick={() => void read()}>
          {busy ? 'Checking sign-in progress…' : 'Check sign-in progress'}
        </button>
      ) : !value.available ? (
        <p>
          Opening Claude’s sign-in window from here is available on Mac. On this computer, finish
          signing in through Claude Code, then check this computer again.
        </p>
      ) : (
        <>
          <p>
            Sign in through Claude’s own browser flow. This opens a Terminal window on the selected
            Mac; follow its instructions there. You do not need to type a command.
          </p>
          {value.attempt && (
            <p role="status">
              {value.attempt.state === 'opened'
                ? 'The sign-in window was opened on your Mac.'
                : 'A sign-in window may already be open on your Mac.'}{' '}
              Check Terminal before opening another. Once you finish, check sign-in below.
            </p>
          )}
          <button
            className={`flow-button ${value.attempt ? '' : 'primary'}`}
            disabled={busy || checking}
            onClick={() => void open()}
          >
            {busy
              ? 'Opening sign-in…'
              : value.attempt
                ? 'Open another sign-in window'
                : 'Sign in with Claude'}
          </button>
          {value.attempt && (
            <button className="flow-button primary" disabled={busy || checking} onClick={checked}>
              {checking ? 'Checking…' : 'Check Claude sign-in'}
            </button>
          )}
          <small>
            Your password and sign-in codes stay with Claude. Close its Terminal window when you are
            done.
          </small>
        </>
      )}
    </div>
  );
}
