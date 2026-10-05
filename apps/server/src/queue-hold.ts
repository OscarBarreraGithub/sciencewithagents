import type { QueuedMessageAction } from '@dock/shared';
import { Conflict } from './store.js';

/** Shared atomic revision/client checks for app-owned managed and native-chat outboxes. */
export function requireQueueHold(
  run: { queueRevision?: number; queueEdit?: { clientId: string; state: string } | null },
  input: QueuedMessageAction,
) {
  if (input.revision !== run.queueRevision)
    throw new Conflict(
      'This queued message changed on another tab or device. Reopen it before editing.',
      'QUEUE_CHANGED',
    );
  if (run.queueEdit?.state === 'steering' && input.text !== undefined)
    throw new Conflict('The steering outcome is uncertain. Its submitted text cannot be changed.');
  if (['edit', 'takeover'].includes(input.action)) {
    if (input.action !== 'takeover' && run.queueEdit && run.queueEdit.clientId !== input.clientId)
      throw new Conflict(
        'This message is held by another browser. Its saved draft is retained.',
        'QUEUE_HELD',
      );
    if (run.queueEdit?.state === 'steering' && input.action !== 'takeover')
      throw new Conflict(
        'The steering outcome is uncertain. Inspect the running reply; this item remains held.',
      );
  } else if (!run.queueEdit || run.queueEdit.clientId !== input.clientId) {
    throw new Conflict('Hold this message for editing before changing or sending it.');
  } else if (run.queueEdit.state !== 'editing' && input.action !== 'remove') {
    throw new Conflict(
      'The steering outcome is uncertain. This item remains held and will not be resent.',
    );
  }
}
