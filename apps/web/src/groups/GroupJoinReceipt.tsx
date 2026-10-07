import { useEffect, useState } from 'react';
import { groupHostOpenSchema } from '@dock/shared/dist/group-host.js';
import { api, ApiError } from '../api';

/** Reopens a saved join made against an older service, without another enrollment. */
export function GroupJoinReceipt({
  receipt,
  onApproved,
}: {
  receipt: { handle: string; name: string };
  onApproved: () => void;
}) {
  const [error, setError] = useState('');
  useEffect(() => {
    let controller: AbortController | undefined;
    const check = async () => {
      if (document.hidden || controller) return;
      const read = new AbortController();
      controller = read;
      try {
        groupHostOpenSchema.parse(
          await api('/groups/open', { handle: receipt.handle }, read.signal),
        );
        if (read.signal.aborted) return;
        onApproved();
        location.hash = `#/groups/${receipt.handle}`;
      } catch (reason) {
        if (!read.signal.aborted)
          setError(
            reason instanceof ApiError && reason.code === 'GROUP_PENDING'
              ? 'This group service still uses the old approval flow. Ask the creator to update it; your request is saved.'
              : 'Could not connect. Retrying automatically; your request is saved.',
          );
      } finally {
        if (controller === read) controller = undefined;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 10000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
      controller?.abort();
    };
  }, [receipt.handle, onApproved]);
  return (
    <section className="group-join-receipt" aria-label="Join status">
      <h2>Joining {receipt.name}</h2>
      <p role="status">{error || 'Opening your group…'}</p>
    </section>
  );
}
