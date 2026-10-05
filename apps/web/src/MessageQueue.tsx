import './MessageQueue.css';
import { useEffect, useState, type ReactNode } from 'react';
import { Maximize2 } from 'lucide-react';
import { Modal } from './Modal';

/** Displays provider-acknowledged or durable scheduled messages, never local send guesses. */
export function MessageQueue({
  messages,
  hasMore = false,
  error,
  actions,
}: {
  messages: readonly { id: string; text: string }[];
  hasMore?: boolean;
  error?: 'unsupported' | 'unavailable';
  actions?: (id: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!messages.length && !hasMore && !error) setExpanded(false);
  }, [messages.length, hasMore, error]);
  if (!messages.length && !hasMore && !error) return null;
  const list = () => (
    <ol aria-label="Queued messages" tabIndex={0}>
      {messages.map((message) => (
        <li key={message.id}>
          <p>{message.text}</p>
          {actions?.(message.id)}
        </li>
      ))}
    </ol>
  );
  return (
    <>
      <details className="message-queue" open>
        <summary>
          {error ? (
            'Queue unavailable'
          ) : (
            <>
              Queued messages · {messages.length}
              {hasMore ? '+' : ''}
            </>
          )}
        </summary>
        {messages.length > 0 && (
          <button
            className="subtle message-queue-expand"
            type="button"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 size={15} /> Expand queue
          </button>
        )}
        {error && (
          <p className="message-queue-more" role="status">
            {error === 'unsupported'
              ? 'This provider version does not expose its native queue.'
              : 'Queued messages could not be read. The queue may still contain messages; reconnecting automatically.'}
          </p>
        )}
        {messages.length > 0 && list()}
        {hasMore && (
          <p className="message-queue-more">
            More messages are queued. View the full queue in the native app.
          </p>
        )}
      </details>
      {expanded && (
        <Modal
          title="Queued messages"
          className="message-queue-dialog"
          close={() => setExpanded(false)}
        >
          {!actions && <p>Native queued messages stay under the editor’s control.</p>}
          {list()}
          {hasMore && <p>More messages are available in the native app.</p>}
        </Modal>
      )}
    </>
  );
}
