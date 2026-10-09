import { useEffect, useRef, useState } from 'react';
import { Pencil, Zap } from 'lucide-react';
import { withoutChatAttachments, type QueuedMessageAction } from '@dock/shared';
import { apiScope } from './api';
import { Modal } from './Modal';
import { MessageQueue } from './MessageQueue';
import { Notepad, type DraftSelection } from './Notepad';
import { useBrowserNotepad } from './useBrowserNotepad';
import { promptLengthError } from './promptLength';
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
  observation,
  hasMore,
  queueError,
}: {
  target: QueueEditorTarget;
  messages: readonly EditableQueuedMessage[];
  operations: QueuedMessageOperations;
  /** Identity of the last authoritative list response, before filtering/mapping. */
  observation: object;
  hasMore?: boolean;
  queueError?: 'unsupported' | 'unavailable';
}) {
  const workspace = useWorkspaceState();
  const scope = useRef(apiScope()).current;
  const [updates, setUpdates] = useState<Record<string, EditableQueuedMessage>>({});
  const [deleting, setDeleting] = useState<EditableQueuedMessage | null>(null);
  const [selected, setSelected] = useState<EditableQueuedMessage | null>(null);
  const [inspection, setInspection] = useState<{
    id: string;
    record?: EditableQueuedMessage;
    failed?: boolean;
  } | null>(null);
  const operationsRef = useRef(operations);
  operationsRef.current = operations;
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
    setInspection((saved) => (saved?.id === run.id ? { id: run.id, record: run } : saved));
    setRecoveries(operations.recoveries());
  };
  const selectedId = selected?.id;
  const selectedMissing = !!selectedId && !messages.some((run) => run.id === selectedId);
  useEffect(() => {
    if (!selectedId || !selectedMissing) {
      setInspection(null);
      return;
    }
    // List absence is not a receipt. Inspect once per fresh parent list response,
    // not on our own state updates or a freshly mapped presentation array.
    let active = true;
    setInspection({ id: selectedId });
    void operationsRef.current.read(selectedId).then(
      (record) => {
        if (active) setInspection({ id: selectedId, record, failed: !record });
      },
      () => {
        if (active) setInspection({ id: selectedId, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [selectedId, selectedMissing, observation]);
  const selectedLatest = selected
    ? [
        selected,
        updates[selected.id],
        inspection?.id === selected.id ? inspection.record : undefined,
        messages.find((run) => run.id === selected.id),
      ].reduce<EditableQueuedMessage | undefined>(
        (latest, run) =>
          run && (!latest || (run.queueRevision ?? 0) >= (latest.queueRevision ?? 0))
            ? run
            : latest,
        undefined,
      )
    : undefined;
  const verification =
    selectedMissing && !(inspection?.id === selectedId && inspection.record)
      ? inspection?.failed
        ? 'Delivery state needs inspection. Your local draft is retained.'
        : 'Checking delivery. Your local draft is retained.'
      : '';
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
  const removeQueued = async () => {
    if (!deleting || !clientId || busy) return;
    setBusy(true);
    setError('');
    try {
      if (apiScope() !== scope)
        throw new Error('Reopen the original computer before deleting this message.');
      changed(
        await operations.submit(deleting.id, {
          key: crypto.randomUUID(),
          clientId,
          revision: deleting.queueRevision ?? 0,
          action: 'remove',
        }),
      );
      setDeleting(null);
    } catch (reason) {
      setError(errorText(reason));
      setRecoveries(operations.recoveries());
    } finally {
      setBusy(false);
    }
  };
  const counts = { queued: 0, handedOff: 0, uncertain: 0, held: 0 };
  for (const run of shown) {
    if (run.status === 'uncertain' || run.queueEdit?.state === 'steering') counts.uncertain++;
    else if (run.status === 'running') counts.handedOff++;
    else if (run.queueEdit?.state === 'editing') counts.held++;
    else counts.queued++;
  }
  const failure = error || (!clientId && workspace.error);
  return (
    <>
      <MessageQueue
        hasMore={hasMore}
        error={queueError}
        counts={counts}
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
              {run.status === 'queued' &&
                run.queueEditable &&
                !other &&
                run.queueEdit?.state !== 'steering' && (
                  <button
                    type="button"
                    className="subtle"
                    disabled={
                      !clientId || busy || recoveries.some((saved) => saved.messageId === run.id)
                    }
                    onClick={() => {
                      setError('');
                      setDeleting(run);
                    }}
                  >
                    Delete queued message
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
      {deleting && (
        <QueueDeleteConfirmation
          text={deleting.queueEdit?.text ?? deleting.text}
          busy={busy}
          error={error}
          confirm={() => void removeQueued()}
          close={() => {
            if (!busy) setDeleting(null);
          }}
        />
      )}
      {selected && clientId && (
        <QueueEditor
          key={selected.id}
          target={target}
          operations={operations}
          run={selected}
          latest={selectedLatest!}
          verification={verification}
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

function QueueDeleteConfirmation({
  text,
  busy,
  error,
  confirm,
  close,
}: {
  text: string;
  busy: boolean;
  error: string;
  confirm: () => void;
  close: () => void;
}) {
  return (
    <Modal title="Delete queued message?" close={close}>
      <p>
        This removes this message from the app queue. Saved history and running replies stay intact.
      </p>
      <pre className="draft-preview">{withoutChatAttachments(text)}</pre>
      {error && <p role="alert">{error}</p>}
      <div className="message-queue-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>
          Close
        </button>
        <button type="button" className="primary" disabled={busy || !!error} onClick={confirm}>
          {busy ? 'Deleting…' : 'Delete message'}
        </button>
      </div>
    </Modal>
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
  latest,
  verification,
  clientId,
  scope,
  steerOptions,
  changed,
  close,
}: {
  target: QueueEditorTarget;
  operations: QueuedMessageOperations;
  run: EditableQueuedMessage;
  latest: EditableQueuedMessage;
  verification: string;
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
  const finalizing = useRef(false);
  const selection = useRef<DraftSelection>({ start: 0, end: 0 });
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState(
    pending.current ? 'An earlier queued action needs inspection. It has not been repeated.' : '',
  );
  const [savedUncertain, setUncertain] = useState(run.queueEdit?.state === 'steering');
  const uncertain =
    savedUncertain || latest.status === 'uncertain' || latest.queueEdit?.state === 'steering';
  const local = useBrowserNotepad(`dock:${scope}:queue:${run.id}`, text, setText);
  const authorityLost = !['queued', 'uncertain'].includes(latest.status)
    ? 'This message has left the queue. Your local draft was not sent again.'
    : latest.queueEdit?.clientId !== clientId
      ? latest.queueEdit
        ? 'Another browser took over this message. Your local draft is retained.'
        : 'This message is no longer held for editing. Your local draft is retained.'
      : '';
  const [closedReason, setClosedReason] = useState('');
  const blocked = closedReason || authorityLost || verification;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (authorityLost) {
      local.checkpoint();
      setClosedReason(authorityLost);
    }
  }, [authorityLost]);
  const send = (action: QueuedMessageAction['action'], retry = false): Promise<boolean> => {
    if (blockedRef.current) return Promise.resolve(false);
    if (working.current) return working.current;
    if (
      ['save', 'queue', 'steer'].includes(action) &&
      !pending.current &&
      promptLengthError(currentText.current, target.maxLength)
    )
      return Promise.resolve(false);
    const task = Promise.resolve().then(async () => {
      setBusy(true);
      setError('');
      try {
        if (blockedRef.current) return false;
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
        if (
          pending.current &&
          !operations
            .recoveries()
            .some(
              (record) => record.messageId === run.id && record.input.key === pending.current!.key,
            )
        )
          pending.current = null;
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
    if (
      blocked ||
      finishing ||
      busy ||
      uncertain ||
      error ||
      text === saved.current.queueEdit?.text
    )
      return;
    const timer = window.setTimeout(() => {
      void send('save');
    }, 600);
    return () => window.clearTimeout(timer);
  }, [text, blocked, finishing, busy, uncertain, error]);
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
      if (!latest) {
        setError('Delivery state could not be verified. Your local draft is retained.');
        return;
      }
      changed(latest);
      if (!['queued', 'uncertain'].includes(latest.status) || !latest.queueEdit) {
        return;
      }
      if (latest.queueEdit?.clientId !== clientId)
        throw new Error(
          'Another browser holds this message. Minimize, then explicitly Take over edit. Your local version is retained.',
        );
      if (blockedRef.current) return;
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
    // Accept the explicit action during autosave, without losing a pointer click
    // or starting another action while we wait for its acknowledgement.
    if (blockedRef.current || finalizing.current) return;
    finalizing.current = true;
    setFinishing(true);
    try {
      if (working.current && !(await working.current)) return;
      if (
        action === 'remove' &&
        !uncertain &&
        currentText.current !== saved.current.queueEdit?.text &&
        !(await send('save'))
      )
        return;
      local.checkpoint();
      await send(action);
    } finally {
      finalizing.current = false;
      setFinishing(false);
    }
  };
  return (
    <>
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
        sendLabel={blocked ? 'Editing closed' : 'Save and queue'}
        initialOptionsOpen={steerOptions}
        statusLabel={
          blocked
            ? 'Editing closed · local copy'
            : uncertain
              ? 'Held · inspect steering outcome'
              : busy
                ? 'Held · saving…'
                : 'Held for editing'
        }
        canSend={
          !blocked &&
          !uncertain &&
          !error &&
          !!text.trim() &&
          !promptLengthError(text, target.maxLength)
        }
        sending={finishing || (busy && pending.current?.action !== 'save')}
        readOnly={
          !!blocked || finishing || uncertain || (busy && pending.current?.action !== 'save')
        }
        notice={
          blocked ||
          error ||
          (uncertain
            ? 'Steering was not acknowledged. Inspect the reply before removing this held item. It will not be resent.'
            : '')
        }
        onSend={() => void finish('queue')}
        onMinimize={() => {
          local.checkpoint();
          if (
            !blockedRef.current &&
            !busy &&
            !error &&
            !uncertain &&
            text !== saved.current.queueEdit?.text
          )
            void send('save');
          close();
        }}
        localOnly
        localHistory={local.history}
        recoveryDescription={
          blocked
            ? 'Your local text and Versions are retained. Copy or download this local version before closing if needed.'
            : 'Minimize keeps this message held. Save and queue returns it to the queue. Edits save to this computer; Versions keeps browser recovery copies.'
        }
        controls={
          <div className="message-queue-actions">
            {blocked && (
              <button
                type="button"
                className="subtle"
                onClick={() => {
                  local.checkpoint();
                  close();
                }}
              >
                Close edit
              </button>
            )}
            {!blocked && error && pending.current && (
              <button
                type="button"
                className="subtle"
                disabled={busy}
                onClick={() => void send(pending.current!.action, true)}
              >
                Retry saved action
              </button>
            )}
            {(error || blocked) && (
              <button
                type="button"
                className="subtle"
                disabled={busy}
                onClick={() => void reopen()}
              >
                Inspect saved edit
              </button>
            )}
            {!blocked && !uncertain && (
              <button
                type="button"
                className="subtle"
                disabled={busy || !!error}
                onClick={() => void finish('discard')}
              >
                Discard edits and queue original
              </button>
            )}
            {!blocked && !uncertain && target.canSteer && (
              <button
                type="button"
                className="subtle"
                disabled={busy || !!error || !text.trim()}
                onClick={() => void finish('steer')}
              >
                <Zap size={14} /> Steer now
              </button>
            )}
            {!blocked && !uncertain && (
              <button
                type="button"
                className="subtle"
                disabled={finishing || !!error}
                onClick={() => setDeleteOpen(true)}
              >
                Delete queued message
              </button>
            )}
            {!blocked && uncertain && (
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
      {deleteOpen && (
        <QueueDeleteConfirmation
          text={text}
          busy={finishing}
          error={error || blocked}
          confirm={() => void finish('remove')}
          close={() => {
            if (!finishing) setDeleteOpen(false);
          }}
        />
      )}
    </>
  );
}
