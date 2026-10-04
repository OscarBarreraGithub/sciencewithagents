import { useRef, useState } from 'react';
import {
  resourceStatusSchema,
  type ProviderId,
  type ResourceCheck,
  type ResourceSample,
  type ResourceStatus,
} from '@dock/shared';
import { api, apiScope, ApiError } from '../api';

import { ChatMarkdown } from '../ChatMarkdown';

export const providerNames: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude' };
export const pressureLabels: Record<ResourceSample['memoryPressure'], string> = {
  normal: 'Normal',
  warning: 'Elevated',
  critical: 'Critical',
  unknown: 'Not measured',
};
export const activeCheck = (check: ResourceCheck) => ['queued', 'running'].includes(check.state);

export function reportFallback(check: ResourceCheck) {
  return check.state === 'queued'
    ? 'Waiting for its turn in QUARK.'
    : check.state === 'running'
      ? 'Looking at the saved readings and current work…'
      : check.state === 'completed'
        ? 'This check finished without a written report.'
        : 'This check did not finish. It was not replayed; you can ask again.';
}

export const gb = (n: number | null | undefined) =>
  n == null ? null : `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
export const percent = (n: number | null | undefined) => (n == null ? null : `${Math.round(n)}%`);
export const mbps = (n: number | null | undefined) =>
  n == null ? null : `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB/s`;
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
export function ago(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** Reports share chat math formatting, with links and images kept inactive. */
export function ReportText({ text, fallback }: { text: string; fallback: string }) {
  return (
    <div className="health-report-text">
      <ChatMarkdown report>{text || fallback}</ChatMarkdown>
    </div>
  );
}

type ActionFailure = { path: string; message: string; uncertain: boolean };
/**
 * One receipt per resource action. An identical retry reuses the saved key, so a lost
 * acknowledgment is checked rather than repeated; a changed request gets a new key.
 */
export function useResourceActions(done: (status: ResourceStatus) => void) {
  const receipt = useRef<{ signature: string; key: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  async function run(path: string, payload: Record<string, unknown>, requestKey?: string) {
    const storageKey = `dock:${apiScope()}:resource-action:${path}`;
    // A composer's saved send key identifies the complete original request, even
    // if the visible model choice or current readings changed after a lost reply.
    if (requestKey) {
      try {
        const previous = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
        if (previous?.key === requestKey && previous.signature?.startsWith(`${path}:`))
          payload = JSON.parse(previous.signature.slice(path.length + 1));
      } catch {
        /* The current view still retains its key. */
      }
    }
    const signature = `${path}:${JSON.stringify(payload)}`;
    if (receipt.current?.signature !== signature) {
      receipt.current = { signature, key: crypto.randomUUID() };
      try {
        const previous = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
        if (previous?.signature === signature && typeof previous.key === 'string')
          receipt.current = { signature, key: previous.key };
        sessionStorage.setItem(storageKey, JSON.stringify(receipt.current));
      } catch {
        // The current view retains its receipt when browser storage is unavailable.
      }
    }
    if (requestKey) receipt.current.key = requestKey;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(receipt.current));
    } catch {
      /* Live receipt remains. */
    }
    const body = { key: receipt.current.key, ...payload };
    setBusy(path);
    setFailure(null);
    try {
      const status = resourceStatusSchema.parse(await api(path, body));
      try {
        const previous = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
        if (previous?.key === body.key) sessionStorage.removeItem(storageKey);
      } catch {
        /* Keep the confirmed response usable without browser storage. */
      }
      receipt.current = null;
      done(status);
      return status;
    } catch (error) {
      const definite = error instanceof ApiError && error.status >= 400 && error.status < 500;
      setFailure({
        path,
        uncertain: !definite,
        message:
          error instanceof Error && error.message
            ? error.message
            : 'Could not reach this computer.',
      });
      return null;
    } finally {
      setBusy(null);
    }
  }
  return { run, busy, failure, clear: () => setFailure(null) };
}
