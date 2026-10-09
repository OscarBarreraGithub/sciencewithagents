import { useId, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { apiScope } from '../api';
import { Modal } from '../Modal';
import './issue-report.css';

const issueUrl = 'https://github.com/OscarBarreraGithub/sciencewithagents/issues/new';
const emptyDraft = { title: '', description: '' };

export function IssueReport({ page, close }: { page: string; close: () => void }) {
  const storageKey = `dock:${apiScope()}:github-issue-draft`;
  const noteId = useId();
  const [copyStatus, setCopyStatus] = useState('');
  const [draft, setDraft] = useState(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (
        saved &&
        typeof saved === 'object' &&
        'title' in saved &&
        typeof saved.title === 'string' &&
        'description' in saved &&
        typeof saved.description === 'string'
      )
        return { title: saved.title.slice(0, 120), description: saved.description.slice(0, 6000) };
    } catch {
      /* The visible form still works when browser storage is unavailable. */
    }
    return emptyDraft;
  });
  function edit(next: typeof emptyDraft) {
    setDraft(next);
    setCopyStatus('');
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Keep the visible draft. */
    }
  }
  const ready = !!draft.title.trim() && !!draft.description.trim();
  const target = new URL(issueUrl);
  target.searchParams.set('title', draft.title.trim());
  // Only the screen name is included: never a chat/project identifier, query or full URL.
  const screen = page.split(/[/?#]/)[0] || 'home';
  const body = `## What happened?\n${draft.description.trim()}\n\n## App screen\n${screen}`;
  target.searchParams.set('body', body);
  const needsCopy = target.href.length > 7500;
  async function copyReport() {
    try {
      await navigator.clipboard.writeText(`${draft.title.trim()}\n\n${body}`);
      setCopyStatus('Report copied. Paste the summary and description into the new GitHub issue.');
    } catch {
      setCopyStatus(
        'Copying was blocked. Select and copy your summary and description above, then paste them on GitHub.',
      );
    }
  }
  return (
    <Modal title="Report a problem on GitHub" close={close} className="issue-report-dialog">
      <div className="issue-report-form">
        <p id={noteId} className="issue-report-note">
          Tell the sciencewithagents maintainers what went wrong. GitHub issues are public and
          require GitHub sign-in. Include only information you want to share publicly.
        </p>
        <div className="issue-report-field">
          <label htmlFor={`${noteId}-summary`}>Summary</label>
          <input
            id={`${noteId}-summary`}
            value={draft.title}
            maxLength={120}
            onChange={(event) => edit({ ...draft, title: event.target.value })}
            placeholder="A short description of the problem"
            aria-describedby={noteId}
          />
        </div>
        <div className="issue-report-field">
          <label htmlFor={`${noteId}-description`}>What happened?</label>
          <textarea
            id={`${noteId}-description`}
            value={draft.description}
            maxLength={6000}
            rows={7}
            onChange={(event) => edit({ ...draft, description: event.target.value })}
            placeholder="What were you trying to do? What happened, and what did you expect?"
            aria-describedby={noteId}
          />
        </div>
        <p className="issue-report-note">
          This opens a draft on GitHub for you to review and submit. Only your text and the app
          screen name are included. Logs, conversations and account details are not attached.
        </p>
        {ready && needsCopy && (
          <p className="issue-report-note">
            This report is too long for a draft link. Copy it, open GitHub, and paste it into the
            new issue.
          </p>
        )}
        <div className="issue-report-actions">
          {ready && needsCopy && (
            <button type="button" className="flow-button" onClick={() => void copyReport()}>
              Copy report
            </button>
          )}
          {ready ? (
            <a
              className="flow-button primary"
              href={needsCopy ? issueUrl : target.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {needsCopy ? 'Open GitHub issue' : 'Open GitHub issue draft'}{' '}
              <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          ) : (
            <button type="button" className="flow-button primary" disabled>
              Open GitHub issue draft <ArrowUpRight size={17} aria-hidden="true" />
            </button>
          )}
          {(draft.title || draft.description) && (
            <button type="button" className="flow-button" onClick={() => edit(emptyDraft)}>
              Clear draft
            </button>
          )}
        </div>
        {copyStatus && (
          <p className="issue-report-note" role="status">
            {copyStatus}
          </p>
        )}
        <p className="issue-report-note">
          Your draft stays in this browser when you close this window or retry later.
        </p>
      </div>
    </Modal>
  );
}
