import { useEffect, useRef, useState } from 'react';
import { withoutChatAttachments } from '@dock/shared';
import { Modal } from './Modal';
import './PromptHistory.css';
import { useBackStep } from './home/Navigation';

export type PromptPage<T> = {
  value: T;
  prompts: { id: string; text: string; createdAt?: string }[];
  before?: string;
};

/** One retained conversation page per click; never fetch the full prompt list. */
export function PromptHistory<T>({
  read,
  choose,
  close,
}: {
  read: (before?: string) => Promise<PromptPage<T>>;
  choose: (value: T, id: string, newer: (string | undefined)[]) => void;
  close: () => void;
}) {
  useBackStep(close);
  const [page, setPage] = useState<PromptPage<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [positions, setPositions] = useState<(string | undefined)[]>([undefined]);
  const request = useRef(0);
  const attempted = useRef<(string | undefined)[]>([undefined]);
  const readRef = useRef(read);
  readRef.current = read;

  async function load(next: (string | undefined)[]) {
    attempted.current = next;
    const current = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = await readRef.current(next[next.length - 1]);
      if (current !== request.current) return;
      setPage(result);
      setPositions(next);
    } catch (cause) {
      if (current === request.current)
        setError(
          cause instanceof Error ? cause.message : 'Could not read your prompts. Try again.',
        );
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  useEffect(() => {
    void load([undefined]);
    return () => {
      request.current++;
    };
  }, []);

  return (
    <Modal title="Your prompts" close={close} className="prompt-history-dialog">
      <p className="muted">Choose a prompt to see the conversation around it.</p>
      {busy && <p role="status">Reading your prompts…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void load(attempted.current)}
          >
            Try again
          </button>
        </div>
      )}
      {page && (
        <>
          <ol className="prompt-history-list" aria-label="Saved prompts" aria-busy={busy}>
            {[...page.prompts].reverse().map((prompt) => {
              const text = withoutChatAttachments(prompt.text).replace(/\s+/g, ' ').trim();
              return (
                <li key={prompt.id}>
                  <button
                    className="prompt-history-choice"
                    disabled={busy}
                    onClick={() => choose(page.value, prompt.id, positions.slice(0, -1))}
                  >
                    {prompt.createdAt && (
                      <time dateTime={prompt.createdAt}>
                        {new Date(prompt.createdAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </time>
                    )}
                    <span>
                      {text ? `${text.slice(0, 240)}${text.length > 240 ? '…' : ''}` : 'Attachment'}
                    </span>
                    <span className="prompt-history-open">View conversation</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {!page.prompts.length && !busy && (
            <p className="muted">
              {page.before
                ? 'No prompts on this page. Try Older prompts.'
                : 'No prompts on this page.'}
            </p>
          )}
          <nav className="prompt-history-pages" aria-label="Prompt pages">
            {positions.length > 1 && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void load(positions.slice(0, -1))}
              >
                Newer prompts
              </button>
            )}
            {page.before && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void load([...positions, page.before])}
              >
                Older prompts
              </button>
            )}
          </nav>
        </>
      )}
    </Modal>
  );
}

export function scrollToPrompt(container: HTMLElement, id: string) {
  const target = Array.from(container.querySelectorAll<HTMLElement>('[data-prompt-id]')).find(
    (element) => element.dataset.promptId === id,
  );
  if (!target) return;
  container.scrollTop +=
    target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
}
