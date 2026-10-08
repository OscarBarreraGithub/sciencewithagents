import type { Agent, AgentDetail, Entry, Project, Snapshot } from '@dock/shared';

/*
 * A small saved copy of recent chat text in this browser, shown while the computer is
 * reached again. It is display text only: no status, approvals, decisions, usage, models,
 * permissions, delivery receipts, images, uploads, PDFs or archived chats. Every read is
 * labelled as a saved copy with its age; live responses always replace it.
 *
 * Limits are shared by every computer and session of this origin, not per computer.
 * Drafts, receipts and other storage are never read or cleared here.
 */
export const READ_CACHE_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  conversations: 5,
  chatLists: 5,
  conversationBytes: 1024 * 1024,
  chatListBytes: 512 * 1024,
  entries: 80,
  chats: 200,
  maxAgeMs: 3 * 24 * 60 * 60 * 1000,
});

export type CachedProject = Pick<Project, 'id' | 'name' | 'managerId' | 'internal'>;
export type CachedChat = Pick<
  Agent,
  | 'id'
  | 'projectId'
  | 'parentId'
  | 'name'
  | 'role'
  | 'provider'
  | 'surface'
  | 'createdAt'
  | 'updatedAt'
  | 'lastActivityAt'
>;
export type CachedEntry = Pick<
  Entry,
  'id' | 'agentId' | 'kind' | 'title' | 'text' | 'createdAt' | 'phase'
>;
export type CachedChatList = { projects: CachedProject[]; chats: CachedChat[] };
/** Newest contiguous text entries; `olderOmitted` means earlier history exists elsewhere. */
export type CachedConversation = {
  chat: CachedChat;
  entries: CachedEntry[];
  olderOmitted: boolean;
};
export type SavedCopy<T> = { value: T; saved: true; savedAt: string; ageMs: number };
/**
 * `computer` is apiScope(). `session` is a non-secret label for the confirmed sign-in
 * (for example the paired device id, or 'local'). Both are hashed with this origin into an
 * opaque partition; neither is written to disk. Never pass a token or credential.
 */
export type ReadCacheScope = { computer: string; session: string };
export type ReadCache = {
  /** False after sign-in expired or any tab cleared saved copies; reopen after sign-in. */
  readonly active: boolean;
  readChatList(): Promise<SavedCopy<CachedChatList> | null>;
  saveChatList(snapshot: Pick<Snapshot, 'projects' | 'agents'>): Promise<boolean>;
  readConversation(agentId: string): Promise<SavedCopy<CachedConversation> | null>;
  /** Save only the newest page (a request without `before`) of the channel shown. */
  saveConversation(detail: Pick<AgentDetail, 'agent' | 'entries' | 'hasMore'>): Promise<boolean>;
  forgetConversation(agentId: string): Promise<void>;
  /** This computer and session only. */
  clear(): Promise<void>;
};

type Kind = 'chats' | 'conversation';
type Meta = { key: string; kind: Kind; bytes: number; savedAt: number; usedAt: number };

const DB_NAME = 'swa-read-cache';
const textKinds = new Set<Entry['kind']>(['user', 'assistant', 'message']);
const encoder = new TextEncoder();
const utf8Bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
// Strictly increasing use order, so uses within one millisecond still evict correctly.
let lastUse = 0;
const useTime = (now: number) => (lastUse = Math.max(now, lastUse + 1));

// Bumped by clearReadCache here or in another tab; older handles stop reading and writing.
let generation = 0;
const channel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel('swa-read-cache') : null;
if (channel) channel.onmessage = () => void generation++;

let opening: Promise<IDBDatabase | null> | null = null;
function database() {
  return (opening ??= new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore('meta', { keyPath: 'key' });
      request.result.createObjectStore('values');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    // Unavailable storage (private modes, quota, blocked upgrade) just means no saved copy.
    request.onerror = request.onblocked = () => resolve(null);
  }));
}
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Saved copy unavailable.'));
  });
const expired = (meta: Meta, now: number) =>
  now - meta.savedAt > READ_CACHE_LIMITS.maxAgeMs || meta.savedAt > now + 60_000;

/** Keys to remove so the incoming record fits: expired first, then least recently used. */
function evictions(others: Meta[], incoming: Meta, now: number) {
  const out = new Set<string>();
  const live: Meta[] = [];
  for (const meta of others)
    if (expired(meta, now)) out.add(meta.key);
    else live.push(meta);
  live.sort((a, b) => a.usedAt - b.usedAt);
  const limit = {
    conversation: READ_CACHE_LIMITS.conversations,
    chats: READ_CACHE_LIMITS.chatLists,
  };
  const count = { conversation: 0, chats: 0 };
  count[incoming.kind]++;
  for (const meta of live) count[meta.kind]++;
  let bytes = live.reduce((sum, meta) => sum + meta.bytes, incoming.bytes);
  for (const meta of live)
    if (count[meta.kind] > limit[meta.kind] || bytes > READ_CACHE_LIMITS.bytes) {
      out.add(meta.key);
      count[meta.kind]--;
      bytes -= meta.bytes;
    }
  return out;
}

function chat(agent: Agent): CachedChat {
  return {
    id: agent.id,
    projectId: agent.projectId,
    parentId: agent.parentId,
    name: agent.name,
    role: agent.role,
    provider: agent.provider,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(agent.surface ? { surface: agent.surface } : {}),
    ...(agent.lastActivityAt ? { lastActivityAt: agent.lastActivityAt } : {}),
  };
}
function textEntry(entry: Entry): CachedEntry | null {
  // Interactive requests and unconfirmed deliveries are live state, not saved text.
  if (!textKinds.has(entry.kind) || entry.urlRequest || entry.ownerInput?.delivery === 'uncertain')
    return null;
  return {
    id: entry.id,
    agentId: entry.agentId,
    kind: entry.kind,
    title: entry.title,
    text: entry.text,
    createdAt: entry.createdAt,
    ...(entry.phase ? { phase: entry.phase } : {}),
  };
}
const activity = (item: CachedChat) => item.lastActivityAt ?? item.updatedAt;

function chatList(snapshot: Pick<Snapshot, 'projects' | 'agents'>): CachedChatList {
  const chats = snapshot.agents
    .filter((agent) => !agent.archivedAt)
    .map(chat)
    .sort((a, b) => activity(b).localeCompare(activity(a)))
    .slice(0, READ_CACHE_LIMITS.chats);
  const retainedProjects = new Set(chats.map((item) => item.projectId));
  const projects = snapshot.projects
    .filter((project) => retainedProjects.has(project.id))
    .map((project) => ({
      id: project.id,
      name: project.name,
      managerId: project.managerId,
      ...(project.internal === undefined ? {} : { internal: project.internal }),
    }));
  const value = { projects, chats };
  while (chats.length && utf8Bytes(value) > READ_CACHE_LIMITS.chatListBytes) {
    chats.pop();
    const remaining = new Set(chats.map((item) => item.projectId));
    value.projects = value.projects.filter((project) => remaining.has(project.id));
  }
  return value;
}
/** Newest entries that fit; null when even the newest text entry is too large to keep. */
function conversation(detail: Pick<AgentDetail, 'agent' | 'entries' | 'hasMore'>) {
  const all = detail.entries.filter((entry) => entry.agentId === detail.agent.id);
  const kept: CachedEntry[] = [];
  let bytes = utf8Bytes({ chat: chat(detail.agent), entries: [], olderOmitted: true });
  let index = all.length - 1;
  for (; index >= 0 && kept.length < READ_CACHE_LIMITS.entries; index--) {
    const entry = textEntry(all[index]!);
    if (!entry) continue;
    const size = utf8Bytes(entry) + 1;
    if (bytes + size > READ_CACHE_LIMITS.conversationBytes) break;
    kept.unshift(entry);
    bytes += size;
  }
  if (!kept.length) return null;
  const value: CachedConversation = {
    chat: chat(detail.agent),
    entries: kept,
    olderOmitted: detail.hasMore || index >= 0,
  };
  // Exact serialized size is what the shared budget counts.
  while (value.entries.length > 1 && utf8Bytes(value) > READ_CACHE_LIMITS.conversationBytes)
    value.entries.shift();
  return utf8Bytes(value) > READ_CACHE_LIMITS.conversationBytes ? null : value;
}

async function partitionId(scope: ReadCacheScope) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(['swa-read-cache', location.origin, scope.computer, scope.session].join('\n')),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens saved copies for one computer and confirmed sign-in. Call only after the computer
 * has accepted this session; returns null when storage or hashing is unavailable.
 * `clock` exists for tests.
 */
export async function openReadCache(
  scope: ReadCacheScope,
  clock: () => number = Date.now,
): Promise<ReadCache | null> {
  const valid = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!valid(scope.computer, 200) || !valid(scope.session, 500)) return null;
  if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return null;
  const opened = generation;
  const [db, partition] = await Promise.all([database(), partitionId(scope).catch(() => null)]);
  if (!db || !partition || opened !== generation) return null;
  const active = () => opened === generation;
  const key = (kind: Kind, id = '') => `${partition}:${kind}:${id}`;

  const remove = async (keys: string[]) => {
    const tx = db.transaction(['meta', 'values'], 'readwrite');
    for (const item of keys) {
      tx.objectStore('meta').delete(item);
      tx.objectStore('values').delete(item);
    }
    await done(tx);
  };
  const read = async <T>(item: string): Promise<SavedCopy<T> | null> => {
    if (!active()) return null;
    const tx = db.transaction(['meta', 'values'], 'readonly');
    const meta = tx.objectStore('meta').get(item) as IDBRequest<Meta | undefined>;
    const value = tx.objectStore('values').get(item) as IDBRequest<T | undefined>;
    await done(tx);
    const now = clock();
    if (!meta.result || value.result === undefined || expired(meta.result, now)) {
      if (meta.result || value.result !== undefined) await remove([item]);
      return null;
    }
    if (!active()) return null;
    const touch = db.transaction('meta', 'readwrite');
    const current = touch.objectStore('meta').get(item) as IDBRequest<Meta | undefined>;
    current.onsuccess = () => {
      // A concurrent save owns its newer size/date; a clear must not be resurrected.
      if (active() && current.result)
        touch.objectStore('meta').put({ ...current.result, usedAt: useTime(now) });
    };
    await done(touch);
    if (!active()) return null;
    return {
      value: value.result,
      saved: true,
      savedAt: new Date(meta.result.savedAt).toISOString(),
      ageMs: Math.max(0, now - meta.result.savedAt),
    };
  };
  const write = async (item: string, kind: Kind, value: unknown) => {
    if (!active()) return false;
    const now = clock();
    const bytes = utf8Bytes(value);
    const entryLimit =
      kind === 'chats' ? READ_CACHE_LIMITS.chatListBytes : READ_CACHE_LIMITS.conversationBytes;
    if (bytes > entryLimit || bytes > READ_CACHE_LIMITS.bytes) return false;
    const meta: Meta = {
      key: item,
      kind,
      bytes,
      savedAt: now,
      usedAt: useTime(now),
    };
    const tx = db.transaction(['meta', 'values'], 'readwrite');
    const metas = tx.objectStore('meta');
    const values = tx.objectStore('values');
    const all = metas.getAll() as IDBRequest<Meta[]>;
    all.onsuccess = () => {
      const others = all.result.filter((other) => other.key !== item);
      for (const evicted of evictions(others, meta, now)) {
        metas.delete(evicted);
        values.delete(evicted);
      }
      metas.put(meta);
      values.put(value, item);
    };
    await done(tx);
    return true;
  };

  return {
    get active() {
      return active();
    },
    readChatList: () => read<CachedChatList>(key('chats')),
    saveChatList: (snapshot) => write(key('chats'), 'chats', chatList(snapshot)),
    readConversation: async (agentId) => {
      const copy = await read<CachedConversation>(key('conversation', agentId));
      return copy?.value.chat.id === agentId ? copy : null;
    },
    saveConversation: async (detail) => {
      const item = key('conversation', detail.agent.id);
      const value = detail.agent.archivedAt ? null : conversation(detail);
      if (value) return write(item, 'conversation', value);
      if (active()) await remove([item]);
      return false;
    },
    forgetConversation: (agentId) => remove([key('conversation', agentId)]),
    clear: async () => {
      const tx = db.transaction(['meta', 'values'], 'readwrite');
      const range = IDBKeyRange.bound(`${partition}:`, `${partition}:￿`);
      tx.objectStore('meta').delete(range);
      tx.objectStore('values').delete(range);
      await done(tx);
    },
  };
}

/** Removes every saved copy for this origin and revokes open handles in all tabs. */
export async function clearReadCache() {
  generation++;
  channel?.postMessage('clear');
  if (typeof indexedDB === 'undefined') return;
  const db = await database();
  if (!db) return;
  const tx = db.transaction(['meta', 'values'], 'readwrite');
  tx.objectStore('meta').clear();
  tx.objectStore('values').clear();
  await done(tx);
}

/** Totals across all computers and sessions of this origin, for checks and diagnostics. */
export async function readCacheUsage() {
  const db = typeof indexedDB === 'undefined' ? null : await database();
  const usage = { bytes: 0, conversations: 0, chatLists: 0 };
  if (!db) return usage;
  const tx = db.transaction('meta', 'readonly');
  const all = tx.objectStore('meta').getAll() as IDBRequest<Meta[]>;
  await done(tx);
  for (const meta of all.result) {
    usage.bytes += meta.bytes;
    if (meta.kind === 'chats') usage.chatLists++;
    else usage.conversations++;
  }
  return usage;
}
