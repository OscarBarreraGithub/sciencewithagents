import type { JobEstimate, WorkspaceDraftSubmission } from '@dock/shared';

export type PendingMessage = {
  key: string;
  text: string;
  steer: boolean;
  draft?: WorkspaceDraftSubmission;
  scheduling?: JobEstimate;
  modeUnknown?: boolean;
};

const listeners = new WeakMap<Storage, Map<string, Set<(pending: PendingMessage) => void>>>();

export function samePendingMessage(value: unknown, pending: PendingMessage): boolean {
  if (!value || typeof value !== 'object') return false;
  const other = value as PendingMessage;
  return (
    other.key === pending.key &&
    other.text === pending.text &&
    (other.steer === true) === (pending.steer === true) &&
    (typeof other.steer !== 'boolean' || Boolean(other.modeUnknown)) ===
      (typeof pending.steer !== 'boolean' || Boolean(pending.modeUnknown)) &&
    JSON.stringify(other.draft ?? null) === JSON.stringify(pending.draft ?? null) &&
    JSON.stringify(other.scheduling ?? null) === JSON.stringify(pending.scheduling ?? null)
  );
}

export function ownsPendingMessage(storage: Storage, storageKey: string, pending: PendingMessage) {
  const saved = storage.getItem(`${storageKey}:pending`);
  return saved !== null && samePendingMessage(JSON.parse(saved), pending);
}

// This is only a same-document notification of an already acknowledged send.
// Storage objects keep tab-local Groups receipts separate from ordinary receipts.
export function onPendingMessageSettled(
  storage: Storage,
  storageKey: string,
  listener: (pending: PendingMessage) => void,
) {
  let keys = listeners.get(storage);
  if (!keys) listeners.set(storage, (keys = new Map()));
  let subscribers = keys.get(storageKey);
  if (!subscribers) keys.set(storageKey, (subscribers = new Set()));
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) keys.delete(storageKey);
  };
}

export function settlePendingMessage(
  storage: Storage,
  storageKey: string,
  pending: PendingMessage,
) {
  const saved = storage.getItem(`${storageKey}:pending`);
  // An old view's acknowledgement must not remove a newer view's pending send.
  if (saved && !samePendingMessage(JSON.parse(saved), pending)) return false;
  storage.removeItem(`${storageKey}:pending`);
  for (const listener of listeners.get(storage)?.get(storageKey) ?? []) listener(pending);
  return true;
}
