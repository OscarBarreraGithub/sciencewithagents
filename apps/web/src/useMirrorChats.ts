import { useEffect, useState } from 'react';
import { mirrorWindowSchema, type MirrorState } from '@dock/shared';
import { api, apiScope } from './api';

/** `listedAt`: when the discovery read that produced this summary started (client clock). */
export type MirrorChat = Omit<MirrorState, 'entries'> & { online?: boolean; listedAt?: number };
export const mirrorKey = (chat: MirrorChat) => `${chat.provider ?? 'codex'}:${chat.threadId}`;
export const mirrorProvider = (chat: MirrorChat) =>
  chat.provider === 'claude' ? 'Claude Code' : 'Codex';
/** A native Codex shared-server session (possibly a terminal); omitted source is VS Code. */
export const mirrorDaemon = (chat: Pick<MirrorChat, 'source'>) => chat.source === 'codex-daemon';
/** List caption: editor chats name their provider; daemon sessions say what they are. */
export const mirrorKind = (chat: MirrorChat) =>
  mirrorDaemon(chat) ? 'Codex session' : mirrorProvider(chat);
export const mirrorStatus = (chat: MirrorChat) =>
  ({
    idle: 'Connected',
    busy: 'Working',
    attention: mirrorDaemon(chat) ? 'Check your computer' : 'Check VS Code',
    offline: 'Offline',
  })[chat.status];

/** Remember navigation metadata only, never transcripts or credentials. */
export function useMirrorChats(includeArchived = false) {
  const baseKey = `dock:mirror-chats:${apiScope()}`;
  const storageKey = `${baseKey}${includeArchived ? ':all' : ''}`;
  const [chats, setChats] = useState<MirrorChat[]>(() => {
    try {
      return mirrorWindowSchema
        .array()
        .parse(
          JSON.parse(
            sessionStorage.getItem(storageKey) ??
              (includeArchived ? sessionStorage.getItem(baseKey) : null) ??
              '[]',
          ),
        )
        .slice(0, 50)
        .map((chat) => ({ ...chat, status: 'offline', online: false }));
    } catch {
      return [];
    }
  });
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const listedAt = Date.now();
      try {
        const list = mirrorWindowSchema
          .array()
          .parse(await api(`/vscode/windows${includeArchived ? '?includeArchived=true' : ''}`));
        if (ended) return;
        setChats((old) => {
          const next = new Map(
            old.map((chat) => [
              mirrorKey(chat),
              { ...chat, status: 'offline' as MirrorChat['status'], online: false },
            ]),
          );
          // Keep the selected provider thread stable when the editor switches chats
          // or reconnects with a new window ID. Never redirect a saved draft.
          for (const chat of list)
            if (chat.threadId) next.set(mirrorKey(chat), { ...chat, online: true, listedAt });
          const result = [...next.values()]
            .sort((a, b) => Number(a.status === 'offline') - Number(b.status === 'offline'))
            .slice(0, 50);
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(result));
          } catch {
            /* Navigation can remain memory-only. */
          }
          return result;
        });
        setError('');
      } catch {
        if (ended) return;
        setChats((old) => old.map((chat) => ({ ...chat, status: 'offline', online: false })));
        setError('Cannot reach this computer. Reconnecting automatically; nothing will be sent.');
      } finally {
        if (!ended) {
          setLoaded(true);
          timer = setTimeout(poll, 1500);
        }
      }
    };
    void poll();
    return () => {
      ended = true;
      clearTimeout(timer);
    };
  }, [storageKey, includeArchived]);
  return { chats, loaded, error };
}
