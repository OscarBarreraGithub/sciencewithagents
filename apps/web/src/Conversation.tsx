import './Composer.css';
import { AppMessageQueue } from './AppMessageQueue';
import { ConversationStatus } from './ConversationStatus';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAttachmentPicker, useChatAttachmentUpload } from './ChatImages';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  GitBranch,
  Layers3,
  Maximize2,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Terminal,
} from 'lucide-react';
import {
  parseMcpFormValues,
  withoutChatAttachments,
  withChatAttachmentText,
  jobEstimateSchema,
  type Agent,
  type AgentDetail,
  type Approval,
  type Entry,
  type Task,
  type WorkspaceSnapshot,
  type WorkspaceDraftSubmission,
  type JobEstimate,
  type McpFormValues,
} from '@dock/shared';
import { api, apiScope, apiUrl, detail, ApiError } from './api';
import { useSharedDraft, workspaceStorageKey, type SharedDraft } from './useWorkspaceState';
import { DraftHandoff } from './WorkspacePanel';
import { McpFormFields } from './McpFormFields';
import { McpUrlLink } from './McpUrlLink';
import { Notepad, type DraftSelection } from './Notepad';
import { useScrollHints } from './home/useScrollHints';

function SendTiming({
  steer,
  disabled,
  onChange,
}: {
  steer: boolean;
  disabled: boolean;
  onChange: (steer: boolean) => void;
}) {
  return (
    <select
      className="composer-timing"
      aria-label="Send timing"
      title={
        steer
          ? 'Guide the reply Codex is working on now.'
          : 'Send a separate message after the current reply finishes.'
      }
      value={steer ? 'steer' : 'queue'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === 'steer')}
    >
      <option value="steer">Steer now</option>
      <option value="queue">Queue next</option>
    </select>
  );
}

export const time = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const roleLabel = {
  manager: 'Manager',
  planner: 'Planner',
  implementer: 'Builder',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
};
export const statusLabel: Record<string, string> = {
  idle: 'Ready',
  queued: 'Queued',
  running: 'Working',
  waiting: 'Needs input',
  interrupted: 'Interrupted',
  failed: 'Needs attention',
  open: 'Open',
  working: 'In progress',
  review: 'In review',
  needs_decision: 'Decision needed',
  done: 'Completed',
  integrated: 'Changes applied',
  split: 'Split into smaller tasks',
};
export function Badge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`badge ${status}`}>
      <span />
      {label ?? statusLabel[status] ?? status}
    </span>
  );
}
export function TaskBadge({ task }: { task: Task }) {
  return (
    <Badge
      status={task.status}
      label={task.status === 'done' && task.hasReviewedChanges ? 'Ready to apply' : undefined}
    />
  );
}
export function Avatar({ role, small = false }: { role: Agent['role']; small?: boolean }) {
  return (
    <span className={`avatar ${role} ${small ? 'small' : ''}`}>
      {role === 'manager' ? (
        <Layers3 size={small ? 15 : 19} />
      ) : role === 'reviewer' ? (
        <Check size={small ? 15 : 19} />
      ) : role === 'implementer' ? (
        <Terminal size={small ? 15 : 19} />
      ) : (
        <Search size={small ? 15 : 19} />
      )}
    </span>
  );
}
export function Markdown({ children }: { children: string }) {
  return <ChatMarkdown>{children}</ChatMarkdown>;
}

// Consecutive tool calls become one activity row, so messages stay the timeline.
type TimelineRow = Entry | Entry[];
function timeline(entries: Entry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if (entry.kind === 'tool' && !entry.image) {
      if (Array.isArray(last)) last.push(entry);
      else rows.push([entry]);
    } else rows.push(entry);
  }
  return rows;
}
const failedTool = (status: string) => /fail|error|declin|cancel/i.test(status);
const groupLimit = 100;

/** Collapsed activity; bodies render only when opened. */
function ToolGroup({ entries, working }: { entries: Entry[]; working: boolean }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(groupLimit);
  const last = entries[entries.length - 1]!;
  const problems = entries.filter((entry) => failedTool(entry.status)).length;
  const shown = entries.slice(-limit);
  return (
    <details className="tool-group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        <span className="tool-group-count">
          {working ? 'Working · ' : ''}
          {entries.length.toLocaleString()} {entries.length === 1 ? 'action' : 'actions'}
          {problems ? ` · ${problems} failed` : ''}
        </span>
        <span className="tool-group-current">{last.title}</span>
      </summary>
      {open && (
        <div className="tool-group-body">
          {entries.length > shown.length && (
            <button
              type="button"
              className="load-history"
              onClick={() => setLimit((value) => value + groupLimit)}
            >
              Show {Math.min(groupLimit, entries.length - shown.length)} earlier actions
            </button>
          )}
          {shown.map((entry) => (
            <ToolEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </details>
  );
}
function ToolEntry({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="tool-entry" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Terminal size={14} />
        <span>{entry.title}</span>
        <span className={`tool-state${failedTool(entry.status) ? ' failed' : ''}`}>
          {entry.status}
        </span>
        <ChevronDown size={13} />
      </summary>
      {open && <pre>{entry.text || 'Waiting for the result…'}</pre>}
    </details>
  );
}

export function Conversation({
  agent,
  detail: data,
  approvals,
  act,
  personal = false,
  intro,
  formatEntry,
}: {
  agent: Agent;
  detail: AgentDetail | null;
  approvals: Approval[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  personal?: boolean;
  intro?: { title: string; description: string; note: string };
  formatEntry?: (entry: Entry) => Entry;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const scrollHint = useScrollHints(scroll, agent.id);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const shownApproval = useRef<string | null>(null);
  const [older, setOlder] = useState<AgentDetail | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyRequest = useRef(0);
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const first = approvals[0]?.id ?? null;
    if (first) {
      if (shownApproval.current !== first) {
        const card = container.querySelector('.approval-card');
        if (card)
          container.scrollTop +=
            card.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
      }
    } else if (!older && pinned.current && !document.documentElement.dataset.pdfOpen)
      container.scrollTop = container.scrollHeight;
    shownApproval.current = first;
  }, [data, approvals, older]);
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    pinned.current = !older;
    container.scrollTop = older ? 0 : container.scrollHeight;
    lastTop.current = container.scrollTop;
  }, [older]);
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    // A keyboard, a taller composer or late layout (fonts, formatting) resizes the timeline.
    // Keep the newest message in view only for a reader already at the bottom; anyone
    // reading history keeps their place.
    const observer = new ResizeObserver(() => {
      if (pinned.current && !document.documentElement.dataset.pdfOpen)
        container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const entries = (older?.entries ?? data?.entries ?? [])
    .map((e) => (formatEntry ? formatEntry(e) : e))
    .filter((e, i, all) => all.findIndex((v) => v.id === e.id) === i);
  const load = async () => {
    if (loadingHistory) return;
    const request = ++historyRequest.current;
    setLoadingHistory(true);
    try {
      const result = await detail(agent.id, entries[0]?.id);
      if (request === historyRequest.current) setOlder(result);
    } finally {
      if (request === historyRequest.current) setLoadingHistory(false);
    }
  };
  return (
    <>
      <div
        className="conversation"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (!element) return;
          // Only the reader moving up leaves the newest message. Scrolls caused by layout,
          // pinning or scroll anchoring must not unpin a reader who was at the bottom.
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          if (nearBottom) pinned.current = true;
          else if (element.scrollTop < lastTop.current - 1) pinned.current = false;
          lastTop.current = element.scrollTop;
        }}
      >
        <div className="conversation-inner">
          <div className="conversation-scroll-hint" aria-hidden={!scrollHint}>
            {scrollHint}
          </div>
          <div className="conversation-date">
            <span />
            {new Date(agent.createdAt).toLocaleDateString([], { month: 'long', day: 'numeric' })}
            <span />
          </div>
          {older && (
            <button
              className="load-history"
              onClick={() => {
                historyRequest.current++;
                setLoadingHistory(false);
                setOlder(null);
              }}
            >
              Latest messages
            </button>
          )}
          {(older?.hasMore ?? data?.hasMore) && (
            <button
              className="load-history"
              disabled={loadingHistory}
              onClick={() => void act(load)}
            >
              Load earlier messages
            </button>
          )}
          {entries.length === 0 && (
            <div className="conversation-intro">
              <Avatar role={agent.role} />
              <h2>{intro?.title ?? agent.name}</h2>
              <p>
                {intro?.description ??
                  (personal
                    ? 'Talk through your priorities, ask about saved progress, or pass a request to a project manager you have chosen to share.'
                    : agent.role === 'manager'
                      ? 'Describe the project or send the next task. Your manager can delegate work and ask for input here.'
                      : 'Assignments, questions, tool results and handoffs will stay in this conversation.')}
              </p>
              <div className="starter-note">
                <GitBranch size={16} />{' '}
                {intro?.note ??
                  (personal
                    ? 'Your assistant sees only the projects and notes you choose in Assistant privacy.'
                    : 'Your team prepares changes separately. Your project settings decide how reviewed changes are applied.')}
              </div>
            </div>
          )}
          {timeline(
            entries.filter(
              (entry) => !(entry.kind === 'system' && entry.title === 'Original queued message'),
            ),
          ).map((row, index, rows) => {
            if (Array.isArray(row))
              return (
                <ToolGroup
                  key={row[0]!.id}
                  entries={row}
                  working={!older && agent.status === 'running' && index === rows.length - 1}
                />
              );
            // The stored supervision event is still a message from the person. Render
            // both existing and newly sent steering with the normal user bubble.
            const entry: Entry =
              row.kind === 'system' && row.title === 'Owner steering'
                ? { ...row, kind: 'user', title: 'You' }
                : row;
            return entry.image ? (
              <figure className="generated-image" key={entry.id}>
                <a
                  href={apiUrl(`/agents/${entry.agentId}/images/${entry.image.id}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open generated image"
                >
                  <img
                    src={apiUrl(`/agents/${entry.agentId}/images/${entry.image.id}`)}
                    alt="Generated image"
                    width={entry.image.width}
                    height={entry.image.height}
                    loading="lazy"
                  />
                </a>
                <figcaption>
                  <strong>Generated image</strong>
                  <a
                    href={apiUrl(`/agents/${entry.agentId}/images/${entry.image.id}`)}
                    download={`generated-${entry.image.id}.png`}
                  >
                    Download PNG
                  </a>
                </figcaption>
                <details>
                  <summary>Generation prompt</summary>
                  <p>{entry.text}</p>
                </details>
              </figure>
            ) : entry.kind === 'system' ? (
              <div className="system-entry" key={entry.id}>
                <Clock3 size={14} />
                <div>
                  <strong>{entry.title}</strong>
                  <p>{entry.text}</p>
                  {entry.urlRequest && <McpUrlLink request={entry.urlRequest} />}
                </div>
              </div>
            ) : (
              <article className={`message ${entry.kind}`} key={entry.id}>
                <div className="message-avatar">
                  {entry.kind === 'user' ? (
                    <span className="user-avatar">You</span>
                  ) : (
                    <Avatar role={agent.role} small />
                  )}
                </div>
                <div className="message-body">
                  <div className="message-heading">
                    <strong>{entry.title}</strong>
                    {entry.kind === 'message' && (
                      <span className="handoff-label">TEAM MESSAGE</span>
                    )}
                    <time>{time(entry.createdAt)}</time>
                  </div>
                  <div className="markdown">
                    <ChatMarkdown entry={entry}>{entry.text}</ChatMarkdown>
                  </div>
                  {entry.status === 'streaming' && <span className="stream-caret" />}
                </div>
              </article>
            );
          })}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} act={act} />
          ))}
          <ConversationStatus agent={agent} />
          {['interrupted', 'failed'].includes(agent.status) && (
            <div className="recovery-note">
              <RefreshCw size={16} />
              <div>
                <strong>History is safe.</strong>
                <p>
                  Inspect the last result, then send a message or choose Resume from history to
                  continue.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <AppMessageQueue agent={agent} runs={data?.runs ?? []} />
    </>
  );
}

export function Composer({
  agent,
  workspace,
  disabled,
  send,
  onError,
  onCommand,
  onStop,
  onHelp,
  notepad,
  reference,
  onNotepadClose,
  draftOverride,
  maxLength = 24_000,
  specialized = false,
  localHistory,
  messagePlaceholder,
  onSent,
  onDraftReady,
}: {
  agent: Agent;
  workspace: WorkspaceSnapshot | null;
  disabled: boolean;
  send: (
    text: string,
    key: string,
    steer: boolean,
    draft?: WorkspaceDraftSubmission,
    scheduling?: JobEstimate,
  ) => Promise<void>;
  onError: (error: string) => void;
  onCommand: (command: 'new' | 'compact' | 'resume' | 'interrupt') => void;
  onStop: () => void;
  onHelp: () => void;
  /** Open the full-page notepad on mount, e.g. for a new project's first brief. */
  notepad?: 'brief';
  /** Quote an exact note or to-do at the caret. Referencing never sends. */
  reference?: { nonce: number; text: string } | null;
  onNotepadClose?: () => void;
  /** Specialized APIs keep their own receipts and can prepare a browser-only first draft. */
  draftOverride?: SharedDraft;
  maxLength?: number;
  specialized?: boolean;
  messagePlaceholder?: string;
  localHistory?: { versions: { text: string; at: string }[]; restore: (text: string) => void };
  /** Specialized conversations can follow an acknowledged replacement thread. */
  onSent?: (remainingDraft: string) => void;
  /** Uses the existing draft owner; callers must not replace conflicting typing. */
  onDraftReady?: (draft: SharedDraft) => void;
}) {
  const managedDraft = useSharedDraft(draftOverride ? null : workspace, agent.id);
  const sourceDraft = draftOverride ?? managedDraft;
  useEffect(() => {
    if (sourceDraft.ready) onDraftReady?.(sourceDraft);
  }, [sourceDraft.ready, sourceDraft.text, sourceDraft.conflict, onDraftReady]);
  const draftRevision = useRef(0);
  const draft: SharedDraft = {
    ...sourceDraft,
    setText: (value) => {
      draftRevision.current++;
      sourceDraft.setText(value);
    },
  };
  const { text, setText } = draft;
  // The notepad is another view of this same draft, never a second draft.
  const [expanded, setExpanded] = useState<false | 'brief' | 'message'>(notepad ?? false);
  const [notice, setNotice] = useState('');
  const selection = useRef<DraftSelection>({ start: text.length, end: text.length });
  const refocus = useRef(false);
  const fail = (reason: string) => {
    setNotice(reason);
    onError(reason);
  };
  const storageKey = workspaceStorageKey(`send:${agent.id}`);
  const receiptStorage = draftOverride ? sessionStorage : localStorage;
  const scope = useRef(apiScope()).current;
  const [legacyBackup, setLegacyBackup] = useState<string | null>(() =>
    localStorage.getItem(`${storageKey}:legacy`),
  );
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const attachmentUpload = useChatAttachmentUpload({
    currentText: draft.currentText,
    setText,
    maxLength,
    onBusy: setUploading,
  });
  const [literalSlash, setLiteralSlash] = useState(false);
  // A running Codex turn accepts native steering, so a new message updates it by default.
  // Turning it off sends a separate message; a retry always keeps its recorded mode.
  const canSteer = !specialized && agent.provider === 'codex' && agent.status === 'running';
  const [steerChoice, setSteer] = useState<boolean | null>(null);
  const steer = canSteer ? (steerChoice ?? true) : false;
  const tools = useRef<HTMLDivElement>(null);
  const [moreTools, setMoreTools] = useState(false);
  useLayoutEffect(() => {
    const element = tools.current;
    if (!element) return;
    const read = () =>
      setMoreTools(element.scrollWidth - element.clientWidth - element.scrollLeft > 8);
    const observer = new ResizeObserver(read);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener('scroll', read, { passive: true });
    read();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', read);
    };
  }, [canSteer, specialized, steer]);
  const [priority, setPriority] = useState<JobEstimate['priority']>('interactive');
  const [unknownLegacyMode, setUnknownLegacyMode] = useState(false);
  type PendingMessage = {
    key: string;
    text: string;
    steer: boolean;
    draft?: WorkspaceDraftSubmission;
    scheduling?: JobEstimate;
    modeUnknown?: boolean;
  };
  const retry = useRef<PendingMessage | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [rejectedText, setRejectedText] = useState<string | null>(() => {
    try {
      return receiptStorage.getItem(`${storageKey}:rejected`);
    } catch {
      return null;
    }
  });
  const sendingRef = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!draft.ready) return;
    let active = true;
    try {
      // Migrate only the local host's older storage. Never copy it into another account's host.
      if (apiScope() === 'local') {
        const legacyKey = `dock:draft:${agent.id}`;
        const oldDraft = localStorage.getItem(legacyKey);
        if (oldDraft !== null && !localStorage.getItem(`${storageKey}:legacy-migrated`)) {
          localStorage.setItem(`${storageKey}:legacy`, oldDraft);
          localStorage.setItem(`${storageKey}:legacy-migrated`, '1');
          setLegacyBackup(oldDraft);
          if (!draft.currentText() && draft.state?.own.revision === 0) {
            setText(oldDraft);
            void draft
              .flush()
              .then(() => {
                localStorage.removeItem(legacyKey);
                localStorage.removeItem(`${storageKey}:legacy`);
                if (active) setLegacyBackup(null);
              })
              .catch(() => {});
          } else if (draft.currentText() === oldDraft) {
            localStorage.removeItem(legacyKey);
            localStorage.removeItem(`${storageKey}:legacy`);
            setLegacyBackup(null);
          }
        }
        const oldPending = localStorage.getItem(`${legacyKey}:pending`);
        if (oldPending && !receiptStorage.getItem(`${storageKey}:pending`)) {
          receiptStorage.setItem(`${storageKey}:pending`, oldPending);
          localStorage.removeItem(`${legacyKey}:pending`);
        }
      }
      const raw = receiptStorage.getItem(`${storageKey}:pending`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PendingMessage>;
      const pending: PendingMessage = {
        key: parsed.key ?? '',
        text: parsed.text ?? '',
        steer: parsed.steer === true,
        ...(typeof parsed.steer !== 'boolean' || parsed.modeUnknown ? { modeUnknown: true } : {}),
        ...(parsed.draft ? { draft: parsed.draft } : {}),
        ...(parsed.scheduling ? { scheduling: jobEstimateSchema.parse(parsed.scheduling) } : {}),
      };
      if (typeof pending.key !== 'string' || typeof pending.text !== 'string') return;
      retry.current = pending;
      setPendingText(pending.text);
      setUnknownLegacyMode(Boolean(pending.modeUnknown));
      setSteer(pending.steer);
      if (specialized) return;
      void api<{
        run: { text: string } | null;
        submitted?: { text: string; steer: boolean } | null;
      }>(`/agents/${agent.id}/receipts/${pending.key}`)
        .then(async (value) => {
          if (!active || retry.current?.key !== pending.key) return;
          const acknowledged =
            value.submitted ?? (value.run ? { text: value.run.text, steer: false } : null);
          if (
            acknowledged?.text !== pending.text ||
            (!pending.modeUnknown && acknowledged.steer !== pending.steer)
          )
            return;
          if (pending.draft) await draft.clearSent(pending.text, pending.draft);
          else if (draft.currentText().trim() === pending.text) {
            setText('');
            await draft.flush();
          }
          if (!active || retry.current?.key !== pending.key) return;
          const saved = receiptStorage.getItem(`${storageKey}:pending`);
          if (saved && (JSON.parse(saved) as PendingMessage).key !== pending.key) return;
          receiptStorage.removeItem(`${storageKey}:pending`);
          retry.current = null;
          setPendingText(null);
          setUnknownLegacyMode(false);
        })
        .catch(() => {
          /* Keep the exact pending key for a deliberate retry. */
        });
    } catch {
      fail('The saved draft receipt could not be read. Your draft is retained.');
    }
    return () => {
      active = false;
    };
  }, [storageKey, draft.ready]);
  /** Resolves true only after the manager accepted the message. */
  const submit = async (asText = false): Promise<boolean> => {
    const value = draft.currentText().trim();
    const sentRevision = draftRevision.current;
    if (
      (!value && !retry.current) ||
      sendingRef.current ||
      uploading ||
      (disabled && !(specialized && retry.current?.text === value)) ||
      !draft.ready ||
      draft.conflict ||
      unknownLegacyMode
    )
      return false;
    if (apiScope() !== scope) return false;
    setNotice('');
    if (!retry.current && !specialized && value.startsWith('/') && !asText) {
      const match = {
        '/new': 'new',
        '/clear': 'new',
        '/compact': 'compact',
        '/resume': 'resume',
        '/stop': 'interrupt',
      }[value] as 'new' | 'compact' | 'resume' | 'interrupt' | undefined;
      if (match) {
        if (agent.provider === 'claude' && match === 'compact') {
          fail(
            'Claude manages compaction itself. Your draft is retained. Use New context only when you want a fresh conversation.',
          );
          return false;
        }
        onCommand(match);
        setText('');
      } else {
        setLiteralSlash(true);
        fail(
          agent.provider === 'claude'
            ? 'This can be sent as text, including a file path. For Claude slash commands, use Claude Code or its shared editor chat. Your draft is retained.'
            : 'This can be sent as text, including a file path. Use Native terminal in Advanced controls for Codex slash commands. Your draft is retained.',
        );
      }
      return false;
    }
    setLiteralSlash(false);
    sendingRef.current = true;
    setSending(true);
    try {
      let pending = retry.current;
      if (!pending) {
        const token = await draft.flush();
        if ((!token && !draftOverride) || draft.currentText().trim() !== value)
          throw new Error(
            'Your text changed while preparing to send. Review it and choose Send again.',
          );
        pending = {
          key: crypto.randomUUID(),
          text: value,
          steer,
          ...(token ? { draft: token } : {}),
          ...(!steer && priority !== 'interactive'
            ? { scheduling: jobEstimateSchema.parse({ priority }) }
            : {}),
        };
      }
      retry.current = pending;
      setPendingText(pending.text);
      try {
        receiptStorage.setItem(`${storageKey}:pending`, JSON.stringify(pending));
      } catch {
        throw new Error(
          'The retry receipt could not be saved. Keep this page open and free browser storage before sending.',
        );
      }
      // A retry preserves the original mode and token even if a running turn ended meanwhile.
      if (apiScope() !== scope)
        throw new Error(
          'The selected computer changed. Reopen the original computer to send its draft.',
        );
      await send(pending.text, pending.key, pending.steer, pending.draft, pending.scheduling);
      if (draftRevision.current === sentRevision && pending.draft)
        await draft.clearSent(pending.text, pending.draft);
      else if (
        draftRevision.current === sentRevision &&
        draft.currentText().trim() === pending.text
      ) {
        setText('');
        await draft.flush();
      }
      receiptStorage.removeItem(`${storageKey}:pending`);
      retry.current = null;
      setPendingText(null);
      setSteer(null);
      try {
        onSent?.(draft.currentText());
      } catch {
        // Delivery is confirmed. A view transition must never create a send retry.
        fail('Message accepted. Reopen this conversation to continue. Your draft is retained.');
      }
      textarea.current?.focus({ preventScroll: true });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DRAFT_CHANGED') {
        // This typed refusal happens before reservation. A confirmed delivery
        // returns its existing receipt first, even after the draft has changed.
        const rejected = retry.current?.text ?? null;
        setRejectedText(rejected);
        try {
          if (rejected) receiptStorage.setItem(`${storageKey}:rejected`, rejected);
        } catch {
          /* Current draft is retained separately. */
        }
        retry.current = null;
        setPendingText(null);
        receiptStorage.removeItem(`${storageKey}:pending`);
        fail(
          'That message was not sent because the draft changed. Your current draft is kept; review it and choose Send.',
        );
        return false;
      }
      if (e instanceof ApiError && e.code === 'NO_ACTIVE_TURN') {
        // The host rejected this before reserving or submitting it. Keep the
        // draft, but let an explicit next Send become a normal follow-up.
        retry.current = null;
        setPendingText(null);
        receiptStorage.removeItem(`${storageKey}:pending`);
        setSteer(false);
        fail(
          'The reply finished before your update was sent. Your draft is safe; press Send to send it as a follow-up.',
        );
        return false;
      }
      fail(e instanceof Error ? e.message : 'Could not send. Your draft is retained.');
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const canSend =
    (!disabled || (specialized && retry.current?.text === text.trim())) &&
    !sending &&
    !uploading &&
    draft.ready &&
    !draft.conflict &&
    !unknownLegacyMode &&
    (!!text.trim() || pendingText !== null);
  const openNotepad = (mode: 'brief' | 'message') => {
    const area = textarea.current;
    if (area) selection.current = { start: area.selectionStart, end: area.selectionEnd };
    setExpanded(mode);
  };
  const closeNotepad = () => {
    refocus.current = true;
    setExpanded(false);
    onNotepadClose?.();
  };
  const rememberSelection = () => {
    const area = textarea.current;
    if (area) selection.current = { start: area.selectionStart, end: area.selectionEnd };
  };
  // Grow with the message up to the stylesheet's max-height, then scroll inside.
  const resize = () => {
    const area = textarea.current;
    if (!area) return;
    area.style.height = 'auto';
    const style = getComputedStyle(area);
    let limit = Number.parseFloat(style.maxHeight);
    const wanted = area.scrollHeight + 2;
    // A short keyboard or zoomed phone can leave less room than the percentage cap.
    // In a clipping chat pane, stop where Send would pass the pane's bottom edge.
    const composer = area.parentElement;
    const pane = composer?.parentElement;
    const paneStyle = pane && getComputedStyle(pane);
    if (composer && pane && paneStyle && /hidden|clip/.test(paneStyle.overflowY)) {
      const floor = Number.parseFloat(style.minHeight) || 0;
      const tried = Number.isFinite(limit) ? Math.min(wanted, limit) : wanted;
      const bottom =
        pane.getBoundingClientRect().bottom - Number.parseFloat(paneStyle.borderBottomWidth);
      const over = (height: number) => {
        area.style.height = `${height}px`;
        return composer.getBoundingClientRect().bottom - bottom;
      };
      // Zoomed text with an open keyboard can hide Send even at the smallest textarea.
      // Then fold the toolbar into one row, and next give up the message floor.
      // Start from the ordinary layout each time so a closing keyboard restores it.
      delete composer.dataset.fit;
      if (over(tried) > 0.5)
        for (const fit of ['compact', 'tight']) {
          if (over(floor) <= 0.5) break;
          composer.dataset.fit = fit;
        }
      const excess = over(tried);
      if (excess > 0.5) limit = Math.max(floor, Math.floor(tried - excess));
    }
    const capped = Number.isFinite(limit) && wanted > limit;
    area.style.height = `${capped ? limit : wanted}px`;
    area.style.overflowY = capped ? 'auto' : 'hidden';
  };
  useLayoutEffect(resize, [text, expanded, steer, canSteer]);
  useEffect(() => {
    // The phone cap follows the visible viewport, which a keyboard changes without a
    // window resize. Measure after the shell has applied the new visible height.
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };
    // A full-screen dialog mounts hidden before showModal. Remeasure when it
    // becomes visible, and when a side panel changes the available writing width.
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        // Height changes do not retrigger this width guard. Measure directly so
        // restored drafts also size correctly when Safari suspends animation frames.
        resize();
      }
    });
    if (textarea.current) observer.observe(textarea.current);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', later);
    };
  }, []);
  useEffect(() => {
    if (expanded || !refocus.current) return;
    refocus.current = false;
    const area = textarea.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    const { start, end } = selection.current;
    area.setSelectionRange(Math.min(start, area.value.length), Math.min(end, area.value.length));
  }, [expanded]);
  useEffect(() => {
    if (!reference) return;
    if (draft.conflict) {
      fail('Choose which draft to keep before adding a reference. Nothing was changed.');
      return;
    }
    const current = draft.currentText();
    const start = Math.min(selection.current.start, current.length);
    const end = Math.min(Math.max(selection.current.end, start), current.length);
    const before = current.slice(0, start);
    const insert = `${before && !before.endsWith('\n') ? '\n' : ''}${reference.text}\n`;
    const next = before + insert + current.slice(end);
    if (next.length > maxLength) {
      fail('Adding this reference would exceed the message limit. Your draft is unchanged.');
      return;
    }
    setText(next);
    const caret = start + insert.length;
    selection.current = { start: caret, end: caret };
    if (expanded) return;
    requestAnimationFrame(() => {
      const area = textarea.current;
      if (!area) return;
      area.focus({ preventScroll: true });
      area.setSelectionRange(caret, caret);
    });
  }, [reference?.nonce]);
  // Only the ordinary saved state is shortened on phones; progress, receipts and errors stay full.
  const draftSteady =
    draft.ready &&
    !draft.saving &&
    !draft.unsaved &&
    !draft.error &&
    !draft.conflict &&
    !draft.state?.own.submitted;
  return (
    <div className={`composer${draftSteady ? ' draft-steady' : ''}`}>
      <textarea
        ref={textarea}
        aria-label={`Message ${agent.name}`}
        placeholder={
          messagePlaceholder ??
          (steer
            ? 'Guide the reply in progress…'
            : canSteer
              ? 'Write the next message…'
              : agent.provider === 'claude' && agent.status === 'running'
                ? 'Add a follow-up…'
                : agent.role === 'manager'
                  ? 'Describe an idea, ask a question, or move the work forward…'
                  : `Message ${agent.name}…`)
        }
        value={withoutChatAttachments(text)}
        onChange={(event) => {
          setText(withChatAttachmentText(draft.currentText(), event.target.value));
          setLiteralSlash(false);
          rememberSelection();
        }}
        onSelect={rememberSelection}
        maxLength={maxLength}
        rows={1}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            !window.matchMedia('(pointer: coarse)').matches
          ) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <button
        className="send-button"
        aria-label={pendingText !== null && !sending ? 'Retry previous message' : 'Send message'}
        title={pendingText !== null && !sending ? 'Retry previous message' : undefined}
        onClick={() => void submit()}
        disabled={!canSend}
      >
        {sending ? (
          <RefreshCw className="spin" size={18} />
        ) : pendingText !== null ? (
          // Visible cue: this press re-checks the earlier unconfirmed message, not the new draft.
          <RotateCcw size={18} />
        ) : (
          <ArrowUp size={20} />
        )}
      </button>
      <DraftHandoff draft={draft} compact />
      {rejectedText !== null && (
        <details className="draft-handoff">
          <summary>Previous unsent message</summary>
          <pre className="draft-preview">{rejectedText}</pre>
        </details>
      )}
      {literalSlash && (
        <div className="draft-handoff">
          <p>
            This starts with /. Send it as an ordinary message, or open the provider’s command
            controls.
          </p>
          <button
            className="secondary"
            disabled={disabled || sending}
            onClick={() => void submit(true)}
          >
            Send as text
          </button>
          <button className="secondary" onClick={onHelp}>
            Open command controls
          </button>
        </div>
      )}
      {unknownLegacyMode && (
        <div className="draft-handoff" role="alert">
          <p>
            This older unconfirmed message did not record whether it was steering a running turn.
            Check the conversation before deciding to send another message; sciencewithagents will
            not guess or repeat it.
          </p>
          <button
            className="secondary"
            onClick={() => {
              receiptStorage.removeItem(`${storageKey}:pending`);
              retry.current = null;
              setPendingText(null);
              setSteer(null);
              setUnknownLegacyMode(false);
            }}
          >
            I checked — prepare as a new message
          </button>
        </div>
      )}
      {legacyBackup !== null && (
        <details className="draft-handoff">
          <summary>Older browser draft retained</summary>
          <pre className="draft-preview">{legacyBackup || '(Empty draft)'}</pre>
          <button
            className="secondary"
            disabled={Boolean(text.trim()) || draft.conflict || !draft.ready}
            onClick={() => {
              setText(legacyBackup);
              void draft
                .flush()
                .then(() => {
                  localStorage.removeItem(`dock:draft:${agent.id}`);
                  localStorage.removeItem(`${storageKey}:legacy`);
                  setLegacyBackup(null);
                })
                .catch(() => {});
            }}
          >
            Restore older draft here
          </button>
          <button
            className="secondary"
            onClick={() => {
              localStorage.removeItem(`dock:draft:${agent.id}`);
              localStorage.removeItem(`${storageKey}:legacy`);
              setLegacyBackup(null);
            }}
          >
            Discard older draft
          </button>
        </details>
      )}
      <div className="composer-toolbar">
        <div ref={tools} role="group" aria-label="Message tools; scroll horizontally for more">
          {canSteer && <SendTiming steer={steer} disabled={sending} onChange={setSteer} />}
          <button
            className="composer-notepad"
            title="Open notepad"
            aria-label="Open notepad"
            onClick={() => openNotepad('message')}
          >
            <Maximize2 className="composer-notepad-icon" size={16} aria-hidden="true" />{' '}
            <span>Notepad</span>
          </button>
          <ChatAttachmentPicker
            key={agent.id}
            text={text}
            currentText={draft.currentText}
            setText={setText}
            disabled={sending || pendingText !== null || !draft.ready || draft.conflict}
            uploader={attachmentUpload}
          />
          {!specialized && !steer && (
            <select
              className="composer-priority"
              aria-label="Message priority"
              value={priority}
              disabled={sending}
              onChange={(e) => setPriority(e.target.value as JobEstimate['priority'])}
            >
              <option value="interactive">Do this soon</option>
              <option value="high">High priority</option>
              <option value="normal">Normal</option>
              <option value="background">Background</option>
            </select>
          )}
          {moreTools && (
            <span className="composer-tools-cue" aria-hidden="true">
              <ChevronRight size={18} />
            </span>
          )}
        </div>
        <div>
          {!specialized && (
            <button
              className="icon-button"
              title="Session commands"
              aria-label="Show commands"
              onClick={onHelp}
            >
              <span className="slash-icon">/</span>
            </button>
          )}
          {!specialized && ['running', 'queued', 'waiting'].includes(agent.status) && (
            <button
              className="stop-button"
              aria-label="Stop agent"
              title="Stop reply"
              onClick={onStop}
            >
              <Square size={15} /> <span>Stop</span>
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <Notepad
          draft={draft}
          agentId={agent.id}
          clientId={workspace?.client.id ?? null}
          localOnly={!!draftOverride}
          localHistory={localHistory}
          maxLength={maxLength}
          agentName={agent.name}
          mode={expanded}
          selection={selection}
          canSend={canSend}
          sending={sending}
          notice={notice}
          onMinimize={closeNotepad}
          onSend={() => {
            void submit().then((sent) => {
              if (sent) closeNotepad();
            });
          }}
          attachments={
            <ChatAttachmentPicker
              text={text}
              currentText={draft.currentText}
              setText={setText}
              disabled={sending || pendingText !== null || !draft.ready || draft.conflict}
              uploader={attachmentUpload}
            />
          }
          controls={
            specialized ? undefined : (
              <div className="notepad-controls">
                {canSteer && (
                  <label>
                    Send timing
                    <SendTiming steer={steer} disabled={sending} onChange={setSteer} />
                  </label>
                )}
                {!steer && (
                  <label>
                    Priority for this message{' '}
                    <select
                      value={priority}
                      disabled={sending}
                      onChange={(e) => setPriority(e.target.value as JobEstimate['priority'])}
                    >
                      <option value="interactive">Do this soon</option>
                      <option value="high">High priority</option>
                      <option value="normal">Normal</option>
                      <option value="background">Background</option>
                    </select>
                  </label>
                )}
                {literalSlash && (
                  <button
                    type="button"
                    className="notepad-button"
                    disabled={disabled || sending}
                    onClick={() => {
                      void submit(true).then((sent) => {
                        if (sent) closeNotepad();
                      });
                    }}
                  >
                    Send as text
                  </button>
                )}
              </div>
            )
          }
        />
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  act,
}: {
  approval: Approval;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [formValues, setFormValues] = useState<McpFormValues>(() =>
    Object.fromEntries(
      Object.entries(approval.form?.requestedSchema.properties ?? {}).flatMap(([name, field]) =>
        field.default !== undefined
          ? [[name, field.default]]
          : field.type === 'array' && approval.form?.requestedSchema.required?.includes(name)
            ? [[name, []]]
            : [],
      ),
    ),
  );
  const submit = (decision: 'accept' | 'decline') =>
    void act(() =>
      api(`/approvals/${approval.id}`, {
        decision,
        answers: Object.fromEntries(
          approval.questions.map((q) => [
            q.id,
            [
              ...(answers[q.id] ?? []),
              ...(customAnswers[q.id]?.trim() ? [customAnswers[q.id].trim()] : []),
            ],
          ]),
        ),
        ...(approval.kind === 'mcp_form' && decision === 'accept' && approval.form
          ? { formValues: parseMcpFormValues(approval.form, formValues) }
          : {}),
      }),
    );
  return (
    <div className="approval-card">
      <span className="eyebrow">YOUR INPUT IS NEEDED</span>
      <h3>{approval.title}</h3>
      {approval.kind === 'mcp_url' && approval.urlRequest ? (
        <>
          <McpUrlLink request={approval.urlRequest} />
          <p className="mcp-form-notice">
            Open the page only if you trust this destination, then allow or decline the request.
            Opening the page does not answer Codex. Allowing the request does not prove
            authentication succeeded.
          </p>
        </>
      ) : approval.kind === 'mcp_form' && approval.form ? (
        <McpFormFields
          form={approval.form}
          values={formValues}
          onChange={(name, value) =>
            setFormValues((old) => {
              const next = { ...old };
              if (value === undefined) delete next[name];
              else next[name] = value;
              return next;
            })
          }
        />
      ) : approval.kind === 'input' ? (
        approval.questions.map((q) =>
          q.allowCustom || q.multiSelect ? (
            <fieldset className="approval-question" key={q.id}>
              <legend>{q.question}</legend>
              {q.multiSelect && <p>Choose all that apply.</p>}
              {q.options?.map((option) => (
                <label className="approval-choice" key={option.label}>
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`${approval.id}-${q.id}`}
                    aria-label={option.label}
                    checked={answers[q.id]?.includes(option.label) ?? false}
                    onChange={(event) => {
                      setAnswers((old) => ({
                        ...old,
                        [q.id]: q.multiSelect
                          ? event.target.checked
                            ? [...(old[q.id] ?? []), option.label]
                            : (old[q.id] ?? []).filter((value) => value !== option.label)
                          : [option.label],
                      }));
                      if (!q.multiSelect) setCustomAnswers((old) => ({ ...old, [q.id]: '' }));
                    }}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              {q.allowCustom && (
                <label>
                  {q.multiSelect ? 'Add your own answer' : 'Or write your own answer'}
                  <textarea
                    aria-label={`${q.header} — your own answer`}
                    maxLength={8000}
                    value={customAnswers[q.id] ?? ''}
                    onChange={(event) => {
                      setCustomAnswers((old) => ({ ...old, [q.id]: event.target.value }));
                      if (!q.multiSelect && event.target.value)
                        setAnswers((old) => ({ ...old, [q.id]: [] }));
                    }}
                  />
                </label>
              )}
            </fieldset>
          ) : (
            <label key={q.id}>
              {q.question}
              {q.options?.length ? (
                <select
                  aria-label={q.header}
                  value={answers[q.id]?.[0] ?? ''}
                  onChange={(event) =>
                    setAnswers((old) => ({ ...old, [q.id]: [event.target.value] }))
                  }
                >
                  <option value="">Choose an answer…</option>
                  {q.options.map((option) => (
                    <option key={option.label}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <textarea
                  aria-label={q.header}
                  value={answers[q.id]?.[0] ?? ''}
                  onChange={(event) =>
                    setAnswers((old) => ({ ...old, [q.id]: [event.target.value] }))
                  }
                />
              )}
            </label>
          ),
        )
      ) : (
        <details>
          <summary>Review the exact request</summary>
          <pre>{approval.details}</pre>
        </details>
      )}
      {approval.kind === 'mcp_form' && approval.form && (
        <p className="mcp-form-notice">
          To: <strong>{approval.form.serverName}</strong> · Stored locally. No credentials.
        </p>
      )}
      <div className="button-row">
        <button className="primary" onClick={() => submit('accept')}>
          {approval.kind === 'mcp_url'
            ? 'Allow URL request'
            : approval.kind === 'mcp_form'
              ? 'Submit form'
              : approval.kind === 'input'
                ? 'Submit answer'
                : 'Approve once'}
        </button>
        <button className="secondary" onClick={() => submit('decline')}>
          Decline
        </button>
      </div>
    </div>
  );
}
