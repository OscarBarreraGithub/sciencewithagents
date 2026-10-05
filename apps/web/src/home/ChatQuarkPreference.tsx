import { useEffect, useId, useRef, useState } from 'react';
import { chatQuarkPolicySaveSchema, chatQuarkPolicySchema } from '@dock/shared';
import { api, apiScope, ApiError, connectionLost } from '../api';

type Policy = ReturnType<typeof chatQuarkPolicySchema.parse>;
type Save = ReturnType<typeof chatQuarkPolicySaveSchema.parse>;
const failure = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Could not reach this computer. Try again.';

/** A receipt survives closing Configure and reload; an uncertain save is never recreated. */
export function ChatQuarkPreference({ agentId }: { agentId: string }) {
  const storageKey = `dock:chat-quark:${apiScope()}:${agentId}`;
  const description = useId();
  const alive = useRef(true);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [pending, setPending] = useState<Save | null>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      return saved ? chatQuarkPolicySaveSchema.parse(JSON.parse(saved)) : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readingError, setReadingError] = useState('');
  const read = async () => {
    try {
      const current = chatQuarkPolicySchema.parse(await api(`/agents/${agentId}/chat-quark`));
      if (alive.current) {
        setPolicy(current);
        setReadingError('');
      }
    } catch (reason) {
      if (alive.current) setReadingError(failure(reason));
    }
  };
  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [agentId]);
  const clear = (request: Save) => {
    // A late acknowledgement cannot erase a different retained request.
    if (sessionStorage.getItem(storageKey) === JSON.stringify(request))
      sessionStorage.removeItem(storageKey);
    if (alive.current) setPending(null);
  };
  const save = async (request: Save) => {
    setBusy(true);
    setError('');
    try {
      const saved = chatQuarkPolicySchema.parse(
        await api(`/agents/${agentId}/chat-quark`, request),
      );
      clear(request);
      if (alive.current) setPolicy(saved);
      // An older receipt can acknowledge a value superseded by another device.
      await read();
    } catch (reason) {
      const rejected =
        reason instanceof ApiError &&
        !connectionLost(reason) &&
        [400, 403, 404, 409, 422].includes(reason.status);
      if (rejected) {
        clear(request);
        await read();
      }
      if (alive.current)
        setError(
          `${failure(reason)}${rejected ? '' : ' Your change is retained; retry to check the saved result.'}`,
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const change = (enabled: boolean) => {
    if (!policy || busy || pending) return;
    const request: Save = { key: crypto.randomUUID(), enabled, expectedRevision: policy.revision };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      void save(request);
    } catch {
      setError(
        'This browser could not retain a save receipt. No preference was changed. Try again.',
      );
    }
  };
  return (
    <div className="chat-quark-preference">
      <button
        type="button"
        className="chat-small-button"
        role="switch"
        aria-checked={policy?.enabled ?? false}
        aria-describedby={description}
        disabled={!policy || busy || !!pending}
        onClick={() => change(!policy!.enabled)}
      >
        Ignore QUARK for my replies: {policy?.enabled ? 'On' : 'Off'}
      </button>
      <p id={description}>
        Direct replies only; workers stay supervised. Current queued replies and new messages skip
        allowance caps, reserves and pacing. Pauses, native permissions and provider limits still
        apply. A running reply keeps its existing setting.
      </p>
      <p role="status">
        {busy
          ? 'Saving chat preference…'
          : pending
            ? `Save unconfirmed: ${pending.enabled ? 'On' : 'Off'}.`
            : policy
              ? `Saved: ${policy.enabled ? 'On' : 'Off'}.`
              : 'Reading chat preference…'}
      </p>
      {readingError && (
        <div>
          <p className="chat-panel-error" role="alert">
            {readingError}
          </p>
          <button
            className="chat-small-button"
            type="button"
            disabled={busy}
            onClick={() => void read()}
          >
            Read chat preference again
          </button>
        </div>
      )}
      {error && (
        <p className="chat-panel-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <button
          className="chat-small-button"
          type="button"
          disabled={busy}
          onClick={() => void save(pending)}
        >
          {busy ? 'Saving…' : 'Retry chat preference save'}
        </button>
      )}
    </div>
  );
}
