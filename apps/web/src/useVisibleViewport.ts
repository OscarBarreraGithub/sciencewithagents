import { useEffect, useState } from 'react';

export type VisibleViewport = {
  /** Height in CSS px: the area above an open keyboard, otherwise the full layout. */
  height: number;
  top: number;
  /** An on-screen keyboard shortens the visible area; fixed surfaces should cover exactly it. */
  keyboard: boolean;
};

// Phone keyboards shrink and pan the visual viewport (offsetTop) without resizing the layout
// viewport or 100dvh. While one is open, fixed app surfaces cover exactly the visible area so
// their composers stay above it. Every other state uses the full layout instead of the last
// keyboard geometry: following a full-height rubber-band offset opens blank bands, and while
// pinch-zoomed (Safari keeps zoom after the keyboard closes) the native visual viewport pans
// across the whole layout. Fractional scales from rounding count as unzoomed.
export function visibleViewport(): VisibleViewport {
  const layout = Math.max(document.documentElement.clientHeight, innerHeight);
  const viewport = window.visualViewport;
  if (viewport && Math.abs(viewport.scale - 1) < 0.01 && viewport.height < layout - 80)
    return { height: viewport.height, top: Math.max(0, viewport.offsetTop), keyboard: true };
  return { height: layout, top: 0, keyboard: false };
}

const settleMs = 700;

/** Calls `change` with each new visible viewport, starting with the current one. */
export function watchVisibleViewport(change: (view: VisibleViewport) => void) {
  const viewport = window.visualViewport;
  let last: VisibleViewport | undefined;
  let frame = 0;
  let until = 0;
  const update = () => {
    const next = visibleViewport();
    if (last?.height === next.height && last.top === next.top && last.keyboard === next.keyboard)
      return;
    last = next;
    change(next);
  };
  // Keyboard, rotation, navigation and resume transitions can report intermediate geometry or
  // finish without a final viewport event. Re-read each frame briefly after them; no polling.
  const step = () => {
    update();
    frame = performance.now() < until ? requestAnimationFrame(step) : 0;
  };
  const settle = () => {
    update();
    until = performance.now() + settleMs;
    if (!frame) frame = requestAnimationFrame(step);
  };
  const windowEvents = ['resize', 'orientationchange', 'pageshow', 'hashchange', 'popstate'];
  const documentEvents = ['focusin', 'focusout', 'visibilitychange'];
  update();
  viewport?.addEventListener('resize', settle);
  viewport?.addEventListener('scroll', update);
  for (const name of windowEvents) window.addEventListener(name, settle);
  for (const name of documentEvents) document.addEventListener(name, settle, true);
  return () => {
    viewport?.removeEventListener('resize', settle);
    viewport?.removeEventListener('scroll', update);
    for (const name of windowEvents) window.removeEventListener(name, settle);
    for (const name of documentEvents) document.removeEventListener(name, settle, true);
    cancelAnimationFrame(frame);
  };
}

/** Keeps `--{name}-height` and `--{name}-top` on a fixed element while a keyboard is open;
 *  otherwise removes them so the element's CSS full-screen fallbacks apply. */
export function fitToVisibleViewport(element: HTMLElement, name: string) {
  return watchVisibleViewport((view) => {
    for (const [property, value] of [
      [`--${name}-height`, view.height],
      [`--${name}-top`, view.top],
    ] as const) {
      if (view.keyboard) element.style.setProperty(property, `${value}px`);
      else element.style.removeProperty(property);
    }
  });
}

/** The current visible viewport while `enabled`; undefined when disabled. */
export function useVisibleViewport(enabled = true) {
  const [view, setView] = useState<VisibleViewport | undefined>(() =>
    enabled ? visibleViewport() : undefined,
  );
  useEffect(() => {
    if (!enabled) return;
    const stop = watchVisibleViewport(setView);
    return () => {
      stop();
      setView(undefined);
    };
  }, [enabled]);
  return enabled ? view : undefined;
}
