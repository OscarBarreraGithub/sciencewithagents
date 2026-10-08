import { useEffect, useRef, useState } from 'react';
import { arxivImportRequestSchema, type ArxivImport, type SavedDocument } from '@dock/shared';
import { api, apiScope, ApiError, connectionLost } from './api';
import { arxivImportResponseSchema } from './document-responses';

const pendingSchema = arxivImportRequestSchema.extend({
  id: arxivImportRequestSchema.shape.key.optional(),
});
type Pending = ReturnType<typeof pendingSchema.parse>;

export function ArxivImportForm({ onReady }: { onReady: (document: SavedDocument) => void }) {
  const storageKey = `dock:arxiv:${apiScope()}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return pendingSchema.parse(JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'));
    } catch {
      return null;
    }
  });
  const [link, setLink] = useState(pending?.link ?? '');
  const [job, setJob] = useState<ArxivImport | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [retry, setRetry] = useState(0);
  const callback = useRef(onReady);
  callback.current = onReady;
  const submission = useRef<AbortController | null>(null);
  const save = (value: Pending | null) => {
    setPending(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Import and retry still work for this visit when browser storage is unavailable.
    }
  };
  const receive = (value: ArxivImport) => {
    setJob(value);
    if (value.state === 'ready' && value.document) {
      save(null);
      callback.current(value.document);
    } else if (value.state === 'failed') save(null);
  };
  useEffect(() => () => submission.current?.abort(), []);
  useEffect(() => {
    if (!pending?.id) return;
    const abort = new AbortController();
    const id = pending.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setChecking(true);
    setError('');
    const read = async () => {
      try {
        const value = arxivImportResponseSchema.parse(
          await api(`/documents/arxiv/${id}`, undefined, abort.signal),
        );
        if (abort.signal.aborted) return;
        receive(value);
        if (value.state === 'queued' || value.state === 'fetching') timer = setTimeout(read, 1200);
        else setChecking(false);
      } catch (error) {
        if (abort.signal.aborted) return;
        setChecking(false);
        setError(
          error instanceof ApiError && !connectionLost(error)
            ? error.message
            : 'Import progress could not be read. Check again when connected.',
        );
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pending?.id, retry]);
  async function submit() {
    if (sending || checking || !link.trim()) return;
    if (pending?.id) {
      setRetry((value) => value + 1);
      return;
    }
    const attempt =
      pending?.link === link.trim() ? pending : { key: crypto.randomUUID(), link: link.trim() };
    save(attempt); // A lost acknowledgement retries the same durable operation.
    setSending(true);
    setError('');
    setJob(null);
    const abort = new AbortController();
    submission.current = abort;
    try {
      const value = arxivImportResponseSchema.parse(
        await api('/documents/arxiv', attempt, abort.signal),
      );
      if (abort.signal.aborted) return;
      receive(value);
      if (value.state === 'queued' || value.state === 'fetching')
        save({ ...attempt, id: value.id });
    } catch (error) {
      if (!abort.signal.aborted)
        setError(
          error instanceof ApiError && !connectionLost(error)
            ? error.status === 404
              ? 'arXiv import is unavailable on this computer. Update the app and try again.'
              : error.message
            : 'The import may still be running. Retry to check it when connected.',
        );
    } finally {
      if (!abort.signal.aborted) setSending(false);
    }
  }
  const failure = error || (job?.state === 'failed' ? job.message : '');
  return (
    <form
      className="arxiv-import"
      aria-label="Open an arXiv paper"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        Open an arXiv paper
        <input
          aria-label="arXiv link or ID"
          placeholder="arxiv.org/abs/2401.12345 or arXiv ID"
          maxLength={2048}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={link}
          disabled={sending || checking}
          onChange={(event) => {
            setLink(event.target.value);
            setError('');
            setJob(null);
            save(null);
          }}
        />
      </label>
      <button className="flow-button primary" disabled={sending || checking || !link.trim()}>
        {sending || checking
          ? 'Opening…'
          : pending?.id
            ? 'Check again'
            : failure || pending
              ? 'Retry import'
              : 'Open paper'}
      </button>
      {(sending || checking) && <p role="status">{job?.message ?? 'Requesting import…'}</p>}
      {!sending && !checking && pending && !pending.id && !failure && (
        <p role="status">Import may still be running. Retry to check it.</p>
      )}
      {failure && <p role="alert">{failure}</p>}
    </form>
  );
}
