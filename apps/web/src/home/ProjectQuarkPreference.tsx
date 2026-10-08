import { useEffect, useId, useRef, useState } from 'react';
import { projectQuarkPolicySaveSchema, projectQuarkPolicySchema } from '@dock/shared';
import { api, apiScope, ApiError, connectionLost } from '../api';

type Policy = ReturnType<typeof projectQuarkPolicySchema.parse>;
type Save = ReturnType<typeof projectQuarkPolicySaveSchema.parse>;
const failure = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Could not reach this computer. Try again.';

/** Retain the exact change before sending it, including across menu close and browser restart. */
export function ProjectQuarkPreference({ projectId }: { projectId: string }) {
  const storageKey = `dock:project-quark:${apiScope()}:${projectId}`;
  const path = `/projects/${projectId}/quark-scheduler`;
  const description = useId();
  const alive = useRef(true);
  const locked = useRef(false);
  const readVersion = useRef(0);
  const retained = () => {
    const value = localStorage.getItem(storageKey);
    return value ? projectQuarkPolicySaveSchema.parse(JSON.parse(value)) : null;
  };
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [pending, setPending] = useState<Save | null>(() => {
    try {
      return retained();
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState('');
  const [readingError, setReadingError] = useState('');
  const read = async () => {
    const version = ++readVersion.current;
    if (alive.current) setReading(true);
    try {
      const current = projectQuarkPolicySchema.parse(await api(path));
      if (current.projectId !== projectId)
        throw new Error('Could not confirm this project’s setting.');
      if (alive.current && version === readVersion.current) {
        setPolicy(current);
        setReadingError('');
      }
      return current;
    } catch (reason) {
      if (alive.current && version === readVersion.current) setReadingError(failure(reason));
      throw reason;
    } finally {
      if (alive.current && version === readVersion.current) setReading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void read().catch(() => {});
    return () => {
      alive.current = false;
      readVersion.current++;
    };
  }, [projectId]);
  const clear = (request: Save) => {
    // A late receipt must never erase a different change retained by another tab.
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === JSON.stringify(request)) {
        localStorage.removeItem(storageKey);
        if (alive.current) setPending(null);
      } else if (alive.current) {
        setPending(saved ? projectQuarkPolicySaveSchema.parse(JSON.parse(saved)) : null);
      }
    } catch {
      if (alive.current)
        setError(
          'The setting was read, but this browser could not clear the receipt. Retry the retained change.',
        );
    }
  };
  const save = async (request: Save) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = projectQuarkPolicySchema.parse(await api(path, request));
      if (receipt.projectId !== projectId)
        throw new Error('Could not confirm this project’s setting.');
      // An idempotent receipt may describe an older value. Display only the fresh read.
      await read();
      clear(request);
    } catch (reason) {
      const conflict =
        reason instanceof ApiError && !connectionLost(reason) && reason.status === 409;
      if (conflict) {
        clear(request);
        await read().catch(() => {});
      }
      if (alive.current)
        setError(
          conflict
            ? 'The project setting changed elsewhere. Review its current value and choose again.'
            : `${failure(reason)} Your change is retained; retry to confirm it.`,
        );
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const change = () => {
    if (!policy || busy || reading || readingError || pending || locked.current) return;
    try {
      const existing = retained();
      if (existing) {
        setPending(existing);
        setError('An earlier change is retained. Retry it before choosing another setting.');
        return;
      }
      const request: Save = {
        key: crypto.randomUUID(),
        enabled: !policy.enabled,
        expectedRevision: policy.revision,
      };
      localStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      void save(request);
    } catch {
      setError('This browser could not retain the change. No setting was changed. Try again.');
    }
  };
  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        className="conversation-menu-item project-quark-toggle"
        aria-label="Follow QUARK"
        aria-checked={policy ? policy.enabled : 'mixed'}
        aria-describedby={description}
        aria-busy={busy || undefined}
        disabled={!policy || busy || reading || !!readingError || !!pending}
        onClick={change}
      >
        <span>
          <strong>Follow QUARK</strong>
          <small>Project + all workers</small>
        </span>
        <span className="project-quark-value" aria-hidden="true">
          <span className="project-quark-switch" />
          <span>{policy ? (policy.enabled ? 'On' : 'Off') : '…'}</span>
        </span>
      </button>
      <span id={description} className="home-sr-only">
        On follows QUARK allowance limits, reserves and rate pacing for this project and all
        workers. Off keeps them off until you turn this on again. Stop, held jobs, native
        permissions and provider limits still apply.
      </span>
      {(busy || pending) && (
        <p className="project-quark-status" role="status">
          {busy ? 'Saving…' : `${pending!.enabled ? 'On' : 'Off'} change unconfirmed.`}
        </p>
      )}
      {(error || readingError) && (
        <p className="project-quark-status chat-panel-error" role="alert">
          {error || readingError}
        </p>
      )}
      {pending && (
        <button
          type="button"
          role="menuitem"
          className="conversation-menu-item"
          disabled={busy || reading}
          onClick={() => void save(pending)}
        >
          Retry QUARK change
        </button>
      )}
      {readingError && !pending && (
        <button
          type="button"
          role="menuitem"
          className="conversation-menu-item"
          disabled={busy || reading}
          onClick={() => void read().catch(() => {})}
        >
          Read QUARK setting again
        </button>
      )}
    </>
  );
}
