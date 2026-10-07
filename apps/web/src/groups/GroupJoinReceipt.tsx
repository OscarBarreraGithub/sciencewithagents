import { useEffect, useRef, useState } from 'react';
import { groupHostOpenSchema } from '@dock/shared/dist/group-host.js';
import { api, ApiError } from '../api';

export function GroupJoinReceipt({
  receipt,
  onApproved,
}: {
  receipt: { handle: string; name: string; confirmation: string };
  onApproved: () => void;
}) {
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const code = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (approved) return;
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
        setApproved(true);
        setError('');
        onApproved();
      } catch (reason) {
        if (!read.signal.aborted)
          setError(
            reason instanceof ApiError && reason.code === 'GROUP_PENDING'
              ? ''
              : 'Could not check approval. Reconnecting automatically; your request is saved.',
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
  }, [receipt.handle, approved, onApproved]);
  return (
    <section className="group-join-receipt" aria-label="Join request status">
      <h2 ref={heading} tabIndex={-1}>
        {approved ? 'You’re approved' : 'Request sent'}
      </h2>
      <p role="status">
        {approved
          ? `You can now open ${receipt.name}.`
          : `Waiting for creator approval for ${receipt.name}.`}
      </p>
      {approved ? (
        <button
          className="primary"
          onClick={() => {
            location.hash = `#/groups/${receipt.handle}`;
          }}
        >
          Open group
        </button>
      ) : (
        <>
          <p>
            Send this confirmation code privately to the creator. They select your name under{' '}
            <strong>Join requests</strong> and paste the code to approve you.
          </p>
          <label>
            Confirmation code
            <input ref={code} readOnly value={receipt.confirmation} />
          </label>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(receipt.confirmation);
                setCopied(true);
                setCopyFailed(false);
              } catch {
                code.current?.focus();
                code.current?.select();
                setCopyFailed(true);
              }
            }}
          >
            {copied ? 'Code copied' : 'Copy confirmation code'}
          </button>
          {copyFailed && (
            <p role="status">The code is selected. Copy it by hand and send it privately.</p>
          )}
          {error && <p role="status">{error}</p>}
        </>
      )}
    </section>
  );
}
