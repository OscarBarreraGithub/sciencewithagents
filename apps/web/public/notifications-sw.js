// Push and notification clicks only. There is deliberately no fetch handler: page loads,
// caching and app updates keep their existing network/no-store behavior.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
