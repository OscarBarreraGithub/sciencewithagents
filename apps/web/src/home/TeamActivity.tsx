import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, RefreshCw } from 'lucide-react';
import type { Agent, AgentDetail, Entry, Snapshot } from '@dock/shared';
import { apiUrl, detail } from '../api';
import { ChatMarkdown } from '../ChatMarkdown';
import './team-activity.css';

/** Saved coordination in server order (oldest first) and whether older entries exist. */
type Feed = { entries: Entry[]; hasMore: boolean };

/**
 * The newest page is authoritative from its first already-known entry onward; pages loaded
 * earlier stay in place. A complete page replaces the feed, including rows reclassified
 * after owner steering. Without overlap, replacement avoids leaving a hidden gap.
 */
function mergeLatest(old: Feed | null, page: AgentDetail): Feed {
  const positions = new Map(old?.entries.map((entry, index) => [entry.id, index]));
  const start = page.entries
    .map((entry) => positions.get(entry.id))
    .find((index) => index !== undefined);
  if (!old || !page.hasMore || !start) return { entries: page.entries, hasMore: page.hasMore };
  return { entries: [...old.entries.slice(0, start), ...page.entries], hasMore: old.hasMore };
}

type Row = { key: string; entries: Entry[] };
/** Consecutive tool calls from one run become one row; rows read newest first. */
function rows(entries: Entry[]) {
  const result: Row[] = [];
  for (const entry of entries) {
    const last = result[result.length - 1]?.entries;
    const tool = entry.kind === 'tool' && !entry.image;
    if (tool && last?.[0]?.kind === 'tool' && !last[0].image && last[0].runId === entry.runId)
      last.push(entry);
    else result.push({ key: entry.id, entries: [entry] });
  }
  return result.reverse();
}

const time = (value: string) =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 320);

function ActivityRow({ row, names }: { row: Row; names: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const first = row.entries[0]!;
  const last = row.entries[row.entries.length - 1]!;
  const source = first.coordination?.sourceId ? names.get(first.coordination.sourceId) : undefined;
  const report = first.coordination?.kind === 'report';
  const label = first.image
    ? 'Generated image'
    : first.kind === 'message'
      ? `${report ? 'Report' : 'Message'}${source ? ` from ${source}` : ''}`
      : first.kind === 'tool'
        ? `${row.entries.length.toLocaleString()} manager ${row.entries.length === 1 ? 'action' : 'actions'}`
        : 'Manager reply';
  const context =
    first.kind === 'message' || !first.coordination
      ? ''
      : `${report ? 'report' : 'message'}${source ? ` from ${source}` : ''}`;
  const image = first.image && apiUrl(`/agents/${first.agentId}/images/${first.image.id}`);
  return (
    <li className={`chat-item team-activity-item team-activity-${first.kind}`} data-entry={row.key}>
      {/* The whole summary opens the saved evidence: a compact row with a large tap target. */}
      <button
        type="button"
        className="team-activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="team-activity-summary">
          <strong>{label}</strong>
          <span className="team-activity-preview">
            {first.kind === 'tool' && !first.image
              ? last.title
              : preview(first.text) || first.title}
          </span>
          <small>
            {time(last.createdAt)}
            {context && ` · about a ${context}`}
            {first.status === 'streaming' ? ' · in progress' : ''}
          </small>
        </span>
        <span className="team-activity-action">
          {open ? 'Hide' : 'Show'}
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </button>
      {open &&
        (image && first.image ? (
          <figure className="team-activity-image">
            <a href={image} target="_blank" rel="noopener noreferrer">
              <img
                src={image}
                alt="Generated image"
                width={first.image.width}
                height={first.image.height}
                loading="lazy"
              />
            </a>
            <figcaption>{first.text}</figcaption>
          </figure>
        ) : first.kind === 'tool' ? (
          <ul className="team-activity-tools">
            {row.entries.map((entry) => (
              <ToolDetail key={entry.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <div className="markdown team-activity-full">
            <ChatMarkdown entry={first}>{first.text}</ChatMarkdown>
          </div>
        ))}
    </li>
  );
}
function ToolDetail({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span>{entry.title}</span> <small>{entry.status}</small>
        </summary>
        {open && <pre>{entry.text || 'No result was recorded.'}</pre>}
      </details>
    </li>
  );
}

/**
 * Routine messages, reports and the manager's replies to them, read from the server's
 * coordination channel. Reading never starts model work; paging is independent of the chat.
 */
export function TeamActivity({ manager, state }: { manager: Agent; state: Snapshot }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState('');
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'failed'>('idle');
  const list = useRef<HTMLOListElement>(null);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const alive = useRef(true);
  const reading = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // New activity is added above. A reader scrolled into the list keeps their place.
  const remember = () => {
    const scroller = list.current?.closest('.chat-side-body');
    anchor.current = null;
    if (!list.current || !scroller) return;
    const top = scroller.getBoundingClientRect().top;
    if (list.current.getBoundingClientRect().top >= top) return;
    for (const item of list.current.children) {
      const box = item.getBoundingClientRect();
      if (box.bottom > top && item instanceof HTMLElement && item.dataset.entry) {
        anchor.current = { key: item.dataset.entry, top: box.top };
        return;
      }
    }
  };
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    const scroller = list.current?.closest('.chat-side-body');
    const item = kept && list.current?.querySelector(`[data-entry="${CSS.escape(kept.key)}"]`);
    if (kept && scroller && item) scroller.scrollTop += item.getBoundingClientRect().top - kept.top;
  }, [feed]);
  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const page = await detail(manager.id, undefined, 'coordination');
      if (!alive.current) return;
      remember();
      setFeed((old) => mergeLatest(old, page));
      setError('');
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error
            ? reason.message
            : 'The computer could not be reached. Try again.',
        );
    } finally {
      reading.current = false;
    }
  }, [manager.id]);
  useEffect(() => {
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [read]);
  const loadEarlier = async () => {
    const cursor = feed?.entries[0]?.id;
    if (!cursor || earlier === 'loading') return;
    setEarlier('loading');
    try {
      const page = await detail(manager.id, cursor, 'coordination');
      if (!alive.current) return;
      setFeed((old) => {
        // A replaced feed has a different oldest entry; this page no longer joins it.
        if (!old || old.entries[0]?.id !== cursor) return old;
        const known = new Set(old.entries.map((entry) => entry.id));
        return {
          entries: [...page.entries.filter((entry) => !known.has(entry.id)), ...old.entries],
          hasMore: page.hasMore,
        };
      });
      setEarlier('idle');
    } catch {
      if (alive.current) setEarlier('failed');
    }
  };
  const names = new Map(state.agents.map((agent) => [agent.id, agent.name]));
  const shown = feed ? rows(feed.entries) : [];
  return (
    <section className="team-activity" aria-labelledby="team-activity-title">
      <div className="chat-side-section">
        <h3 id="team-activity-title">Team activity</h3>
        <a className="chat-small-button" href={`#/search/${manager.projectId}`}>
          Search saved history <ArrowUpRight size={15} />
        </a>
      </div>
      <p className="chat-side-note">
        Routine team messages, reports and the manager’s replies to them. Your messages, its answers
        to you and requests for your approval stay in the chat.
      </p>
      {error && (
        <div className="team-activity-error" role="alert">
          <p className="chat-panel-error">
            {feed ? `Could not refresh. Showing saved activity. ${error}` : error}
          </p>
          <button type="button" className="chat-small-button" onClick={() => void read()}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      )}
      {!feed && !error && <p className="chat-side-empty">Loading saved team activity…</p>}
      {feed && !shown.length && (
        <p className="chat-side-empty">
          No team messages or reports yet. They appear here once workers report back.
        </p>
      )}
      <ol className="chat-item-list" ref={list}>
        {shown.map((row) => (
          <ActivityRow key={row.key} row={row} names={names} />
        ))}
      </ol>
      {earlier === 'failed' && (
        <p className="chat-panel-error" role="alert">
          Could not load earlier activity. Nothing was lost; try again.
        </p>
      )}
      {feed?.hasMore && (
        <button
          type="button"
          className="chat-small-button"
          disabled={earlier === 'loading'}
          onClick={() => void loadEarlier()}
        >
          {earlier === 'loading' ? 'Loading earlier activity…' : 'Load earlier activity'}
        </button>
      )}
    </section>
  );
}
