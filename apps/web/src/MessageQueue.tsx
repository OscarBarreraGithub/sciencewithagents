import './MessageQueue.css';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ListOrdered, Maximize2 } from 'lucide-react';
import { Modal } from './Modal';

/** Displays provider-acknowledged or durable scheduled messages, never local send guesses.
 * Closed, it is one summary row so the conversation keeps its height; the full-height
 * dialog opens on demand. Opening or closing it never changes the queue or a held edit. */
export function MessageQueue({
  messages,
  hasMore = false,
  error,
  actions,
  detail,
  alert,
}: {
  messages: readonly { id: string; text: string }[];
  hasMore?: boolean;
  error?: 'unsupported' | 'unavailable';
  actions?: (id: string) => ReactNode;
  /** Short state shown in the closed summary, such as held or uncertain items. */
  detail?: string;
  /** Receipts and failures follow the open dialog so they are never hidden behind it. */
  alert?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!messages.length && !hasMore && !error) setExpanded(false);
  }, [messages.length, hasMore, error]);
  if (!messages.length && !hasMore && !error)
    return alert ? <div className="message-queue">{alert}</div> : null;
  const summary =
    error && !messages.length
      ? 'Queue unavailable'
      : [
          // The count leads so a narrow or zoomed row still shows it.
          `${messages.length}${hasMore ? '+' : ''} queued message${messages.length === 1 && !hasMore ? '' : 's'}`,
          detail,
          error && 'native queue unavailable',
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <>
      <div className="message-queue">
        <button
          type="button"
          className="message-queue-summary"
          aria-haspopup="dialog"
          onClick={() => setExpanded(true)}
        >
          <ListOrdered size={16} aria-hidden="true" />
          <span className="message-queue-status">{summary}</span>
          <span className="message-queue-open">
            <Maximize2 size={15} aria-hidden="true" /> <span>Expand queue</span>
          </span>
        </button>
        {!expanded && alert}
      </div>
      {expanded && (
        <Modal
          title="Queued messages"
          className="message-queue-dialog"
          close={() => setExpanded(false)}
        >
          {error && (
            <p className="message-queue-more" role="status">
              {error === 'unsupported'
                ? 'This provider version does not expose its native queue.'
                : 'Queued messages could not be read. The queue may still contain messages; reconnecting automatically.'}
            </p>
          )}
          {!actions && <p>Native queued messages stay under the editor’s control.</p>}
          {alert}
          {messages.length > 0 && (
            <ol aria-label="Queued messages" tabIndex={0}>
              {messages.map((message) => (
                <li key={message.id}>
                  <QueueMessagePreview text={message.text} />
                  {actions?.(message.id)}
                </li>
              ))}
            </ol>
          )}
          {hasMore && (
            <p className="message-queue-more">
              More messages are queued. View the full queue in the native app.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

/** Full text stays available without pushing the next item's actions out of reach. */
function QueueMessagePreview({ text }: { text: string }) {
  const preview = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = preview.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p ref={preview} className={expanded ? undefined : 'message-queue-preview'}>
        {text}
      </p>
      {(clipped || expanded) && (
        <button
          type="button"
          className="subtle message-queue-read"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Collapse text' : 'Read full text'}
        </button>
      )}
    </>
  );
}
