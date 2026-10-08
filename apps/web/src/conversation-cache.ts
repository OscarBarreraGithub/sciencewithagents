import { apiScope } from './api';
import { openReadCache, type ReadCache } from './read-cache';

// This app has one owner per installation. Callers mount behind PhoneGate and only
// hydrate a conversation after that computer has returned an authenticated snapshot.
// Channels stay separate, so a team-only history cannot appear in the main chat.
const handles = new Map<string, Promise<ReadCache | null>>();
export async function conversationCache(channel = 'all') {
  const key = `${apiScope()}:${channel}`;
  let pending = handles.get(key);
  if (!pending) {
    pending = openReadCache({ computer: apiScope(), session: `owner:${channel}` });
    handles.set(key, pending);
  }
  const cache = await pending;
  if (cache && !cache.active) {
    handles.delete(key);
    return null;
  }
  return cache;
}
window.addEventListener('dock:authentication-required', () => handles.clear());
