// Push, notification clicks and a small offline copy of the app's content-hashed bundles.
// The fetch handler answers only same-origin GET /assets/<name>-<hash>.<js|css|font>.
// Pages, API, uploads, media, PDFs and everything else keep their network/no-store
// behavior. Taking over never reloads a page, so open drafts are untouched.
const ASSET_PREFIX = 'swa-assets-';
const ASSET_CACHE = `${ASSET_PREFIX}v1`;
const ASSET_BUDGET = 15 * 1024 * 1024;
const ASSET_ENTRY_LIMIT = 2 * 1024 * 1024;
const TOUCH_INTERVAL = 10 * 60 * 1000;
const hashedAsset = /^\/assets\/[\w.-]+-[\w-]{8}\.(js|mjs|css|woff2?|ttf)$/;
const assetTypes = {
  js: /javascript/,
  mjs: /javascript/,
  css: /^text\/css/,
  woff2: /^font\//,
  woff: /^font\//,
  ttf: /^font\//,
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      // Only this worker's earlier asset caches; other caches and storage stay untouched.
      if (self.caches)
        for (const name of await caches.keys())
          if (name.startsWith(ASSET_PREFIX) && name !== ASSET_CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);

const assetKind = (request) => {
  if (request.method !== 'GET' || request.mode === 'navigate' || request.headers.has('range'))
    return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || /pdf/i.test(url.pathname)) return null;
  return hashedAsset.exec(url.pathname)?.[1] ?? null;
};
// The server's fallback page answers unknown /assets names with HTML; never keep that.
const cacheable = (response, kind) =>
  response.status === 200 &&
  response.type === 'basic' &&
  !response.redirected &&
  Number(response.headers.get('content-length') ?? 0) <= ASSET_ENTRY_LIMIT &&
  assetTypes[kind].test(response.headers.get('content-type') ?? '');

// Cache work runs one task at a time so byte accounting stays exact.
let queue = Promise.resolve();
const serial = (task) => (queue = queue.then(task).catch(() => undefined));
// url -> { bytes, used, saved }; rebuilt from response headers once per worker start.
let index = null;
async function loadIndex(cache) {
  if (index) return index;
  const next = new Map();
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const bytes = Number(response?.headers.get('x-swa-bytes'));
    const saved = Number(response?.headers.get('x-swa-used')) || 0;
    // Entries this worker cannot account for are removed rather than guessed.
    if (bytes > 0) next.set(request.url, { bytes, used: saved, saved });
    else await cache.delete(request);
  }
  return (index = next);
}
async function store(url, response) {
  const body = await response.arrayBuffer();
  if (body.byteLength > ASSET_ENTRY_LIMIT) return; // Too large for the budget: network only.
  const cache = await caches.open(ASSET_CACHE);
  const entries = await loadIndex(cache);
  const now = Date.now();
  const headers = new Headers(response.headers);
  headers.set('x-swa-bytes', String(body.byteLength));
  headers.set('x-swa-used', String(now));
  await cache.put(url, new Response(body, { status: 200, headers }));
  entries.delete(url);
  entries.set(url, { bytes: body.byteLength, used: now, saved: now });
  let total = 0;
  for (const entry of entries.values()) total += entry.bytes;
  // Least recently used first; equal times keep their use order.
  const order = [...entries].sort((a, b) => a[1].used - b[1].used);
  for (const [key, entry] of order) {
    if (total <= ASSET_BUDGET) break;
    await cache.delete(key);
    entries.delete(key);
    total -= entry.bytes;
  }
}
async function touch(url) {
  const cache = await caches.open(ASSET_CACHE);
  const entry = (await loadIndex(cache)).get(url);
  if (!entry) return;
  const now = Date.now();
  index.delete(url);
  index.set(url, { ...entry, used: now });
  // Persist use times coarsely so ordinary loads do not rewrite bundles.
  if (now - entry.saved < TOUCH_INTERVAL) return;
  const cached = await cache.match(url);
  if (!cached) return void index.delete(url);
  const headers = new Headers(cached.headers);
  headers.set('x-swa-used', String(now));
  await cache.put(url, new Response(await cached.arrayBuffer(), { status: 200, headers }));
  index.set(url, { ...entry, used: now, saved: now });
}
async function serveAsset(event, kind) {
  const url = event.request.url;
  try {
    const cached = await (await caches.open(ASSET_CACHE)).match(url);
    if (cached) {
      event.waitUntil(serial(() => touch(url)));
      return cached;
    }
  } catch {
    // Storage trouble never blocks the network copy.
  }
  const response = await fetch(event.request);
  if (cacheable(response, kind)) {
    const copy = response.clone();
    event.waitUntil(serial(() => store(url, copy)));
  }
  return response;
}
self.addEventListener('fetch', (event) => {
  const kind = self.caches ? assetKind(event.request) : null;
  // Not answered here: the browser makes its normal network request.
  if (kind) event.respondWith(serveAsset(event, kind));
});

// Only this app's own origin and its chat routes; never an address chosen by the payload.
// The subscription belongs to this entry computer, so every click opens with its typed marker.
const safeRoute = (value) => {
  const hash =
    typeof value === 'string'
      ? /^\/(?:\?computer=entry)?(#\/chat\/[0-9a-f-]{36})?$/i.exec(value)
      : null;
  return `/?computer=entry${hash?.[1] ?? ''}`;
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'sciencewithagents';
  const body =
    typeof data.body === 'string' ? data.body.slice(0, 160) : 'Work needs your attention.';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 64) : 'dock',
      icon: '/dock-192.png?v=drawn-alien',
      badge: '/dock-192.png?v=drawn-alien',
      data: { route: safeRoute(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // A new document: an open tab may have another computer selected or an unsaved draft.
  const target = new URL(safeRoute(event.notification.data?.route), self.location.origin);
  event.waitUntil(self.clients.openWindow(target.href));
});
