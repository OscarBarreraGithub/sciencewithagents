import { useState } from 'react';
import { apiScope } from './api';

/** Only this browser's own retained text; no server read or automatic resend. */
export function RetainedDraft({ agentId }: { agentId?: string }) {
  const [copied, setCopied] = useState(false);
  const id = agentId ?? location.hash.match(/^#\/chat\/([a-f0-9-]{36})(?:\/|$)/i)?.[1];
  let text = '';
  try {
    const saved =
      id && JSON.parse(localStorage.getItem(`dock:${apiScope()}:workspace:draft:${id}`) ?? 'null');
    if (saved && typeof saved.text === 'string') text = saved.text;
  } catch {
    /* Corrupt browser storage cannot block the reconnect controls. */
  }
  if (!text) return null;
  return (
    <section className="draft-handoff" aria-label="Retained browser draft">
      <h2>Your draft on this device</h2>
      <pre className="draft-preview">{text}</pre>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy draft'}
      </button>
      <p>Sending will be available when this computer reconnects.</p>
    </section>
  );
}
