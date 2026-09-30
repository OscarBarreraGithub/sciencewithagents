import { useState } from 'react';
import { mirrorControlSchema, mirrorResultSchema, type MirrorControl } from '@dock/shared';
import { api, apiScope } from './api';

/** A stop is bound to the displayed native turn and has a read-only retry receipt. */
export function MirrorStopReply({
  windowId,
  threadId,
  provider,
  token,
  daemon = false,
}: {
  windowId: string;
  threadId: string;
  provider: 'codex' | 'claude';
  token?: string;
  // A native Codex daemon session is inspected on the computer, not in VS Code.
  daemon?: boolean;
}) {
  const storageKey = `dock:mirror-stop:${apiScope()}:${provider}:${threadId}`;
  const [pending, setPending] = useState<MirrorControl | null>(() => {
    try {
      const saved = mirrorControlSchema.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'),
      );
      return saved.success && saved.data.threadId === threadId && saved.data.provider === provider
        ? saved.data
        : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [lastToken, setLastToken] = useState('');
  async function stop() {
    if (busy || (!pending && (!token || token === lastToken))) return;
    const input: MirrorControl = pending ?? {
      key: crypto.randomUUID(),
      provider,
      threadId,
      action: 'interrupt',
      token: token!,
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(input));
    } catch {
      /* Memory-only receipt; failure guidance never offers an automatic resend. */
    }
    setBusy(true);
    setPending(input);
    try {
      const result = mirrorResultSchema.parse(
        pending
          ? await api(`/vscode/deliveries/${input.key}`)
          : await api(`/vscode/windows/${windowId}/control`, input),
      );
      setMessage(result.message);
      if (result.state !== 'uncertain') {
        setPending(null);
        setLastToken(input.token);
        try {
          if (JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')?.key === input.key)
            sessionStorage.removeItem(storageKey);
        } catch {
          /* Keep the result in this live view. */
        }
      }
    } catch {
      setMessage(
        daemon
          ? 'Stop was not confirmed. Check its status or inspect the Codex session on your computer; nothing is repeated automatically.'
          : 'Stop was not confirmed. Check its status or inspect VS Code; nothing is repeated automatically.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!token && !pending && !message) return null;
  return (
    <div className="mirror-stop-row">
      {(token || pending) && (
        <button
          type="button"
          className="secondary"
          onClick={() => void stop()}
          disabled={busy || (!pending && token === lastToken)}
        >
          {busy ? 'Checking…' : pending ? 'Check stop status' : 'Stop reply'}
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {pending && !busy && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            if (
              !window.confirm(
                `Have you checked this reply ${daemon ? 'on your computer' : 'in VS Code'}? This only clears the stop receipt; it will not stop or restart anything.`,
              )
            )
              return;
            try {
              sessionStorage.removeItem(storageKey);
            } catch {
              /* In-memory state remains explicit. */
            }
            setPending(null);
            setLastToken(pending.token);
            setMessage('Stop receipt cleared after your check.');
          }}
        >
          {daemon ? 'I checked on my computer' : 'I checked in VS Code'}
        </button>
      )}
    </div>
  );
}
