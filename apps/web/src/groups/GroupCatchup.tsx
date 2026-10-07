import { useEffect, useRef, useState } from 'react';
import {
  groupCatchupPageSchema,
  groupCatchupAckSchema,
  type GroupCatchupPage,
} from '@dock/shared/dist/group-catchup.js';
import {
  groupEvidencePageSchema,
  groupEvidenceQuerySchema,
  groupEvidenceRequestSchema,
  type GroupEvidenceQuery,
  type GroupEvidencePage,
  type GroupEvidenceRecord,
} from '@dock/shared/dist/group-evidence.js';
import { groupUtf8Bytes, type GroupEvent } from '@dock/shared';
import './group-catchup.css';
import { api, apiScope } from '../api';

type QueryType = GroupEvidenceQuery['type'];
const queryLabels: Record<QueryType, string> = {
  offline_changes: 'What changed while I was away?',
  who_working: 'Who is working on what?',
  why_stopped: 'Why was this work stopped?',
  who_decided: 'Who decided this?',
  instruction_actions: 'Actions from my instruction',
  file_changes: 'What changed in this file?',
  unresolved: 'What remains unresolved?',
  autonomous_decisions: 'What did the manager decide autonomously?',
};
async function post(path: string, body: unknown): Promise<unknown> {
  return api(`/groups/${path}`, body);
}
/** Normal Groups entry owns opening this view with its host-issued authenticated handle.
 * Each page remains unread until the user explicitly chooses Mark this page read. */
export function GroupCatchup({
  handle,
  onClose,
  members = [],
}: {
  handle: string;
  onClose: () => void;
  members?: { id: string; name: string }[];
}) {
  const storageKey = `group-evidence:${apiScope()}:${location.origin}:${handle}`;
  const [page, setPage] = useState<GroupCatchupPage | null>(null);
  const [queryType, setQueryType] = useState<QueryType>('offline_changes');
  const [target, setTarget] = useState('');
  const [result, setResult] = useState<GroupEvidencePage | null>(null);
  const [savedQuery, setSavedQuery] = useState<ReturnType<
    typeof groupEvidenceRequestSchema.parse
  > | null>(null);
  const [lastQuery, setLastQuery] = useState<GroupEvidenceQuery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState<{ eventId: string; text: string } | null>(null);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    generation.current++;
    const current = generation.current;
    setBusy(true);
    setPage(null);
    setResult(null);
    setError('');
    setTarget('');
    setOriginal(null);
    setSavedQuery(null);
    setLastQuery(null);
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const request = groupEvidenceRequestSchema.parse(JSON.parse(saved));
        if (request.handle !== handle) throw new Error('scope');
        setSavedQuery(request);
        setLastQuery(request.query);
      }
    } catch {
      setError('Saved private query could not be read. Its saved data was preserved.');
    }
    heading.current?.focus();
    // Opening is a private read: the service retains a snapshot, without a
    // model call or advancing the explicit read acknowledgement. Defer until
    // after effect cleanup so StrictMode does not start two snapshot requests.
    void Promise.resolve().then(async () => {
      if (current !== generation.current) return;
      try {
        const value = groupCatchupPageSchema.parse(await post('catchup/start', { handle }));
        if (current === generation.current) setPage(value);
      } catch (e) {
        if (current === generation.current)
          setError(e instanceof Error ? e.message : 'Shared reading unavailable. Retry.');
      } finally {
        if (current === generation.current) setBusy(false);
      }
    });
    return () => {
      generation.current++;
    };
  }, [handle, storageKey]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : 'Shared reading unavailable. Retry.');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const readPage = async (path: string, body: unknown) => {
    const current = generation.current;
    const value = groupCatchupPageSchema.parse(await post(path, body));
    if (current === generation.current) {
      setPage(value);
      setOriginal(null);
    }
  };
  const start = () => run(() => readPage('catchup/start', { handle }));
  const ack = () =>
    run(async () => {
      if (!page) return;
      const current = generation.current;
      const receipt = groupCatchupAckSchema.parse(
        await post('catchup/ack', {
          handle,
          snapshotId: page.snapshotId,
          pageId: page.pageId,
          acknowledgementId: page.acknowledgementId,
        }),
      );
      if (
        receipt.pageId !== page.pageId ||
        receipt.snapshotId !== page.snapshotId ||
        receipt.acknowledgementId !== page.acknowledgementId ||
        receipt.through !== page.through ||
        receipt.watermark !== page.watermark
      )
        throw new Error('Read acknowledgement does not match this page. Retry the saved page.');
      if (current === generation.current) setPage({ ...page, acknowledged: true });
    });
  const next = () =>
    run(async () => {
      if (page?.acknowledged && page.continuation)
        await readPage('catchup/page', {
          handle,
          snapshotId: page.snapshotId,
          continuation: page.continuation,
        });
    });
  const events = page?.entries ?? [];
  const makeQuery = (): GroupEvidenceQuery => {
    switch (queryType) {
      case 'who_working':
        return groupEvidenceQuerySchema.parse({ type: queryType, memberId: target });
      case 'why_stopped':
        return groupEvidenceQuerySchema.parse({ type: queryType, subjectId: target });
      case 'who_decided':
        return groupEvidenceQuerySchema.parse({ type: queryType, eventId: target });
      case 'instruction_actions':
        return groupEvidenceQuerySchema.parse({ type: queryType, instructionEventId: target });
      case 'file_changes':
        return groupEvidenceQuerySchema.parse({ type: queryType, path: target });
      default:
        return { type: queryType };
    }
  };
  const readQuery = async (request: ReturnType<typeof groupEvidenceRequestSchema.parse>) => {
    const current = generation.current;
    try {
      localStorage.setItem(storageKey, JSON.stringify(request));
    } catch {
      throw new Error(
        'Private query identity could not be saved. Restore browser storage and retry.',
      );
    }
    setSavedQuery(request);
    setLastQuery(request.query);
    const value = groupEvidencePageSchema.parse(await post('evidence/query', request));
    if (current === generation.current) {
      setResult(value);
      setOriginal(null);
    }
  };
  const query = () =>
    run(async () => {
      let q: GroupEvidenceQuery;
      try {
        q = makeQuery();
      } catch {
        throw new Error('Choose an original source or enter an exact file path for this question.');
      }
      await readQuery({
        handle,
        queryId: crypto.randomUUID(),
        query: q,
        limit: 8,
        continuation: null,
      });
    });
  const resumeQuery = () =>
    run(async () => {
      if (savedQuery) await readQuery(savedQuery);
    });
  const more = () =>
    run(async () => {
      if (!savedQuery || !lastQuery || !result?.continuation) return;
      await readQuery({ ...savedQuery, query: lastQuery, continuation: result.continuation });
    });
  const readOriginal = (event: GroupEvent) =>
    run(async () => {
      const current = generation.current;
      const raw = (await post('evidence/original', { handle, eventId: event.eventId })) as {
        eventId?: unknown;
        text?: unknown;
      };
      if (
        raw.eventId !== event.eventId ||
        typeof raw.text !== 'string' ||
        groupUtf8Bytes(raw.text) !== event.manifest.bytes
      )
        throw new Error('Exact original failed verification.');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw.text));
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      if (hex !== event.manifest.sha256) throw new Error('Exact original failed verification.');
      if (current === generation.current) setOriginal({ eventId: event.eventId, text: raw.text });
    });
  const memberName = (id: string) =>
    members.find((m) => m.id === id)?.name ?? `Member ${id.slice(0, 8)}`;
  const renderRecord = ({ event, facts }: GroupEvidenceRecord) => (
    <li key={event.eventId} className="group-catchup-record">
      <p className="group-catchup-record-heading">
        <strong>{memberName(event.scope.memberId)}</strong>
        <span>{event.category}</span>
      </p>
      <p className="group-catchup-record-text">{event.condensedText}</p>
      <button type="button" disabled={busy} onClick={() => readOriginal(event)}>
        Read exact original
      </button>
      {original?.eventId === event.eventId && (
        <pre aria-label="Exact original">{original.text}</pre>
      )}
      <details>
        <summary>Original IDs and evidence</summary>
        <dl>
          <dt>Shared event</dt>
          <dd>
            {event.eventId} · position {event.sequence}
          </dd>
          <dt>Source message</dt>
          <dd>{event.scope.source.messageId}</dd>
          <dt>Causal references</dt>
          <dd>{event.scope.causalRefs.join(', ') || 'Unknown: no verified causal edge'}</dd>
          <dt>Evidence references</dt>
          <dd>{event.evidenceRefs.join(', ') || 'None recorded'}</dd>
        </dl>
        {facts ? (
          <>
            <p>
              Original source: {facts.sourceId} · version {facts.sourceVersion}
            </p>
            <dl>
              {Object.entries(facts.originalIds).map(([kind, id]) => (
                <div key={kind}>
                  <dt>{kind}</dt>
                  <dd>{id ?? 'Unknown'}</dd>
                </div>
              ))}
            </dl>
            <ul>
              {facts.edges.map((edge, i) => (
                <li key={i}>
                  {edge.fromId} → {edge.relation} → {edge.toId}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>Source-specific facts are not indexed; responsibility and causality remain unknown.</p>
        )}
      </details>
    </li>
  );
  const targets =
    queryType === 'who_working'
      ? members.length
        ? members.map((m) => ({ id: m.id, label: m.name }))
        : Array.from(new Set(events.map((e) => e.scope.memberId))).map((id) => ({
            id,
            label: memberName(id),
          }))
      : events
          .filter((e) =>
            queryType === 'who_decided'
              ? e.category === 'Decision'
              : queryType === 'instruction_actions'
                ? e.category === 'Instruction'
                : true,
          )
          .map((e) => ({
            id: queryType === 'why_stopped' ? e.entityId : e.eventId,
            label: e.condensedText.slice(0, 100),
          }));
  return (
    <section className="group-catchup" aria-labelledby="group-catchup-title" aria-busy={busy}>
      <header className="group-catchup-heading">
        <button type="button" onClick={onClose} aria-label="Back to chat">
          <span aria-hidden="true">←</span> Back
        </button>
        <h2 id="group-catchup-title" tabIndex={-1} ref={heading}>
          Private catch-up
        </h2>
      </header>
      <div className="group-catchup-scroll">
        <div className="group-catchup-inner">
          <p className="group-catchup-cue">Only you can see your reading and questions.</p>
          {error && <p role="alert">{error}</p>}
          {!page &&
            (busy ? (
              <p role="status">Loading shared updates…</p>
            ) : (
              <button type="button" onClick={start}>
                Retry catch-up
              </button>
            ))}
          {page && (
            <div className="group-catchup-page">
              <p role="status" className="group-catchup-position">
                {page.entries.length
                  ? `Positions ${page.after + 1}–${page.through} of snapshot ${page.watermark}`
                  : `No new shared events through position ${page.watermark}.`}
              </p>
              <ol aria-label="Catch-up page">
                {page.entries.map((event) =>
                  renderRecord({
                    event,
                    facts:
                      page.sourceFacts?.find((f) => f.eventId === event.eventId)?.facts ?? null,
                  }),
                )}
              </ol>
              <div className="group-catchup-actions">
                {page.entries.length > 0 && (
                  <button type="button" disabled={busy || page.acknowledged} onClick={ack}>
                    {page.acknowledged ? 'Page marked read' : 'Mark this page read'}
                  </button>
                )}
                {page.continuation && (
                  <button type="button" disabled={busy || !page.acknowledged} onClick={next}>
                    Continue catch-up
                  </button>
                )}
                {!page.continuation && page.acknowledged && (
                  <button type="button" disabled={busy} onClick={start}>
                    Check for newer changes
                  </button>
                )}
                {page.entries.length === 0 && (
                  <button type="button" disabled={busy} onClick={start}>
                    Check for newer changes
                  </button>
                )}
              </div>
            </div>
          )}
          <details className="group-catchup-query">
            <summary>Explore shared evidence</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void query();
              }}
            >
              <h3>Ask shared evidence privately</h3>
              <label>
                Question
                <select
                  aria-label="Question"
                  value={queryType}
                  disabled={busy}
                  onChange={(e) => {
                    setQueryType(e.target.value as QueryType);
                    setTarget('');
                  }}
                >
                  {Object.entries(queryLabels).map(([type, label]) => (
                    <option value={type} key={type}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {queryType === 'file_changes' ? (
                <label>
                  Exact group file path
                  <input
                    value={target}
                    disabled={busy}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="src/example.ts"
                  />
                </label>
              ) : (
                ['who_working', 'why_stopped', 'who_decided', 'instruction_actions'].includes(
                  queryType,
                ) && (
                  <label>
                    Original source
                    <select
                      aria-label="Original source"
                      disabled={busy}
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      <option value="">Choose a member or original from this page</option>
                      {targets.map((t, i) => (
                        <option key={`${t.id}:${i}`} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              )}
              <button disabled={busy} type="submit">
                Query evidence
              </button>
            </form>
            {savedQuery && (
              <button type="button" disabled={busy} onClick={resumeQuery}>
                Resume saved evidence query
              </button>
            )}
          </details>
          {result && (
            <div aria-label="Private evidence result">
              <p>Indexed shared sources through position {result.watermark}</p>
              {result.unknown.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
              <ol>{result.records.map(renderRecord)}</ol>
              {result.continuation && (
                <button disabled={busy} type="button" onClick={more}>
                  Continue evidence query
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
