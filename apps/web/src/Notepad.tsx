import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Copy,
  Download,
  History,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import {
  promptTextLimit,
  withoutChatAttachments,
  withChatAttachmentText,
  type WorkspaceDraft,
} from '@dock/shared';
import { api, ApiError } from './api';
import { parseDraftHistory } from './home/chat-contracts';
import type { SharedDraft } from './useWorkspaceState';
import { DraftHandoff } from './WorkspacePanel';
import { fitToVisibleViewport } from './useVisibleViewport';
import './Notepad.css';
import { promptLengthError } from './promptLength';
import { downloadBlob } from './downloadBlob';

export type DraftSelection = { start: number; end: number };
// Every autosave is a version, so older pages stay behind an explicit request.
const maxVersions = 200;
const stamp = (value: string) =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Full-page view of the Composer's own shared draft; it never keeps a second copy. */
export function Notepad({
  draft,
  agentId,
  clientId,
  agentName,
  mode,
  selection,
  canSend,
  sending,
  notice,
  controls,
  overlay,
  attachments,
  onSend,
  onMinimize,
  localOnly = false,
  localHistory,
  maxLength = promptTextLimit,
  readOnly = false,
  title,
  sendLabel = 'Send',
  statusLabel,
  recoveryDescription,
  initialOptionsOpen = false,
  className = '',
}: {
  draft: SharedDraft;
  agentId: string;
  clientId: string | null;
  agentName: string;
  mode: 'brief' | 'message';
  selection: MutableRefObject<DraftSelection>;
  canSend: boolean;
  sending: boolean;
  notice: string;
  controls?: ReactNode;
  overlay?: ReactNode;
  attachments?: ReactNode;
  onSend: () => void;
  onMinimize: () => void;
  localOnly?: boolean;
  localHistory?: { versions: { text: string; at: string }[]; restore: (text: string) => void };
  maxLength?: number;
  readOnly?: boolean;
  title?: string;
  sendLabel?: string;
  statusLabel?: string;
  recoveryDescription?: string;
  initialOptionsOpen?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(initialOptionsOpen);
  const [exported, setExported] = useState('');
  const lengthError = promptLengthError(draft.text, maxLength);
  useEffect(() => {
    // Saving and device-transfer problems must stay actionable, even with options tucked away.
    if (draft.error || draft.conflict || notice || lengthError) setOptionsOpen(true);
  }, [draft.error, draft.conflict, notice, lengthError]);
  useEffect(() => {
    const element = dialog.current;
    const stop = element && fitToVisibleViewport(element, 'notepad');
    if (element && !element.open) element.showModal();
    const area = editor.current;
    if (area) {
      area.focus({ preventScroll: true });
      const { start, end } = selection.current;
      area.setSelectionRange(Math.min(start, area.value.length), Math.min(end, area.value.length));
    }
    return () => {
      stop?.();
      if (element?.open) element.close();
    };
  }, []);
  const remember = () => {
    const area = editor.current;
    if (area) selection.current = { start: area.selectionStart, end: area.selectionEnd };
  };
  const status = draft.error
    ? localOnly
      ? 'Not saved in this browser'
      : 'Not saved to this computer'
    : !draft.ready
      ? 'Kept in this browser · connecting'
      : draft.saving
        ? 'Saving…'
        : draft.unsaved
          ? 'Saved in this browser'
          : localOnly
            ? 'Saved in this browser'
            : 'Saved';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.currentText());
      setExported('Copied. Paste it somewhere safe if this browser’s storage is unavailable.');
    } catch {
      setExported('This browser blocked copying. Use Download instead.');
    }
  };
  const download = () => {
    downloadBlob(
      new Blob([draft.currentText()], { type: 'text/plain' }),
      `${agentName.replace(/[^\w -]+/g, '').trim() || 'draft'} draft.txt`,
    );
    setExported('Downloaded a text copy of this draft.');
  };
  // Keep the full-page editor outside the small composer's CSS ancestors.
  return createPortal(
    <dialog
      ref={dialog}
      className={`notepad ${historyOpen ? 'with-history' : ''} ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape keeps the draft and returns to chat; it never sends.
        event.preventDefault();
        if (optionsOpen) {
          setOptionsOpen(false);
          return;
        }
        remember();
        onMinimize();
      }}
    >
      <header className="notepad-bar">
        <div className="notepad-title">
          <p>{mode === 'brief' ? `First request for ${agentName}` : `Message to ${agentName}`}</p>
          <h2 id={titleId}>
            {title ?? (mode === 'brief' ? 'Describe your project' : 'Write at length')}
          </h2>
        </div>
        <span className={`notepad-status ${draft.error ? 'failed' : ''}`} role="status">
          {statusLabel ?? status}
        </span>
        <div className="notepad-actions">
          <button
            type="button"
            className="notepad-button notepad-history-toggle"
            aria-label="Versions"
            aria-expanded={historyOpen}
            aria-controls={`${titleId}-history`}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <History size={17} /> <span>Versions</span>
          </button>
          <button
            type="button"
            className="notepad-button notepad-options-toggle"
            aria-label="Notepad options"
            aria-expanded={optionsOpen}
            aria-controls={`${titleId}-options`}
            onClick={() => setOptionsOpen((open) => !open)}
          >
            <MoreHorizontal size={17} /> <span>Options</span>
          </button>
          <button
            type="button"
            className="notepad-button"
            onClick={() => {
              remember();
              onMinimize();
            }}
          >
            <Minimize2 size={17} /> <span>Minimize</span>
          </button>
          <button
            type="button"
            className="notepad-button primary"
            disabled={!canSend || sending}
            onClick={() => {
              remember();
              onSend();
            }}
          >
            {sending ? <RefreshCw className="spin" size={17} /> : <ArrowUp size={17} />}
            <span>{sending ? (sendLabel === 'Send' ? 'Sending…' : 'Saving…') : sendLabel}</span>
          </button>
        </div>
      </header>
      {attachments && <div className="notepad-attachments">{attachments}</div>}
      <div className="notepad-body">
        <div className="notepad-paper">
          <textarea
            ref={editor}
            aria-label={mode === 'brief' ? 'Project description' : `Long message to ${agentName}`}
            value={withoutChatAttachments(draft.text)}
            aria-invalid={!!lengthError || undefined}
            readOnly={readOnly}
            placeholder={
              mode === 'brief'
                ? 'Describe the goal, what you already know, and anything the manager should set up first. Minimize keeps your draft; Send starts the conversation.'
                : undefined
            }
            spellCheck
            onChange={(event) => {
              draft.setText(withChatAttachmentText(draft.currentText(), event.target.value));
              remember();
            }}
            onSelect={remember}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing &&
                canSend &&
                !sending
              ) {
                event.preventDefault();
                remember();
                onSend();
              }
            }}
          />
        </div>
        {historyOpen && localOnly ? (
          <aside className="notepad-history" id={`${titleId}-history`} aria-label="Saved versions">
            <h3>Saved versions</h3>
            <p>
              Saved on this browser, including recovery copies from earlier tabs. Restore copies
              text into this tab and keeps its current text too. It never sends.
            </p>
            <ol className="notepad-versions">
              {localHistory?.versions.map((version, i) => (
                <li key={`${version.at}:${i}`}>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => localHistory.restore(version.text)}
                  >
                    <strong>{stamp(version.at)}</strong>
                    <small>{version.text.slice(0, 120) || 'Empty draft'}</small>
                  </button>
                </li>
              ))}
            </ol>
            {!localHistory?.versions.length && <p>No saved versions yet.</p>}
          </aside>
        ) : (
          historyOpen && (
            <DraftHistory
              id={`${titleId}-history`}
              draft={draft}
              agentId={agentId}
              clientId={clientId}
              close={() => setHistoryOpen(false)}
            />
          )
        )}
      </div>
      {optionsOpen && (
        <section className="notepad-foot" id={`${titleId}-options`} aria-label="Notepad options">
          <div className="notepad-options-head">
            <strong>Notepad options</strong>
            <button type="button" className="notepad-button" onClick={() => setOptionsOpen(false)}>
              Close options
            </button>
          </div>
          <p className="notepad-count" aria-live="off">
            {draft.text.length.toLocaleString()} / {maxLength.toLocaleString()} characters
          </p>
          {localOnly && draft.error && (
            <p role="alert" className="notepad-notice">
              {draft.error}
            </p>
          )}
          {(lengthError || notice) && (!lengthError || draft.error !== lengthError) && (
            <p className="notepad-notice" role="alert">
              {lengthError || notice}
            </p>
          )}
          {controls}
          {!localOnly && <DraftHandoff draft={draft} />}
          <div className="notepad-export">
            <span>
              {recoveryDescription ??
                (localOnly
                  ? 'This tab keeps its own draft. Browser-local recovery copies and versions survive closing the tab; reopen Versions to copy them. They do not sync to another device.'
                  : 'Autosaved in this browser as you type, then to this computer.')}{' '}
              Clearing browser data or losing the device can remove unsent drafts.
            </span>
            <button type="button" className="notepad-button" onClick={() => void copy()}>
              <Copy size={16} /> Copy text
            </button>
            <button type="button" className="notepad-button" onClick={download}>
              <Download size={16} /> Download
            </button>
            {exported && <span role="status">{exported}</span>}
          </div>
        </section>
      )}
      {overlay}
    </dialog>,
    document.body,
  );
}

function DraftHistory({
  id,
  draft,
  agentId,
  clientId,
  close,
}: {
  id: string;
  draft: SharedDraft;
  agentId: string;
  clientId: string | null;
  close: () => void;
}) {
  const [versions, setVersions] = useState<WorkspaceDraft[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<WorkspaceDraft | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const load = async (before?: number) => {
    if (!clientId) {
      setError('Reconnect to this computer to see saved versions. Your text is kept here.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const page = parseDraftHistory(
        await api(
          `/workspace/${clientId}/drafts/${agentId}/history${before ? `?before=${before}` : ''}`,
        ),
      );
      if (!alive.current) return;
      setVersions((old) => {
        const merged = before ? [...old, ...page.versions] : page.versions;
        return merged
          .filter((v, i) => merged.findIndex((w) => w.revision === v.revision) === i)
          .slice(0, maxVersions);
      });
      setNext(page.nextBefore);
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof ApiError && reason.status === 404
            ? 'Saved versions are not available from this computer yet. Your current draft is unaffected.'
            : reason instanceof Error
              ? reason.message
              : 'Saved versions could not be read. Try again.',
        );
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [clientId, agentId]);
  const restore = async (version: WorkspaceDraft) => {
    setRestoring(true);
    setMessage('');
    try {
      // Record the current text as its own version before replacing it.
      await draft.flush();
      draft.setText(version.text);
      await draft.flush();
      if (!alive.current) return;
      setMessage(
        `Restored the ${stamp(version.updatedAt)} version as a new version. The text it replaced is saved too.`,
      );
      setSelected(null);
      await load();
    } catch (reason) {
      if (alive.current)
        setMessage(
          reason instanceof Error
            ? `${reason.message} Nothing was replaced unless the current text was saved first.`
            : 'The current text could not be saved first, so nothing was restored.',
        );
    } finally {
      if (alive.current) setRestoring(false);
    }
  };
  return (
    <aside className="notepad-history" id={id} aria-label="Saved versions">
      <div className="notepad-history-head">
        <h3>Saved versions</h3>
        <button type="button" className="notepad-button" onClick={close}>
          Close
        </button>
      </div>
      <p className="notepad-history-note">
        Private to this browser, newest first. Restoring adds a new version; nothing newer is erased
        and an earlier send is never repeated.
      </p>
      {error && (
        <div role="alert" className="notepad-history-error">
          <p>{error}</p>
          <button type="button" className="notepad-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {selected ? (
        <div className="notepad-version-preview">
          <p>
            <strong>{stamp(selected.updatedAt)}</strong>
            {selected.submitted ? ' · submitted with Send' : ''}
          </p>
          <pre>{selected.text || '(Empty draft)'}</pre>
          <div className="notepad-history-actions">
            <button type="button" className="notepad-button" onClick={() => setSelected(null)}>
              Back to versions
            </button>
            <button
              type="button"
              className="notepad-button primary"
              disabled={restoring || !draft.ready || draft.conflict || selected.text === draft.text}
              onClick={() => void restore(selected)}
            >
              <RotateCcw size={16} /> {restoring ? 'Restoring…' : 'Restore this version'}
            </button>
          </div>
          {selected.text === draft.text && <p>This matches your current draft.</p>}
          {draft.conflict && <p>Choose which draft to keep before restoring.</p>}
        </div>
      ) : (
        <ol className="notepad-versions">
          {versions.map((version) => (
            <li key={version.revision}>
              <button type="button" onClick={() => setSelected(version)}>
                <span>
                  <strong>{stamp(version.updatedAt)}</strong>
                  {version.submitted && <em>Sent</em>}
                </span>
                <small>{version.text.trim().split('\n')[0]?.slice(0, 120) || 'Empty draft'}</small>
              </button>
            </li>
          ))}
          {!versions.length && !loading && !error && <li>No saved versions yet.</li>}
        </ol>
      )}
      {!selected && next !== null && versions.length < maxVersions && (
        <button
          type="button"
          className="notepad-button"
          disabled={loading}
          onClick={() => void load(next)}
        >
          {loading ? 'Loading…' : 'Older versions'}
        </button>
      )}
      {!selected && versions.length >= maxVersions && (
        <p className="notepad-history-note">Showing the newest {maxVersions} versions.</p>
      )}
    </aside>
  );
}
