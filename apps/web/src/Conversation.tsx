import { agentName } from './agentName';
import './Composer.css';
import { flushSync } from 'react-dom';
import { AppMessageQueue } from './AppMessageQueue';
import { ConversationStatus } from './ConversationStatus';
import { RunRecovery } from './RunRecovery';
import { ImagePreview } from './ImagePreview';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAttachmentPicker, useChatAttachmentUpload } from './ChatImages';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  nativeCommandReceiptSchema,
  promptTextLimit,
  type Agent,
  type AgentDetail,
  type AgentDetailChannel,
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
import { ChatCommands } from './ChatCommands';
import { PromptHistory, scrollToPrompt } from './PromptHistory';
import { promptLengthError } from './promptLength';

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
  manager: 'Agent',
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
const ownerInput = (entry: Entry) =>
  entry.kind === 'user' || (entry.kind === 'system' && entry.title === 'Owner steering');
/**
 * An explicit provider phase wins: commentary joins the activity row and final stays in the
 * timeline. Without a phase (unknown), only earlier replies of a completed run that were
 * followed, in that same run and page, by tool activity and a later reply join the row,
 * labelled as earlier replies. Imports (no run), running or stopped turns, anything split by
 * owner input and replies after owner steering stay in the timeline. Nothing is removed.
 */
function foldedReplies(entries: Entry[], runs: AgentDetail['runs']) {
  const completed = new Set(runs.filter((run) => run.status === 'completed').map((run) => run.id));
  // A reply after mid-turn owner steering may answer it; keep that part of the run as is.
  const steered = new Set<string>();
  const afterSteering = new Set<string>();
  for (const entry of entries) {
    if (entry.runId && steered.has(entry.runId)) afterSteering.add(entry.id);
    if (entry.runId && entry.kind === 'system' && entry.title === 'Owner steering')
      steered.add(entry.runId);
  }
  const folded = new Map<string, 'commentary' | 'earlier'>();
  // Per run, walking backwards: has a later reply been seen, and a tool since then?
  const later = new Map<string, { reply: boolean; toolBeforeReply: boolean }>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (ownerInput(entry)) {
      later.clear();
      continue;
    }
    if (entry.kind === 'assistant' && !entry.image && entry.phase === 'commentary') {
      folded.set(entry.id, 'commentary');
      continue;
    }
    if (!entry.runId || !completed.has(entry.runId) || entry.image) continue;
    const seen = later.get(entry.runId) ?? { reply: false, toolBeforeReply: false };
    if (entry.kind === 'tool' && seen.reply) seen.toolBeforeReply = true;
    else if (entry.kind === 'assistant') {
      if (entry.phase !== 'final' && seen.toolBeforeReply && !afterSteering.has(entry.id))
        folded.set(entry.id, 'earlier');
      else seen.reply = true;
    }
    later.set(entry.runId, seen);
  }
  return folded;
}
function timeline(entries: Entry[], folded: Map<string, unknown>): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if ((entry.kind === 'tool' && !entry.image) || folded.has(entry.id)) {
      if (Array.isArray(last)) last.push(entry);
      else rows.push([entry]);
    } else rows.push(entry);
  }
  return rows;
}
const failedTool = (status: string) => /fail|error|declin|cancel/i.test(status);
const groupLimit = 100;
const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 240);

/** Collapsed activity; bodies render only when opened. */
function ToolGroup({
  entries,
  working,
  folded,
}: {
  entries: Entry[];
  working: boolean;
  folded: Map<string, 'commentary' | 'earlier'>;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(groupLimit);
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const notes = entries.length - tools.length;
  const earlier = entries.filter((entry) => folded.get(entry.id) === 'earlier').length;
  const updates = notes - earlier;
  const problems = tools.filter((entry) => failedTool(entry.status)).length;
  // The agent's own latest progress note describes the work; raw commands stay inside.
  const latestNote = [...entries].reverse().find((entry) => entry.kind !== 'tool');
  const shown = entries.slice(-limit);
  return (
    <details className="tool-group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        <span className="tool-group-count">
          {working ? 'Working · ' : ''}
          {tools.length.toLocaleString()} {tools.length === 1 ? 'action' : 'actions'}
          {updates ? ` · ${updates} ${updates === 1 ? 'update' : 'updates'}` : ''}
          {earlier ? ` · ${earlier} earlier ${earlier === 1 ? 'reply' : 'replies'}` : ''}
          {problems ? ` · ${problems} failed` : ''}
        </span>
        {latestNote && <span className="tool-group-current">{firstLine(latestNote.text)}</span>}
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
          {shown.map((entry) =>
            entry.kind === 'tool' ? (
              <ToolEntry key={entry.id} entry={entry} />
            ) : (
              <div className="tool-note" key={entry.id}>
                <small>{folded.get(entry.id) === 'earlier' ? 'Earlier reply' : 'Update'}</small>
                <div className="markdown">
                  <ChatMarkdown entry={entry}>{entry.text}</ChatMarkdown>
                </div>
              </div>
            ),
          )}
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
  channel,
  promptNavigation = true,
  recovery = true,
  displayOnly = false,
}: {
  agent: Agent;
  detail: AgentDetail | null;
  approvals: Approval[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  personal?: boolean;
  intro?: { title: string; description: string; note: string };
  formatEntry?: (entry: Entry) => Entry;
  /** Earlier pages come from the same server channel as `detail`. */
  channel?: AgentDetailChannel;
  /** Custom group feeds do not use the retained agent history route. */
  promptNavigation?: boolean;
  recovery?: boolean;
  /** Saved text can be read while live controls reconnect. */
  displayOnly?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const shownApproval = useRef<string | null>(null);
  const [older, setOlder] = useState<AgentDetail | null>(null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyRequest = useRef(0);
  const historyBefore = useRef<string | undefined>(undefined);
  const [newerHistory, setNewerHistory] = useState<(string | undefined)[]>([]);
  useEffect(() => {
    setOlder(null);
    setPromptsOpen(false);
    setSelectedPrompt(null);
    setLoadingHistory(false);
    setNewerHistory([]);
    historyBefore.current = undefined;
    return () => {
      historyRequest.current++;
    };
  }, [agent.id, channel]);
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
    } else if (
      !older &&
      !selectedPrompt &&
      pinned.current &&
      !document.documentElement.dataset.pdfOpen &&
      !document.documentElement.dataset.imageOpen
    )
      container.scrollTop = container.scrollHeight;
    shownApproval.current = first;
  }, [data, approvals, older, selectedPrompt]);
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    pinned.current = !older && !selectedPrompt;
    if (selectedPrompt) scrollToPrompt(container, selectedPrompt);
    else container.scrollTop = older ? 0 : container.scrollHeight;
    lastTop.current = container.scrollTop;
  }, [older, selectedPrompt]);
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    // A keyboard, a taller composer or late layout (fonts, formatting) resizes the timeline.
    // Keep the newest message in view only for a reader already at the bottom; anyone
    // reading history keeps their place.
    const observer = new ResizeObserver(() => {
      if (
        pinned.current &&
        !document.documentElement.dataset.pdfOpen &&
        !document.documentElement.dataset.imageOpen
      )
        container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const entries = (older?.entries ?? data?.entries ?? [])
    .map((e) => (formatEntry ? formatEntry(e) : e))
    .filter((e, i, all) => all.findIndex((v) => v.id === e.id) === i);
  const shown = entries.filter(
    (entry) => !(entry.kind === 'system' && entry.title === 'Original queued message'),
  );
  // A saved entry is not a delivery receipt. Latest run state wins even while an
  // earlier history page remains open; entry.status may still say "queued".
  const liveRuns = data?.runs ?? [];
  const runsById = new Map([...(older?.runs ?? []), ...liveRuns].map((run) => [run.id, run]));
  const attentionRun = liveRuns
    .filter((run) => !['queued', 'cancelled'].includes(run.status))
    .at(-1);
  const legacyRunId =
    attentionRun &&
    ['failed', 'interrupted'].includes(attentionRun.status) &&
    !liveRuns
      .slice(liveRuns.indexOf(attentionRun) + 1)
      .some((run) => ['user', 'resume'].includes(run.kind) || run.status === 'running')
      ? attentionRun.id
      : undefined;
  const folded = foldedReplies(shown, (older ?? data)?.runs ?? []);
  const load = async () => {
    if (loadingHistory) return;
    const request = ++historyRequest.current;
    setLoadingHistory(true);
    try {
      const result = await detail(agent.id, entries[0]?.id, channel);
      if (request === historyRequest.current) {
        const previousBefore = historyBefore.current;
        setNewerHistory((positions) => [...positions, previousBefore]);
        historyBefore.current = entries[0]?.id;
        setSelectedPrompt(null);
        setOlder(result);
      }
    } finally {
      if (request === historyRequest.current) setLoadingHistory(false);
    }
  };
  return (
    <>
      {promptNavigation && channel !== 'coordination' && (
        <nav className="prompt-history-actions" aria-label="Conversation history">
          <button type="button" className="secondary" onClick={() => setPromptsOpen(true)}>
            Your prompts
          </button>
          {older && newerHistory.length > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={loadingHistory}
              onClick={() =>
                void act(async () => {
                  const request = ++historyRequest.current;
                  setLoadingHistory(true);
                  const before = newerHistory[newerHistory.length - 1];
                  try {
                    const value = await detail(agent.id, before, channel);
                    if (request !== historyRequest.current) return;
                    historyBefore.current = before;
                    setNewerHistory((positions) => positions.slice(0, -1));
                    setSelectedPrompt(null);
                    setOlder(value);
                  } finally {
                    if (request === historyRequest.current) setLoadingHistory(false);
                  }
                })
              }
            >
              Continue reading
            </button>
          )}
          {(older || selectedPrompt) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                historyRequest.current++;
                setLoadingHistory(false);
                setSelectedPrompt(null);
                setOlder(null);
                setNewerHistory([]);
                historyBefore.current = undefined;
              }}
            >
              Back to latest
            </button>
          )}
        </nav>
      )}
      {promptsOpen && (
        <PromptHistory
          key={`${agent.id}:${channel ?? 'all'}`}
          close={() => setPromptsOpen(false)}
          read={async (before) => {
            const value = await detail(agent.id, before, channel);
            return {
              value: { detail: value, before },
              prompts: value.entries
                .filter(
                  (entry) =>
                    entry.kind === 'user' ||
                    (entry.kind === 'system' && entry.title === 'Owner steering'),
                )
                .map((entry) => (formatEntry ? formatEntry(entry) : entry)),
              before: value.hasMore ? value.entries[0]?.id : undefined,
            };
          }}
          choose={(value, id, newer) => {
            historyRequest.current++;
            setLoadingHistory(false);
            setOlder(value.detail);
            historyBefore.current = value.before;
            setNewerHistory(newer);
            setSelectedPrompt(id);
            setPromptsOpen(false);
          }}
        />
      )}
      <div
        className="conversation"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (!element) return;
          // Only the reader moving up leaves the newest message. Scrolls caused by layout,
          // pinning or scroll anchoring must not unpin a reader who was at the bottom.
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          if (nearBottom && !older) pinned.current = true;
          else if (element.scrollTop < lastTop.current - 1) pinned.current = false;
          lastTop.current = element.scrollTop;
        }}
      >
        <div className="conversation-inner">
          <div className="conversation-date">
            <span />
            {new Date(agent.createdAt).toLocaleDateString([], { month: 'long', day: 'numeric' })}
            <span />
          </div>
          {older && channel === 'coordination' && (
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
          {!displayOnly &&
            (older || !promptNavigation || channel === 'coordination') &&
            (older?.hasMore ?? data?.hasMore) && (
              <button
                className="load-history"
                disabled={loadingHistory}
                onClick={() => void act(load)}
              >
                Load earlier messages
              </button>
            )}
          {!displayOnly && data && entries.length === 0 && (
            <div className="conversation-intro">
              <Avatar role={agent.role} />
              <h2>{intro?.title ?? agentName(agent)}</h2>
              <p>
                {intro?.description ??
                  (personal
                    ? 'What would you like help with?'
                    : agent.role === 'manager'
                      ? 'What would you like to work on?'
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
          {timeline(shown, folded).map((row, index, rows) => {
            if (Array.isArray(row))
              return (
                <ToolGroup
                  key={row[0]!.id}
                  entries={row}
                  folded={folded}
                  working={!older && agent.status === 'running' && index === rows.length - 1}
                />
              );
            // The stored supervision event is still a message from the person. Render
            // both existing and newly sent steering with the normal user bubble.
            const entry: Entry =
              row.kind === 'system' && row.title === 'Owner steering'
                ? { ...row, kind: 'user', title: 'You' }
                : row;
            const run = row.kind === 'user' && row.runId ? runsById.get(row.runId) : undefined;
            const delivery =
              run?.status === 'queued'
                ? 'Queued'
                : run?.status === 'running'
                  ? 'In progress'
                  : null;
            return entry.image ? (
              <figure className="generated-image" key={entry.id}>
                <ImagePreview
                  src={apiUrl(`/agents/${entry.agentId}/images/${entry.image.id}`)}
                  alt="Generated image"
                  label="Open generated image"
                  width={entry.image.width}
                  height={entry.image.height}
                />
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
              <article
                className={`message ${entry.kind}${entry.id === selectedPrompt ? ' prompt-selected' : ''}`}
                data-prompt-id={entry.kind === 'user' ? entry.id : undefined}
                key={entry.id}
              >
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
                    {delivery && (
                      <span
                        className={`message-delivery ${run!.status}`}
                        role="status"
                        title={
                          delivery === 'Queued'
                            ? 'Saved in the queue. The agent has not started this message.'
                            : 'The agent is handling this message.'
                        }
                      >
                        {delivery}
                      </span>
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
          {!displayOnly && <ConversationStatus agent={agent} />}
          {recovery &&
            !agent.nativeRootId &&
            !agent.archivedAt &&
            ['interrupted', 'failed'].includes(agent.status) && (
              <RunRecovery
                key={`${apiScope()}:${agent.id}`}
                agent={agent}
                legacyRunId={legacyRunId}
                act={act}
              />
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
  onGoal,
  onCommandBack,
  notepad,
  reference,
  onNotepadClose,
  draftOverride,
  maxLength = promptTextLimit,
  specialized = false,
  attachments = true,
  preserveWhitespace = false,
  localHistory,
  messagePlaceholder,
  onSent,
  onDraftReady,
  extraTools,
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
  /** Opens this conversation's existing goal dialog without sending or replacing a draft. */
  onGoal?: () => void;
  onCommandBack?: (close: (() => void) | null) => void;
  /** Open the full-page notepad on mount, e.g. for a new project's first brief. */
  notepad?: 'brief';
  /** Quote an exact note or to-do at the caret. Referencing never sends. */
  reference?: { nonce: number; text: string } | null;
  onNotepadClose?: () => void;
  /** Specialized APIs keep their own receipts and can prepare a browser-only first draft. */
  draftOverride?: SharedDraft;
  maxLength?: number;
  specialized?: boolean;
  /** Host-scoped conversations may not have an attachment transport. */
  attachments?: boolean;
  /** Retain exact submitted evidence in host-scoped message protocols. */
  preserveWhitespace?: boolean;
  messagePlaceholder?: string;
  localHistory?: { versions: { text: string; at: string }[]; restore: (text: string) => void };
  /** Specialized conversations can follow an acknowledged replacement thread. */
  onSent?: (remainingDraft: string) => void;
  /** Uses the existing draft owner; callers must not replace conflicting typing. */
  onDraftReady?: (draft: SharedDraft) => void;
  /** Controls for a specialized conversation, sharing the ordinary compact toolbar. */
  extraTools?: ReactNode;
}) {
  const messageText = (value: string) => (preserveWhitespace ? value : value.trim());
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
  const lengthError = promptLengthError(text, maxLength);
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
          else if (messageText(draft.currentText()) === pending.text) {
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
  const nativeCommandRetry = useRef<{ key: string; text: string } | null>(null);
  const runNativeCommand = async (commandText: string) => {
    if (sendingRef.current || apiScope() !== scope) return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (!nativeCommandRetry.current) {
        const saved = receiptStorage.getItem(`${storageKey}:native-command`);
        if (saved) nativeCommandRetry.current = JSON.parse(saved) as { key: string; text: string };
      }
      if (nativeCommandRetry.current && nativeCommandRetry.current.text !== commandText)
        throw new Error(
          'The earlier command has an uncertain receipt. Retry that same command before submitting another. Your draft is retained.',
        );
      const pending =
        nativeCommandRetry.current?.text === commandText
          ? nativeCommandRetry.current
          : { key: crypto.randomUUID(), text: commandText };
      nativeCommandRetry.current = pending;
      receiptStorage.setItem(`${storageKey}:native-command`, JSON.stringify(pending));
      const parsed = nativeCommandReceiptSchema.safeParse(
        await api(`/agents/${agent.id}/native-commands`, pending),
      );
      if (!parsed.success)
        throw new Error(
          'The computer returned an incomplete command acknowledgement. Its original receipt and draft are retained.',
        );
      const response = parsed.data;
      if (
        response.key !== pending.key ||
        response.agentId !== agent.id ||
        response.text !== pending.text ||
        response.run.agentId !== agent.id
      )
        throw new Error(
          'The command acknowledgement did not match this submission. Its original receipt and draft are retained.',
        );
      nativeCommandRetry.current = null;
      receiptStorage.removeItem(`${storageKey}:native-command`);
      setLiteralSlash(false);
      setNotice('Command accepted in this conversation. Your draft and attachments are kept.');
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        nativeCommandRetry.current = null;
        receiptStorage.removeItem(`${storageKey}:native-command`);
        setLiteralSlash(true);
      }
      fail(
        error instanceof Error
          ? error.message
          : 'Could not run the command. Your draft is retained.',
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  /** Resolves true only after the manager accepted the message. */
  const submit = async (asText = false): Promise<boolean> => {
    const value = messageText(draft.currentText());
    const commandText = withoutChatAttachments(value).trim();
    const goalCommand =
      !specialized && !retry.current && !asText && /^\/goal(?:\s|$)/.test(commandText);
    const sentRevision = draftRevision.current;
    if (
      (!value.trim() && !retry.current) ||
      sendingRef.current ||
      uploading ||
      (disabled && !goalCommand && !(specialized && retry.current?.text === value)) ||
      !draft.ready ||
      draft.conflict ||
      unknownLegacyMode
    )
      return false;
    if (apiScope() !== scope) return false;
    if (!retry.current && promptLengthError(draft.currentText(), maxLength)) {
      fail(promptLengthError(draft.currentText(), maxLength));
      return false;
    }
    setNotice('');
    // Keep the draft and attachments; /goal never becomes a model message.
    if (goalCommand) {
      setLiteralSlash(false);
      if (commandText !== '/goal') {
        fail('Use /goal by itself to open goal controls. Your draft is retained.');
      } else if (!onGoal) {
        fail('Goals are not available for this conversation. Your draft is retained.');
      } else {
        if (expanded) flushSync(closeNotepad);
        textarea.current?.focus({ preventScroll: true });
        onGoal();
      }
      return false;
    }
    if (!retry.current && !specialized && commandText.startsWith('/') && !asText) {
      const match = {
        '/new': 'new',
        '/clear': 'new',
        '/compact': 'compact',
        '/resume': 'resume',
        '/stop': 'interrupt',
      }[commandText] as 'new' | 'compact' | 'resume' | 'interrupt' | undefined;
      if (match) {
        if (agent.provider === 'claude' && match === 'compact') await runNativeCommand('/compact');
        else onCommand(match);
      } else if (agent.provider === 'claude') {
        await runNativeCommand(commandText);
      } else {
        setLiteralSlash(true);
        fail(
          'This can be sent as text, including a file path. Use Native terminal in Advanced controls for Codex slash commands. Your draft is retained.',
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
        if ((!token && !draftOverride) || messageText(draft.currentText()) !== value)
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
        messageText(draft.currentText()) === pending.text
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
    (!disabled ||
      (!specialized &&
        !retry.current &&
        /^\/goal(?:\s|$)/.test(withoutChatAttachments(text).trim())) ||
      (specialized && retry.current?.text === messageText(text))) &&
    !sending &&
    !uploading &&
    draft.ready &&
    !draft.conflict &&
    !unknownLegacyMode &&
    (!lengthError || retry.current !== null) &&
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
        // Resizing this observed textarea during delivery changes its height and
        // leaves WebKit with an undelivered notification, even with a width guard.
        // Coalesce the measurement outside this delivery; cleanup cancels it.
        later();
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
  // Routine autosave is shortened on phones and must not toggle while typing or saving;
  // connecting, receipts, errors and conflicts stay full.
  const draftSteady =
    draft.ready &&
    !draft.error &&
    !draft.conflict &&
    !(draft.state?.own.submitted && !draft.unsaved && !draft.saving);
  return (
    <div className={`composer${draftSteady ? ' draft-steady' : ''}`}>
      <textarea
        ref={textarea}
        aria-label={`Message ${agentName(agent)}`}
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
                  : `Message ${agentName(agent)}…`)
        }
        value={withoutChatAttachments(text)}
        onChange={(event) => {
          setText(withChatAttachmentText(draft.currentText(), event.target.value));
          setLiteralSlash(false);
          rememberSelection();
        }}
        onSelect={rememberSelection}
        aria-invalid={!!lengthError || undefined}
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
      {lengthError && draft.error !== lengthError && (
        <p className="draft-handoff" role="alert">
          {lengthError}
        </p>
      )}
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
          {extraTools}
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
          {attachments && (
            <ChatAttachmentPicker
              key={agent.id}
              text={text}
              currentText={draft.currentText}
              setText={setText}
              disabled={sending || pendingText !== null || !draft.ready || draft.conflict}
              uploader={attachmentUpload}
            />
          )}
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
            <ChatCommands
              onGoal={
                onGoal ??
                (() =>
                  fail('Goals are not available for this conversation. Your draft is retained.'))
              }
              onCommand={(command) => {
                if (agent.provider === 'claude' && command === 'compact')
                  void runNativeCommand('/compact');
                else onCommand(command);
              }}
              agentId={agent.id}
              onNativeCommand={(text) => {
                void runNativeCommand(text);
              }}
              onAdvanced={onHelp}
              onBack={onCommandBack}
            />
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
          agentName={agentName(agent)}
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
            attachments ? (
              <ChatAttachmentPicker
                text={text}
                currentText={draft.currentText}
                setText={setText}
                disabled={sending || pendingText !== null || !draft.ready || draft.conflict}
                uploader={attachmentUpload}
              />
            ) : undefined
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
