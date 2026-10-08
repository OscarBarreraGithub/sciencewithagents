import { useEffect, useRef, useState } from 'react';
import {
  GROUP_LIMITS,
  groupFeedPageSchema,
  latestGroupFeedEntries,
  type GroupFeedCursor,
  type GroupFeedEntry,
} from '@dock/shared';
import type { GroupRead, GroupsWorkspaceProps } from './types';

export type GroupMessageReader = Pick<
  GroupsWorkspaceProps,
  'loadPage' | 'loadOriginal' | 'members'
>;
export type SharedGroupMessage = { event: GroupFeedEntry; text: string };

/** Read the shared service's exact originals. No agent turn or private handle is used. */
export function useGroupMessages(groupId: string, active: boolean, reader?: GroupMessageReader) {
  const [messages, setMessages] = useState<SharedGroupMessage[]>([]);
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [windowed, setWindowed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, SharedGroupMessage>());
  const position = useRef(0);
  const initialized = useRef(false);
  const loadPage = reader?.loadPage;
  const loadOriginal = reader?.loadOriginal;
  useEffect(() => {
    if (!active || !loadPage || !loadOriginal) return;
    const controller = new AbortController();
    let alive = true;
    let reading = false;
    const ready = <T>(result: GroupRead<T>): T => {
      if (result.kind === 'ready') return result.value;
      if (result.kind === 'revoked' && alive) {
        setRevoked(true);
        cache.current.clear();
        setMessages([]);
      }
      throw new Error(result.message);
    };
    const pageAt = async (after: number, cursor: GroupFeedCursor | null) => {
      const page = groupFeedPageSchema.parse(
        ready(
          await loadPage({ visibility: 'shared', limit: 20, after, cursor }, controller.signal),
        ),
      );
      if (
        page.entries.some(
          (event) =>
            event.scope.groupId !== groupId ||
            event.scope.visibility !== 'shared' ||
            event.sequence <= (cursor?.after ?? after) ||
            (event.origin &&
              (event.origin.key.groupId !== groupId ||
                event.origin.scope.groupId !== groupId ||
                event.origin.scope.visibility !== 'shared')),
        ) ||
        (page.continuation && page.continuation.visibility !== 'shared') ||
        (cursor &&
          (page.watermark !== cursor.watermark ||
            (page.continuation && page.continuation.scopeKey !== cursor.scopeKey)))
      )
        throw new Error('These messages did not belong to this shared group.');
      return page;
    };
    const read = async () => {
      if (reading || document.hidden || !alive) return;
      reading = true;
      try {
        let page = await pageAt(position.current, null);
        if (!alive || controller.signal.aborted) return;
        if (!initialized.current && page.watermark > 200) {
          // The service's public positions belong only to this shared group.
          // Start near the present rather than downloading an unbounded history.
          position.current = page.watermark - 200;
          setWindowed(true);
          page = await pageAt(position.current, null);
        }
        for (let pages = 0; pages < 25; pages++) {
          const originals = await Promise.all(
            page.entries.map(async (event) => {
              const prior = cache.current.get(event.eventId);
              if (prior) return prior;
              const original = ready(await loadOriginal(event, controller.signal));
              const bytes = new TextEncoder().encode(original.text);
              if (
                original.eventId !== event.eventId ||
                bytes.length > GROUP_LIMITS.payloadBytes ||
                bytes.length !== event.manifest.bytes
              )
                throw new Error('A shared message did not match its original. Retry messages.');
              const digest = Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                (byte) => byte.toString(16).padStart(2, '0'),
              ).join('');
              if (digest !== event.manifest.sha256)
                throw new Error('A shared message failed its integrity check. Retry messages.');
              return { event, text: original.text };
            }),
          );
          if (!alive || controller.signal.aborted) return;
          originals.forEach((original) => cache.current.set(original.event.eventId, original));
          const combined = [...cache.current.values()].sort(
            (a, b) => a.event.sequence - b.event.sequence,
          );
          if (combined.length > 200) setWindowed(true);
          const retained = combined.slice(-200);
          cache.current = new Map(retained.map((original) => [original.event.eventId, original]));
          setMessages(
            latestGroupFeedEntries(retained.map((message) => message.event)).map(
              (event) => cache.current.get(event.eventId)!,
            ),
          );
          position.current = Math.max(
            position.current,
            ...page.entries.map((event) => event.sequence),
          );
          initialized.current = true;
          if (!page.continuation || pages === 24) break;
          page = await pageAt(0, page.continuation);
        }
        if (alive) setError('');
      } catch (reason) {
        if (alive && !controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : 'Group messages are unavailable. Retry.',
          );
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    const refresh = () => void read();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, groupId, loadPage, loadOriginal, attempt]);
  return { messages, error, revoked, windowed, retry: () => setAttempt((value) => value + 1) };
}
