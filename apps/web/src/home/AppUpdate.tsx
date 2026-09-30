import { useEffect, useState } from 'react';

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
    let pending = false;
    const check = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const response = await fetch('/', { cache: 'no-store', signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
        const next = entry(new DOMParser().parseFromString(await response.text(), 'text/html'));
        if (next && next !== current && !controller.signal.aborted) setAvailable(true);
      } catch {
        // A sleeping computer or disconnected phone is not an available update.
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
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
