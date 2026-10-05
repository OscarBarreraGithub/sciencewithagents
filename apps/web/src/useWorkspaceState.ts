import { useCallback, useEffect, useRef, useState } from 'react';
import {
  workspaceDraftsSchema,
  workspaceDraftUpdateResultSchema,
  workspaceDraftUpdateSchema,
  workspaceSnapshotSchema,
  workspaceRestoreResultsSchema,
  workspaceUpdateResultSchema,
  workspaceUpdateSchema,
  type WorkspaceDraft,
  type WorkspaceDrafts,
  type WorkspaceDraftSubmission,
  type WorkspaceDraftUpdate,
  type WorkspaceSnapshot,
  type WorkspaceRestoreResults,
  type WorkspaceUpdate,
} from '@dock/shared';
import { api, apiScope, ApiError } from './api';

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The connection was interrupted. Your changes are retained here.';
export const workspaceStorageKey = (part: string) => `dock:${apiScope()}:workspace:${part}`;

/** Metadata-only handoff. Neither mounting nor opening a saved view starts a model turn. */
export function useWorkspaceState(label = 'This browser') {
  const scope = useRef(apiScope()).current;
  const keyFor = (part: string) => `dock:${scope}:workspace:${part}`;
  const request = (path: string, body?: unknown) => {
    if (apiScope() !== scope)
      throw new Error('The selected computer changed. Reopen the original computer to retry.');
    return api(path, body);
  };
  const [state, setState] = useState<WorkspaceSnapshot | null>(null);
  const current = useRef(state);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreResults, setRestoreResults] = useState<WorkspaceRestoreResults | null>(null);
  const restoreInFlight = useRef(false);
  const pending = useRef<WorkspaceUpdate | null>(null);
  const working = useRef(false);
  const alive = useRef(true);
  const boot = useRef<(() => Promise<void>) | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const accept = useCallback((value: WorkspaceSnapshot) => {
    if (
      current.current &&
      current.current.client.id === value.client.id &&
      current.current.client.revision > value.client.revision
    )
      return current.current;
    current.current = value;
    if (alive.current) setState(value);
    return value;
  }, []);
  const refresh = useCallback(async () => {
    if (!current.current) {
      await boot.current?.();
      return;
    }
    try {
      accept(
        workspaceSnapshotSchema.parse(await request(`/workspace/${current.current.client.id}`)),
      );
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
      await boot.current?.();
    }
  }, [accept]);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let starting = false;
    const start = async () => {
      if (starting) return;
      starting = true;
      try {
        if (!cancelled) setError('');
        const identityKey = keyFor('client');
        const id = localStorage.getItem(identityKey);
        let value: WorkspaceSnapshot | null = null;
        let replaced = false;
        if (id) {
          try {
            value = workspaceSnapshotSchema.parse(
              await request(`/workspace/${encodeURIComponent(id)}`),
            );
          } catch (reason) {
            if (!(reason instanceof ApiError) || reason.status !== 404) throw reason;
            // A reset/restored computer can forget a browser. Keep drafts and old
            // receipts locally, but never replay an old workspace action onto it.
            const old = localStorage.getItem(keyFor('pending'));
            if (old) localStorage.setItem(keyFor(`retired:${id}`), old);
            localStorage.removeItem(keyFor('pending'));
            localStorage.removeItem(identityKey);
            pending.current = null;
            replaced = true;
          }
        }
        if (!value) {
          const registrationKey = keyFor('registration');
          const key = localStorage.getItem(registrationKey) ?? crypto.randomUUID();
          localStorage.setItem(registrationKey, key);
          value = workspaceSnapshotSchema.parse(
            await request('/workspace/clients', { key, label }),
          );
          localStorage.setItem(identityKey, value.client.id);
          localStorage.removeItem(registrationKey);
        }
        if (cancelled) return;
        const saved = localStorage.getItem(keyFor('pending'));
        if (saved) pending.current = workspaceUpdateSchema.parse(JSON.parse(saved));
        accept(value);
        if (replaced)
          setError(
            'This computer no longer had this browser registered. It is connected again; your local drafts are retained and no old request was replayed.',
          );
        else if (saved)
          setError(
            'An open-conversation change needs a connection retry. It has not been discarded.',
          );
      } catch (reason) {
        if (!cancelled) setError(message(reason));
      } finally {
        starting = false;
      }
    };
    boot.current = start;
    void start();
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 15_000);
    const focus = () => {
      void refresh().catch(() => {});
    };
    window.addEventListener('focus', focus);
    window.addEventListener('dock:host-connected', focus);
    return () => {
      cancelled = true;
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('dock:host-connected', focus);
    };
  }, [accept, label, refresh]);

  const performOne = async (action?: WorkspaceUpdate['action']) => {
    if (working.current) return null;
    if (!current.current) {
      await boot.current?.();
      return current.current;
    }
    working.current = true;
    setBusy(true);
    setError('');
    try {
      if (action && pending.current)
        throw new Error(
          'Retry the previous workspace change first. Your open conversations are retained.',
        );
      const input =
        pending.current ??
        (action
          ? {
              key: crypto.randomUUID(),
              hostId: current.current.hostId,
              revision: current.current.client.revision,
              action,
            }
          : null);
      if (!input) {
        await refresh();
        return current.current;
      }
      pending.current = input;
      localStorage.setItem(keyFor('pending'), JSON.stringify(input));
      const result = workspaceUpdateResultSchema.parse(
        await request(`/workspace/${current.current.client.id}`, input),
      );
      pending.current = null;
      localStorage.removeItem(keyFor('pending'));
      accept(result.state);
      if (result.status === 'conflict') throw new Error(result.reason);
      await refresh();
      return current.current;
    } catch (reason) {
      setError(message(reason));
      return null;
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const perform = (action?: WorkspaceUpdate['action']) => {
    const next = queue.current.then(() => performOne(action));
    queue.current = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const restore = async () => {
    if (restoreInFlight.current) return;
    restoreInFlight.current = true;
    setRestoring(true);
    setRestoreError('');
    setRestoreResults(null);
    try {
      if (!current.current) await boot.current?.();
      const saved = current.current;
      if (!saved)
        throw new Error('Reconnect to this computer first. Your saved views are retained.');
      const results = workspaceRestoreResultsSchema.parse(
        await request(`/workspace/${saved.client.id}/restore`, { hostId: saved.hostId }),
      );
      if (alive.current) setRestoreResults(results);
    } catch (reason) {
      if (alive.current) setRestoreError(message(reason));
    } finally {
      restoreInFlight.current = false;
      if (alive.current) setRestoring(false);
    }
  };
  return {
    state,
    error,
    busy,
    restoring,
    restoreError,
    restoreResults,
    restore,
    refresh,
    retry: () => perform(),
    open: (agentId: string) => perform({ kind: 'open', agentId }),
    close: (agentId: string) => perform({ kind: 'close', agentId }),
    rename: (label: string) => perform({ kind: 'rename', label }),
    continueHere: (sourceClientId: string, sourceRevision: number) =>
      perform({ kind: 'adopt', sourceClientId, sourceRevision }),
  };
}

export type SharedDraft = ReturnType<typeof useSharedDraft>;

/** Per-browser CAS drafts. A remote update never replaces unsaved local typing. */
export function useSharedDraft(workspace: WorkspaceSnapshot | null, agentId: string) {
  const scope = useRef(apiScope()).current;
  const storageKey = `dock:${scope}:workspace:draft:${agentId}`;
  const request = (path: string, body?: unknown) => {
    if (apiScope() !== scope)
      throw new Error('The selected computer changed. Your draft stays on its original computer.');
    return api(path, body);
  };
  const [text, updateText] = useState(() => {
    try {
      return String(
        (JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { text: string } | null)?.text ??
          '',
      );
    } catch {
      return '';
    }
  });
  const textRef = useRef(text);
  const own = useRef<WorkspaceDrafts | null>(null);
  const pending = useRef<WorkspaceDraftUpdate | null>(null);
  const inFlight = useRef<Promise<WorkspaceDraftSubmission | null> | null>(null);
  const dirty = useRef(false);
  const blocked = useRef(false);
  const alive = useRef(true);
  const [state, setState] = useState<WorkspaceDrafts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const clientId = workspace?.client.id ?? '';
  const hostId = workspace?.hostId ?? '';
  const path = `/workspace/${clientId}/drafts/${agentId}`;

  const persist = () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ text: textRef.current, baseRevision: own.current?.own.revision ?? 0 }),
    );
  };
  const install = (next: WorkspaceDrafts) => {
    own.current = next;
    if (alive.current) setState(next);
  };
  const setText = (next: string) => {
    textRef.current = next;
    dirty.current = true;
    updateText(next);
    try {
      persist();
    } catch {
      setError('Browser draft storage is full. Keep this page open until your text is saved.');
    }
  };
  const markConflict = (reason: string) => {
    blocked.current = true;
    if (alive.current) {
      setConflict(true);
      setError(reason);
    }
  };
  const refresh = async (initial = false) => {
    const next = workspaceDraftsSchema.parse(await request(path));
    if (!alive.current) return;
    if (next.hostId !== hostId)
      throw new Error('The connected computer changed. Reopen it before editing.');
    if (own.current && next.own.revision < own.current.own.revision) return;
    if (initial || !own.current) {
      const raw = localStorage.getItem(storageKey);
      const saved = raw ? (JSON.parse(raw) as { text?: string; baseRevision?: number }) : null;
      const savedPending = localStorage.getItem(`${storageKey}:save`);
      if (savedPending)
        pending.current = workspaceDraftUpdateSchema.parse(JSON.parse(savedPending));
      if (saved && typeof saved.text === 'string') {
        dirty.current = textRef.current !== next.own.text;
        if (dirty.current && !pending.current && saved.baseRevision !== next.own.revision)
          markConflict(
            'A newer version was saved in another tab. Your typing is retained here; choose which version to keep.',
          );
      } else if (!dirty.current) {
        textRef.current = next.own.text;
        updateText(next.own.text);
      }
    } else if (
      !inFlight.current &&
      !pending.current &&
      own.current?.own.revision !== next.own.revision
    ) {
      if (dirty.current && textRef.current !== next.own.text)
        markConflict('Another tab saved a different draft. Your text has not been overwritten.');
      else {
        textRef.current = next.own.text;
        dirty.current = false;
        updateText(next.own.text);
      }
    }
    if (!inFlight.current) {
      install(next);
      if (!dirty.current && !blocked.current) persist();
    }
  };
  useEffect(() => {
    alive.current = true;
    if (!clientId || !agentId) return;
    void refresh(true).catch((reason) => {
      if (alive.current) setError(message(reason));
    });
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 10_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
    // Composer must be keyed by host and agent; workspace list refreshes are not draft resets.
  }, [clientId, hostId, agentId]);

  const token = (): WorkspaceDraftSubmission | null => {
    const draft = own.current?.own;
    return draft?.deliveryKey
      ? { hostId, clientId, revision: draft.revision, deliveryKey: draft.deliveryKey }
      : null;
  };
  const flush = (): Promise<WorkspaceDraftSubmission | null> => {
    if (inFlight.current) return inFlight.current;
    const save = async () => {
      if (!own.current)
        throw new Error(
          'Wait for this computer to reconnect before sending. Your draft stays here.',
        );
      if (blocked.current)
        throw new Error('Resolve the draft conflict before sending. Both versions are retained.');
      if (alive.current) {
        setSaving(true);
        setError('');
      }
      try {
        while (pending.current || dirty.current) {
          const input = pending.current ?? {
            key: crypto.randomUUID(),
            hostId,
            revision: own.current.own.revision,
            action: { kind: 'save' as const, text: textRef.current },
          };
          pending.current = input;
          localStorage.setItem(`${storageKey}:save`, JSON.stringify(input));
          const result = workspaceDraftUpdateResultSchema.parse(await request(path, input));
          pending.current = null;
          localStorage.removeItem(`${storageKey}:save`);
          if (own.current.own.revision > result.state.own.revision) {
            if (textRef.current !== own.current.own.text) {
              markConflict(
                'The saved draft is newer than this retry receipt. Your local text is retained; review both versions.',
              );
              throw new Error('Review the newer saved draft before continuing.');
            }
            dirty.current = false;
            persist();
            continue;
          }
          install(result.state);
          if (result.status === 'conflict') {
            markConflict(result.reason ?? 'The saved draft changed. Your local text is retained.');
            throw new Error(result.reason);
          }
          if (input.action.kind === 'copy') {
            if (!textRef.current.trim()) {
              textRef.current = result.state.own.text;
              if (alive.current) updateText(result.state.own.text);
            } else {
              markConflict(
                'Your typing is retained. The copied draft is saved separately; choose the version to keep.',
              );
              throw new Error('Review both draft versions before continuing.');
            }
          }
          dirty.current = textRef.current !== result.state.own.text;
          persist();
        }
        return token();
      } finally {
        if (alive.current) setSaving(false);
      }
    };
    inFlight.current = save()
      .catch((reason) => {
        if (alive.current) setError(message(reason));
        throw reason;
      })
      .finally(() => {
        inFlight.current = null;
      });
    return inFlight.current;
  };
  useEffect(() => {
    if (!state || conflict || (!dirty.current && !pending.current)) return;
    const timer = window.setTimeout(() => {
      void flush().catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [text, Boolean(state), conflict]);

  const copyDraft = async (source: WorkspaceDraft) => {
    if (!own.current || blocked.current)
      throw new Error('Reconnect and resolve any draft conflict first.');
    if (textRef.current.trim())
      throw new Error('Save or send your current draft before copying another one here.');
    await flush();
    const input: WorkspaceDraftUpdate = {
      key: crypto.randomUUID(),
      hostId,
      revision: own.current.own.revision,
      action: { kind: 'copy', sourceClientId: source.clientId, sourceRevision: source.revision },
    };
    pending.current = input;
    localStorage.setItem(`${storageKey}:save`, JSON.stringify(input));
    await flush();
  };
  const useSavedVersion = () => {
    if (!own.current || pending.current) return;
    textRef.current = own.current.own.text;
    updateText(textRef.current);
    dirty.current = false;
    blocked.current = false;
    setConflict(false);
    setError('');
    persist();
  };
  const keepMyVersion = () => {
    if (!own.current || pending.current) return;
    blocked.current = false;
    setConflict(false);
    setError('');
    dirty.current = true;
    persist();
    void flush().catch(() => {});
  };
  const clearSent = async (sentText: string, submitted: WorkspaceDraftSubmission) => {
    if (
      textRef.current.trim() !== sentText ||
      own.current?.own.deliveryKey !== submitted.deliveryKey
    )
      return;
    setText('');
    await flush();
  };
  return {
    text,
    currentText: () => textRef.current,
    setText,
    state,
    ready: Boolean(state),
    saving,
    unsaved: Boolean(state && text !== state.own.text),
    error,
    conflict,
    flush,
    retry: () => (own.current ? flush() : refresh(true)),
    copyDraft,
    useSavedVersion,
    keepMyVersion,
    clearSent,
  };
}
