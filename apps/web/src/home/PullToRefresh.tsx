import { useEffect, useState, type RefObject } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { refreshHome } from './refreshHome';

// Only Home's outer scroller: never capture chat, notepad or panel gestures.
export function PullToRefresh({ main }: { main: RefObject<HTMLElement | null> }) {
  const [distance, setDistance] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'refreshing' | 'done' | 'error'>('idle');
  useEffect(() => {
    const element = main.current;
    if (!element) return;
    let start: { x: number; y: number } | null = null;
    let pull = 0,
      busy = false,
      alive = true;
    let dismiss: number | undefined;
    const cancel = () => {
      start = null;
      pull = 0;
      setDistance(0);
    };
    const begin = (event: TouchEvent) => {
      cancel();
      if (
        busy ||
        element.scrollTop > 0 ||
        event.touches.length !== 1 ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        target.closest(
          'input, textarea, select, button, label, summary, [contenteditable="true"], [role="slider"], .overview-section-body',
        )
      )
        return;
      for (let node = target; node && node !== element; node = node.parentElement!) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return;
      }
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1 || element.scrollTop > 0) return cancel();
      const dx = touch.clientX - start.x,
        dy = touch.clientY - start.y;
      if (Math.abs(dx) > 25 || dy < -5) return cancel();
      if (dy < 8) return;
      if (event.cancelable) event.preventDefault();
      window.clearTimeout(dismiss);
      setPhase('idle');
      pull = Math.min(80, dy * 0.55);
      setDistance(pull);
    };
    const end = () => {
      const ready = pull >= 52;
      cancel();
      if (!ready || busy) return;
      busy = true;
      setPhase('refreshing');
      void refreshHome().then((ok) => {
        busy = false;
        if (!alive) return;
        setPhase(ok ? 'done' : 'error');
        dismiss = window.setTimeout(() => setPhase('idle'), ok ? 1600 : 4000);
      });
    };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', cancel);
    return () => {
      alive = false;
      window.clearTimeout(dismiss);
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', cancel);
    };
  }, [main]);
  const showing = distance > 0 || phase !== 'idle';
  const label =
    phase === 'refreshing'
      ? 'Refreshing…'
      : phase === 'done'
        ? 'Updated'
        : phase === 'error'
          ? 'Couldn’t refresh. Pull to retry.'
          : distance >= 52
            ? 'Release to refresh'
            : 'Pull to refresh';
  return (
    <div className="home-pull-refresh" role="status" aria-live="polite">
      {showing && (
        <div
          className={`home-pull-wheel ${phase}`}
          style={{ transform: `translateY(${phase === 'idle' ? distance / 3 : 16}px)` }}
        >
          {phase === 'done' ? (
            <Check size={17} />
          ) : (
            <RefreshCw
              size={17}
              style={phase === 'idle' ? { transform: `rotate(${distance * 4}deg)` } : undefined}
            />
          )}
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}
