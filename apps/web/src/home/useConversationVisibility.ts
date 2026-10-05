import { useEffect, useRef, useState } from 'react';
import {
  conversationVisibilityIdentity,
  conversationVisibilityPageSchema,
  type ConversationVisibility,
} from '@dock/shared';
import { api } from '../api';
import { trackRefresh } from './refreshHome';

/** Read the complete typed index before replacing list visibility or Home counts. */
export function useConversationVisibility() {
  const [data, setData] = useState<ConversationVisibility[] | null>(null);
  const [error, setError] = useState('');
  const retry = useRef<() => void>(() => {});
  const merge = (records: ConversationVisibility[]) =>
    setData((previous) => {
      const next = new Map(
        (previous ?? []).map((record) => [conversationVisibilityIdentity(record.target), record]),
      );
      for (const record of records) {
        const identity = conversationVisibilityIdentity(record.target);
        if (record.revision >= (next.get(identity)?.revision ?? 0)) next.set(identity, record);
      }
      return [...next.values()];
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
            cursor = page.nextCursor;
            if (cursor && (cursors.has(cursor) || cursors.size >= 1000))
              throw new Error('The archived conversation index could not be read completely.');
            if (cursor) cursors.add(cursor);
          } while (cursor);
          if (alive) {
            merge(records);
            setError('');
          }
          return true;
        } catch {
          if (alive)
            setError(
              'Could not read archived conversations. Your saved visibility has not changed.',
            );
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
    retry: () => retry.current(),
    changed: (record: ConversationVisibility) => merge([record]),
  };
}
