import { useRef, useState } from 'react';
import {
  bugReportRequestSchema,
  bugReportSchema,
  bugReportsSchema,
  type BugReport as Report,
} from '@dock/shared';
import { api, apiScope, ApiError } from '../api';
import { Modal } from '../Modal';
import { useReading } from './useHomeData';
import './bug-report.css';

export function BugReport({ page, close }: { page: string; close: () => void }) {
  const storageKey = `dock:${apiScope()}:bug-report-draft`;
  const [restored] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      const saved = bugReportRequestSchema.safeParse(raw?.request);
      if (saved.success) return { request: saved.data, pending: raw.pending === true };
    } catch {
      /* Storage can be unavailable. */
    }
    return {
      request: { key: crypto.randomUUID(), description: '', page: `#/${page.split('?')[0]}` },
      pending: false,
    };
  });
  const [draft, setDraft] = useState(restored.request);
  const [pending, setPending] = useState(restored.pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Report | null>(null);
  const sending = useRef(false);
  const reports = useReading('/bug-reports', bugReportsSchema.parse);
  function edit(description: string) {
    const next = { ...draft, description };
    setDraft(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ request: next, pending: false }));
    } catch {
      /* Keep the visible draft. */
    }
  }
  async function submit() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setPending(true);
    setError('');
    try {
      // Keep the same receipt after a lost response, including across reopening.
      localStorage.setItem(storageKey, JSON.stringify({ request: draft, pending: true }));
    } catch {
      /* Submission still works when browser storage is disabled. */
    }
    try {
      const result = bugReportSchema.parse(await api('/bug-reports', draft));
      setSaved(result);
      setPending(false);
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Best effort. */
      }
      reports.retry();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 400) {
        setPending(false);
        try {
          localStorage.setItem(storageKey, JSON.stringify({ request: draft, pending: false }));
        } catch {
          /* Keep visible draft. */
        }
      }
      setError(
        `${reason instanceof Error ? reason.message : 'The connection was interrupted.'} Your report is retained. Retry checks the same report.`,
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="Ask an agent to fix a problem" close={close} className="bug-report-dialog">
      {saved ? (
        <div className="bug-report-result" role="status">
          <h3>Report saved</h3>
          <p>{saved.message}</p>
          <p>
            Added to the maintenance manager’s to-do list. It will investigate, delegate a fix and
            review the result.
          </p>
          <small>Local folder: {saved.folder}</small>
          <a className="flow-button primary" href={`#/chat/${saved.managerId}`} onClick={close}>
            Open maintenance chat
          </a>
          {!saved.fileSaved && (
            <button className="flow-button" disabled={busy} onClick={() => void submit()}>
              Retry folder copy
            </button>
          )}
        </div>
      ) : (
        <form
          className="bug-report-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>
            Describe what happened and what you expected. Your private repair request and this
            page’s queue status stay on the selected computer.
          </p>
          <label htmlFor="bug-description">What went wrong?</label>
          <textarea
            id="bug-description"
            rows={7}
            maxLength={8000}
            value={draft.description}
            disabled={busy || pending}
            placeholder="For example: my worker is waiting for a budget increase even though plenty of allowance remains."
            onChange={(event) => edit(event.target.value)}
          />
          <p className="bug-report-note">
            Assigning starts the app’s maintenance manager using your model settings and may use
            your model allowance. It can delegate and apply reviewed fixes; it won’t publish the
            report or restart running work.
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="flow-button primary"
            disabled={busy || !draft.description.trim()}
          >
            {busy ? 'Saving…' : pending ? 'Retry same report' : 'Save and assign'}
          </button>
        </form>
      )}
      {!!reports.data?.items.length && (
        <details className="bug-report-history">
          <summary>Recent reports ({reports.data.items.length})</summary>
          <ul>
            {reports.data.items.map((report) => (
              <li key={report.id}>
                <strong>{report.description.split('\n')[0]?.slice(0, 180)}</strong>
                <p>{report.message}</p>
                <a className="flow-button" href={`#/chat/${report.managerId}`} onClick={close}>
                  Open maintenance chat
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Modal>
  );
}
