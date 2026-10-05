import './MessageQueue.css';

/** Displays provider-acknowledged or durable scheduled messages, never local send guesses. */
export function MessageQueue({
  messages,
  hasMore = false,
  error,
}: {
  messages: readonly { id: string; text: string }[];
  hasMore?: boolean;
  error?: 'unsupported' | 'unavailable';
}) {
  if (!messages.length && !hasMore && !error) return null;
  return (
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
      {error && (
        <p className="message-queue-more" role="status">
          {error === 'unsupported'
            ? 'This provider version does not expose its native queue.'
            : 'Queued messages could not be read. The queue may still contain messages; reconnecting automatically.'}
        </p>
      )}
      {messages.length > 0 && (
        <ol aria-label="Queued messages" tabIndex={0}>
          {messages.map((message) => (
            <li key={message.id}>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      )}
      {hasMore && (
        <p className="message-queue-more">
          More messages are queued. View the full queue in the native app.
        </p>
      )}
    </details>
  );
}
