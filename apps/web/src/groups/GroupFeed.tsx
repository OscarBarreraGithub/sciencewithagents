import { useEffect, useRef, useState } from 'react';
import {
  GROUP_LIMITS,
  groupCategorySchema,
  groupFeedPageSchema,
  type GroupEvent,
  type GroupFeedEntry,
  type GroupFeedCursor,
} from '@dock/shared';
import { DisplayName } from './DisplayName';
import type { GroupRead, GroupsWorkspaceProps } from './types';

type Props = Pick<GroupsWorkspaceProps, 'group' | 'members' | 'loadPage' | 'loadOriginal'> & {
  onRevoked: (message: string) => void;
  refreshable?: boolean;
};
const failure = (reason: unknown): GroupRead<never> => ({
  kind: 'error',
  message: reason instanceof Error ? reason.message : 'Could not load this evidence. Try again.',
});
function Original({
  event,
  loadOriginal,
  onRevoked,
}: Pick<Props, 'loadOriginal' | 'onRevoked'> & { event: GroupEvent }) {
  const [reading, setReading] = useState<GroupRead<string> | { kind: 'loading' }>({
    kind: 'loading',
  });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setReading({ kind: 'loading' });
    void loadOriginal(event, controller.signal)
      .then(async (result) => {
        if (!alive) return;
        if (result.kind === 'revoked') {
          onRevoked(result.message);
          return;
        }
        if (result.kind !== 'ready') {
          setReading(result);
          return;
        }
        const bytes = new TextEncoder().encode(result.value.text);
        if (
          result.value.eventId !== event.eventId ||
          bytes.length > GROUP_LIMITS.payloadBytes ||
          bytes.length !== event.manifest.bytes
        )
          throw new Error('The source did not match this event or its original byte count.');
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        if (!alive) return;
        if (digest !== event.manifest.sha256)
          throw new Error('The original evidence failed its integrity check. Retry the source.');
        setReading({ kind: 'ready', value: result.value.text });
      })
      .catch((reason: unknown) => {
        if (alive) setReading(failure(reason));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [event, loadOriginal, onRevoked, attempt]);
  return (
    <div className="groups-original">
      {reading.kind === 'loading' ? (
        <p role="status">Loading exact original…</p>
      ) : reading.kind === 'ready' ? (
        <pre dir="auto" aria-label="Exact original">
          {reading.value}
        </pre>
      ) : (
        <div role="status">
          <p>{reading.message}</p>
          <button onClick={() => retry((n) => n + 1)}>Retry original</button>
        </div>
      )}
    </div>
  );
}
export function GroupFeed({
  group,
  members,
  loadPage,
  loadOriginal,
  onRevoked,
  refreshable = false,
}: Props) {
  const [{ entries, windowed }, setFeed] = useState<{
    entries: GroupFeedEntry[];
    windowed: boolean;
  }>({
    entries: [],
    windowed: false,
  });
  const [cursor, setCursor] = useState<GroupFeedCursor | null>(null);
  const [reading, setReading] = useState<GroupRead<null> | { kind: 'loading' }>({
    kind: 'loading',
  });
  const [filter, setFilter] = useState<GroupEvent['category'] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const next = useRef<GroupFeedCursor | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setReading({ kind: 'loading' });
    void loadPage(
      { visibility: 'shared', limit: 20, after: 0, cursor: next.current },
      controller.signal,
    )
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'revoked') {
          onRevoked(result.message);
          return;
        }
        if (result.kind !== 'ready') {
          setReading(result);
          return;
        }
        const page = groupFeedPageSchema.parse(result.value);
        if (
          page.entries.some(
            (entry) => entry.scope.groupId !== group.id || entry.scope.visibility !== 'shared',
          ) ||
          (page.continuation && page.continuation.visibility !== 'shared')
        )
          throw new Error('The page did not belong to this shared group.');
        if (
          next.current &&
          (page.watermark !== next.current.watermark ||
            (page.continuation && page.continuation.scopeKey !== next.current.scopeKey))
        )
          throw new Error('The feed snapshot changed. Reopen the group to start a fresh reading.');
        if (next.current && page.entries.some((entry) => entry.sequence <= next.current!.after))
          throw new Error('The next page repeated an earlier position. Retry the page.');
        setFeed((previous) => {
          const ids = new Set(previous.entries.map((entry) => entry.eventId));
          const combined = [
            ...previous.entries,
            ...page.entries.filter((entry) => !ids.has(entry.eventId)),
          ];
          return {
            entries: combined.slice(-200),
            windowed: previous.windowed || combined.length > 200,
          };
        });
        setCursor(page.continuation);
        setReading({ kind: 'ready', value: null });
      })
      .catch((reason: unknown) => {
        if (alive) setReading(failure(reason));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [request, group.id, loadPage, onRevoked]);
  const shown = entries.filter((entry) => !filter || entry.category === filter);
  return (
    <div className="groups-feed-scroll" tabIndex={0} aria-label="Shared feed entries">
      <div className="groups-feed-chrome">
        <header className="groups-panel-heading">
          <h2>Shared feed</h2>
          <p>What members asked, decided and changed. Talk to your agent in chat.</p>
          {refreshable && (
            <button
              onClick={() => {
                next.current = null;
                setCursor(null);
                setFeed({ entries: [], windowed: false });
                setOpen(null);
                setRequest((n) => n + 1);
              }}
            >
              Refresh shared feed
            </button>
          )}
        </header>
        <div className="groups-filters" aria-label="Feed categories">
          {groupCategorySchema.options.map((category) => (
            <button
              key={category}
              aria-pressed={category === filter}
              onClick={() => setFilter(filter === category ? null : category)}
            >
              {category}
            </button>
          ))}
        </div>
      </div>
      {filter && <p role="status">{filter} selected · press again to show every category.</p>}
      {windowed && <p>Showing the latest 200 loaded entries.</p>}
      {shown.map((entry) => (
        <article key={entry.eventId} data-event-id={entry.eventId} className="groups-event">
          <div className="groups-event-meta">
            <span>{entry.category}</span>
            <DisplayName
              value={
                entry.origin?.displayName ??
                members.find(
                  (member) =>
                    member.groupId === group.id && member.memberId === entry.scope.memberId,
                )?.displayName ??
                'Unknown member'
              }
            />
            <time dateTime={entry.recordedAt}>
              {new Date(entry.recordedAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </div>
          <p>{entry.condensedText}</p>
          {entry.origin && (
            <p className="groups-event-provenance">
              Original {entry.origin.kind} source · condensed by{' '}
              {members.find((m) => m.installationId === entry.origin!.writerId)?.displayName ??
                'the designated group writer'}
            </p>
          )}
          <button
            className="groups-source-button"
            aria-expanded={open === entry.eventId}
            onClick={() => setOpen(open === entry.eventId ? null : entry.eventId)}
          >
            {open === entry.eventId ? 'Close original' : 'Read exact original'}
          </button>
          {open === entry.eventId && (
            <>
              <Original event={entry} loadOriginal={loadOriginal} onRevoked={onRevoked} />
              <details>
                <summary>Evidence and causal references</summary>
                <p>
                  Event <code>{entry.eventId}</code> · revision {entry.revision}
                </p>
                <p>
                  Source message <code>{entry.scope.source.messageId}</code>
                </p>
                {entry.origin && (
                  <p>
                    Original source <code>{entry.origin.scope.source.messageId}</code> · version{' '}
                    {entry.origin.key.version}. Writer source remains distinct.
                  </p>
                )}
                <p>
                  Causal events:{' '}
                  {entry.scope.causalRefs.length
                    ? entry.scope.causalRefs.join(', ')
                    : 'None recorded'}
                </p>
                <p>
                  Evidence events:{' '}
                  {entry.evidenceRefs.length ? entry.evidenceRefs.join(', ') : 'None recorded'}
                </p>
                {entry.corrects && <p>Corrects event: {entry.corrects}</p>}
              </details>
            </>
          )}
        </article>
      ))}
      {reading.kind === 'loading' ? (
        <p role="status">Loading shared events…</p>
      ) : reading.kind !== 'ready' ? (
        <div role="status">
          <p>
            {reading.kind === 'offline' ? 'Offline. ' : ''}
            {reading.message}
          </p>
          <button onClick={() => setRequest((n) => n + 1)}>Retry feed</button>
        </div>
      ) : (
        <>
          {shown.length === 0 && (
            <p>{filter ? 'No matching events in the loaded pages.' : 'No shared events yet.'}</p>
          )}
          {cursor && (
            <button
              className="groups-load"
              onClick={() => {
                next.current = cursor;
                setRequest((n) => n + 1);
              }}
            >
              Load more events
            </button>
          )}
        </>
      )}
    </div>
  );
}
