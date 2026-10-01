import { useEffect, useState } from 'react';
import { trackRefresh } from './refreshHome';

// Installed phone pages can remain alive across releases. Reloading the server
// does not replace JavaScript already running in those pages.
export function AppUpdate() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const entry = (root: Document) =>
      root
        .querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')
        ?.getAttribute('src');
    const current = entry(document);
    if (!current) return; // The development server has no production entry bundle.
    const controller = new AbortController();
    let pending: Promise<boolean> | null = null;
    const check = () => {
      if (pending) return pending;
      pending = (async () => {
        // Bound an unreachable phone connection without cancelling later checks.
        const timeout = new AbortController();
        const abort = () => timeout.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        const timer = window.setTimeout(abort, 15_000);
        try {
          const response = await fetch('/', { cache: 'no-store', signal: timeout.signal });
          if (!response.ok || !response.headers.get('content-type')?.includes('text/html'))
            return false;
          const next = entry(new DOMParser().parseFromString(await response.text(), 'text/html'));
          if (next && next !== current && !controller.signal.aborted) setAvailable(true);
          return true;
        } catch {
          // A sleeping computer or disconnected phone is not an available update.
          return false;
        } finally {
          window.clearTimeout(timer);
          controller.signal.removeEventListener('abort', abort);
          pending = null;
        }
      })();
      return pending;
    };
    const refresh = () => {
      if (!document.hidden) void check();
    };
    const requested = (event: Event) => trackRefresh(event, check());
    void check();
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('swa:refresh-home', requested);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('swa:refresh-home', requested);
    };
  }, []);
  if (!available) return null;
  return (
    <div className="home-update" role="status">
      <span>App update ready</span>
      <button type="button" onClick={() => location.reload()}>
        Reload app
      </button>
    </div>
  );
}
