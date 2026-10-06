import { useEffect, useRef, useState } from 'react';
import { Pencil, Zap } from 'lucide-react';
import { withoutChatAttachments, type QueuedMessageAction } from '@dock/shared';
import { apiScope } from './api';
import { MessageQueue } from './MessageQueue';
import { Notepad, type DraftSelection } from './Notepad';
import { useBrowserNotepad } from './useBrowserNotepad';
import { useWorkspaceState } from './useWorkspaceState';
import type { QueueRecovery } from './queued-action-recovery';

/** Only the fields the held-message editor displays; transport validates complete saved records. */
export type EditableQueuedMessage = {
  id: string;
  text: string;
  status: string;
  queueRevision?: number;
  queueEditable?: boolean;
  queueEdit?: { clientId: string; text: string; state: 'editing' | 'steering' } | null;
  message?: string;
};
export type QueueEditorTarget = {
  id: string;
  name: string;
  canSteer: boolean;
  maxLength: number;
};
export type QueuedMessageOperations = {
  recoveries: () => QueueRecovery[];
  clear: (saved: QueueRecovery) => void;
  submit: (id: string, input: QueuedMessageAction) => Promise<EditableQueuedMessage>;
  inspect: (
    id: string,
    key: string,
  ) => Promise<{
    status: 'applied' | 'uncertain' | 'not_found';
    message: EditableQueuedMessage;
  }>;
  read: (id: string) => Promise<EditableQueuedMessage | undefined>;
};

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The connection was interrupted. Your message remains held.';

export function EditableMessageQueue({
  target,
  messages,
  operations,
  hasMore,
  queueError,
}: {
  target: QueueEditorTarget;
  messages: readonly EditableQueuedMessage[];
  operations: QueuedMessageOperations;
  hasMore?: boolean;
  queueError?: 'unsupported' | 'unavailable';
}) {
  const workspace = useWorkspaceState();
  const scope = useRef(apiScope()).current;
  const [updates, setUpdates] = useState<Record<string, EditableQueuedMessage>>({});
  const [selected, setSelected] = useState<EditableQueuedMessage | null>(null);
  const [steerOptions, setSteerOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveries, setRecoveries] = useState(() => operations.recoveries());
  // Notices move into the open queue dialog, so an inspected outcome must outlive remounting.
  const [outcomes, setOutcomes] = useState<Record<string, 'uncertain' | 'not_found'>>({});
  const [inspected, setInspected] = useState<Set<string>>(new Set());
  const shown = messages
    .map((run) => {
      const saved = updates[run.id];
      return saved && (saved.queueRevision ?? 0) > (run.queueRevision ?? 0) ? saved : run;
    })
    .filter((run) => ['queued', 'running', 'uncertain'].includes(run.status));
  const clientId = workspace.state?.client.id;
  const changed = (run: EditableQueuedMessage) => {
    setUpdates((saved) => ({ ...saved, [run.id]: run }));
    setRecoveries(operations.recoveries());
  };
  const open = async (run: EditableQueuedMessage, action: 'edit' | 'takeover', steer = false) => {
    if (!clientId || busy) return;
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('The selected computer changed. Reopen the original computer.');
      const held = await operations.submit(run.id, {
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
      setRecoveries(operations.recoveries());
    } finally {
      setBusy(false);
    }
  };
  const inspectDelivery = async (run: EditableQueuedMessage) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('Reopen the original computer to inspect delivery.');
      const latest = await operations.read(run.id);
      if (latest) changed(latest);
      setInspected((saved) => new Set(saved).add(run.id));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const removeInspected = async (run: EditableQueuedMessage) => {
    if (!clientId || busy || !inspected.has(run.id)) return;
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('Reopen the original computer before removing this item.');
      changed(
        await operations.submit(run.id, {
          key: crypto.randomUUID(),
          clientId,
          revision: run.queueRevision ?? 0,
          action: 'remove',
        }),
      );
    } catch (reason) {
      setError(errorText(reason));
      setRecoveries(operations.recoveries());
    } finally {
      setBusy(false);
    }
  };
  const held = shown.filter((run) => run.queueEdit?.state === 'editing').length;
  const inspect = shown.filter(
    (run) => run.queueEdit?.state === 'steering' || (run.status === 'uncertain' && !run.queueEdit),
  ).length;
  const failure = error || (!clientId && workspace.error);
  return (
    <>
      <MessageQueue
        hasMore={hasMore}
        error={queueError}
        detail={[held && `${held} held`, inspect && `${inspect} to inspect`]
          .filter(Boolean)
          .join(' · ')}
        alert={
          (recoveries.length > 0 || failure) && (
            <>
              {recoveries.map((saved) => (
                <QueuedActionRecovery
                  key={`${saved.messageId}:${saved.input.key}`}
                  operations={operations}
                  saved={saved}
                  scope={scope}
                  status={outcomes[saved.input.key] ?? null}
                  setStatus={(status) =>
                    setOutcomes((all) => ({ ...all, [saved.input.key]: status }))
                  }
                  resolved={(run) => {
                    if (run) changed(run);
                    setRecoveries(operations.recoveries());
                  }}
                />
              ))}
              {failure && (
                <p className="message-queue-more" role="alert">
                  {failure}
                </p>
              )}
            </>
          )
        }
        messages={shown.map((run) => ({
          id: run.id,
          text: withoutChatAttachments(run.queueEdit?.text ?? run.text),
        }))}
        actions={(id) => {
          const run = shown.find((run) => run.id === id)!;
          const other = run.queueEdit && run.queueEdit.clientId !== clientId;
          return (
            <div className="message-queue-actions">
              {run.message && <span>{run.message}</span>}
              {run.status === 'running' && <span>Handed off for delivery</span>}
              {run.status === 'uncertain' && !run.queueEdit && (
                <>
                  <span>Delivery needs inspection · held</span>
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    onClick={() => void inspectDelivery(run)}
                  >
                    Inspect delivery
                  </button>
                  {inspected.has(run.id) && (
                    <button
                      type="button"
                      className="subtle"
                      disabled={busy || !clientId}
                      onClick={() => void removeInspected(run)}
                    >
                      Remove item after inspection
                    </button>
                  )}
                </>
              )}
              {run.queueEdit && (
                <span>
                  {run.queueEdit.state === 'steering'
                    ? 'Steering outcome needs inspection'
                    : 'Held for editing'}
                </span>
              )}
              {run.queueEditable && (
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
              {run.queueEditable && target.canSteer && !run.queueEdit && (
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
      {selected && clientId && (
        <QueueEditor
          key={selected.id}
          target={target}
          operations={operations}
          run={selected}
          clientId={clientId}
          scope={scope}
          steerOptions={steerOptions}
          changed={changed}
          close={() => {
            setSelected(null);
            setRecoveries(operations.recoveries());
          }}
        />
      )}
    </>
  );
}

function QueuedActionRecovery({
  operations,
  saved,
  scope,
  status,
  setStatus,
  resolved,
}: {
  operations: QueuedMessageOperations;
  saved: QueueRecovery;
  scope: string;
  status: 'uncertain' | 'not_found' | null;
  setStatus: (status: 'uncertain' | 'not_found') => void;
  resolved: (run?: EditableQueuedMessage) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inspect = async () => {
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('Reopen the original computer to inspect this action.');
      const receipt = await operations.inspect(saved.messageId, saved.input.key);
      if (receipt.status === 'applied') operations.clear(saved);
      else setStatus(receipt.status);
      resolved(receipt.message);
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
      resolved(await operations.submit(saved.messageId, saved.input));
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
                operations.clear(saved);
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
  target,
  operations,
  run,
  clientId,
  scope,
  steerOptions,
  changed,
  close,
}: {
  target: QueueEditorTarget;
  operations: QueuedMessageOperations;
  run: EditableQueuedMessage;
  clientId: string;
  scope: string;
  steerOptions: boolean;
  changed: (run: EditableQueuedMessage) => void;
  close: () => void;
}) {
  const [text, setText] = useState(run.queueEdit?.text ?? run.text);
  const currentText = useRef(text);
  currentText.current = text;
  const saved = useRef(run);
  const pending = useRef<QueuedMessageAction | null>(
    operations.recoveries().find((saved) => saved.messageId === run.id)?.input ?? null,
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
        const result = await operations.submit(run.id, input);
        saved.current = result;
        pending.current = null;
        changed(result);
        setUncertain(result.queueEdit?.state === 'steering');
        if (['queue', 'discard', 'steer', 'remove'].includes(input.action)) close();
        return true;
      } catch (reason) {
        setError(errorText(reason));
        // Minimize can unmount the editor while its final save finishes. Keep the
        // receipt recovery visible in the queue even when that save loses its acknowledgement.
        changed(saved.current);
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
        const receipt = await operations.inspect(run.id, input.key);
        changed(receipt.message);
        if (receipt.status === 'uncertain') {
          saved.current = receipt.message;
          setUncertain(true);
          setError('');
          return;
        }
        operations.clear({ messageId: run.id, input });
        pending.current = null;
      }
      const latest = await operations.read(run.id);
      if (!latest || !['queued', 'uncertain'].includes(latest.status) || !latest.queueEdit) {
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
      agentId={target.id}
      clientId={clientId}
      agentName={target.name}
      maxLength={target.maxLength}
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
          {!uncertain && target.canSteer && (
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
