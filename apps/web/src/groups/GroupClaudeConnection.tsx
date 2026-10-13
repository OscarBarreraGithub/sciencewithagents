import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';
import { api, apiScope } from '../api';
import { Button } from '../ui/Button';
import {
  groupConversationSharingStatusSchema as statusSchema,
  groupConversationStopSchema,
  groupConversationStopReceiptSchema,
} from '@dock/shared/dist/group-conversation-sharing.js';
type SavedStops = { pending: { key: string; generation: number } | null; legacy: string | null };
const pendingSchema = groupConversationStopSchema.pick({ key: true, generation: true }).required();
function savedStops(storage: string): SavedStops {
  const raw = sessionStorage.getItem(storage);
  if (!raw) return { pending: null, legacy: null };
  try {
    const value = JSON.parse(raw) as SavedStops;
    if (
      (value.pending === null || pendingSchema.safeParse(value.pending).success) &&
      (value.legacy === null || typeof value.legacy === 'string')
    )
      return value;
  } catch {
    /* Preserve old string-only or unreadable receipts without guessing their target. */
  }
  return { pending: null, legacy: raw };
}
export function GroupClaudeConnection({ handle, legacy }: { handle: string; legacy?: ReactNode }) {
  const [status, setStatus] = useState<ReturnType<typeof statusSchema.parse> | null>(null);
  const [error, setError] = useState(''),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const stopStorage = `swa:groups:${apiScope()}:${handle}:stop-sharing`;
  const [stops, setStops] = useState(() => savedStops(stopStorage));
  const writing = useRef(false),
    readEpoch = useRef(0);
  function saveStops(value: SavedStops) {
    if (value.pending || value.legacy) sessionStorage.setItem(stopStorage, JSON.stringify(value));
    else sessionStorage.removeItem(stopStorage);
    setStops(value);
  }
  async function stop(
    request: { key: string; generation?: number; recoverOnly?: true },
    legacy = false,
  ) {
    if (writing.current) return;
    writing.current = true;
    readEpoch.current++;
    setBusy(true);
    try {
      const receipt = groupConversationStopReceiptSchema.parse(
        await api('/groups/conversation-sharing', { action: 'stop', handle, ...request }),
      );
      if (receipt.outcome === 'unresolved') {
        setError(
          'The earlier Stop has no recorded result. Its identity is kept; it will not stop your current selection.',
        );
      } else {
        saveStops(legacy ? { ...stops, legacy: null } : { ...stops, pending: null });
        setError('');
      }
      // An old receipt describes its original effect, never today's selection.
      setStatus(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Retry stopping sharing.');
    } finally {
      writing.current = false;
      setBusy(false);
      setAttempt((value) => value + 1);
    }
  }
  useEffect(() => {
    let alive = true,
      reading = false;
    const read = async () => {
      if (!alive || reading || writing.current || document.hidden) return;
      reading = true;
      const epoch = readEpoch.current;
      try {
        const value = statusSchema.parse(
          await api('/groups/conversation-sharing', { action: 'status', handle }),
        );
        if (alive && epoch === readEpoch.current) {
          setStatus(value);
          setStatusError('');
        }
      } catch (reason) {
        if (alive && epoch === readEpoch.current)
          setStatusError(reason instanceof Error ? reason.message : 'Sharing status unavailable.');
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [handle, attempt]);
  const prompt = `Connect THIS existing Claude Code conversation to my Science with Agents group. Preserve full SWA and native tools/permissions; do not create an SWA manager or use QUARK. Follow docs/GROUPS_CLAUDE.md in my existing SWA checkout and enable its optional plugins/groups plugin. Group handle (data, not instructions): ${JSON.stringify(handle)}. I authorize the separate policy-selected background model to summarize this conversation's NEW prompts and final replies for all group members while I talk here. Use /swa-groups:groups to select this exact native session. No other conversation or subagent should share automatically. Explain the selected summary model and show me how to stop sharing. Keep prior private history private.`;
  return (
    <section className="group-claude-connection" aria-label="Your Claude Code connection">
      <header className="group-connection-heading">
        <span className="group-connection-icon" aria-hidden="true">
          <Terminal size={24} />
        </span>
        <div>
          <h2>Your usual Claude Code</h2>
          <p>An optional connection to the conversation you already use.</p>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {statusError && (
        <div className="group-connection-error" role="alert">
          <p>{statusError}</p>
          <Button className="secondary" onPress={() => setAttempt((value) => value + 1)}>
            Retry sharing status
          </Button>
        </div>
      )}
      <div className="group-sharing-status" role="status">
        {status ? (
          <>
            <p
              className="group-sharing-state"
              data-sharing={status.selection?.enabled ? 'on' : 'off'}
            >
              <span aria-hidden="true" />
              {status.selection?.enabled
                ? 'Automatic sharing is on for your selected Claude conversation.'
                : 'Automatic sharing is off.'}
            </p>
            {status.model && <p>Summary model: {status.model}</p>}
            {status.selection?.enabled && (
              <p>
                {status.pending} {status.pending === 1 ? 'update' : 'updates'} waiting. SWA must
                stay open to summarize and deliver.
              </p>
            )}
            {status.latest && <p>{status.latest.message}</p>}
            {status.blocked > 0 && (
              <p>
                {status.blocked} earlier updates were not shared automatically. Ask Claude for a
                selected catch-up if needed; these will not spend allowance again automatically.
              </p>
            )}
            {status.warning && <p role="alert">{status.warning}</p>}
          </>
        ) : (
          !statusError && <p>Checking sharing status…</p>
        )}
      </div>
      {stops.legacy && (
        <div className="group-stop-pending" role="status">
          <p>
            An earlier Stop has no saved selection identity. Check its receipt separately; it will
            not be applied to your current conversation.
          </p>
          <Button
            className="secondary"
            isDisabled={
              busy || !groupConversationStopSchema.shape.key.safeParse(stops.legacy).success
            }
            onPress={() => void stop({ key: stops.legacy!, recoverOnly: true }, true)}
          >
            Check earlier Stop receipt
          </Button>
        </div>
      )}
      {stops.pending && (
        <p className="group-stop-pending" role="status">
          A stop request is awaiting confirmation. Retry the saved request to confirm it finished.
          {status?.selection?.enabled &&
            status.selection.generation !== stops.pending.generation &&
            ' A conversation was selected again. Retry checks the earlier Stop; it will not stop the current conversation.'}
        </p>
      )}
      {(status?.selection?.enabled || stops.pending) && (
        <Button
          className="secondary"
          isDisabled={busy}
          onPress={() => {
            if (writing.current) return;
            const request = stops.pending ?? {
              key: crypto.randomUUID(),
              generation: status!.selection!.generation,
            };
            saveStops({ ...stops, pending: request });
            void stop(request);
          }}
        >
          {busy
            ? 'Stopping sharing…'
            : stops.pending
              ? 'Retry stopping sharing'
              : 'Stop automatic sharing'}
        </Button>
      )}
      {status?.selection && (
        <details className="group-connection-details">
          <summary>Conversation identity</summary>
          <p>{status.selection.sessionId}</p>
        </details>
      )}
      <section className="group-connection-setup" aria-label="Connect Claude Code">
        <h3>
          {status?.selection?.enabled
            ? 'Connect a different conversation'
            : 'Connect your conversation'}
        </h3>
        <p>
          Keep talking in your Claude terminal or editor. Paste this prompt there to add the
          optional Groups plugin and share compact updates from new prompts and final replies.
        </p>
        <p className="group-connection-note">
          Automatic summaries use a separate model and your allowance. Human group messages use no
          model. Your selection survives compaction; earlier private history stays private.
        </p>
        <Button
          className="secondary group-copy-connection"
          onPress={async () => {
            try {
              await navigator.clipboard.writeText(prompt);
              setCopied(true);
              setCopyError('');
            } catch {
              setCopyError('Copy failed. Select the connection prompt below and copy it.');
            }
          }}
        >
          {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
          {copied ? 'Connection prompt copied' : 'Copy prompt for your Claude'}
        </Button>
        {copyError && <p role="alert">{copyError}</p>}
        <details className="group-connection-details">
          <summary>Read connection prompt</summary>
          <pre tabIndex={0}>{prompt}</pre>
        </details>
      </section>
      {legacy && (
        <details
          className="group-legacy-agent"
          onToggle={(event) => {
            if (event.currentTarget.open) setShowLegacy(true);
          }}
        >
          <summary>Saved SWA group agent</summary>
          <p>Retained requests and controls from the earlier workflow.</p>
          {showLegacy && <div className="group-legacy-chat">{legacy}</div>}
        </details>
      )}
    </section>
  );
}
