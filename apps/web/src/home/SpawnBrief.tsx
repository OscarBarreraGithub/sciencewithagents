import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, apiScope, ApiError } from '../api';
import { ChatAttachmentPicker, useChatAttachmentUpload } from '../ChatImages';
import { Notepad } from '../Notepad';
import { useBrowserNotepad } from '../useBrowserNotepad';
import './spawn-brief.css';
import { promptLengthError } from '../promptLength';

type SendReceipt = { key: string; text: string };
export type ProjectBriefSeed = {
  id: string;
  brief: string;
  sourceItemIds: string[];
  suggestedName?: string;
};

/** A separate setup route keeps an idea from replacing an unfinished project setup. */
export function seedProjectBrief(input: Omit<ProjectBriefSeed, 'id'>) {
  const id = crypto.randomUUID();
  sessionStorage.setItem(`dock:${apiScope()}:project-seed:${id}`, JSON.stringify({ ...input, id }));
  return `#/new/idea/${id}`;
}

export function readProjectSeed(id: string | undefined): ProjectBriefSeed | undefined {
  if (!id) return;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`dock:${apiScope()}:project-seed:${id}`) ?? 'null',
    );
    if (value?.id === id && typeof value.brief === 'string' && Array.isArray(value.sourceItemIds))
      return value;
  } catch {
    // The original idea stays in the board if a local setup handoff is unavailable.
  }
}

/** The brief exists before its manager does. Preparing never replaces the writing surface. */
export function SpawnBrief({
  identity,
  name,
  open,
  preparing,
  preparationError,
  managerId,
  retryPreparation,
  minimize,
  sent,
  initialText = '',
}: {
  identity: string;
  name: string;
  open: boolean;
  preparing: boolean;
  preparationError: string;
  managerId?: string;
  retryPreparation: () => void;
  minimize: () => void;
  sent: (managerId: string) => void;
  initialText?: string;
}) {
  const storageKey = `dock:${apiScope()}:spawn-brief:${identity}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? initialText;
    } catch {
      return initialText;
    }
  });
  const [storageError, setStorageError] = useState('');
  const [receipt, setReceipt] = useState<SendReceipt | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(`${storageKey}:send`) ?? 'null');
      return value && typeof value.key === 'string' && typeof value.text === 'string'
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState('');
  const attempted = useRef(false);
  const mounted = useRef(true);
  const selection = useRef({ start: 0, end: 0 });
  const { draft, history, checkpoint } = useBrowserNotepad(storageKey, text, (value) => {
    setText(value);
    try {
      sessionStorage.setItem(storageKey, value);
      setStorageError('');
    } catch {
      setStorageError('Keep this page open, or download your draft before leaving.');
    }
  });
  const attachmentUpload = useChatAttachmentUpload({
    currentText: draft.currentText,
    setText: draft.setText,
    maxLength: 24_000,
    onBusy: setUploading,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retainReceipt = (value: SendReceipt | null) => {
    try {
      if (value) sessionStorage.setItem(`${storageKey}:send`, JSON.stringify(value));
      else sessionStorage.removeItem(`${storageKey}:send`);
    } catch {
      setStorageError('Keep this page open until sending has finished.');
    }
    setReceipt(value);
  };
  const send = async (target: string, request: SendReceipt) => {
    if (attempted.current) return;
    attempted.current = true;
    setSending(true);
    setSendError('');
    try {
      await api(`/agents/${target}/messages`, request);
      if (!mounted.current) return;
      retainReceipt(null);
      sent(target);
    } catch (reason) {
      // These responses are definite refusals; allow corrections without losing text.
      // Disconnects, conflicts and server failures keep the exact receipt for reconciliation.
      if (
        mounted.current &&
        reason instanceof ApiError &&
        [400, 403, 404, 413, 422].includes(reason.status)
      ) {
        retainReceipt(null);
        attempted.current = false;
      }
      if (mounted.current)
        setSendError(
          reason instanceof Error ? reason.message : 'Could not send. Your draft is saved.',
        );
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  useEffect(() => {
    // One captured request survives setup finishing, an ambiguous reply and reloads.
    // Changing preparation state must never generate a second message receipt.
    if (receipt && managerId && !sendError) void send(managerId, receipt);
  }, [receipt, managerId, sendError]);
  const submit = () => {
    if (sending || uploading) return;
    if (!receipt && promptLengthError(draft.currentText(), 24_000)) {
      setSendError(promptLengthError(draft.currentText(), 24_000));
      return;
    }
    checkpoint();
    attempted.current = false;
    setSendError('');
    const next = receipt ?? { key: crypto.randomUUID(), text: draft.currentText() };
    retainReceipt(next);
    if (managerId) void send(managerId, next);
    else if (!preparing) retryPreparation();
  };
  if (!open) return null;
  const waiting = !!receipt && !managerId && preparing;
  return (
    <Notepad
      draft={draft}
      maxLength={24_000}
      agentId={identity}
      clientId={null}
      agentName={name}
      mode="brief"
      selection={selection}
      canSend={!uploading && (!!receipt || (!!text.trim() && !promptLengthError(text, 24_000)))}
      sending={sending || waiting}
      readOnly={!!receipt}
      localOnly
      localHistory={history}
      notice={sendError || preparationError || storageError}
      onSend={submit}
      onMinimize={minimize}
      overlay={
        waiting && (
          <div className="spawn-brief-wait" role="status" aria-live="polite">
            <div>
              <RefreshCw className="spin" size={24} />
              <h2>Finishing project setup…</h2>
              <p>Your request is saved. It will send when the project is ready.</p>
              <button type="button" className="notepad-button" onClick={() => retainReceipt(null)}>
                Keep writing instead
              </button>
            </div>
          </div>
        )
      }
      attachments={
        <ChatAttachmentPicker
          text={text}
          currentText={draft.currentText}
          setText={draft.setText}
          disabled={sending || !!receipt}
          uploader={attachmentUpload}
        />
      }
      controls={
        <>
          {preparationError && !preparing && (
            <button type="button" className="notepad-button" onClick={retryPreparation}>
              Retry project setup
            </button>
          )}
          {receipt && !attempted.current && !preparing && !managerId && (
            <button type="button" className="notepad-button" onClick={() => retainReceipt(null)}>
              Keep writing
            </button>
          )}
        </>
      }
    />
  );
}
