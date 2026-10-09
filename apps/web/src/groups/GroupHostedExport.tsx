import { useState } from 'react';
import {
  groupExportArchiveSchema,
  groupExportArchiveRequestSchema,
  GROUP_EXPORT_LIMITS,
} from '@dock/shared/dist/group-hosted-export.js';
import { api, apiScope, ApiError } from '../api';
type Receipt = ReturnType<typeof groupExportArchiveSchema.parse>;
const description = (saved: Receipt) =>
  `Verified private archive ${saved.archiveId}: ${saved.rows.toLocaleString()} rows, ${saved.bytes.toLocaleString()} bytes. Your setup agent can copy it from this computer’s Groups hosted-archives folder. This does not back up local agent histories or restore data.`;
export function GroupHostedExport({ handle }: { handle: string }) {
  const storage = `swa:${apiScope()}:group-hosted-export:${handle}`;
  const [retained, setRetained] = useState<{ key: string; receipt: Receipt | null } | null>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storage) ?? 'null') as {
        key?: unknown;
        receipt?: unknown;
      } | null;
      if (!raw) return null;
      const key = groupExportArchiveRequestSchema.shape.key.parse(raw.key);
      return { key, receipt: raw.receipt ? groupExportArchiveSchema.parse(raw.receipt) : null };
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false),
    [held, setHeld] = useState(false),
    [message, setMessage] = useState(() =>
      retained?.receipt
        ? description(retained.receipt)
        : retained
          ? 'An export acknowledgement is pending. Retry to reconcile the same private archive.'
          : '',
    );
  return (
    <details className="group-host-members">
      <summary>Private hosted backup</summary>
      <p>
        Save and verify the hosted group’s shared data, membership and receipts privately on this
        creator computer. Choose a quiet window: new group changes interrupt the export.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage('Exporting and verifying hosted data…');
          void (async () => {
            try {
              // Keep unknown acknowledgements across reloads and browser restarts.
              // A new key needs explicit success or held-file disposition.
              const pending =
                retained && !retained.receipt && !held
                  ? retained
                  : { key: crypto.randomUUID(), receipt: null };
              localStorage.setItem(storage, JSON.stringify(pending));
              setRetained(pending);
              setHeld(false);
              const saved = groupExportArchiveSchema.parse(
                await api(
                  '/groups/hosted-export',
                  { handle, key: pending.key },
                  undefined,
                  GROUP_EXPORT_LIMITS.timeoutMs + 5000,
                ),
              );
              const complete = { key: pending.key, receipt: saved };
              localStorage.setItem(storage, JSON.stringify(complete));
              setRetained(complete);
              setMessage(description(saved));
            } catch (error) {
              setHeld(error instanceof ApiError && error.code === 'GROUP_EXPORT_HELD');
              setMessage((error as Error).message);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        {busy
          ? 'Exporting…'
          : held
            ? 'Keep held archive and export a fresh snapshot'
            : retained?.receipt
              ? 'Export another snapshot'
              : 'Export hosted data'}
      </button>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
