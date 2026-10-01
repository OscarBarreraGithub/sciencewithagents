import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';
import { ArrowLeft } from 'lucide-react';
import { apiScope } from '../api';

const key = () => `dock:${apiScope()}:navigation`;
function restore(current: string): string[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key()) ?? 'null');
    if (
      Array.isArray(saved) &&
      saved.length <= 12 &&
      saved.every((r) => typeof r === 'string') &&
      saved.at(-1) === current
    )
      return saved;
  } catch {
    /* A direct link still has a way home. */
  }
  return current === 'home' ? ['home'] : ['home', current];
}

export const Navigation = createContext(() => {
  location.hash = '#/home';
});

/** A small, bounded trail within the app. Home always starts a fresh trip. */
export function useNavigation(current: string, main: RefObject<HTMLElement | null>) {
  const trail = useRef(restore(current));
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(key(), JSON.stringify(trail.current));
      } catch {
        /* In-memory navigation remains available. */
      }
    };
    const visit = () => {
      const next = location.hash.startsWith('#/') ? location.hash.slice(2) || 'home' : 'home';
      const previous = trail.current.indexOf(next);
      trail.current =
        next === 'home'
          ? ['home']
          : previous >= 0
            ? trail.current.slice(0, previous + 1)
            : [...trail.current, next].slice(-12);
      // Save at the navigation event, before rendering; a fast reload must retain the return route.
      save();
    };
    save();
    window.addEventListener('hashchange', visit);
    window.addEventListener('pagehide', visit);
    return () => {
      window.removeEventListener('hashchange', visit);
      window.removeEventListener('pagehide', visit);
    };
  }, []);
  const back = () => {
    location.hash = `#/${trail.current.at(-2) ?? 'home'}`;
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
