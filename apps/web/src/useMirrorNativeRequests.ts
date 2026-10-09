import { useEffect, useRef, useState } from 'react';
import { mirrorNativeRequestsViewSchema, type MirrorNativeRequestsView } from '@dock/shared';
import { api, ApiError } from './api';
import { mirrorKey, type MirrorChat } from './useMirrorChats';

/** Read only the observed native requests; a slow transcript cannot hold this reading. */
export function useMirrorNativeRequests(chat: MirrorChat) {
  const identity = mirrorKey(chat);
  const [view, setView] = useState<MirrorNativeRequestsView | null>(null);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(false);
  const readAt = useRef(0);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let ended = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    readAt.current = 0;
    setFresh(false);
    const read = async () => {
      if (ended || pending || !chat.online) return;
      pending = true;
      const started = Date.now();
      try {
        const next = mirrorNativeRequestsViewSchema.parse(
          await api(`/vscode/windows/${chat.windowId}/questions`),
        );
        if (ended) return;
        if (
          next.threadId !== chat.threadId ||
          (next.provider ?? 'codex') !== (chat.provider ?? 'codex') ||
          next.windowId !== chat.windowId
        )
          throw new Error('The shared conversation identity changed.');
        readAt.current = started;
        setView((previous) =>
          next.nativeRequestsUnavailable === true &&
          next.nativeRequests?.length === 0 &&
          previous?.windowId === next.windowId &&
          previous.threadId === next.threadId &&
          (previous.provider ?? 'codex') === (next.provider ?? 'codex')
            ? {
                ...next,
                nativeRequests: previous.nativeRequests?.map((request) => ({
                  ...request,
                  observation: 'unconfirmed',
                  response: 'editor_only',
                })),
              }
            : next,
        );
        setError('');
        setFresh(true);
      } catch (failure) {
        if (ended) return;
        setFresh(false);
        if (failure instanceof ApiError && failure.status === 404) {
          setView(null);
          setError(
            'Native questions are unavailable on this connection. Check the original editor. An older host or companion may need an update when its running work is safe.',
          );
        } else {
          setError(
            'Native requests could not be refreshed. Any retained request is unconfirmed; reconnect or retry before answering.',
          );
        }
      } finally {
        pending = false;
        if (!ended) timer = setTimeout(read, 1500);
      }
    };
    retry.current = () => {
      clearTimeout(timer);
      void read();
    };
    const visible = () => {
      if (!document.hidden) retry.current();
    };
    document.addEventListener('visibilitychange', visible);
    void read();
    return () => {
      ended = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      retry.current = () => {};
    };
  }, [identity, chat.windowId, chat.online]);
  const discoveryFailed =
    chat.status === 'offline' && (chat.listedAt ?? Infinity) >= readAt.current;
  const available =
    !!chat.online &&
    fresh &&
    !!view &&
    view.windowId === chat.windowId &&
    view.threadId === chat.threadId &&
    view.status !== 'offline' &&
    !error &&
    !discoveryFailed;
  return { view, available, error, retry: () => retry.current() };
}
