import { useEffect, useRef, useState } from 'react';
import {
  conversationVisibilityIdentity,
  conversationVisibilityPageSchema,
  type ConversationVisibility,
} from '@dock/shared';
import { api, apiScope, ApiError } from '../api';
import { trackRefresh } from './refreshHome';

// Retain confirmed metadata across Home/Chats mounts in this document, scoped to its host.
const known = new Map<string, ConversationVisibility[]>();
export const archiveUnavailable =
  'Archiving is not available on this computer yet. Chats and drafts are still available.';

/** Read the complete typed index before replacing list visibility or Home counts. */
export function useConversationVisibility() {
  const scope = apiScope();
  const [data, setData] = useState<ConversationVisibility[] | null>(() => known.get(scope) ?? null);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [available, setAvailable] = useState(false);
  const retry = useRef<() => void>(() => {});
  const merge = (records: ConversationVisibility[]) =>
    setData((previous) => {
      const next = new Map(
        (known.get(scope) ?? previous ?? []).map((record) => [
          conversationVisibilityIdentity(record.target),
          record,
        ]),
      );
      for (const record of records) {
        const identity = conversationVisibilityIdentity(record.target);
        if (record.revision >= (next.get(identity)?.revision ?? 0)) next.set(identity, record);
      }
      const saved = [...next.values()];
      known.set(scope, saved);
      return saved;
    });
  useEffect(() => {
    let alive = true;
    let pending: Promise<boolean> | null = null;
    let controller: AbortController | undefined;
    const read = () => {
      if (pending) return pending;
      controller = new AbortController();
      const signal = controller.signal;
      pending = (async () => {
        let pages = 0;
        try {
          const records: ConversationVisibility[] = [];
          const cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const page: { records: ConversationVisibility[]; nextCursor: string | null } =
              conversationVisibilityPageSchema.parse(
                await api(
                  `/conversations/visibility${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
                  undefined,
                  signal,
                ),
              );
            records.push(...page.records);
            pages++;
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 1000))
              throw new Error('The archived conversation index could not be read completely.');
            if (cursor) cursors.add(cursor);
          } while (cursor);
          if (alive) {
            merge(records);
            setError('');
            setUnsupported(false);
            setAvailable(true);
          }
          return true;
        } catch (reason) {
          if (alive) {
            setAvailable(false);
            // Only an explicit JSON refusal of the first page proves this optional route
            // absent. A tunnel's HTML 404, auth error or failed later page proves nothing.
            const absent =
              pages === 0 &&
              reason instanceof ApiError &&
              [404, 501].includes(reason.status) &&
              reason.code !== 'INTERRUPTED';
            setUnsupported(absent);
            if (absent) {
              setData((previous) => previous ?? known.get(scope) ?? []);
              setError('');
            } else
              setError(
                'Could not read archived conversations. Your saved visibility has not changed.',
              );
          }
          return false;
        } finally {
          pending = null;
        }
      })();
      return pending;
    };
    const refresh = () => {
      if (!document.hidden) void read();
    };
    const requested = (event: Event) => trackRefresh(event, read());
    retry.current = () => void read();
    void read();
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('swa:refresh-home', requested);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('swa:refresh-home', requested);
    };
  }, []);
  return {
    data,
    error,
    unsupported,
    unavailable: available
      ? undefined
      : unsupported
        ? archiveUnavailable
        : 'Read conversation visibility before changing its archive status.',
    retry: () => retry.current(),
    changed: (record: ConversationVisibility) => merge([record]),
  };
}
