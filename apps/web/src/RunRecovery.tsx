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
import { api, apiScope, ApiError } from './api';

/** Same stopped run gets the same command receipt across tabs and lost responses. */
async function legacyContinueKey(scope: string, agentId: string, runId: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`sciencewithagents:legacy-continue:${scope}:${agentId}:${runId}`),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The server chooses safe replay versus inspection; the browser never guesses from error text. */
export function RunRecovery({
  agent,
  legacyRunId,
  act,
}: {
  agent: Agent;
  legacyRunId?: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<RunRecoveryView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<RunRecoveryRequest | null>(null);
  const generation = useRef(0);
  const scope = apiScope();
  const storageKey = `run-recovery:${scope}:${agent.id}`;
  useEffect(() => {
    let alive = true;
    generation.current++;
    setView(null);
    setError('');
    setBusy(false);
    setAccepted(false);
    setLegacy(false);
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
            if (!alive) return;
            if (receipt) {
              runRecoveryReceiptSchema.parse(receipt);
              localStorage.removeItem(storageKey);
              pending.current = null;
            }
          }
        }
        const value = await api(`/agents/${agent.id}/run-recovery`);
        if (alive) setView(value === null ? null : runRecoveryViewSchema.parse(value));
      } catch (reason) {
        // Connected computers may update at different times. Only an explicit JSON
        // unsupported response permits the older durable Continue command.
        if (
          alive &&
          reason instanceof ApiError &&
          [404, 501].includes(reason.status) &&
          reason.code !== 'INTERRUPTED' &&
          legacyRunId
        )
          setLegacy(true);
        else if (alive) setError('Recovery could not be checked. Try again.');
      }
    })();
    return () => {
      alive = false;
      generation.current++;
    };
  }, [agent.id, agent.status, agent.updatedAt, legacyRunId, scope, storageKey, refresh]);
  if (!['failed', 'interrupted'].includes(agent.status)) return null;
  const recover = async () => {
    if ((!view && !legacy) || busy || apiScope() !== scope) return;
    const started = generation.current;
    const current = () => started === generation.current && apiScope() === scope;
    setBusy(true);
    setError('');
    try {
      if (legacy) {
        if (!legacyRunId) return;
        const legacyKey = `${storageKey}:continue:${legacyRunId}`;
        const key = await legacyContinueKey(scope, agent.id, legacyRunId);
        if (!current()) return;
        localStorage.setItem(legacyKey, key);
        await api(`/agents/${agent.id}/commands`, { command: 'resume', key });
        if (!current()) return;
        localStorage.removeItem(legacyKey);
        setAccepted(true);
        await act(async () => undefined);
        return;
      }
      if (!view) return;
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
      // A later stopped run can arrive before this acknowledgement. Its recovery
      // controls belong to that new failure, even when this older request succeeded.
      if (!current()) return;
      localStorage.removeItem(storageKey);
      pending.current = null;
      setAccepted(true);
      await act(async () => undefined);
    } catch (reason) {
      if (!current()) return;
      setError(
        reason instanceof Error
          ? reason.message
          : 'Recovery was not acknowledged. Tap again to check the same request.',
      );
    } finally {
      if (current()) setBusy(false);
    }
  };
  if (!view && !error && !legacy) return null;
  return (
    <div className="recovery-note run-recovery" data-agent-id={agent.id} role="status">
      <RefreshCw size={16} />
      <div>
        <strong>{accepted ? 'Recovery queued' : 'Your message and history are saved.'}</strong>
        <p>
          {accepted
            ? 'The saved request is in the work queue.'
            : legacy
              ? 'Continue from saved progress.'
              : view?.explanation}
        </p>
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
        {(view || legacy) && !accepted && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void recover()}
          >
            {busy ? 'Checking…' : view?.action === 'retry' ? 'Retry message' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
}
