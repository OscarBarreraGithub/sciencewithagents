import { useEffect, useRef, useState } from 'react';
import {
  localJobsStatusSchema,
  localResourcesSchema,
  type LocalJob,
  type LocalResources,
  type LocalJobsStatus,
} from '@dock/shared';
import { api, apiScope } from './api';
import { Modal } from './Modal';

export function LocalJobsPanel({
  close,
  projectId,
  embedded = false,
}: {
  close: () => void;
  projectId?: string;
  embedded?: boolean;
}) {
  const storageKey = `dock:local-transcription:${apiScope()}:${projectId ?? 'all'}`;
  const saved = useRef<{
    url?: string;
    resources?: LocalResources;
    pending?: { fingerprint: string; key: string };
  }>(
    (() => {
      try {
        return JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
      } catch {
        return {};
      }
    })(),
  );
  const [state, setState] = useState<LocalJobsStatus | null>(null);
  const [url, setUrl] = useState(typeof saved.current.url === 'string' ? saved.current.url : '');
  const [resources, setResources] = useState<LocalResources>(
    () =>
      localResourcesSchema.safeParse(saved.current.resources).data ??
      localResourcesSchema.parse({}),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<{
    id: string;
    text: string;
    nextOffset: number | null;
  } | null>(null);
  const pending = useRef<{ fingerprint: string; key: string } | null>(
    saved.current.pending ?? null,
  );
  const persist = (nextUrl = url) => {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ url: nextUrl, resources, pending: pending.current }),
      );
    } catch {
      throw new Error(
        'This browser cannot save a retry receipt. Enable browser storage before submitting a new transcription.',
      );
    }
  };
  useEffect(() => {
    try {
      persist();
    } catch {
      /* Submission shows an actionable error before sending. */
    }
  }, [url, resources]);
  const read = async () => {
    const value = localJobsStatusSchema.parse(await api('/local-jobs'));
    setState(value);
  };
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const value = localJobsStatusSchema.parse(await api('/local-jobs'));
        if (active) {
          setState(value);
          setError((previous) =>
            previous === 'Could not read local jobs. Reconnect and retry.' ? '' : previous,
          );
        }
      } catch {
        if (active) setError('Could not read local jobs. Reconnect and retry.');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const mutate = async (path: string, body: Record<string, unknown>) => {
    if (busy) return;
    const fingerprint = JSON.stringify({ path, body });
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      persist();
      await api(path, { ...body, key: pending.current.key });
      pending.current = null;
      if (path === '/local-jobs') setUrl('');
      persist(path === '/local-jobs' ? '' : url);
      await read();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not save this action. Check job status and retry.',
      );
    } finally {
      setBusy(false);
    }
  };
  const openTranscript = async (job: LocalJob, offset = 0) => {
    setBusy(true);
    setError('');
    try {
      const value = await api<{ text: string | null; nextOffset: number | null }>(
        '/local-jobs/read',
        { jobId: job.id, offset },
      );
      setTranscript((prior) => ({
        id: job.id,
        text: (offset && prior?.id === job.id ? prior.text : '') + (value.text ?? ''),
        nextOffset: value.nextOffset,
      }));
    } catch {
      setError('Could not load the transcript. Retry when connected.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Local video transcription" close={close} embedded={embedded}>
      <p>
        Paste a public YouTube video. Whisper transcribes on this computer, and QUARK makes room
        according to your priority.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p className="muted">{state?.setupMessage ?? 'Checking local tools…'}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void mutate('/local-jobs', { url, projectId: projectId ?? null, resources });
        }}
      >
        <label>
          YouTube video link
          <input
            type="url"
            required
            value={url}
            placeholder="https://www.youtube.com/watch?v=…"
            maxLength={2000}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Priority
          <select
            value={resources.priority}
            onChange={(e) =>
              setResources({ ...resources, priority: e.target.value as LocalResources['priority'] })
            }
            disabled={busy}
          >
            <option value="interactive">Do this soon — I’m waiting</option>
            <option value="high">High priority</option>
            <option value="normal">Normal</option>
            <option value="background">Background — spare capacity</option>
          </select>
        </label>
        <details>
          <summary>Computer budget and time estimate</summary>
          <div className="estimate-grid">
            <label>
              CPU cores
              <input
                type="number"
                min="1"
                max="8"
                value={resources.cpuCores}
                onChange={(e) => setResources({ ...resources, cpuCores: e.target.valueAsNumber })}
              />
            </label>
            <label>
              Memory estimate (MB)
              <input
                type="number"
                min="512"
                max="16384"
                value={resources.memoryMb}
                onChange={(e) => setResources({ ...resources, memoryMb: e.target.valueAsNumber })}
              />
            </label>
            <label>
              Expected minutes
              <input
                type="number"
                min="1"
                max="1440"
                value={resources.expectedSeconds / 60}
                onChange={(e) =>
                  setResources({ ...resources, expectedSeconds: e.target.valueAsNumber * 60 })
                }
              />
            </label>
          </div>
          <p className="muted">
            Estimates depend on video length and this computer. Transcription itself uses no Codex
            or Claude allowance.
          </p>
        </details>
        <button className="primary" disabled={busy || !url.trim()}>
          {busy ? 'Saving…' : 'Queue transcription'}
        </button>
      </form>
      {state?.jobs.map((job) => (
        <article className="pulsar-job" key={job.id}>
          <h3>
            {job.status === 'completed'
              ? 'Transcript ready'
              : job.status === 'paused'
                ? 'Transcription paused'
                : 'Video transcription'}
          </h3>
          <small>
            {job.resources.priority} · {job.status} · attempt {job.attempt}
          </small>
          <p>{job.message}</p>
          {job.expectedFinishAt && (
            <p className="muted">
              Estimated finish {new Date(job.expectedFinishAt).toLocaleTimeString()}. This is an
              estimate.
            </p>
          )}
          <div className="pulsar-actions">
            {['queued', 'running'].includes(job.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate('/local-jobs/control', { jobId: job.id, action: 'pause' })
                }
              >
                Pause transcription
              </button>
            )}
            {job.status === 'paused' && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate('/local-jobs/control', { jobId: job.id, action: 'resume' })
                }
              >
                Resume transcription
              </button>
            )}
            {['failed', 'interrupted'].includes(job.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate('/local-jobs/control', { jobId: job.id, action: 'retry' })
                }
              >
                Retry transcription
              </button>
            )}
            {['queued', 'paused'].includes(job.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate('/local-jobs/control', { jobId: job.id, action: 'override' })
                }
              >
                Use reserved computer capacity
              </button>
            )}
            {!['completed', 'cancelled'].includes(job.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate('/local-jobs/control', { jobId: job.id, action: 'cancel' })
                }
              >
                Cancel transcription
              </button>
            )}
            {job.transcriptAvailable && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void openTranscript(job)}
              >
                Read transcript
              </button>
            )}
          </div>
          {transcript?.id === job.id && (
            <>
              <pre className="draft-preview">{transcript.text}</pre>
              {transcript.nextOffset !== null && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void openTranscript(job, transcript.nextOffset!)}
                >
                  Read more transcript
                </button>
              )}
              <button
                className="secondary"
                onClick={() => {
                  const blob = new Blob([transcript.text], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `transcript-${job.id}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                disabled={transcript.nextOffset !== null}
              >
                Download complete transcript
              </button>
            </>
          )}
        </article>
      ))}
      {state?.jobs.length === 0 && <p>No local transcription jobs yet.</p>}
      <p className="muted">
        Only app-owned processes can be paused. Paused jobs keep their memory. After a computer
        restart, inspect interrupted jobs and choose Retry; no old process or command is replayed
        automatically.
      </p>
    </Modal>
  );
}
