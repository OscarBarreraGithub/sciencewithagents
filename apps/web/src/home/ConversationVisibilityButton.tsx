import { useRef, useState } from 'react';
import { Archive, ArchiveRestore } from 'lucide-react';
import {
  conversationVisibilitySchema,
  type ConversationVisibility,
  type ConversationVisibilityTarget,
  type ConversationVisibilityUpdate,
} from '@dock/shared';
import { api } from '../api';
import { Modal } from '../Modal';
import { refreshHome } from './refreshHome';

/** App visibility only: never provider archiving or manager removal. */
export function ConversationVisibilityButton({
  target,
  record,
  changed,
  name,
}: {
  target: ConversationVisibilityTarget;
  record?: ConversationVisibility;
  changed: (record: ConversationVisibility) => void;
  name?: string;
}) {
  const attempt = useRef<ConversationVisibilityUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const restoring = attempt.current ? !attempt.current.archived : !!record?.archived;
  const label = `${restoring ? 'Restore' : 'Archive'} ${name ?? 'conversation'}`;
  const submit = async () => {
    if (busy) return;
    attempt.current ??= {
      key: crypto.randomUUID(),
      target,
      expectedRevision: record?.revision ?? 0,
      archived: !record?.archived,
    };
    setBusy(true);
    setError('');
    try {
      const saved = conversationVisibilitySchema.parse(
        await api('/conversations/visibility', attempt.current),
      );
      attempt.current = null;
      changed(saved);
      void refreshHome();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The connection was interrupted. Retry this same visibility request.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="chat-tool conversation-visibility-button"
        type="button"
        title={label}
        aria-label={label}
        disabled={busy}
        onClick={() => void submit()}
      >
        {restoring ? <ArchiveRestore size={17} /> : <Archive size={17} />}
        <span className="chat-tool-label">{restoring ? 'Restore' : 'Archive'}</span>
      </button>
      {error && (
        <Modal title={label} close={() => setError('')}>
          <p role="alert">{error}</p>
          <button
            className="flow-button"
            type="button"
            disabled={busy}
            onClick={() => void submit()}
          >
            Retry same request
          </button>
          <button
            className="flow-button"
            type="button"
            disabled={busy}
            onClick={() => {
              attempt.current = null;
              setError('');
              void refreshHome();
            }}
          >
            Inspect current visibility
          </button>
        </Modal>
      )}
    </>
  );
}
