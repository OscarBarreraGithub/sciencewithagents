import { clearReadCache } from './read-cache';

// The same worker, address and scope as notification settings, so both share one registration.
const workerUrl = '/notifications-sw.js';
let started = false;

/**
 * Starts this browser's small app-managed caches once per document:
 * - the notifications worker also keeps up to 15 MB of content-hashed /assets bundles and
 *   fonts for loading without a connection. Pages, API, uploads, media and PDFs stay network
 *   only. Registration never reloads or interrupts an open page or draft.
 * - saved chat text (read-cache.ts) is cleared whenever a request reports expired sign-in.
 */
export function startClientCache(options: { registerWorker: boolean }) {
  if (started) return;
  started = true;
  window.addEventListener('dock:authentication-required', () => {
    void clearReadCache().catch(() => undefined);
  });
  if (!options.registerWorker || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  // An optional speed-up after the page has loaded; the app works the same without it.
  const register = () =>
    void navigator.serviceWorker.register(workerUrl, { scope: '/' }).catch(() => undefined);
  if (document.readyState === 'complete') setTimeout(register, 0);
  else window.addEventListener('load', register, { once: true });
}
