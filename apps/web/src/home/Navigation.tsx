import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';
import { ArrowLeft } from 'lucide-react';
import { apiScope } from '../api';

const key = () => `dock:${apiScope()}:navigation`;
export const canonicalRoute = (value: string) =>
  (value.replace(/^#\//, '').replace(/\/$/, '') || 'home')
    .replace(/^usage(?=\/|$)/, 'work')
    .replace(/^advanced$/, 'settings');
const visitRoute = (trail: string[], route: string) => {
  const next = canonicalRoute(route);
  const previous = trail.indexOf(next);
  if (next === 'home') return ['home'];
  if (previous >= 0) return trail.slice(0, previous + 1);
  // Closing a notepad replaces its sub-view; Back must not reopen it.
  if (trail.at(-1)?.startsWith(`${next}/`)) return [...trail.slice(0, -1), next];
  return [...trail, next].slice(-12);
};
function restore(current: string): string[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key()) ?? 'null');
    if (Array.isArray(saved) && saved.length <= 12 && saved.every((r) => typeof r === 'string')) {
      const normalized = saved.reduce<string[]>((trail, item) => visitRoute(trail, item), []);
      if (normalized.at(-1) === canonicalRoute(current)) return normalized;
    }
  } catch {
    /* A direct link still has a way home. */
  }
  return visitRoute(['home'], current);
}
function save(trail: string[]) {
  try {
    sessionStorage.setItem(key(), JSON.stringify(trail));
  } catch {
    /* In-memory navigation remains available. */
  }
}

export const Navigation = createContext(() => {
  location.hash = '#/home';
});

/** A small, bounded trail within the app. Home always starts a fresh trip. */
export function useNavigation(current: string, main: RefObject<HTMLElement | null>) {
  const trail = useRef(restore(current));
  useEffect(() => {
    const visit = (event: Event) => {
      if (event instanceof HashChangeEvent) {
        const old = canonicalRoute(new URL(event.oldURL).hash);
        // replaceState does not emit an event. Reconcile only a closed sub-view;
        // blindly recording oldURL reintroduces pages removed by Back.
        if (trail.current.at(-1)?.startsWith(`${old}/`))
          trail.current = visitRoute(trail.current, old);
        // Each event has its own destination, even if several arrive after a slow render.
        trail.current = visitRoute(trail.current, new URL(event.newURL).hash);
      } else trail.current = visitRoute(trail.current, location.hash);
      save(trail.current);
    };
    save(trail.current);
    window.addEventListener('hashchange', visit);
    window.addEventListener('pagehide', visit);
    return () => {
      window.removeEventListener('hashchange', visit);
      window.removeEventListener('pagehide', visit);
    };
  }, []);
  const back = () => {
    // Consume synchronously so two quick taps cannot use the same stale step.
    trail.current = trail.current.length > 1 ? trail.current.slice(0, -1) : ['home'];
    save(trail.current);
    location.hash = `#/${trail.current.at(-1) ?? 'home'}`;
  };
  const goBack = useRef(back);
  goBack.current = back;
  useEffect(() => {
    const element = main.current;
    if (!element) return;
    let start: { x: number; y: number; at: number } | null = null;
    const begin = (event: TouchEvent) => {
      start = null;
      if (event.touches.length !== 1 || document.querySelector('dialog[open]')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        target.closest(
          'input, textarea, select, button, a, label, summary, [contenteditable="true"], [role="slider"]',
        )
      )
        return;
      // Leave sideways tables, notepads, sliders and native screen-edge gestures alone.
      for (let node = target; node && node !== element; node = node.parentElement!) {
        if (
          node.scrollWidth > node.clientWidth + 2 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return;
      }
      const touch = event.touches[0]!;
      if (touch.clientX < 24) return;
      start = { x: touch.clientX, y: touch.clientY, at: Date.now() };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1 || Math.abs(touch.clientY - start.y) > 35) {
        start = null;
        return;
      }
      if (touch.clientX - start.x > 25 && event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (
        start &&
        touch &&
        touch.clientX - start.x > 85 &&
        Math.abs(touch.clientY - start.y) < 35 &&
        Date.now() - start.at < 900 &&
        !window.getSelection()?.toString()
      )
        goBack.current();
      start = null;
    };
    const cancel = () => {
      start = null;
    };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', cancel);
    return () => {
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', cancel);
    };
  }, [main]);
  return back;
}

export function BackLink() {
  const back = useContext(Navigation);
  return (
    <a
      className="home-back"
      href="#/home"
      onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        back();
      }}
    >
      <ArrowLeft size={17} /> Back
    </a>
  );
}
