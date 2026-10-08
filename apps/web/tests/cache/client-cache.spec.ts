import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { transformWithEsbuild } from 'vite';

// A disposable fixture origin serving the real worker and cache modules from source. Assets
// mimic the production server: no-store everywhere, and HTML for unknown /assets names.
const MiB = 1024 * 1024;
const hits = new Map<string, number>();
let offline = false;
let server: Server;
let origin = '';
const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const module = async (path: string, name: string) =>
  (await transformWithEsbuild(await source(path), name, { loader: 'ts', format: 'esm' })).code;

test.beforeAll(async () => {
  const files: Record<string, string> = {
    '/notifications-sw.js': await source('../../public/notifications-sw.js'),
    '/read-cache.js': await module('../../src/read-cache.ts', 'read-cache.ts'),
    '/cache-bootstrap.js': (
      await module('../../src/cache-bootstrap.ts', 'cache-bootstrap.ts')
    ).replace(/from\s*["']\.\/read-cache["']/, 'from "/read-cache.js"'),
  };
  server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    hits.set(request.url!, (hits.get(request.url!) ?? 0) + 1);
    if (offline) return void request.socket.destroy();
    response.setHeader('Cache-Control', 'no-store');
    const send = (type: string, body: string | Buffer) => {
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    };
    if (files[path]) return send('text/javascript', files[path]);
    if (path.startsWith('/api/')) return send('application/json', '{"ok":true}');
    const chunk = /^\/assets\/chunk(\d+)-/.exec(path);
    if (chunk) return send('text/javascript', `//${'x'.repeat(1.5 * MiB - 2)}`);
    if (path === '/assets/big-BBBBBBBB.js') return send('text/javascript', 'x'.repeat(3 * MiB));
    if (/^\/assets\/(app|pdf\.worker\.min)-/.test(path))
      return send('text/javascript', 'export const app = 1;');
    if (path === '/assets/font-EEEEEEEE.woff2') return send('font/woff2', Buffer.alloc(2048, 1));
    send('text/html', '<!doctype html><title>Cache fixture</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
test.beforeEach(() => {
  hits.clear();
  offline = false;
});

const get = (page: Page, path: string) =>
  page.evaluate(async (url) => {
    try {
      const response = await fetch(url);
      return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
    } catch {
      return { ok: false, bytes: 0 };
    }
  }, path);
const cached = (page: Page) =>
  page.evaluate(async () => {
    const cache = await caches.open('swa-assets-v1');
    let bytes = 0;
    const paths: string[] = [];
    for (const request of await cache.keys()) {
      paths.push(new URL(request.url).pathname + new URL(request.url).search);
      bytes += (await (await cache.match(request))!.arrayBuffer()).byteLength;
    }
    return { paths, bytes };
  });

test('the worker keeps only hashed bundles within 15 MB and never answers pages or API', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Worker caching is checked once in Chromium.');
  await page.goto(`${origin}/`);
  await page.evaluate(async () => {
    localStorage.setItem('dock:draft:fixture', 'unsent draft');
    await (await caches.open('swa-assets-v0')).put('/old', new Response('old'));
    await (await caches.open('someone-else')).put('/theirs', new Response('kept'));
    await navigator.serviceWorker.register('/notifications-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
      );
  });
  expect(await page.evaluate(() => caches.keys())).toEqual(
    expect.not.arrayContaining(['swa-assets-v0']),
  );

  const app = '/assets/app-AbCd1234.js';
  expect((await get(page, app)).ok).toBe(true);
  await expect.poll(async () => (await cached(page)).paths).toContain(app);
  const fromWorker = page.waitForResponse((response) => response.url().endsWith(app));
  expect((await get(page, app)).ok).toBe(true);
  expect((await fromWorker).fromServiceWorker()).toBe(true);
  expect(hits.get(app)).toBe(1);

  const api = page.waitForResponse((response) => response.url().endsWith('/api/snapshot'));
  await get(page, '/api/snapshot');
  expect((await api).fromServiceWorker()).toBe(false);
  for (const path of [
    '/api/snapshot',
    '/assets/missing-CCCCCCCC.js',
    '/assets/big-BBBBBBBB.js',
    '/assets/pdf.worker.min-DDDDDDDD.mjs',
    `${app}?v=2`,
    '/uploads/photo-AAAAAAAA.js',
  ])
    await get(page, path);
  await get(page, '/assets/font-EEEEEEEE.woff2');
  await expect
    .poll(async () => (await cached(page)).paths)
    .toContain('/assets/font-EEEEEEEE.woff2');
  await page.reload();
  expect(hits.get('/')).toBe(2);
  expect((await cached(page)).paths.sort()).toEqual([app, '/assets/font-EEEEEEEE.woff2'].sort());

  // Offline: kept bundles load; API and anything uncached fail exactly as without a worker.
  offline = true;
  expect(await get(page, app)).toEqual({ ok: true, bytes: 21 });
  expect((await get(page, '/api/snapshot')).ok).toBe(false);
  expect((await get(page, '/assets/big-BBBBBBBB.js')).ok).toBe(false);
  offline = false;

  // Budget: 9 × 1.5 MB, reuse chunk01, then two more; least recently used leave first.
  const chunk = (n: number) => `/assets/chunk${String(n).padStart(2, '0')}-HASH00${n % 10}0.js`;
  for (let n = 1; n <= 9; n++) await get(page, chunk(n));
  await expect.poll(async () => (await cached(page)).paths).toContain(chunk(9));
  await get(page, chunk(1));
  await get(page, chunk(10));
  await get(page, chunk(11));
  await expect.poll(async () => (await cached(page)).paths).toContain(chunk(11));
  const after = await cached(page);
  expect(after.bytes).toBeLessThanOrEqual(15 * MiB);
  expect(after.paths).toEqual(expect.arrayContaining([chunk(1), chunk(3), chunk(10), chunk(11)]));
  expect(after.paths).not.toContain(chunk(2));
  expect(after.paths).not.toContain(app);

  // Cleanup touched only the worker's own cache.
  expect(await page.evaluate(() => caches.keys())).toContain('someone-else');
  expect(await page.evaluate(() => localStorage.getItem('dock:draft:fixture'))).toBe(
    'unsent draft',
  );
  await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistration('/'))?.unregister(),
  );
});

// Fixture builders run inside the page; they produce the shared contract shapes.
const helpers = () => {
  const id = () => crypto.randomUUID();
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 12, minutes)).toISOString();
  const agent = (agentId = id(), extra: Record<string, unknown> = {}) => ({
    id: agentId,
    projectId: 'p1',
    parentId: null,
    taskId: null,
    name: 'Thesis chat',
    role: 'manager',
    scope: '',
    status: 'running',
    provider: 'codex',
    assignment: null,
    model: 'secret-model',
    effort: 'high',
    permission: 'full-access',
    mcpServers: [],
    pluginsEnabled: false,
    webSearch: 'disabled',
    imageGeneration: false,
    nativeRootId: null,
    nativePath: '/Users/someone/private',
    checkpoint: 'cp',
    createdAt: at(0),
    updatedAt: at(1),
    lastActivityAt: at(2),
    ...extra,
  });
  const entry = (agentId: string, n: number, text = `message ${n}`, extra = {}) => ({
    id: `e${n}`,
    agentId,
    runId: null,
    kind: n % 2 ? 'assistant' : 'user',
    title: '',
    text,
    status: 'done',
    createdAt: at(n),
    ...extra,
  });
  return { id, agent, entry };
};

test('saved chat text is display-only, bounded and partitioned by computer and session', async ({
  page,
}) => {
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async (makeHelpers) => {
    const { id, agent, entry } = (0, eval)(`(${makeHelpers})`)();
    const m = await import(/* @vite-ignore */ `${location.origin}/read-cache.js`);
    const local = (await m.openReadCache({ computer: 'local', session: 'device-1' }))!;
    const other = (await m.openReadCache({ computer: id(), session: 'device-1' }))!;
    const otherSession = (await m.openReadCache({ computer: 'local', session: 'device-2' }))!;
    const live = agent();
    await local.saveChatList({
      projects: [{ id: 'p1', name: 'Thesis', description: 'private notes', managerId: live.id }],
      agents: [live, agent(id(), { archivedAt: agent().updatedAt })],
      approvals: [{ id: 'approval' }],
    });
    const list = await local.readChatList();
    const conversationId = id();
    await local.saveConversation({
      agent: agent(conversationId),
      hasMore: false,
      entries: [
        entry(conversationId, 1),
        entry(conversationId, 2, 'tool output', { kind: 'tool' }),
        entry(conversationId, 3, 'picture', { image: { path: '/uploads/a.png' } }),
        entry(conversationId, 4, 'sent?', { ownerInput: { delivery: 'uncertain' } }),
      ],
    });
    const saved = await local.readConversation(conversationId);
    const tx = await new Promise<string>((resolve) => {
      const open = indexedDB.open('swa-read-cache');
      open.onsuccess = () => {
        const all = open.result.transaction('meta').objectStore('meta').getAll();
        all.onsuccess = () => resolve(JSON.stringify(all.result));
      };
    });

    // Five conversations; reading one keeps it while the least used leaves.
    const ids = Array.from({ length: 6 }, () => id());
    for (const chatId of ids.slice(0, 5))
      await local.saveConversation({
        agent: agent(chatId),
        hasMore: false,
        entries: [entry(chatId, 1)],
      });
    await local.readConversation(ids[0]);
    await local.saveConversation({
      agent: agent(ids[5]),
      hasMore: false,
      entries: [entry(ids[5], 1)],
    });
    const kept = await Promise.all(
      ids.map(async (chatId) => !!(await local.readConversation(chatId))),
    );

    // Large records keep the newest entries; an oversized newest entry is not saved.
    const long = id();
    const tenKb = 'é'.repeat(5 * 1024);
    await local.saveConversation({
      agent: agent(long),
      hasMore: false,
      entries: Array.from({ length: 300 }, (_, n) => entry(long, n, tenKb)),
    });
    const trimmed = (await local.readConversation(long))!.value;
    const huge = id();
    const hugeSaved = await local.saveConversation({
      agent: agent(huge),
      hasMore: false,
      entries: [entry(huge, 1, 'x'.repeat(1.2 * 1024 * 1024))],
    });

    // Shared 5 MB budget across computers: five near-limit conversations plus large lists.
    const big = 'y'.repeat(900 * 1024);
    for (let n = 0; n < 5; n++) {
      const chatId = id();
      await local.saveConversation({
        agent: agent(chatId),
        hasMore: false,
        entries: [entry(chatId, 1, big)],
      });
      const computer = (await m.openReadCache({ computer: id(), session: 'device-1' }))!;
      await computer.saveChatList({
        projects: [],
        agents: Array.from({ length: 200 }, () => agent(id(), { name: 'n'.repeat(2400) })),
      });
    }
    return {
      list,
      otherList: await other.readChatList(),
      otherSessionList: await otherSession.readChatList(),
      saved,
      meta: tx,
      kept,
      trimmed: {
        count: trimmed.entries.length,
        last: trimmed.entries.at(-1).id,
        omitted: trimmed.olderOmitted,
        bytes: new TextEncoder().encode(JSON.stringify(trimmed)).byteLength,
      },
      hugeSaved,
      hugeRead: await local.readConversation(huge),
      usage: await m.readCacheUsage(),
      limits: m.READ_CACHE_LIMITS,
    };
  }, helpers.toString());

  expect(result.list!.saved).toBe(true);
  expect(result.list!.ageMs).toBeGreaterThanOrEqual(0);
  expect(result.list!.value.chats).toHaveLength(1);
  expect(Object.keys(result.list!.value.chats[0]).sort()).toEqual([
    'createdAt',
    'id',
    'lastActivityAt',
    'name',
    'parentId',
    'projectId',
    'provider',
    'role',
    'updatedAt',
  ]);
  expect(JSON.stringify(result.list)).not.toMatch(
    /private|approval|full-access|secret-model|running/,
  );
  expect(result.otherList).toBeNull();
  expect(result.otherSessionList).toBeNull();
  expect(result.saved!.value.entries.map((item: { id: string }) => item.id)).toEqual(['e1', 'e3']);
  expect(JSON.stringify(result.saved)).not.toContain('/uploads/');
  expect(result.meta).not.toMatch(/device-1|local/);
  expect(result.kept).toEqual([true, false, true, true, true, true]);
  expect(result.trimmed.last).toBe('e299');
  expect(result.trimmed.omitted).toBe(true);
  expect(result.trimmed.count).toBeLessThanOrEqual(result.limits.entries);
  expect(result.trimmed.bytes).toBeLessThanOrEqual(result.limits.conversationBytes);
  expect(result.hugeSaved).toBe(false);
  expect(result.hugeRead).toBeNull();
  expect(result.usage.bytes).toBeLessThanOrEqual(5 * MiB);
  expect(result.usage.conversations).toBeLessThanOrEqual(5);
  expect(result.usage.chatLists).toBeLessThanOrEqual(5);
});

test('expired sign-in clears saved chat text only; drafts, receipts and other storage remain', async ({
  page,
}) => {
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async (makeHelpers) => {
    const { id, agent, entry } = (0, eval)(`(${makeHelpers})`)();
    const m = await import(/* @vite-ignore */ `${location.origin}/read-cache.js`);
    const boot = await import(/* @vite-ignore */ `${location.origin}/cache-bootstrap.js`);
    localStorage.setItem('dock:draft:fixture', 'unsent draft');
    sessionStorage.setItem('dock:receipt:fixture', 'delivery receipt');
    await (await caches.open('someone-else')).put('/theirs', new Response('kept'));
    await new Promise<void>((resolve) => {
      const open = indexedDB.open('other-app-db', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('drafts');
      open.onsuccess = () => {
        const tx = open.result.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put('kept', 'draft');
        tx.oncomplete = () => resolve();
      };
    });
    boot.startClientCache({ registerWorker: false });
    let now = Date.now();
    const cache = (await m.openReadCache({ computer: 'local', session: 'device-1' }, () => now))!;
    const chatId = id();
    await cache.saveConversation({
      agent: agent(chatId),
      hasMore: false,
      entries: [entry(chatId, 1)],
    });
    now += m.READ_CACHE_LIMITS.maxAgeMs + 1;
    const expired = await cache.readConversation(chatId);
    now = Date.now();
    await cache.saveConversation({
      agent: agent(chatId),
      hasMore: false,
      entries: [entry(chatId, 1)],
    });
    const before = await m.readCacheUsage();
    window.dispatchEvent(new Event('dock:authentication-required'));
    for (let tries = 0; tries < 50 && (await m.readCacheUsage()).bytes; tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const lateWrite = await cache.saveConversation({
      agent: agent(chatId),
      hasMore: false,
      entries: [entry(chatId, 1)],
    });
    const reopened = (await m.openReadCache({ computer: 'local', session: 'device-1' }))!;
    const otherDb = await new Promise((resolve) => {
      const open = indexedDB.open('other-app-db', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('drafts').objectStore('drafts').get('draft');
        get.onsuccess = () => resolve(get.result);
      };
    });
    return {
      expired,
      before,
      after: await m.readCacheUsage(),
      active: cache.active,
      lateWrite,
      reread: await reopened.readConversation(chatId),
      draft: localStorage.getItem('dock:draft:fixture'),
      receipt: sessionStorage.getItem('dock:receipt:fixture'),
      caches: await caches.keys(),
      otherDb,
    };
  }, helpers.toString());
  expect(result.expired).toBeNull();
  expect(result.before.conversations).toBe(1);
  expect(result.after).toEqual({ bytes: 0, conversations: 0, chatLists: 0 });
  expect(result.active).toBe(false);
  expect(result.lateWrite).toBe(false);
  expect(result.reread).toBeNull();
  expect(result.draft).toBe('unsent draft');
  expect(result.receipt).toBe('delivery receipt');
  expect(result.caches).toContain('someone-else');
  expect(result.otherDb).toBe('kept');
});

test('project metadata cannot exceed the per-list or shared byte limit', async ({ page }) => {
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async (makeHelpers) => {
    const { id, agent } = (0, eval)(`(${makeHelpers})`)();
    const m = await import(/* @vite-ignore */ `${location.origin}/read-cache.js`);
    const cache = (await m.openReadCache({ computer: 'local', session: 'device-1' }))!;
    const live = agent();
    await cache.saveChatList({
      agents: [live],
      projects: [
        { id: live.projectId, name: 'Relevant project', managerId: live.id },
        { id: id(), name: 'unrelated'.repeat(1024 * 1024), managerId: id() },
      ],
    });
    const relevant = await cache.readChatList();
    await cache.saveChatList({
      agents: [],
      projects: [{ id: id(), name: 'x'.repeat(6 * 1024 * 1024), managerId: id() }],
    });
    const empty = await cache.readChatList();
    await cache.saveChatList({
      agents: [live],
      projects: [{ id: live.projectId, name: 'x'.repeat(6 * 1024 * 1024), managerId: live.id }],
    });
    const largeRelevant = await cache.readChatList();
    return {
      relevant,
      empty,
      largeRelevant,
      usage: await m.readCacheUsage(),
      limits: m.READ_CACHE_LIMITS,
    };
  }, helpers.toString());
  expect(result.relevant!.value.projects).toHaveLength(1);
  expect(result.relevant!.value.projects[0].name).toBe('Relevant project');
  expect(result.empty!.value.projects).toEqual([]);
  expect(result.largeRelevant!.value.projects).toEqual([]);
  expect(
    new TextEncoder().encode(JSON.stringify(result.largeRelevant!.value)).byteLength,
  ).toBeLessThanOrEqual(result.limits.chatListBytes);
  expect(result.usage.bytes).toBeLessThanOrEqual(result.limits.bytes);
});

test('a read racing a larger save preserves the new size for shared-budget accounting', async ({
  page,
}) => {
  await page.goto(`${origin}/`);
  const result = await page.evaluate(async (makeHelpers) => {
    const { id, agent, entry } = (0, eval)(`(${makeHelpers})`)();
    const m = await import(/* @vite-ignore */ `${location.origin}/read-cache.js`);
    const scope = { computer: 'local', session: 'device-1' };
    const reader = (await m.openReadCache(scope))!;
    const writer = (await m.openReadCache(scope))!;
    const chatId = id(),
      live = agent(chatId);
    await writer.saveConversation({
      agent: live,
      hasMore: false,
      entries: [entry(chatId, 1, 'small')],
    });
    await Promise.all([
      reader.readConversation(chatId),
      writer.saveConversation({
        agent: live,
        hasMore: false,
        entries: [entry(chatId, 2, 'x'.repeat(900 * 1024))],
      }),
    ]);
    const copy = await reader.readConversation(chatId);
    return {
      bytes: new TextEncoder().encode(JSON.stringify(copy!.value)).byteLength,
      usage: await m.readCacheUsage(),
    };
  }, helpers.toString());
  expect(result.bytes).toBeGreaterThan(900 * 1024);
  expect(result.usage.bytes).toBe(result.bytes);
});
