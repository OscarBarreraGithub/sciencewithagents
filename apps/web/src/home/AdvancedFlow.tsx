import { lazy, Suspense, useEffect, useState } from 'react';
import { ArrowUpRight, Download, Layers3, Pause, Play, Plus, Terminal } from 'lucide-react';
import { commandSchema, type Agent } from '@dock/shared';
import { api, apiScope, apiUrl } from '../api';
import { ExecutionInfo } from '../ExecutionInfo';
import { SessionSettings } from '../SessionSettings';
import { SessionBrowser } from '../SessionBrowser';
import { Modal } from '../Modal';
import { FlowEmpty, FlowHeading } from './WorkspaceFlow';
import type { HomeData } from './useHomeData';
import './advanced-flow.css';

const NativeTerminal = lazy(() =>
  import('../NativeTerminal').then((m) => ({ default: m.NativeTerminal })),
);
type Command = ReturnType<typeof commandSchema.parse>;
const descriptions = {
  compact: [
    'Compact working context',
    'Codex summarizes its working context. QUARK checks shared capacity and allowance caps, and tracks this as maintenance. It does not continue or complete the assignment.',
  ],
  new: [
    'New context, keep history',
    'Retire the current provider context. Your visible transcript, task, review and saved checkpoints stay here. The next message reconstructs context from that evidence; the old working cache is not retained. This action sends no task message.',
  ],
  resume: [
    'Continue unfinished work',
    'Send a new request to inspect the saved state and continue the unfinished objective. This uses the original conversation and normal QUARK admission. It can spend allowance; exhausted caps remain in force.',
  ],
  interrupt: [
    'Stop the reply',
    'Ask the provider to stop this reply. Saved progress and the conversation remain available.',
  ],
} as const;

export function AdvancedFlow({ route, data }: { route: string; data: HomeData }) {
  const [, target, intent] = route.split('/');
  const state = data.snapshot.data;
  const [native, setNative] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [nativeError, setNativeError] = useState('');
  const agent = state?.agents.find((a) => a.id === target);
  useEffect(() => {
    setImporting(false);
    if (native && native !== target) setNative(null);
  }, [target]);
  const task = state?.tasks.find((t) => t.id === agent?.taskId);
  const archived = !!task && ['done', 'integrated', 'split', 'cancelled'].includes(task.status);
  return (
    <section className="flow-page connection-page advanced-page">
      <FlowHeading
        label="ADVANCED CONTROLS"
        title={agent ? agent.name : 'Advanced controls'}
        action={
          agent ? (
            <a
              className="flow-button"
              href={`#/chat/${agent.id}`}
              onClick={(event) => {
                if (native !== agent.id) return;
                event.preventDefault();
                void api(`/agents/${agent.id}/terminal/close`, {})
                  .then(() => {
                    setNative(null);
                    location.hash = `#/chat/${agent.id}`;
                  })
                  .catch((reason) =>
                    setNativeError(
                      reason instanceof Error
                        ? reason.message
                        : 'Could not return to chat. Try again.',
                    ),
                  );
              }}
            >
              Return to conversation <ArrowUpRight size={17} />
            </a>
          ) : undefined
        }
      >
        Session models, original provider tools and deliberate context changes, with your saved work
        intact.
      </FlowHeading>
      {nativeError && (
        <p className="flow-chat-notice" role="alert">
          {nativeError}
        </p>
      )}
      {!state ? (
        <FlowEmpty title="Reading your workspace…">
          <button className="flow-button" onClick={data.snapshot.retry}>
            Try again
          </button>
        </FlowEmpty>
      ) : !agent ? (
        <FlowEmpty title="That conversation is unavailable">
          <p>Open a conversation in Chats, then choose its settings for advanced controls.</p>
          <a className="flow-button" href="#/chats">
            Open Chats <ArrowUpRight size={16} />
          </a>
        </FlowEmpty>
      ) : (
        <>
          <div className="activity-shortcuts">
            <a href={apiUrl(`/agents/${agent.id}/export`)} download>
              <Download />
              <strong>Export conversation</strong>
              <span>Download the saved visible record</span>
              <ArrowUpRight />
            </a>
            <a href={`#/search/${agent.projectId}`}>
              <Layers3 />
              <strong>Search saved evidence</strong>
              <span>Messages, tools and decisions</span>
              <ArrowUpRight />
            </a>
          </div>
          {agent.nativeRootId ? (
            <div className="flow-form-panel">
              <h2>Controlled by its owning conversation</h2>
              <p>
                This helper’s visible evidence remains available here. Direct input, Stop and
                session changes belong to the owning conversation.
              </p>
              <a className="flow-button" href={`#/advanced/${agent.nativeRootId}`}>
                Open controlling conversation <ArrowUpRight size={17} />
              </a>
            </div>
          ) : archived || agent.interview ? (
            <div className="flow-form-panel">
              <h2>{agent.interview ? 'A read-only discussion' : 'A saved work record'}</h2>
              <p>
                {agent.interview
                  ? 'This discussion uses the original recorded model and saved evidence. Execution and broader permissions belong to a new task.'
                  : 'The task and its review remain closed. Ask about the work through its separate read-only discussion, or give your manager a new task.'}
              </p>
            </div>
          ) : (
            <>
              {native === agent.id ? (
                <div className="advanced-terminal">
                  <Suspense fallback={<p>Opening native controls…</p>}>
                    <NativeTerminal
                      agentId={agent.id}
                      onClose={() => setNative(null)}
                      onTransfer={(id) => {
                        setNative(id);
                        location.hash = `#/advanced/${id}`;
                        data.snapshot.retry();
                      }}
                    />
                  </Suspense>
                </div>
              ) : (
                <>
                  <AdvancedCommands
                    key={`${agent.id}:${intent ?? ''}`}
                    intent={intent}
                    agent={agent}
                    refresh={data.snapshot.retry}
                  />
                  {agent.provider === 'codex' ? (
                    <div className="flow-form-panel">
                      <h2>Native Codex</h2>
                      <p>
                        Open this conversation’s native terminal for Codex slash commands, skills,
                        model choices and installed connections. New turns still need QUARK
                        admission. Return to chat before sending from the app.
                      </p>
                      <button className="primary" onClick={() => setNative(agent.id)}>
                        <Terminal size={16} /> Open native Codex
                      </button>
                    </div>
                  ) : (
                    <div className="flow-form-panel">
                      <h2>Claude’s native tools</h2>
                      <p>
                        Claude can use its native tools, skills and connections while QUARK follows
                        the work. Interactive terminal controls remain in Claude Code or its shared
                        editor chat. Saved restricted conversations can opt in below while idle.
                      </p>
                      <a className="flow-button" href="#/vscode">
                        Open shared editor chats <ArrowUpRight size={16} />
                      </a>
                    </div>
                  )}
                  <div className="flow-form-panel">
                    <SessionSettings
                      key={agent.id}
                      embedded
                      agent={agent}
                      act={async (fn) => {
                        try {
                          await fn();
                          data.snapshot.retry();
                        } catch {
                          /* The form retains its actionable error. */
                        }
                      }}
                      close={() => {
                        data.snapshot.retry();
                        location.hash = `#/chat/${agent.id}`;
                      }}
                    />
                  </div>
                </>
              )}
            </>
          )}
          <div className="flow-form-panel">
            <ExecutionInfo agent={agent} />
          </div>
          {!agent.interview &&
            !archived &&
            agent.projectId !== data.frontdesk.data?.projectId &&
            agent.projectId !== data.resources.data?.projectId && (
              <div className="flow-form-panel">
                <h2>Bring in existing Codex history</h2>
                <p>
                  Read saved Codex sessions for this project, even when its manager uses Claude.
                  Importing requires confirming that the original conversation has stopped; it does
                  not start a model turn.
                </p>
                <button className="secondary" onClick={() => setImporting(true)}>
                  Browse saved Codex sessions
                </button>
              </div>
            )}
          {importing && (
            <SessionBrowser
              projectId={agent.projectId}
              managers={state.agents.filter(
                (a) => a.projectId === agent.projectId && a.role === 'manager' && !a.nativeRootId,
              )}
              initialManagerId={state.projects.find((p) => p.id === agent.projectId)!.managerId}
              close={() => setImporting(false)}
              onOpen={(id) => {
                setImporting(false);
                data.snapshot.retry();
                location.hash = `#/chat/${id}`;
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function AdvancedCommands({
  agent,
  refresh,
  intent,
}: {
  agent: Agent;
  refresh: () => void;
  intent?: string;
}) {
  const storageKey = `dock:${apiScope()}:session-command:${agent.id}`;
  const [pending, setPending] = useState<Command | null>(() => {
    try {
      const result = commandSchema.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'),
      );
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  });
  const [choice, setChoice] = useState<Command | null>(() => {
    if (pending) return null;
    const command = commandSchema.safeParse({ command: intent, key: crypto.randomUUID() });
    return command.success && !(agent.provider === 'claude' && command.data.command === 'compact')
      ? command.data
      : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inspected, setInspected] = useState(false);
  const run = async (input: Command) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(input));
      setPending(input);
      await api(`/agents/${agent.id}/commands`, input);
      sessionStorage.removeItem(storageKey);
      setPending(null);
      setChoice(null);
      setNotice(
        input.command === 'new'
          ? 'New context is ready for your next message. Saved history is retained.'
          : input.command === 'compact'
            ? 'Compaction was admitted. Follow its progress in the conversation or Work.'
            : input.command === 'interrupt'
              ? 'Stop requested. Follow the conversation for confirmation.'
              : 'Your continuation is queued in QUARK.',
      );
      refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Confirmation was lost. Check the same request before trying another control.',
      );
    } finally {
      setBusy(false);
    }
  };
  const choose = (command: Command['command']) => {
    setChoice({ command, key: crypto.randomUUID() });
    setError('');
  };
  return (
    <div className="flow-form-panel">
      <h2>Context and continuation</h2>
      <p>
        These controls act on this conversation. Read the confirmation before changing its working
        context or resuming work.
      </p>
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div className="activity-warning">
          <h3>Check a previous request</h3>
          <p>
            {descriptions[pending.command][0]} has an unconfirmed result. Its receipt is retained
            across reload.
          </p>
          <button className="secondary" disabled={busy} onClick={() => setChoice(pending)}>
            Check the same request
          </button>
          <details>
            <summary>If the request is still uncertain</summary>
            <p>
              Read the conversation and current work before choosing another action. Clearing this
              local receipt does not undo the earlier command or send it again.
            </p>
            <a className="flow-button" href={`#/chat/${agent.id}`}>
              Inspect conversation <ArrowUpRight size={16} />
            </a>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={inspected}
                onChange={(event) => setInspected(event.target.checked)}
              />
              I checked the current state and want to prepare a new request.
            </label>
            <button
              className="secondary"
              disabled={busy || !inspected}
              onClick={() => {
                sessionStorage.setItem(`${storageKey}:previous`, JSON.stringify(pending));
                sessionStorage.removeItem(storageKey);
                setPending(null);
                setChoice(null);
                setInspected(false);
                setError('');
                setNotice(
                  'The earlier receipt is retained. Choose and confirm a new action when ready.',
                );
              }}
            >
              Allow a new request
            </button>
          </details>
        </div>
      )}
      <div className="advanced-actions">
        <button className="secondary" disabled={busy || !!pending} onClick={() => choose('resume')}>
          <Play size={16} /> Continue unfinished work
        </button>
        <button className="secondary" disabled={busy || !!pending} onClick={() => choose('new')}>
          <Plus size={16} /> New context, keep history
        </button>
        {agent.provider === 'codex' && (
          <button
            className="secondary"
            disabled={busy || !!pending}
            onClick={() => choose('compact')}
          >
            <Layers3 size={16} /> Compact working context
          </button>
        )}
        <button
          className="secondary"
          disabled={busy || !!pending}
          onClick={() => choose('interrupt')}
        >
          <Pause size={16} /> Stop the reply
        </button>
      </div>
      {choice && (
        <Modal
          title={descriptions[choice.command][0]}
          close={() => {
            if (!busy) setChoice(null);
          }}
        >
          <p>{descriptions[choice.command][1]}</p>
          {error && <p role="alert">{error}</p>}
          <div className="activity-confirm-actions">
            <button className="secondary" disabled={busy} onClick={() => setChoice(null)}>
              Keep reviewing
            </button>
            <button className="primary" disabled={busy} onClick={() => void run(choice)}>
              {busy ? 'Checking…' : pending ? 'Check command receipt' : 'Confirm action'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
