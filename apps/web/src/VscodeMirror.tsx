import { flushSync } from 'react-dom';
import { MirrorMessageQueue } from './MirrorMessageQueue';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAttachmentPicker, useChatAttachmentUpload } from './ChatImages';
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  MessageSquare,
  Monitor,
  NotebookPen,
} from 'lucide-react';
import {
  mirrorStateSchema,
  withoutChatAttachments,
  withChatAttachmentText,
  mirrorResultSchema,
  mirrorSendSchema,
  mirrorPage,
  promptTextLimit,
  type MirrorState,
  type MirrorSend,
} from '@dock/shared';
import { api, apiScope, ApiError, connectionLost } from './api';
import { Modal } from './Modal';
import {
  mirrorDaemon,
  mirrorKey,
  mirrorKind,
  mirrorProvider,
  mirrorStatus,
  type MirrorChat,
} from './useMirrorChats';
import './VscodeMirror.css';
import { MirrorStopReply } from './MirrorStopReply';
import { MirrorNativeRequests } from './MirrorNativeRequests';
import { useMirrorNativeRequests } from './useMirrorNativeRequests';
import { NativeGoalCard } from './NativeGoalCard';
import { ChatCommands } from './ChatCommands';
import { Notepad, type DraftSelection } from './Notepad';
import { useBrowserNotepad } from './useBrowserNotepad';
import { useVisibleViewport } from './useVisibleViewport';
import { promptLengthError } from './promptLength';
import { PromptHistory, scrollToPrompt } from './PromptHistory';

// A native Codex daemon session lives on the computer, never in a VS Code window.
const DaemonSource = createContext(false);

function MirrorImage({ alt }: React.ComponentProps<'img'>) {
  const daemon = useContext(DaemonSource);
  return <span>[Image: {alt ?? (daemon ? 'view on your computer' : 'view in VS Code')}]</span>;
}

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
      {entry.role === 'activity' ? (
        <pre>{current.text}</pre>
      ) : (
        <ChatMarkdown image={MirrorImage}>{current.text}</ChatMarkdown>
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
    selected = false,
  }: {
    entry: MirrorState['entries'][number];
    provider: string;
    windowId: string;
    selected?: boolean;
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
      <article
        className={`mirror-message ${entry.role}${selected ? ' prompt-selected' : ''}`}
        data-prompt-id={entry.role === 'user' ? entry.id : undefined}
      >
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
    a.selected === b.selected &&
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
  const daemon = useContext(DaemonSource);
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
          {loaded?.page?.reset && (
            <p>
              Activity changed {daemon ? 'on your computer' : 'in VS Code'}. Reopen its current
              summary.
            </p>
          )}
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
    <nav
      className="mirror-chat-list"
      aria-label={chats.some(mirrorDaemon) ? 'Shared chats' : 'VS Code chats'}
    >
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
              {mirrorKind(chat)} · {mirrorStatus(chat)}
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
  const daemon = chats.some(mirrorDaemon);
  return (
    <section
      className="mirror-home"
      aria-label={daemon ? 'Shared conversations' : 'VS Code conversations'}
    >
      {!embedded && (
        <div className="mirror-home-heading">
          <Monitor size={28} />
          <h1>{daemon ? 'Your shared chats' : 'Your VS Code chats'}</h1>
          <p>Pick up the same conversation on your phone or computer.</p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {!loaded && <p role="status">Looking for shared conversations…</p>}
      {daemon && (
        <p className="mirror-note">
          A Codex session is a native Codex conversation on your computer, possibly running in a
          terminal. Messages typed there and here at the same time can join the same reply.
          Approvals stay on the computer.
        </p>
      )}
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

export function VscodeMirror({
  chat,
  headerAction,
}: {
  chat: MirrorChat;
  headerAction?: ReactNode;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const visible = useVisibleViewport();
  const identity = mirrorKey(chat);
  const provider = mirrorProvider(chat);
  const daemon = mirrorDaemon(chat);
  const nativeRequests = useMirrorNativeRequests(chat);
  // Retain the original Codex draft key for upgrades from the modal preview.
  const draftKey = `dock:mirror:${apiScope()}:${chat.provider === 'claude' ? 'claude:' : ''}${chat.threadId}`;
  const [state, setState] = useState<MirrorState | null>(null);
  const [text, setText] = useState('');
  const lengthError = promptLengthError(text);
  const [goalOpen, setGoalOpen] = useState<string | null>(null);
  const resizeInput = () => {
    const element = input.current;
    if (!element) return;
    const scrollTop = element.scrollTop;
    const log = viewport.current;
    const logTop = log?.scrollTop ?? 0;
    element.style.overflowY = 'hidden';
    element.style.height = 'auto';
    const style = getComputedStyle(element);
    const maximum = Number.parseFloat(style.maxHeight) || 140;
    const wanted = Math.ceil(
      element.scrollHeight +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth),
    );
    element.style.height = `${Math.min(wanted, maximum)}px`;
    element.style.overflowY = wanted > maximum ? 'auto' : 'hidden';
    element.scrollTop = scrollTop;
    // Measuring at height:auto briefly enlarges the log and WebKit clamps its top.
    // Restore the reader's position before queued scroll events classify that clamp.
    if (log && !document.documentElement.dataset.pdfOpen) log.scrollTop = logTop;
  };
  useLayoutEffect(resizeInput, [text, visible?.height, visible?.keyboard]);
  useEffect(() => {
    // Resize saved drafts too: zoom, rotation and side panels change line wrapping
    // without changing the text. Ignore our own height changes to avoid a resize loop.
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        resizeInput();
      }
    });
    if (input.current) observer.observe(input.current);
    window.addEventListener('resize', resizeInput);
    window.visualViewport?.addEventListener('resize', resizeInput);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeInput);
      window.visualViewport?.removeEventListener('resize', resizeInput);
    };
  }, []);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<MirrorSend | null>(null);
  const [pendingReceiptState, setPendingReceiptState] = useState<'missing' | 'recorded' | null>(
    null,
  );
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [inspectedDelivery, setInspectedDelivery] = useState(false);
  const [uploading, setUploading] = useState(false);
  const pendingRef = useRef<MirrorSend | null>(null);
  const busyRef = useRef(false);
  const draftRevision = useRef(0);
  const [notepadOpen, setNotepadOpen] = useState(false);
  const selection = useRef<DraftSelection>({ start: 0, end: 0 });
  const refocus = useRef(false);
  const browserNotepad = useBrowserNotepad(draftKey, text, (value) => {
    draftRevision.current++;
    setText(value);
    try {
      save(value, pendingRef.current);
    } catch {
      setReceipt('Draft storage is unavailable. Keep this page open.');
    }
  });
  const attachmentUpload = useChatAttachmentUpload({
    currentText: browserNotepad.draft.currentText,
    setText: browserNotepad.draft.setText,
    maxLength: promptTextLimit,
    onBusy: setUploading,
  });
  useEffect(() => {
    if (!notepadOpen && refocus.current) {
      refocus.current = false;
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(selection.current.start, selection.current.end);
    }
  }, [notepadOpen]);
  const [following, setFollowing] = useState(true);
  const [historyQuery, setHistoryQuery] = useState('');
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptSelection, setPromptSelection] = useState<{ state: MirrorState; id: string } | null>(
    null,
  );
  const displayed = promptSelection?.state ?? state;
  useEffect(() => {
    setPromptSelection(null);
    setPromptsOpen(false);
    setHistoryQuery('');
  }, [identity]);
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const startHistory = useRef(false);
  // When the latest successful chat read started (client clock), for freshness against discovery.
  const readAt = useRef(0);
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
    let received = false;
    let pendingRead = false;
    readAt.current = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // An attached editor can temporarily report its provider offline. Keep
      // reading that live bridge; only stop when discovery loses the connection.
      if (!chat.online || ended || pendingRead) return;
      if (document.hidden && received) {
        timer = setTimeout(poll, 1500);
        return;
      }
      pendingRead = true;
      const started = Date.now();
      try {
        const raw = mirrorStateSchema.parse(
          await api(`/vscode/windows/${chat.windowId}${historyQuery}`),
        );
        const value = raw.page
          ? raw
          : mirrorPage(raw, Object.fromEntries(new URLSearchParams(historyQuery)));
        if (ended) return;
        received = true;
        if (mirrorKey(value) !== identity) {
          setState((s) => (s ? { ...s, status: 'offline' } : null));
          setError(
            daemon
              ? 'This Codex session now shows a different conversation. Choose it from your chat list.'
              : 'VS Code is sharing a different conversation. Choose it from your chat list, or share this one again.',
          );
        } else {
          readAt.current = started;
          setState(value);
          setError('');
        }
      } catch {
        if (!ended) {
          setError('Connection interrupted. Your draft is safe; reconnecting automatically.');
          setState((s) => (s ? { ...s, status: 'offline' } : null));
        }
      } finally {
        pendingRead = false;
        if (!ended) timer = setTimeout(poll, historyQuery ? 5000 : 1500);
      }
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener('visibilitychange', visible);
    void poll();
    return () => {
      document.removeEventListener('visibilitychange', visible);
      ended = true;
      clearTimeout(timer);
    };
  }, [identity, chat.windowId, chat.online, historyQuery, daemon]);
  useEffect(() => {
    const restore = () => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? '{}');
        setText(typeof saved.text === 'string' ? saved.text : '');
        const value = mirrorSendSchema.safeParse(saved.pending);
        pendingRef.current =
          value.success &&
          value.data.threadId === chat.threadId &&
          (value.data.provider ?? 'codex') === (chat.provider ?? 'codex')
            ? value.data
            : null;
        setPending(pendingRef.current);
        setPendingReceiptState(null);
      } catch {
        setText('');
        setPending(null);
        pendingRef.current = null;
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
    if (startHistory.current && state && viewport.current) {
      startHistory.current = false;
      viewport.current.scrollTop = 0;
      followTop.current = 0;
      follow.current = false;
      setFollowing(false);
      return;
    }
    if (
      !promptSelection &&
      follow.current &&
      viewport.current &&
      !document.documentElement.dataset.pdfOpen
    )
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [state?.entries, promptSelection]);
  useLayoutEffect(() => {
    if (promptSelection && viewport.current) {
      follow.current = false;
      setFollowing(false);
      scrollToPrompt(viewport.current, promptSelection.id);
      followTop.current = viewport.current.scrollTop;
    }
  }, [promptSelection]);
  useEffect(() => {
    const log = viewport.current;
    if (!log) return;
    // A keyboard or taller composer shrinks the log. Keep the newest message in view
    // only for a reader already at the bottom; anyone reading history keeps their place.
    const observer = new ResizeObserver(() => {
      if (!promptSelection && follow.current && !document.documentElement.dataset.pdfOpen)
        log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, [promptSelection]);
  function save(value: string, request: MirrorSend | null) {
    sessionStorage.setItem(draftKey, JSON.stringify({ text: value, pending: request }));
  }
  function history(direction: 'before' | 'after' | 'latest') {
    const cursor = direction !== 'latest' ? displayed?.page?.[direction] : undefined;
    setHistoryQuery(cursor ? `?${new URLSearchParams({ [direction]: cursor })}` : '');
    setPromptSelection(null);
    setState(null);
    startHistory.current = direction !== 'latest';
    follow.current = true;
    setFollowing(true);
  }
  // The newer reading wins. A chat read that started after discovery's failed refresh
  // restores the chat; that failure clears send, steer and stop from an older reading.
  const listFailed =
    chat.online && chat.status === 'offline' && (chat.listedAt ?? Infinity) >= readAt.current;
  const waitingForNativeInput =
    nativeRequests.available &&
    !nativeRequests.view?.nativeRequestsUnavailable &&
    (nativeRequests.view?.nativeRequestCount ?? 0) > 0;
  const status = waitingForNativeInput
    ? 'attention'
    : !chat.online || listFailed
      ? 'offline'
      : (state?.status ?? 'offline');
  const connecting = !!chat.online && !state && !error && !waitingForNativeInput;
  const [sendTiming, setSendTiming] = useState<'steer' | 'queue'>('steer');
  const canSteer = status === 'busy' && !!state?.canSteer && !!state.steerToken;
  const canQueue = status === 'busy' && !!state?.canQueue;
  const queueSelected = canQueue && (!canSteer || sendTiming === 'queue');
  const canSend = status === 'idle' || canSteer || canQueue;
  const localGoal = !pending && /^\/goal(?:\s|$)/.test(withoutChatAttachments(text).trim());
  const openGoal = () => {
    if (!chat.threadId) {
      setReceipt(
        'This connection has no selected conversation for a goal. Your draft is retained.',
      );
      return;
    }
    if (notepadOpen) flushSync(() => setNotepadOpen(false));
    input.current?.focus({ preventScroll: true });
    setGoalOpen(`${apiScope()}:${identity}`);
  };
  function resolvePending(input: MirrorSend, sentRevision: number, delivered: boolean) {
    // Resolve only this exact browser intent, preserving any edited or later draft.
    let savedUpdated = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? '{}');
      if (saved.pending?.key === input.key) {
        const currentText =
          typeof saved.text === 'string' ? saved.text : browserNotepad.draft.currentText();
        save(
          delivered && draftRevision.current === sentRevision && currentText.trim() === input.text
            ? ''
            : currentText,
          null,
        );
        savedUpdated = true;
      }
    } catch {
      /* The live view below still retains the result. */
    }
    if (mounted.current && pendingRef.current?.key === input.key) {
      pendingRef.current = null;
      setPending(null);
      setPendingReceiptState(null);
      setDeliveryOpen(false);
      if (
        delivered &&
        draftRevision.current === sentRevision &&
        browserNotepad.draft.currentText().trim() === input.text
      )
        setText('');
    }
    if (savedUpdated)
      window.dispatchEvent(new CustomEvent('dock:mirror-draft', { detail: draftKey }));
  }
  async function send(retryMissing = false) {
    if (
      retryMissing &&
      (!pending || pendingReceiptState !== 'missing' || !chat.online || status === 'offline')
    )
      return;
    const commandText = withoutChatAttachments(browserNotepad.draft.currentText()).trim();
    if (!pending && !busyRef.current && !uploading && /^\/goal(?:\s|$)/.test(commandText)) {
      if (commandText !== '/goal') {
        setReceipt('Use /goal by itself to open goal controls. Your draft is retained.');
      } else {
        openGoal();
      }
      return;
    }
    if (busyRef.current || uploading || !chat.threadId || (!pending && !canSend)) return;
    if (!pending && promptLengthError(browserNotepad.draft.currentText())) {
      return;
    }
    const input = pending ?? {
      key: crypto.randomUUID(),
      threadId: chat.threadId,
      ...(chat.provider === 'claude' ? { provider: 'claude' as const } : {}),
      ...(canSteer && !queueSelected ? { expectedTurnId: state!.steerToken! } : {}),
      ...(queueSelected ? { mode: 'queue' as const } : {}),
      text: text.trim(),
    };
    const checking = !!pending && !retryMissing;
    if (!input.text) return;
    const sentRevision = draftRevision.current;
    busyRef.current = true;
    try {
      save(text, input);
    } catch {
      setReceipt(
        daemon
          ? 'Draft storage is unavailable. Keep this page open and inspect the Codex session on your computer after any connection failure.'
          : 'Draft storage is unavailable. Keep this page open and inspect VS Code after any connection failure.',
      );
    }
    pendingRef.current = input;
    setPending(input);
    setPendingReceiptState(null);
    setBusy(true);
    try {
      const result = mirrorResultSchema.parse(
        checking
          ? await api(`/vscode/deliveries/${input.key}`)
          : await api(`/vscode/windows/${chat.windowId}/send`, input),
      );
      // Navigation may unmount this view while the request finishes. Only resolve
      // its own receipt, never overwrite a later draft or another provider/thread.
      if (result.state !== 'uncertain') {
        resolvePending(input, sentRevision, result.state === 'sent');
      } else if (mounted.current && pendingRef.current?.key === input.key && checking) {
        setPendingReceiptState(result.receiptState ?? null);
      }
      if (mounted.current)
        // This acknowledgement outlives delivery. Only the live queue above
        // should claim that a follow-up is still waiting.
        setReceipt(
          result.state === 'sent' && input.mode === 'queue'
            ? 'Follow-up accepted.'
            : result.message,
        );
      if (result.state === 'sent' && input.mode === 'queue')
        window.dispatchEvent(new CustomEvent('dock:mirror-queue', { detail: identity }));
    } catch (failure) {
      if (
        !checking &&
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        !connectionLost(failure)
      ) {
        resolvePending(input, sentRevision, false);
        if (mounted.current) setReceipt(`${failure.message} Your draft is retained.`);
      } else if (mounted.current) {
        setReceipt(
          'Delivery not confirmed. Check delivery reads the original receipt without sending again.',
        );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="mirror-conversation" aria-label={`${provider} chat`}>
      {chat.threadId && (
        <NativeGoalCard
          key={`${apiScope()}:${identity}`}
          goalPath={`/vscode/windows/${chat.windowId}/goal`}
          threadId={chat.threadId}
          provider={chat.provider ?? 'codex'}
          online={status !== 'offline'}
          place={daemon ? 'on your computer' : 'in VS Code'}
          open={goalOpen === `${apiScope()}:${identity}`}
          onClose={() => setGoalOpen(null)}
        />
      )}
      <header className="mirror-header">
        <span className={`mirror-avatar ${chat.provider ?? 'codex'}`}>
          <MessageSquare size={21} />
        </span>
        <div>
          <h1>{state?.title || chat.title || 'Untitled conversation'}</h1>
          <p>
            <span className={`mirror-presence ${status}`} />
            {connecting
              ? 'Connecting…'
              : mirrorStatus({
                  ...chat,
                  status,
                  nativeRequestCount:
                    nativeRequests.view?.nativeRequestCount ?? chat.nativeRequestCount,
                  nativeRequestsUnavailable:
                    nativeRequests.view?.nativeRequestsUnavailable ??
                    chat.nativeRequestsUnavailable,
                })}{' '}
            · {daemon ? chat.label : `${provider} in ${chat.label}`}
          </p>
        </div>
        {headerAction}
        <details className="mirror-controls">
          <summary aria-label="Chat information">
            <Monitor size={18} />
          </summary>
          {daemon ? (
            <div>
              <strong>Same Codex session, different screen</strong>
              <p>
                This is a native Codex conversation on your computer’s shared Codex server, possibly
                running in a terminal. Sent messages sync both ways. Unsent drafts stay separate.
              </p>
              <p>
                Messages typed on the computer and here at the same time can join the same reply.
                Use /goal here for native goal controls. Other slash commands, approvals,
                permissions and models stay in the original session on your computer. Stop reply is
                available here when supported. No new agent is started here.
              </p>
            </div>
          ) : (
            <div>
              <strong>Same chat, different screen</strong>
              <p>Sent messages sync both ways. Unsent drafts stay separate.</p>
              <p>
                Use /goal here for supported goal controls. Use VS Code for permissions, models and
                other slash commands. Screenshots can be attached here. Stop reply is available here
                when the connected provider supports it. No new agent is started here. After an
                editor crash, reopen VS Code and the original chat.
              </p>
            </div>
          )}
        </details>
      </header>
      {!connecting &&
        (error ||
          status === 'offline' ||
          (status === 'attention' && !waitingForNativeInput) ||
          state?.historyUnavailable) && (
          <div className="mirror-notice" role="status">
            {(waitingForNativeInput && error
              ? 'Conversation history could not refresh. Native requests are still connected; your draft and last reading are retained.'
              : error) ||
              (state?.status === status && state.message) ||
              (listFailed && chat.message) ||
              (daemon
                ? status === 'attention'
                  ? 'A request needs your attention on your computer. Approvals stay in the original Codex session there.'
                  : 'Offline. Reopen this Codex session on your computer to continue. Your draft stays here.'
                : status === 'attention'
                  ? 'A request needs your attention in VS Code. Approvals remain on your computer.'
                  : 'Offline. Open VS Code and share this conversation to continue. Your draft stays here.')}
          </div>
        )}
      <div className="mirror-reading-controls">
        {chat.threadId && (
          <MirrorNativeRequests
            key={`${apiScope()}:${identity}`}
            windowId={chat.windowId}
            threadId={chat.threadId}
            provider={chat.provider ?? 'codex'}
            requests={nativeRequests.view?.nativeRequests}
            unavailable={nativeRequests.view?.nativeRequestsUnavailable || !!nativeRequests.error}
            online={nativeRequests.available}
            readReady={!!nativeRequests.view || !!nativeRequests.error}
            error={nativeRequests.error}
            retry={nativeRequests.retry}
            daemon={daemon}
          />
        )}
        <nav className="mirror-history" aria-label="Conversation history">
          <button type="button" onClick={() => setPromptsOpen(true)}>
            Your prompts
          </button>
          {(historyQuery || promptSelection) && (
            <>
              <button
                type="button"
                disabled={!displayed?.page?.after}
                onClick={() => history('after')}
              >
                Continue reading
              </button>
              <button type="button" onClick={() => history('latest')}>
                Back to latest
              </button>
            </>
          )}
        </nav>
      </div>
      {promptsOpen && (
        <PromptHistory
          key={identity}
          close={() => setPromptsOpen(false)}
          read={async (before) => {
            const query = before ? `?${new URLSearchParams({ before })}` : '';
            const raw = mirrorStateSchema.parse(
              await api(`/vscode/windows/${chat.windowId}${query}`),
            );
            const value = raw.page ? raw : mirrorPage(raw, before ? { before } : {});
            if (mirrorKey(value) !== identity)
              throw new Error(
                'This connection now shares a different conversation. Reopen your chat.',
              );
            if (value.historyUnavailable)
              throw new Error(
                value.message ||
                  'This conversation’s history is currently unavailable. Reconnect and try again.',
              );
            return {
              value: { state: value, query },
              prompts: value.entries.filter((entry) => entry.role === 'user'),
              before: value.page?.before,
            };
          }}
          choose={(value, id) => {
            setHistoryQuery(value.query);
            setState(value.state);
            setPromptSelection({ state: value.state, id });
            setPromptsOpen(false);
          }}
        />
      )}
      {!promptSelection && state?.page?.reset && (
        <p className="mirror-notice">
          History changed {daemon ? 'on your computer' : 'in VS Code'}. Showing the latest messages.
        </p>
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
          follow.current = !promptSelection && (near || held);
          followTop.current = held ? Math.max(followTop.current, top) : top;
          setFollowing(follow.current);
        }}
      >
        <div className="mirror-messages">
          {/* Renders no element; nested history and images name the right computer place. */}
          <DaemonSource.Provider value={daemon}>
            {timelineRows(displayed?.entries ?? []).map((entries, index, rows) =>
              entries[0].role === 'activity' ? (
                <ActivityGroup
                  key={entries[0].id}
                  entries={entries}
                  provider={provider}
                  windowId={chat.windowId}
                  working={
                    !historyQuery &&
                    !promptSelection &&
                    status === 'busy' &&
                    index === rows.length - 1
                  }
                />
              ) : (
                <MirrorEntry
                  key={entries[0].id}
                  entry={entries[0]}
                  provider={provider}
                  windowId={chat.windowId}
                  selected={entries[0].id === promptSelection?.id}
                />
              ),
            )}
          </DaemonSource.Provider>
          {!displayed?.entries.length && !displayed?.historyUnavailable && (
            <p className="mirror-empty">
              {connecting
                ? 'Loading conversation…'
                : status === 'offline'
                  ? daemon
                    ? 'Conversation history is kept on your computer. It will appear when connected.'
                    : 'Conversation history is kept in VS Code. It will appear when connected.'
                  : 'No messages yet. Say hello when the conversation is ready.'}
            </p>
          )}
          {!historyQuery && !promptSelection && status === 'busy' && (
            <p className="mirror-working" role="status">
              <span className="live-dot" />
              {provider} is working…
            </p>
          )}
        </div>
        {/* Sticks to the bottom of the history, so it can never cover the composer. */}
        {!following && !historyQuery && !promptSelection && (
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
        data-keyboard={visible?.keyboard || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {chat.threadId && (
          <MirrorMessageQueue
            key={identity}
            provider={chat.provider ?? 'codex'}
            threadId={chat.threadId}
            canSteer={canSteer}
            nativeQueue={state}
          />
        )}
        <div className="mirror-input-row">
          <textarea
            ref={input}
            aria-label={`Message ${provider}`}
            value={withoutChatAttachments(text)}
            rows={1}
            aria-invalid={!!lengthError || undefined}
            placeholder={
              canSteer && !queueSelected
                ? 'Update the current task…'
                : canQueue
                  ? 'Add a follow-up…'
                  : status === 'idle'
                    ? `Message ${provider}…`
                    : 'Write a draft…'
            }
            onChange={(e) => {
              browserNotepad.draft.setText(
                withChatAttachmentText(browserNotepad.draft.currentText(), e.target.value),
              );
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
                  : queueSelected
                    ? 'Queue follow-up'
                    : 'Send'
            }
            disabled={
              busy ||
              uploading ||
              (!pending &&
                (!!lengthError ||
                  !text.trim() ||
                  (!canSend && !/^\/goal(?:\s|$)/.test(withoutChatAttachments(text).trim()))))
            }
          >
            {busy ? '…' : pending ? 'Check delivery' : <ArrowUp size={20} />}
          </button>
        </div>
        {/* Timing and Stop share the tools row so the draft and history keep the height. */}
        <div className="mirror-compose-tools">
          <ChatCommands onGoal={openGoal} />
          {state?.canSteer && state?.canQueue && (
            <select
              className="mirror-send-timing"
              aria-label="Send timing"
              title={
                sendTiming === 'queue'
                  ? 'Send a separate message after the current reply finishes.'
                  : 'Guide the reply in progress.'
              }
              value={sendTiming}
              disabled={busy || !!pending || !canSteer}
              onChange={(event) =>
                setSendTiming(event.target.value === 'queue' ? 'queue' : 'steer')
              }
            >
              <option value="steer">Steer now</option>
              <option value="queue">Queue next</option>
            </select>
          )}
          <ChatAttachmentPicker
            key={identity}
            text={text}
            currentText={browserNotepad.draft.currentText}
            setText={browserNotepad.draft.setText}
            disabled={busy || !!pending}
            uploadDisabled={chat.canAttachImages === false || state?.canAttachImages === false}
            uploader={attachmentUpload}
          />
          <button
            type="button"
            className="mirror-notepad"
            aria-label="Open notepad"
            onClick={() => {
              if (input.current)
                selection.current = {
                  start: input.current.selectionStart,
                  end: input.current.selectionEnd,
                };
              setNotepadOpen(true);
            }}
          >
            <NotebookPen size={16} aria-hidden="true" /> <span>Notepad</span>
          </button>
          {chat.threadId && (
            <MirrorStopReply
              windowId={chat.windowId}
              threadId={chat.threadId}
              provider={chat.provider ?? 'codex'}
              token={status !== 'offline' ? state?.stopToken : undefined}
              daemon={daemon}
            />
          )}
        </div>
        {(chat.canAttachImages === false || state?.canAttachImages === false) && (
          <p className="mirror-note">
            Remote attachments are unavailable. Remove saved files to send text; attach in VS Code.
          </p>
        )}
        {lengthError && (
          <p className="mirror-receipt" role="alert">
            {lengthError}
          </p>
        )}
        <details className="mirror-delivery-status" title={receipt || undefined}>
          <summary aria-live="polite">{receipt || '\u00a0'}</summary>
          {receipt && <p>{receipt}</p>}
        </details>
        {notepadOpen && (
          <Notepad
            draft={browserNotepad.draft}
            agentId={chat.threadId ?? identity}
            clientId={null}
            agentName={provider}
            mode="message"
            selection={selection}
            localOnly
            localHistory={browserNotepad.history}
            maxLength={promptTextLimit}
            canSend={
              !busy &&
              !uploading &&
              (!!pending || (!lengthError && !!text.trim() && (canSend || localGoal)))
            }
            sending={busy}
            notice={lengthError || receipt}
            onMinimize={() => {
              browserNotepad.checkpoint();
              refocus.current = true;
              setNotepadOpen(false);
            }}
            onSend={() => {
              void send();
            }}
            attachments={
              <ChatAttachmentPicker
                text={text}
                currentText={browserNotepad.draft.currentText}
                setText={browserNotepad.draft.setText}
                disabled={busy || !!pending}
                uploadDisabled={chat.canAttachImages === false || state?.canAttachImages === false}
                uploader={attachmentUpload}
              />
            }
            controls={
              <p className="mirror-note">
                {pending
                  ? 'Check delivery resolves the original receipt before another message can be sent.'
                  : canSteer && !queueSelected
                    ? 'Sends an update to the current reply.'
                    : canQueue
                      ? `Queues a follow-up for ${provider}.`
                      : 'Sends to this shared conversation.'}
              </p>
            }
          />
        )}
        {pending && (
          <div className="mirror-delivery-actions">
            {pendingReceiptState === 'missing' && (
              <button
                type="button"
                className="secondary"
                disabled={busy || !chat.online || status === 'offline'}
                onClick={() => void send(true)}
              >
                Retry message
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setInspectedDelivery(false);
                setDeliveryOpen(true);
              }}
            >
              Review delivery
            </button>
          </div>
        )}
        {deliveryOpen && pending && (
          <Modal title="Message delivery" close={() => setDeliveryOpen(false)}>
            <p role="status">
              {receipt || 'The original message has an unresolved delivery receipt.'}
            </p>
            <p>
              {pendingReceiptState === 'missing'
                ? 'This computer has no recorded receipt for this message. Retry message sends the same original message once, or returns its retained result if a delayed request already arrived.'
                : pendingReceiptState === 'recorded'
                  ? 'This computer recorded the original request, but native acceptance is uncertain. Inspect the conversation before sending anything again.'
                  : 'Check status reads the original receipt without sending. An older or unavailable connection may not distinguish a missing receipt from a recorded uncertain delivery.'}
            </p>
            <details className="mirror-original-message">
              <summary>Original message</summary>
              <pre>{pending.text}</pre>
            </details>
            <p>Your edited draft is separate. A retry never sends the edited draft.</p>
            <div className="mirror-delivery-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void send()}
              >
                Check status
              </button>
              {pendingReceiptState === 'missing' && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !chat.online || status === 'offline'}
                  onClick={() => void send(true)}
                >
                  Retry message
                </button>
              )}
            </div>
            <p>
              Inspect the original conversation {daemon ? 'on your computer' : 'in VS Code'}. If you
              have checked it, you may clear this browser reminder. Clearing does not withdraw, undo
              or repeat a message.
            </p>
            <label className="mirror-delivery-confirm">
              <input
                type="checkbox"
                checked={inspectedDelivery}
                onChange={(event) => setInspectedDelivery(event.target.checked)}
              />
              <span>I inspected the original conversation.</span>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy || !inspectedDelivery}
              onClick={() => {
                try {
                  save(browserNotepad.draft.currentText(), null);
                } catch {
                  setReceipt('The browser reminder could not be cleared. It is retained.');
                  return;
                }
                pendingRef.current = null;
                setPending(null);
                setPendingReceiptState(null);
                setDeliveryOpen(false);
                setReceipt('Browser reminder cleared after your check. No message was repeated.');
              }}
            >
              Clear browser reminder
            </button>
          </Modal>
        )}
      </form>
    </section>
  );
}
