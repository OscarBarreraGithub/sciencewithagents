import { useEffect, useRef, useState } from 'react';
import {
  archiveEditorsSchema,
  archiveItemSchema,
  archivePageSchema,
  type ArchiveItem,
  type ArchivePage,
  type ArchiveQuery,
} from '@dock/shared';
import { api, apiScope } from '../api';

/** Explicit, bounded read-only pages within the existing finder dialog. */
export function ArchiveSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() => {
    try {
      return (sessionStorage.getItem(`dock:archive-query:${apiScope()}`) ?? '').slice(0, 200);
    } catch {
      return '';
    }
  });
  const [sources, setSources] = useState<ReturnType<typeof archiveEditorsSchema.parse> | null>(
    null,
  );
  const [sourceError, setSourceError] = useState('');
  const [selected, setSelected] = useState('managed');
  const [page, setPage] = useState<ArchivePage | null>(null);
  const [request, setRequest] = useState<ArchiveQuery | null>(null);
  const [failed, setFailed] = useState<ArchiveQuery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState<ArchiveItem | null>(null);
  const [readFailure, setReadFailure] = useState<{ item: ArchiveItem; offset: number } | null>(
    null,
  );
  const [pageNumber, setPageNumber] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(`dock:archive-query:${apiScope()}`, query);
    } catch {
      /* Keep the draft in this page. */
    }
  }, [query]);
  const loadSources = async () => {
    setSourceError('');
    try {
      const value = archiveEditorsSchema.parse(await api('/archive/editors'));
      if (alive.current) setSources(value);
    } catch (reason) {
      if (alive.current)
        setSourceError(
          reason instanceof Error ? reason.message : 'Editor sources could not be read.',
        );
    }
  };
  useEffect(() => {
    if (open && !sources) void loadSources();
  }, [open]);
  const scan = async (input: ArchiveQuery, next = false) => {
    setBusy(true);
    setError('');
    setFailed(null);
    setReadFailure(null);
    try {
      const value = archivePageSchema.parse(await api('/archive/search', input));
      if (!alive.current) return;
      setPage(value);
      setRequest(input);
      setPart(null);
      setPageNumber((old) => (next ? old + 1 : 1));
    } catch (reason) {
      if (alive.current) {
        setFailed(input);
        setError(reason instanceof Error ? reason.message : 'This archive page could not be read.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const read = async (item: ArchiveItem, offset = 0) => {
    setBusy(true);
    setError('');
    setReadFailure(null);
    try {
      const value = archiveItemSchema.parse(
        await api('/archive/read', {
          source: item.source,
          recordType: item.recordType,
          id: item.id,
          offset,
          ...(item.source === 'editor'
            ? { windowId: item.windowId, threadId: item.threadId, provider: item.provider }
            : {}),
        }),
      );
      if (alive.current) setPart(value);
    } catch (reason) {
      if (alive.current) {
        setReadFailure({ item, offset });
        setError(reason instanceof Error ? reason.message : 'This message part could not be read.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const window = sources?.windows.find((window) => window.windowId === selected);
  const unavailable =
    selected !== 'managed' &&
    (!window?.threadId || window.status === 'offline' || window.historyUnavailable);
  const input = (): ArchiveQuery => ({
    source: selected === 'managed' ? 'managed' : 'editor',
    query: query.trim(),
    limit: 20,
    ...(window && selected !== 'managed'
      ? {
          windowId: window.windowId,
          threadId: window.threadId!,
          provider: window.provider ?? 'codex',
        }
      : {}),
  });
  return (
    <details className="archive-search" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Search saved text</summary>
      {open && (
        <div className="assisted-search-panel">
          <p className="assisted-search-note">
            Search literal wording or leave blank to review history. This reads saved text in pages
            and uses no model allowance. Choose app history or an available editor thread.
          </p>
          <label className="assisted-search-prompt">
            Text to find
            <input
              value={query}
              disabled={busy}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="assisted-search-prompt">
            Archive source
            <select
              value={selected}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value);
                setPage(null);
                setPart(null);
                setError('');
                setFailed(null);
              }}
            >
              <option value="managed">All retained app history</option>
              {sources?.windows.map((window) => (
                <option key={window.windowId} value={window.windowId}>
                  {window.provider === 'claude' ? 'Claude' : 'Codex'} ·{' '}
                  {window.title || window.label}
                  {window.status === 'offline'
                    ? ' · offline'
                    : window.historyUnavailable
                      ? ' · history unavailable'
                      : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="assisted-search-note">
            {sourceError || sources?.notice || 'Reading available editor sources…'}
          </p>
          {unavailable && (
            <p className="assisted-search-note">
              This editor transcript is unavailable. Reconnect/share it, then refresh sources. It
              has not been searched.
            </p>
          )}
          <div className="assisted-search-row">
            <button
              type="button"
              className="chat-small-button"
              disabled={busy || unavailable}
              onClick={() => void scan(input())}
            >
              {busy ? 'Reading…' : 'Search text'}
            </button>
            <button
              type="button"
              className="chat-small-button"
              disabled={busy}
              onClick={() => void loadSources()}
            >
              Refresh sources
            </button>
          </div>
          {error && (
            <div role="alert">
              <p className="assisted-search-note">{error}</p>
              {failed && (
                <button
                  type="button"
                  className="chat-small-button"
                  disabled={busy}
                  onClick={() => void scan(failed, !!failed.cursor)}
                >
                  Retry this page
                </button>
              )}
              {readFailure && (
                <button
                  type="button"
                  className="chat-small-button"
                  disabled={busy}
                  onClick={() => void read(readFailure.item, readFailure.offset)}
                >
                  Retry this part
                </button>
              )}
            </div>
          )}
          {page && (
            <section className="assisted-search-result" aria-label="Saved text results">
              <p className="assisted-search-note">
                {request?.query ? `Text: “${request.query}”` : 'All saved text'} ·{' '}
                {request?.source === 'editor' ? 'Selected editor thread' : 'Retained app history'}
              </p>
              <p className="assisted-search-note" role="status">
                Page {pageNumber} · {page.items.length} matches · {page.scannedEntries} entries
                examined on this page
                {page.complete ? ' · Scan complete' : ' · More history remains'}
              </p>
              <p className="assisted-search-note">{page.notice}</p>
              {!page.items.length && (
                <p className="assisted-search-note">
                  No matches on this page.
                  {page.nextCursor ? ' Continue to inspect older history.' : ''}
                </p>
              )}
              <ul className="assisted-search-links">
                {page.items.map((item) => (
                  <li key={`${item.source}:${item.id}:${item.offset}`}>
                    <strong>{item.title}</strong>
                    <small>
                      {item.provider === 'claude' ? 'Claude' : 'Codex'} · {item.role}
                    </small>
                    <p className="archive-search-text">{item.text}</p>
                    <div className="assisted-search-row">
                      <button
                        type="button"
                        className="chat-small-button"
                        disabled={busy}
                        onClick={() => void read(item)}
                      >
                        Read full message
                      </button>
                      <a href={item.href}>Open conversation</a>
                    </div>
                  </li>
                ))}
              </ul>
              {page.nextCursor && request && (
                <button
                  type="button"
                  className="chat-small-button"
                  disabled={busy}
                  onClick={() => void scan({ ...request, cursor: page.nextCursor! }, true)}
                >
                  Next archive page
                </button>
              )}
            </section>
          )}
          {part && (
            <section className="assisted-search-result" aria-label="Saved message text">
              <strong>{part.title}</strong>
              <p className="assisted-search-note">
                Characters {part.offset + 1}–{part.offset + part.text.length} of{' '}
                {part.totalCharacters}
              </p>
              <pre className="archive-search-text">{part.text}</pre>
              <div className="assisted-search-row">
                {part.offset > 0 && (
                  <button
                    type="button"
                    className="chat-small-button"
                    disabled={busy}
                    onClick={() => void read(part, Math.max(0, part.offset - 8000))}
                  >
                    Previous message part
                  </button>
                )}
                {part.nextOffset !== null && (
                  <button
                    type="button"
                    className="chat-small-button"
                    disabled={busy}
                    onClick={() => void read(part, part.nextOffset!)}
                  >
                    Next message part
                  </button>
                )}
                <button type="button" className="chat-small-button" onClick={() => setPart(null)}>
                  Close message
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </details>
  );
}
