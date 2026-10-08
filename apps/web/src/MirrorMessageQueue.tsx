import { useEffect, useRef, useState } from 'react';
import {
  mirrorQueuedActionSchema,
  mirrorQueuedMessageSchema,
  mirrorQueuedMessagesSchema,
  mirrorQueuedReceiptSchema,
  promptTextLimit,
  type MirrorQueuedMessage,
  type MirrorState,
} from '@dock/shared';
import { api, apiScope } from './api';
import {
  EditableMessageQueue,
  type EditableQueuedMessage,
  type QueuedMessageOperations,
} from './EditableMessageQueue';
import {
  queuedActionRecoveries,
  clearQueuedAction,
  rememberQueuedAction,
} from './queued-action-recovery';

/** App-owned follow-ups are separate from messages already in the native editor queue. */
export function MirrorMessageQueue({
  provider,
  threadId,
  canSteer,
  nativeQueue,
}: {
  provider: 'codex' | 'claude';
  threadId: string;
  canSteer: boolean;
  nativeQueue: Pick<MirrorState, 'queuedMessages' | 'queueHasMore' | 'queueReadError'> | null;
}) {
  const scope = useRef(apiScope()).current;
  const identity = `${provider}:${threadId}`;
  const recoveryKey = `mirror:${identity}`;
  const [items, setItems] = useState<EditableQueuedMessage[]>([]);
  const [error, setError] = useState('');
  const reload = useRef<() => void>(() => {});
  const row = (item: MirrorQueuedMessage): EditableQueuedMessage => {
    if (item.provider !== provider || item.threadId !== threadId)
      throw new Error('This queued message belongs to another conversation. Reopen its chat.');
    return {
      ...item,
      queueEditable:
        item.status === 'queued' ||
        (item.status === 'uncertain' && item.queueEdit?.state === 'steering'),
    };
  };
  const operations: QueuedMessageOperations = {
    recoveries: () => queuedActionRecoveries(recoveryKey, mirrorQueuedActionSchema.parse),
    clear: (saved) => clearQueuedAction(recoveryKey, saved),
    submit: async (id, raw) => {
      const input = mirrorQueuedActionSchema.parse(raw);
      rememberQueuedAction(recoveryKey, id, input);
      const result = row(mirrorQueuedMessageSchema.parse(await api(`/vscode/queued/${id}`, input)));
      clearQueuedAction(recoveryKey, { messageId: id, input });
      if (input.action === 'remove')
        for (const saved of operations.recoveries())
          if (saved.messageId === id) operations.clear(saved);
      reload.current();
      return result;
    },
    inspect: async (id, key) => {
      const result = mirrorQueuedReceiptSchema.parse(
        await api(`/vscode/queued/${id}/receipts/${key}`),
      );
      reload.current();
      return { status: result.status, message: row(result.item) };
    },
    read: async (id) => row(mirrorQueuedMessageSchema.parse(await api(`/vscode/queued/${id}`))),
  };
  useEffect(() => {
    let alive = true;
    let reading = false;
    const controller = new AbortController();
    const read = async () => {
      if (reading || !alive) return;
      reading = true;
      try {
        if (apiScope() !== scope)
          throw new Error('Reopen the original computer to read this queue.');
        const query = new URLSearchParams({ provider, threadId });
        const saved = mirrorQueuedMessagesSchema.parse(
          await api(`/vscode/queued?${query}`, undefined, controller.signal),
        );
        const next = saved.items.map(row);
        if (alive) {
          setItems(next);
          setError('');
        }
      } catch (reason) {
        if (alive)
          setError(
            reason instanceof Error ? reason.message : 'Queued follow-ups could not be read.',
          );
      } finally {
        reading = false;
      }
    };
    reload.current = () => {
      void read();
    };
    void read();
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 1500);
    const updated = (event: Event) => {
      if ((event as CustomEvent).detail === identity) void read();
    };
    window.addEventListener('dock:mirror-queue', updated);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('dock:mirror-queue', updated);
    };
  }, [scope, provider, threadId, identity]);
  return (
    <div className="mirror-app-queue">
      <EditableMessageQueue
        target={{
          id: threadId,
          name: provider === 'claude' ? 'Claude Code' : 'Codex',
          canSteer: provider === 'codex' && canSteer,
          maxLength: promptTextLimit,
        }}
        messages={[
          ...items,
          ...(nativeQueue?.queuedMessages ?? []).map((item) => ({
            ...item,
            id: `native:${item.id}`,
            status: 'queued',
            queueEditable: false,
            message: 'Native editor queue · edit this message in the editor.',
          })),
        ]}
        operations={operations}
        hasMore={nativeQueue?.queueHasMore}
        queueError={nativeQueue?.queueReadError}
      />
      {error && (
        <p className="message-queue-more" role="alert">
          {error}{' '}
          <button type="button" className="subtle" onClick={() => reload.current()}>
            Retry queue read
          </button>
        </p>
      )}
    </div>
  );
}
