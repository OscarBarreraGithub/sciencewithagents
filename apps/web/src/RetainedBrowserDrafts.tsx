import { useState } from 'react';
import { retainedBrowserDraftsSchema, type RetainedBrowserDrafts as Retained } from '@dock/shared';
import { downloadBlob } from './downloadBlob';
import './RetainedBrowserDrafts.css';

const prefix = 'dock:local-access:retained:';

function readCopies() {
  const copies: { id: string; value: Retained }[] = [];
  let unreadable = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      try {
        copies.push({
          id: key,
          value: retainedBrowserDraftsSchema.parse(JSON.parse(localStorage.getItem(key)!)),
        });
      } catch {
        unreadable = true;
      }
    }
  } catch {
    unreadable = true;
  }
  return {
    copies: copies.sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)),
    unreadable,
  };
}

function label(key: string) {
  if (key.includes('mirror:')) return 'Editor conversation draft';
  if (key.includes('workspace:draft:')) return 'Conversation draft';
  if (/pending|request|start|recovery-copy/.test(key)) return 'Pending request record';
  if (key.includes('project')) return 'Project draft or preference';
  return 'Saved draft or preference';
}

function display(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function download(value: Retained) {
  downloadBlob(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    'sciencewithagents-retained-browser-drafts.json',
  );
}

/** Local browser evidence only. Never replays requests or replaces current drafts. */
export function RetainedBrowserDrafts() {
  const [{ copies, unreadable }] = useState(readCopies);
  if (!copies.length && !unreadable) return null;
  return (
    <section className="retained-drafts" aria-labelledby="retained-drafts-title">
      <h2 id="retained-drafts-title">Retained browser drafts</h2>
      <p>
        These versions were kept when this browser reconnected. Your current drafts take precedence.
        You can read or download the older versions here; pending requests are not sent again.
      </p>
      <p>These copies belong to this browser, even when you select a different computer.</p>
      {unreadable && (
        <p role="alert">Some browser copies could not be read. They have not been removed.</p>
      )}
      <div
        className="retained-copy-list"
        role="region"
        aria-label="Retained browser copies"
        tabIndex={0}
      >
        {copies.map(({ id, value }) => (
          <details key={id} className="retained-copy">
            <summary>
              {value.entries.length} retained {value.entries.length === 1 ? 'item' : 'items'} ·{' '}
              {new Date(value.createdAt).toLocaleString()}
            </summary>
            <button className="flow-button" onClick={() => download(value)}>
              Download this copy
            </button>
            {value.entries.map((entry, index) => (
              <details key={`${entry.kind}:${entry.key}`} className="retained-entry">
                <summary>
                  {label(entry.key)} {index + 1}
                </summary>
                <label>
                  Retained text
                  <textarea readOnly value={display(entry.value)} spellCheck={false} />
                </label>
                <details>
                  <summary>Record details</summary>
                  <p>{entry.kind === 'session' ? 'From the original tab' : 'From this browser'}</p>
                  <code>{entry.key}</code>
                  <p>Original local address: {value.source}</p>
                </details>
              </details>
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}
