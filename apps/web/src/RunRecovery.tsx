import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  runRecoveryViewSchema,
  runRecoveryRequestSchema,
  runRecoveryReceiptSchema,
  type Agent,
  type RunRecoveryRequest,
  type RunRecoveryView,
} from '@dock/shared';
import { api, apiScope } from './api';

/** The server chooses safe replay versus inspection; the browser never guesses from error text. */
export function RunRecovery({
  agent,
  act,
}: {
  agent: Agent;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<RunRecoveryView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<RunRecoveryRequest | null>(null);
  const scope = apiScope();
  const storageKey = `run-recovery:${scope}:${agent.id}`;
  useEffect(() => {
    let alive = true;
    setView(null);
    setError('');
    setAccepted(false);
    pending.current = null;
    if (!['failed', 'interrupted'].includes(agent.status)) return;
    void (async () => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = runRecoveryRequestSchema.safeParse(JSON.parse(saved));
          if (parsed.success) {
            pending.current = parsed.data;
            const receipt = await api(
              `/agents/${agent.id}/run-recovery/receipts/${parsed.data.key}`,
            );
            if (receipt) {
              runRecoveryReceiptSchema.parse(receipt);
              localStorage.removeItem(storageKey);
              pending.current = null;
            }
          }
        }
        const value = await api(`/agents/${agent.id}/run-recovery`);
        if (alive) setView(value === null ? null : runRecoveryViewSchema.parse(value));
      } catch {
        if (alive) setError('Recovery could not be checked. Try again.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [agent.id, agent.status, agent.updatedAt, scope, storageKey, refresh]);
  if (!['failed', 'interrupted'].includes(agent.status)) return null;
  const recover = async () => {
    if (!view || busy || apiScope() !== scope) return;
    setBusy(true);
    setError('');
    try {
      let input = pending.current;
      if (!input || input.failureId !== view.failureId || input.action !== view.action) {
        input = {
          key: crypto.randomUUID(),
          runId: view.runId,
          failureId: view.failureId,
          action: view.action,
        };
        // Retain the exact request before sending; reload/lost acknowledgement never invents a new intent.
        localStorage.setItem(storageKey, JSON.stringify(input));
        pending.current = input;
      }
      runRecoveryReceiptSchema.parse(await api(`/agents/${agent.id}/run-recovery`, input));
      localStorage.removeItem(storageKey);
      pending.current = null;
      setAccepted(true);
      await act(async () => undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Recovery was not acknowledged. Tap again to check the same request.',
      );
    } finally {
      setBusy(false);
    }
  };
  if (!view && !error) return null;
  return (
    <div className="recovery-note run-recovery" data-agent-id={agent.id} role="status">
      <RefreshCw size={16} />
      <div>
        <strong>{accepted ? 'Recovery queued' : 'Your message and history are saved.'}</strong>
        <p>{accepted ? 'The saved request is in the work queue.' : view?.explanation}</p>
        {error && (
          <p className="run-recovery-error" role="alert">
            {error}
          </p>
        )}
        {!view && error && (
          <button
            type="button"
            className="secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Check recovery
          </button>
        )}
        {view && !accepted && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void recover()}
          >
            {busy ? 'Checking…' : view.action === 'retry' ? 'Retry message' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
}
