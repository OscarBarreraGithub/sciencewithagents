import { useEffect, useRef, useState } from 'react';
import {
  historyItemSchema,
  historyPageSchema,
  type Agent,
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
} from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';

export function HistoryBrowser({
  projectId,
  projectName,
  agents,
  agentId,
  close,
  embedded = false,
  open,
}: {
  projectId: string;
  projectName: string;
  agents: Agent[];
  agentId?: string;
  close: () => void;
  embedded?: boolean;
  open: (agentId: string, entryId?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<HistoryQuery['source']>('all');
  const [selectedAgent, setSelectedAgent] = useState(agentId ?? '');
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [retained, setRetained] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  const request = useRef(0);
  const readRequest = useRef(0);
  const search = useRef<Omit<HistoryQuery, 'cursor'>>({
    source: 'all',
    query: '',
    limit: 20,
    ...(agentId ? { agentId } : {}),
  });

  async function load(cursor?: string) {
    const current = ++request.current;
    setBusy(true);
    setError('');
    try {
      const value = historyPageSchema.parse(
        await api(`/projects/${projectId}/history`, {
          ...search.current,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (current !== request.current) return;
      setPage((previous) =>
        cursor && previous ? { ...value, items: [...previous.items, ...value.items] } : value,
      );
    } catch (cause) {
      if (current === request.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not read saved history. Your records are unchanged.',
        );
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    search.current = { source: 'all', query: '', limit: 20, ...(agentId ? { agentId } : {}) };
    setQuery('');
    setSource('all');
    setSelectedAgent(agentId ?? '');
    setPage(null);
    setSelected(null);
    setRetained('');
    void load();
    return () => {
      request.current++;
      readRequest.current++;
    };
  }, [projectId, agentId]);

  async function read(item: HistoryItem, offset = 0) {
    const current = ++readRequest.current;
    setReading(true);
    setReadError('');
    if (offset === 0) {
      setSelected(item);
      setRetained('');
    }
    try {
      const value = historyItemSchema.parse(
        await api(`/projects/${projectId}/history/read`, {
          source: item.source,
          id: item.id,
          offset,
        }),
      );
      if (current !== readRequest.current) return;
      setSelected(value);
      setRetained((previous) => (offset === 0 ? value.text : previous + value.text));
    } catch (cause) {
      if (current === readRequest.current)
        setReadError(
          cause instanceof Error ? cause.message : 'Could not open this saved item. Try again.',
        );
    } finally {
      if (current === readRequest.current) setReading(false);
    }
  }

  const names = new Map(
    agents.filter((agent) => agent.projectId === projectId).map((agent) => [agent.id, agent.name]),
  );
  return (
    <Modal embedded={embedded} title="Saved history" close={close}>
      <p>
        {projectName} · Find earlier conversations, messages between agents and recorded decisions.
        Reading history never starts work.
      </p>
      {selected ? (
        <section aria-label="Saved evidence">
          <button
            className="secondary"
            onClick={() => {
              readRequest.current++;
              setSelected(null);
              setReading(false);
              setReadError('');
            }}
          >
            Back to results
          </button>
          <h3>{selected.title || 'Saved item'}</h3>
          <p className="muted">
            {names.get(selected.agentId) ?? 'Saved agent'} ·{' '}
            {new Date(selected.createdAt).toLocaleString()}
          </p>
          {readError && (
            <p className="form-error" role="alert">
              {readError}
            </p>
          )}
          {retained && <pre>{retained}</pre>}
          {reading && <p role="status">Reading saved text…</p>}
          {readError && (
            <button
              className="secondary"
              disabled={reading}
              onClick={() => void read(selected, retained.length)}
            >
              Try reading again
            </button>
          )}
          {!reading && !readError && selected.nextOffset !== null && (
            <button className="secondary" onClick={() => void read(selected, selected.nextOffset!)}>
              Read more of this item
            </button>
          )}
          {!reading && !readError && selected.nextOffset === null && (
            <p className="muted">
              All {selected.totalCharacters.toLocaleString()} retained characters are shown.
            </p>
          )}
          <button
            className="secondary"
            onClick={() =>
              open(selected.agentId, selected.source === 'entry' ? selected.id : undefined)
            }
          >
            Open conversation
          </button>
          <details>
            <summary>Source reference</summary>
            <p>
              {selected.source}: {selected.id}
            </p>
            <p>
              This is retained visible evidence. Earlier provider-only history, hidden reasoning and
              context caches may be unavailable.
            </p>
          </details>
        </section>
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              search.current = {
                source,
                query: query.trim(),
                limit: 20,
                ...(selectedAgent ? { agentId: selectedAgent } : {}),
              };
              // A failed new search must not offer an older cursor under new filters.
              setPage(null);
              void load();
            }}
          >
            <label>
              Find in saved history
              <input
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="A topic, result or decision"
              />
            </label>
            <label>
              Which records?
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as HistoryQuery['source'])}
              >
                <option value="all">Everything</option>
                <option value="conversations">Conversations and tools</option>
                <option value="messages">Messages between agents</option>
                <option value="decisions">Manager decisions</option>
              </select>
            </label>
            <label>
              Which agent?
              <select
                value={selectedAgent}
                onChange={(event) => setSelectedAgent(event.target.value)}
              >
                <option value="">Everyone in this project</option>
                {[...names].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy}>
              Search saved history
            </button>
          </form>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {busy && <p role="status">Reading saved history…</p>}
          {page && (
            <>
              <p className="muted">
                Newest saved records first. Refresh your search for new records. Results are short
                previews; open one to read all retained text.
              </p>
              {page.items.length === 0 ? (
                <p role="status">
                  No matching saved records. Try another phrase or choose everyone in the project.
                </p>
              ) : (
                <ul className="attention-list">
                  {page.items.map((item) => (
                    <li key={`${item.source}:${item.id}`}>
                      <small>
                        {names.get(item.agentId) ?? 'Saved agent'} ·{' '}
                        {item.source === 'decision'
                          ? 'Decision'
                          : item.kind === 'message'
                            ? 'Agent message'
                            : 'Conversation'}{' '}
                        · {new Date(item.createdAt).toLocaleString()}
                      </small>
                      <h3>{item.title || 'Saved item'}</h3>
                      <p>
                        {item.offset > 0 ? '…' : ''}
                        {item.text}
                        {item.nextOffset !== null ? '…' : ''}
                      </p>
                      <button className="secondary" onClick={() => void read(item)}>
                        Read saved item
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {page.nextCursor && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void load(page.nextCursor!)}
                >
                  Load older results
                </button>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
