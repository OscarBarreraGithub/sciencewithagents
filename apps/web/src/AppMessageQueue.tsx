import { useEffect, useRef, useState } from 'react';
import { Pencil, Zap } from 'lucide-react';
import {
  queuedMessageReceiptSchema,
  withoutChatAttachments,
  type Agent,
  type AgentDetail,
  type QueuedMessageAction,
  type Run,
} from '@dock/shared';
import { api, apiScope } from './api';
import { MessageQueue } from './MessageQueue';
import { Notepad, type DraftSelection } from './Notepad';
import { useBrowserNotepad } from './useBrowserNotepad';
import { useWorkspaceState } from './useWorkspaceState';
import {
  queuedActionRecoveries,
  clearQueuedAction,
  submitQueuedAction,
  type QueueRecovery,
} from './queued-action-recovery';

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The connection was interrupted. Your message remains held.';

export function AppMessageQueue({ agent, runs }: { agent: Agent; runs: readonly Run[] }) {
  const messages = runs.filter((run) => run.status === 'queued' && run.kind === 'user');
  return messages.length || queuedActionRecoveries(agent.id).length ? (
    <EditableQueue agent={agent} runs={messages} />
  ) : null;
}

function EditableQueue({ agent, runs }: { agent: Agent; runs: readonly Run[] }) {
  const workspace = useWorkspaceState();
  const scope = useRef(apiScope()).current;
  const [updates, setUpdates] = useState<Record<string, Run>>({});
  const [selected, setSelected] = useState<Run | null>(null);
  const [steerOptions, setSteerOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveries, setRecoveries] = useState(() => queuedActionRecoveries(agent.id));
  const shown = runs
    .map((run) => {
      const saved = updates[run.id];
      return saved && (saved.queueRevision ?? 0) > (run.queueRevision ?? 0) ? saved : run;
    })
    .filter((run) => run.status === 'queued');
  const clientId = workspace.state?.client.id;
  const changed = (run: Run) => {
    setUpdates((saved) => ({ ...saved, [run.id]: run }));
    setRecoveries(queuedActionRecoveries(agent.id));
  };
  const open = async (run: Run, action: 'edit' | 'takeover', steer = false) => {
    if (!clientId || busy) return;
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('The selected computer changed. Reopen the original computer.');
      const held = await submitQueuedAction(agent.id, run.id, {
        key: crypto.randomUUID(),
        clientId,
        revision: run.queueRevision ?? 0,
        action,
      });
      changed(held);
      setSteerOptions(steer);
      setSelected(held);
    } catch (reason) {
      setError(errorText(reason));
      setRecoveries(queuedActionRecoveries(agent.id));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {recoveries.map((saved) => (
        <QueuedActionRecovery
          key={`${saved.runId}:${saved.input.key}`}
          agentId={agent.id}
          saved={saved}
          scope={scope}
          resolved={(run) => {
            if (run) changed(run);
            setRecoveries(queuedActionRecoveries(agent.id));
          }}
        />
      ))}
      <MessageQueue
        messages={shown.map((run) => ({
          id: run.id,
          text: withoutChatAttachments(run.queueEdit?.text ?? run.text),
        }))}
        actions={(id) => {
          const run = shown.find((run) => run.id === id)!;
          const other = run.queueEdit && run.queueEdit.clientId !== clientId;
          return (
            <div className="message-queue-actions">
              {run.queueEdit && (
                <span>
                  {run.queueEdit.state === 'steering'
                    ? 'Steering outcome needs inspection'
                    : 'Held for editing'}
                </span>
              )}
              {!agent.nativeRootId && run.queueEditable && (
                <button
                  type="button"
                  className="subtle"
                  disabled={!clientId || busy}
                  onClick={() => {
                    if (run.queueEdit?.clientId === clientId) {
                      setSteerOptions(false);
                      setSelected(run);
                    } else void open(run, other ? 'takeover' : 'edit');
                  }}
                >
                  <Pencil size={14} />{' '}
                  {other ? 'Take over edit' : run.queueEdit ? 'Resume edit' : 'Edit'}
                </button>
              )}
              {!agent.nativeRootId &&
                run.queueEditable &&
                agent.provider === 'codex' &&
                agent.status === 'running' &&
                !run.queueEdit && (
                  <button
                    type="button"
                    className="subtle"
                    disabled={!clientId || busy}
                    onClick={() => void open(run, 'edit', true)}
                  >
                    <Zap size={14} /> Steer now…
                  </button>
                )}
            </div>
          );
        }}
      />
      {(error || (!clientId && workspace.error)) && (
        <p className="message-queue-more" role="alert">
          {error || workspace.error}
        </p>
      )}
      {selected && clientId && (
        <QueueEditor
          key={selected.id}
          agent={agent}
          run={selected}
          clientId={clientId}
          scope={scope}
          steerOptions={steerOptions}
          changed={changed}
          close={() => {
            setSelected(null);
            setRecoveries(queuedActionRecoveries(agent.id));
          }}
        />
      )}
    </>
  );
}

function QueuedActionRecovery({
  agentId,
  saved,
  scope,
  resolved,
}: {
  agentId: string;
  saved: QueueRecovery;
  scope: string;
  resolved: (run?: Run) => void;
}) {
  const [status, setStatus] = useState<'uncertain' | 'not_found' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inspect = async () => {
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('Reopen the original computer to inspect this action.');
      const receipt = queuedMessageReceiptSchema.parse(
        await api(`/agents/${agentId}/queued/${saved.runId}/receipts/${saved.input.key}`),
      );
      if (receipt.status === 'applied') clearQueuedAction(agentId, saved);
      else setStatus(receipt.status);
      resolved(receipt.run);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope) throw new Error('Reopen the original computer before retrying.');
      resolved(await submitQueuedAction(agentId, saved.runId, saved.input));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="queue-action-recovery" role="status">
      <p>
        {status === 'uncertain'
          ? 'Steering is uncertain. The message stays held; inspect the reply before removing it.'
          : status === 'not_found'
            ? 'This queued action is not recorded. Inspect the message before explicitly retrying.'
            : 'A queued action needs inspection after a lost acknowledgement. It was not repeated.'}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="message-queue-actions">
        <button type="button" className="subtle" disabled={busy} onClick={() => void inspect()}>
          Inspect queued action
        </button>
        {status === 'not_found' && (
          <>
            <button type="button" className="subtle" disabled={busy} onClick={() => void retry()}>
              Retry saved action
            </button>
            <button
              type="button"
              className="subtle"
              disabled={busy}
              onClick={() => {
                clearQueuedAction(agentId, saved);
                resolved();
              }}
            >
              Dismiss action notice
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function QueueEditor({
  agent,
  run,
  clientId,
  scope,
  steerOptions,
  changed,
  close,
}: {
  agent: Agent;
  run: Run;
  clientId: string;
  scope: string;
  steerOptions: boolean;
  changed: (run: Run) => void;
  close: () => void;
}) {
  const [text, setText] = useState(run.queueEdit?.text ?? run.text);
  const currentText = useRef(text);
  currentText.current = text;
  const saved = useRef(run);
  const pending = useRef<QueuedMessageAction | null>(
    queuedActionRecoveries(agent.id).find((saved) => saved.runId === run.id)?.input ?? null,
  );
  const working = useRef<Promise<boolean> | null>(null);
  const selection = useRef<DraftSelection>({ start: 0, end: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    pending.current ? 'An earlier queued action needs inspection. It has not been repeated.' : '',
  );
  const [uncertain, setUncertain] = useState(run.queueEdit?.state === 'steering');
  const local = useBrowserNotepad(`dock:${scope}:queue:${run.id}`, text, setText);
  const send = (action: QueuedMessageAction['action'], retry = false): Promise<boolean> => {
    if (working.current) return working.current;
    const task = Promise.resolve().then(async () => {
      setBusy(true);
      setError('');
      try {
        if (apiScope() !== scope)
          throw new Error(
            'The selected computer changed. Reopen the original computer to continue this edit.',
          );
        if (pending.current && !retry && !(action === 'remove' && uncertain))
          throw new Error('Retry the saved action first. Your later typing is retained.');
        const input = (action === 'remove' && uncertain ? null : pending.current) ?? {
          key: crypto.randomUUID(),
          clientId,
          revision: saved.current.queueRevision ?? 0,
          action,
          ...(['save', 'queue', 'steer'].includes(action) ? { text: currentText.current } : {}),
        };
        pending.current = input;
        const result = await submitQueuedAction(agent.id, run.id, input);
        saved.current = result;
        pending.current = null;
        changed(result);
        setUncertain(result.queueEdit?.state === 'steering');
        if (['queue', 'discard', 'steer', 'remove'].includes(input.action)) close();
        return true;
      } catch (reason) {
        setError(errorText(reason));
        return false;
      } finally {
        setBusy(false);
        working.current = null;
      }
    });
    working.current = task;
    return task;
  };
  useEffect(() => {
    if (busy || uncertain || error || text === saved.current.queueEdit?.text) return;
    const timer = window.setTimeout(() => {
      void send('save');
    }, 600);
    return () => window.clearTimeout(timer);
  }, [text, busy, uncertain, error]);
  const reopen = async () => {
    if (busy) return;
    local.checkpoint();
    setBusy(true);
    try {
      if (apiScope() !== scope)
        throw new Error('Reopen the original computer to inspect this message.');
      if (pending.current) {
        const input = pending.current;
        const receipt = queuedMessageReceiptSchema.parse(
          await api(`/agents/${agent.id}/queued/${run.id}/receipts/${input.key}`),
        );
        changed(receipt.run);
        if (receipt.status === 'uncertain') {
          saved.current = receipt.run;
          setUncertain(true);
          setError('');
          return;
        }
        clearQueuedAction(agent.id, { runId: run.id, input });
        pending.current = null;
      }
      const detail = await api<AgentDetail>(`/agents/${agent.id}`);
      const latest = detail.runs.find((value) => value.id === run.id);
      if (!latest || latest.status !== 'queued' || !latest.queueEdit) {
        close();
        return;
      }
      if (latest.queueEdit?.clientId !== clientId)
        throw new Error(
          'Another browser holds this message. Minimize, then explicitly Take over edit. Your local version is retained.',
        );
      saved.current = latest;
      pending.current = null;
      local.draft.setText(latest.queueEdit.text);
      changed(latest);
      setUncertain(latest.queueEdit.state === 'steering');
      setError('');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const finish = async (action: 'queue' | 'discard' | 'steer' | 'remove') => {
    if (working.current) await working.current;
    local.checkpoint();
    await send(action);
  };
  return (
    <Notepad
      draft={{
        ...local.draft,
        saving: busy,
        unsaved: text !== saved.current.queueEdit?.text,
        error: error || local.draft.error,
      }}
      agentId={agent.id}
      clientId={clientId}
      agentName={agent.name}
      mode="message"
      selection={selection}
      title="Edit queued message"
      sendLabel="Save and queue"
      initialOptionsOpen={steerOptions}
      statusLabel={
        uncertain ? 'Held · inspect steering outcome' : busy ? 'Held · saving…' : 'Held for editing'
      }
      canSend={!uncertain && !error && !!text.trim()}
      sending={busy}
      readOnly={uncertain || (busy && pending.current?.action !== 'save')}
      notice={
        error ||
        (uncertain
          ? 'Steering was not acknowledged. Inspect the reply before removing this held item. It will not be resent.'
          : '')
      }
      onSend={() => void finish('queue')}
      onMinimize={() => {
        local.checkpoint();
        if (!busy && !error && !uncertain && text !== saved.current.queueEdit?.text)
          void send('save');
        close();
      }}
      localOnly
      localHistory={local.history}
      recoveryDescription="Minimize keeps this message held. Save and queue returns it to the queue. Edits save to this computer; Versions keeps browser recovery copies."
      controls={
        <div className="message-queue-actions">
          {error && pending.current && (
            <button
              type="button"
              className="subtle"
              disabled={busy}
              onClick={() => void send(pending.current!.action, true)}
            >
              Retry saved action
            </button>
          )}
          {error && (
            <button type="button" className="subtle" disabled={busy} onClick={() => void reopen()}>
              Inspect saved edit
            </button>
          )}
          {!uncertain && (
            <button
              type="button"
              className="subtle"
              disabled={busy || !!error}
              onClick={() => void finish('discard')}
            >
              Discard edits and queue original
            </button>
          )}
          {!uncertain && agent.provider === 'codex' && agent.status === 'running' && (
            <button
              type="button"
              className="subtle"
              disabled={busy || !!error || !text.trim()}
              onClick={() => void finish('steer')}
            >
              <Zap size={14} /> Steer now
            </button>
          )}
          {uncertain && (
            <button
              type="button"
              className="subtle"
              disabled={busy}
              onClick={() => void finish('remove')}
            >
              Remove held item after inspection
            </button>
          )}
        </div>
      }
    />
  );
}
