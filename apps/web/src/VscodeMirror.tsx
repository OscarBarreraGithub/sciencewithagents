import { memo, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, MessageSquare, Monitor } from 'lucide-react';
import {
  mirrorStateSchema,
  mirrorResultSchema,
  mirrorSendSchema,
  mirrorPage,
  type MirrorState,
  type MirrorSend,
} from '@dock/shared';
import { api, apiScope } from './api';
import { mirrorKey, mirrorProvider, mirrorStatus, type MirrorChat } from './useMirrorChats';
import './VscodeMirror.css';
import { MirrorStopReply } from './MirrorStopReply';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents = {
  a: ({ href, children }: React.ComponentProps<'a'>) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: ({ alt }: React.ComponentProps<'img'>) => <span>[Image: {alt ?? 'view in VS Code'}]</span>,
};

function EntryText({
  entry,
  windowId,
}: {
  entry: MirrorState['entries'][number];
  windowId: string;
}) {
  const [part, setPart] = useState<typeof entry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    setPart(null);
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [entry.text, entry.textLength, windowId]);
  const current = part ?? entry;
  const offset = current.textOffset ?? 0;
  const total = current.textLength ?? current.text.length;
  async function load(next: number) {
    const request = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ entry: entry.id, offset: String(next) });
      const raw = mirrorStateSchema.parse(await api(`/vscode/windows/${windowId}?${query}`));
      const result = raw.page ? raw : mirrorPage(raw, { entry: entry.id, offset: next });
      if (request !== generation.current) return;
      const value = result.entries.find((item) => item.id === entry.id);
      if (!value) throw new Error('History changed');
      setPart(value);
    } catch {
      if (request === generation.current) setError('Could not load this part. Try again.');
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  return (
    <>
      {current.textLength || entry.role === 'activity' ? (
        <pre>{current.text}</pre>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {current.text}
        </ReactMarkdown>
      )}
      {current.textLength !== undefined && (
        <div className="mirror-text-pages">
          <p>
            Long entry · characters {offset + 1}–{offset + current.text.length} of{' '}
            {total.toLocaleString()}
          </p>
          <button
            type="button"
            disabled={busy || offset === 0}
            onClick={() => void load(Math.max(0, offset - 8000))}
          >
            Previous part
          </button>
          <button
            type="button"
            disabled={busy || offset + current.text.length >= total}
            onClick={() => void load(offset + current.text.length)}
          >
            Next part
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </>
  );
}

const MirrorEntry = memo(
  function MirrorEntry({
    entry,
    provider,
    windowId,
  }: {
    entry: MirrorState['entries'][number];
    provider: string;
    windowId: string;
  }) {
    const [open, setOpen] = useState(false);
    return entry.role === 'activity' ? (
      <details className="mirror-activity" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <ChevronRight size={13} />
          {entry.text.split('\n', 1)[0].slice(0, 180)}
        </summary>
        {open && <EntryText entry={entry} windowId={windowId} />}
      </details>
    ) : (
      <article className={`mirror-message ${entry.role}`}>
        <small>{entry.role === 'user' ? 'You' : provider}</small>
        <div className="mirror-text">
          <EntryText entry={entry} windowId={windowId} />
        </div>
      </article>
    );
  },
  (a, b) =>
    a.provider === b.provider &&
    a.windowId === b.windowId &&
    a.entry.id === b.entry.id &&
    a.entry.role === b.entry.role &&
    a.entry.text === b.entry.text &&
    a.entry.textLength === b.entry.textLength &&
    a.entry.textOffset === b.entry.textOffset,
);

function activityLabel(text: string) {
  const title = text.split('\n', 1)[0];
  const labels: Record<string, string> = {
    commandExecution: 'Running commands',
    fileChange: 'Editing files',
    reasoning: 'Thinking',
    mcpToolCall: 'Using connected tools',
    dynamicToolCall: 'Using tools',
    webSearch: 'Searching the web',
    contextCompaction: 'Saving context',
    plan: 'Updating the plan',
  };
  return labels[title] ?? title.slice(0, 100);
}

function ActivityGroup({
  entries,
  windowId,
  provider,
  working,
}: {
  entries: MirrorState['entries'];
  windowId: string;
  provider: string;
  working: boolean;
}) {
  const first = entries[0];
  const count = first.activityGroup?.count ?? entries.length;
  const remote = !!first.activityGroup;
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<MirrorState | null>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !remote) return;
    let ended = false;
    setBusy(true);
    setError('');
    const params = new URLSearchParams({ activity: first.id, ...query });
    void api(`/vscode/windows/${windowId}?${params}`)
      .then((raw) => {
        if (ended) return;
        setLoaded(mirrorStateSchema.parse(raw));
      })
      .catch(() => {
        if (!ended) setError('Could not load activity. Close and reopen to retry.');
      })
      .finally(() => {
        if (!ended) setBusy(false);
      });
    return () => {
      ended = true;
    };
  }, [open, remote, first.id, count, windowId, query]);
  const visible = remote ? (loaded?.entries ?? []) : entries;
  return (
    <details
      className="mirror-activity-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={14} />
        <span className="mirror-activity-count">
          {working ? 'Working · ' : ''}
          {count.toLocaleString()} {count === 1 ? 'action' : 'actions'}
        </span>
        {working && (
          <span className="mirror-activity-current">{activityLabel(entries.at(-1)!.text)}</span>
        )}
      </summary>
      {open && (
        <div className="mirror-activity-group-body">
          {busy && <p role="status">Loading activity…</p>}
          {error && <p role="alert">{error}</p>}
          {loaded?.page?.reset && <p>Activity changed in VS Code. Reopen its current summary.</p>}
          {visible.map((entry) => (
            <MirrorEntry key={entry.id} entry={entry} windowId={windowId} provider={provider} />
          ))}
          {remote &&
            (loaded?.page?.before || loaded?.page?.after || Object.keys(query).length > 0) && (
              <nav className="mirror-history" aria-label="Activity history">
                <button
                  type="button"
                  disabled={busy || !loaded?.page?.before}
                  onClick={() => setQuery({ before: loaded!.page!.before! })}
                >
                  Earlier activity
                </button>
                <button
                  type="button"
                  disabled={busy || !loaded?.page?.after}
                  onClick={() => setQuery({ after: loaded!.page!.after! })}
                >
                  Later activity
                </button>
                {Object.keys(query).length > 0 && (
                  <button type="button" disabled={busy} onClick={() => setQuery({})}>
                    Latest activity
                  </button>
                )}
              </nav>
            )}
        </div>
      )}
    </details>
  );
}

function timelineRows(entries: MirrorState['entries']): MirrorState['entries'][] {
  const rows: MirrorState['entries'][] = [];
  for (const entry of entries) {
    const previous = rows.at(-1);
    if (
      entry.role === 'activity' &&
      !entry.activityGroup &&
      previous?.[0].role === 'activity' &&
      !previous[0].activityGroup
    )
      previous.push(entry);
    else rows.push([entry]);
  }
  return rows;
}

export function MirrorChatList({
  chats,
  selected,
  choose,
}: {
  chats: MirrorChat[];
  selected: string | null;
  choose(key: string): void;
}) {
  return (
    <nav className="mirror-chat-list" aria-label="VS Code chats">
      {chats.map((chat) => (
        <button
          key={mirrorKey(chat)}
          className={`mirror-chat-link ${selected === mirrorKey(chat) ? 'selected' : ''}`}
          aria-current={selected === mirrorKey(chat) ? 'page' : undefined}
          onClick={() => choose(mirrorKey(chat))}
        >
          <span className={`mirror-avatar ${chat.provider ?? 'codex'}`}>
            <MessageSquare size={18} />
          </span>
          <span className="mirror-chat-label">
            <strong>{chat.title || 'Untitled conversation'}</strong>
            <small>
              {mirrorProvider(chat)} · {mirrorStatus(chat)}
            </small>
          </span>
          <span aria-hidden="true" className={`mirror-presence ${chat.status}`} />
        </button>
      ))}
    </nav>
  );
}

export function MirrorHome({
  chats,
  loaded,
  error,
  choose,
  embedded = false,
}: {
  chats: MirrorChat[];
  loaded: boolean;
  error: string;
  choose(key: string): void;
  embedded?: boolean;
}) {
  return (
    <section className="mirror-home" aria-label="VS Code conversations">
      {!embedded && (
        <div className="mirror-home-heading">
          <Monitor size={28} />
          <h1>Your VS Code chats</h1>
          <p>Pick up the same conversation on your phone or computer.</p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {!loaded && <p role="status">Looking for shared conversations…</p>}
      {!!chats.length && <MirrorChatList chats={chats} selected={null} choose={choose} />}
      <div className="mirror-setup">
        <h2>{chats.length ? 'Share another conversation' : 'Connect a conversation'}</h2>
        <ol>
          <li>Open your conversation in VS Code on the computer.</li>
          <li>
            Click <strong>sciencewithagents</strong> in VS Code’s bottom bar, then choose{' '}
            <strong>Share a Codex conversation</strong> or{' '}
            <strong>Share a Claude Code conversation</strong>.
          </li>
          <li>Choose the conversation you want. It appears here when connected.</li>
        </ol>
        <details>
          <summary>Can’t see sciencewithagents?</summary>
          <p>
            In VS Code’s command menu, search for{' '}
            <strong>sciencewithagents Mirror: Share a Conversation</strong>. The companion extension
            must be installed. If it asks to enable a bridge, finish that step when it is safe to
            reload the editor.
          </p>
        </details>
        <p className="mirror-note">
          Only conversations you choose are shared. Keep VS Code and this computer running.
          Permissions, models, slash commands and other advanced controls stay in the original
          editor.
        </p>
      </div>
    </section>
  );
}

export function VscodeMirror({ chat }: { chat: MirrorChat }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const identity = mirrorKey(chat);
  const provider = mirrorProvider(chat);
  // Retain the original Codex draft key for upgrades from the modal preview.
  const draftKey = `dock:mirror:${apiScope()}:${chat.provider === 'claude' ? 'claude:' : ''}${chat.threadId}`;
  const [state, setState] = useState<MirrorState | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    const maximum = Number.parseFloat(getComputedStyle(element).maxHeight) || 140;
    element.style.height = `${Math.min(element.scrollHeight + 2, maximum)}px`;
  }, [text]);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<MirrorSend | null>(null);
  const [following, setFollowing] = useState(true);
  const [historyQuery, setHistoryQuery] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // Where a following reader last was; only scrolling up from here reads history.
  const followTop = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // An attached editor can temporarily report its provider offline. Keep
      // reading that live bridge; only stop when discovery loses the connection.
      if (!chat.online) return;
      if (document.hidden) {
        timer = setTimeout(poll, 1500);
        return;
      }
      try {
        const raw = mirrorStateSchema.parse(
          await api(`/vscode/windows/${chat.windowId}${historyQuery}`),
        );
        const value = raw.page
          ? raw
          : mirrorPage(raw, Object.fromEntries(new URLSearchParams(historyQuery)));
        if (ended) return;
        if (mirrorKey(value) !== identity) {
          setState((s) => (s ? { ...s, status: 'offline' } : null));
          setError(
            'VS Code is sharing a different conversation. Choose it from your chat list, or share this one again.',
          );
        } else {
          setState(value);
          setError('');
        }
      } catch {
        if (!ended) {
          setError('Connection interrupted. Your draft is safe; reconnecting automatically.');
          setState((s) => (s ? { ...s, status: 'offline' } : null));
        }
      } finally {
        if (!ended) timer = setTimeout(poll, historyQuery ? 5000 : 1500);
      }
    };
    void poll();
    return () => {
      ended = true;
      clearTimeout(timer);
    };
  }, [identity, chat.windowId, chat.online, historyQuery]);
  useEffect(() => {
    const restore = () => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? '{}');
        setText(typeof saved.text === 'string' ? saved.text : '');
        const value = mirrorSendSchema.safeParse(saved.pending);
        setPending(
          value.success &&
            value.data.threadId === chat.threadId &&
            (value.data.provider ?? 'codex') === (chat.provider ?? 'codex')
            ? value.data
            : null,
        );
      } catch {
        setText('');
        setPending(null);
      }
    };
    restore();
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === draftKey) restore();
    };
    window.addEventListener('dock:mirror-draft', changed);
    return () => window.removeEventListener('dock:mirror-draft', changed);
  }, [draftKey]);
  useEffect(() => {
    if (follow.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [state?.entries]);
  useEffect(() => {
    const log = viewport.current;
    if (!log) return;
    // A keyboard or taller composer shrinks the log. Keep the newest message in view
    // only for a reader already at the bottom; anyone reading history keeps their place.
    const observer = new ResizeObserver(() => {
      if (follow.current) log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, []);
  function save(value: string, request: MirrorSend | null) {
    sessionStorage.setItem(draftKey, JSON.stringify({ text: value, pending: request }));
  }
  function history(direction: 'before' | 'after' | 'latest') {
    const cursor = direction !== 'latest' ? state?.page?.[direction] : undefined;
    setHistoryQuery(cursor ? `?${new URLSearchParams({ [direction]: cursor })}` : '');
    setState(null);
    follow.current = true;
    setFollowing(true);
  }
  const status = chat.status === 'offline' ? 'offline' : (state?.status ?? 'offline');
  const canSteer = status === 'busy' && !!state?.canSteer && !!state.steerToken;
  const canQueue = status === 'busy' && !!state?.canQueue;
  const canSend = status === 'idle' || canSteer || canQueue;
  async function send() {
    if (busy || !chat.threadId || (!pending && !canSend)) return;
    const input = pending ?? {
      key: crypto.randomUUID(),
      threadId: chat.threadId,
      ...(chat.provider === 'claude' ? { provider: 'claude' as const } : {}),
      ...(canSteer ? { expectedTurnId: state!.steerToken! } : {}),
      ...(canQueue && !canSteer ? { mode: 'queue' as const } : {}),
      text: text.trim(),
    };
    if (!input.text) return;
    try {
      save(text, input);
    } catch {
      setReceipt(
        'Draft storage is unavailable. Keep this page open and inspect VS Code after any connection failure.',
      );
    }
    setPending(input);
    setBusy(true);
    try {
      const result = mirrorResultSchema.parse(
        pending
          ? await api(`/vscode/deliveries/${input.key}`)
          : await api(`/vscode/windows/${chat.windowId}/send`, input),
      );
      // Navigation may unmount this view while the request finishes. Only resolve
      // its own receipt, never overwrite a later draft or another provider/thread.
      if (result.state !== 'uncertain') {
        try {
          const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? '{}');
          if (saved.pending?.key === input.key) {
            save(result.state === 'sent' ? '' : text, null);
            window.dispatchEvent(new CustomEvent('dock:mirror-draft', { detail: draftKey }));
          }
        } catch {
          /* The live view below still retains the result. */
        }
        if (mounted.current) {
          setPending(null);
          if (result.state === 'sent') setText('');
        }
      }
      if (mounted.current) setReceipt(result.message);
    } catch {
      if (mounted.current)
        setReceipt('Delivery not confirmed. Use Check delivery; do not retype and resend.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="mirror-conversation" aria-label={`${provider} chat`}>
      <header className="mirror-header">
        <span className={`mirror-avatar ${chat.provider ?? 'codex'}`}>
          <MessageSquare size={21} />
        </span>
        <div>
          <h1>{state?.title || chat.title || 'Untitled conversation'}</h1>
          <p>
            <span className={`mirror-presence ${status}`} />
            {mirrorStatus({ ...chat, status })} · {provider} in {chat.label}
          </p>
        </div>
        <details className="mirror-controls">
          <summary aria-label="Chat information">
            <Monitor size={18} />
          </summary>
          <div>
            <strong>Same chat, different screen</strong>
            <p>Sent messages sync both ways. Unsent drafts stay separate.</p>
            <p>
              Use VS Code for permissions, models, slash commands and attachments. Stop reply is
              available here when the connected provider supports it. No new agent is started here.
              After an editor crash, reopen VS Code and the original chat.
            </p>
          </div>
        </details>
      </header>
      {(error || status === 'offline' || status === 'attention') && (
        <div className="mirror-notice" role="status">
          {error ||
            (state?.status === status && state.message) ||
            (status === 'attention'
              ? 'A request needs your attention in VS Code. Approvals remain on your computer.'
              : 'Offline. Open VS Code and share this conversation to continue. Your draft stays here.')}
        </div>
      )}
      {(state?.page?.before || state?.page?.after || historyQuery) && (
        <nav className="mirror-history" aria-label="Conversation history">
          <button type="button" disabled={!state?.page?.before} onClick={() => history('before')}>
            Older messages
          </button>
          <span>{historyQuery ? 'Earlier history' : 'Latest messages'}</span>
          {historyQuery && (
            <>
              <button type="button" disabled={!state?.page?.after} onClick={() => history('after')}>
                Newer messages
              </button>
              <button type="button" onClick={() => history('latest')}>
                Back to latest
              </button>
            </>
          )}
        </nav>
      )}
      {state?.page?.reset && (
        <p className="mirror-notice">History changed in VS Code. Showing the latest messages.</p>
      )}
      <div
        className="mirror-log"
        ref={viewport}
        role="log"
        aria-label={`${provider} conversation`}
        aria-live="off"
        onScroll={() => {
          const el = viewport.current!;
          const top = el.scrollTop;
          const near = el.scrollHeight - el.clientHeight - top < 80;
          // A keyboard or taller composer shrinks the log, and Safari can report that
          // layout scroll before ResizeObserver repins it. The reader has not moved, so
          // keep following unless they scrolled up toward older messages.
          const held = !near && follow.current && top >= followTop.current - 2;
          follow.current = near || held;
          followTop.current = held ? Math.max(followTop.current, top) : top;
          setFollowing(follow.current);
        }}
      >
        <div className="mirror-messages">
          {timelineRows(state?.entries ?? []).map((entries, index, rows) =>
            entries[0].role === 'activity' ? (
              <ActivityGroup
                key={entries[0].id}
                entries={entries}
                provider={provider}
                windowId={chat.windowId}
                working={status === 'busy' && index === rows.length - 1}
              />
            ) : (
              <MirrorEntry
                key={entries[0].id}
                entry={entries[0]}
                provider={provider}
                windowId={chat.windowId}
              />
            ),
          )}
          {!state?.entries.length && (
            <p className="mirror-empty">
              {status === 'offline'
                ? 'Conversation history is kept in VS Code. It will appear when connected.'
                : 'No messages yet. Say hello when the conversation is ready.'}
            </p>
          )}
          {status === 'busy' && (
            <p className="mirror-working" role="status">
              <span className="live-dot" />
              {provider} is working…
            </p>
          )}
        </div>
        {/* Sticks to the bottom of the history, so it can never cover the composer. */}
        {!following && (
          <div className="mirror-latest-dock">
            <button
              className="mirror-latest secondary"
              onClick={() => {
                follow.current = true;
                setFollowing(true);
                viewport.current?.scrollTo({
                  top: viewport.current.scrollHeight,
                  behavior: 'smooth',
                });
              }}
            >
              <ArrowDown size={14} />
              Latest messages
            </button>
          </div>
        )}
      </div>
      <form
        className="mirror-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {chat.threadId && (
          <MirrorStopReply
            windowId={chat.windowId}
            threadId={chat.threadId}
            provider={chat.provider ?? 'codex'}
            token={status !== 'offline' ? state?.stopToken : undefined}
          />
        )}
        <div className="mirror-input-row">
          <textarea
            ref={input}
            aria-label={`Message ${provider}`}
            value={text}
            rows={1}
            maxLength={32000}
            disabled={busy || !!pending}
            placeholder={
              canSteer
                ? 'Update the current task…'
                : canQueue
                  ? 'Add a follow-up…'
                  : status === 'idle'
                    ? `Message ${provider}…`
                    : 'Write a draft…'
            }
            onChange={(e) => {
              setText(e.target.value);
              try {
                save(e.target.value, null);
              } catch {
                setReceipt('Draft storage is unavailable. Keep this page open.');
              }
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !window.matchMedia('(pointer: coarse)').matches
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="primary mirror-send"
            type="submit"
            aria-label={
              busy
                ? 'Checking delivery'
                : pending
                  ? 'Check delivery'
                  : canQueue
                    ? 'Queue follow-up'
                    : 'Send'
            }
            disabled={busy || !text.trim() || (!pending && !canSend)}
          >
            {busy ? '…' : pending ? 'Check delivery' : <ArrowUp size={20} />}
          </button>
        </div>
        <p className="mirror-note">
          {canSteer
            ? 'Your message updates the current task. '
            : canQueue
              ? 'Your message joins Claude’s native queue. '
              : status === 'busy'
                ? (chat.provider ?? 'codex') === 'codex'
                  ? 'Update the VS Code companion to send instructions while Codex works. '
                  : 'Update the VS Code companion to queue follow-ups while Claude works. '
                : ''}
          Drafts stay on this device.{' '}
          <span className="desktop-only">Enter to send · Shift + Enter for a new line.</span>
        </p>
        {receipt && (
          <p className="mirror-receipt" role="status">
            {receipt}
          </p>
        )}
        {pending && !busy && (
          <button
            type="button"
            className="mirror-clear"
            onClick={() => {
              if (
                window.confirm(
                  'Have you inspected the conversation in VS Code? Clearing this receipt does not undo a message that was already sent.',
                )
              ) {
                try {
                  save('', null);
                } catch {
                  /* Keep in-memory receipt explicit. */
                }
                setPending(null);
                setText('');
                setReceipt('Previous receipt cleared after your check.');
              }
            }}
          >
            I checked the conversation
          </button>
        )}
      </form>
    </section>
  );
}
