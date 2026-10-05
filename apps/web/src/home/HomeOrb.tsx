import { useEffect, useRef, useState } from 'react';
import { MODE_DRAWS, resolvePreset, type ModeOpts } from 'thinking-orbs/engine';

// Flowing particle forms only: no polygon morph (it becomes a square) or Rubik-like turns.
// Each form varies a few of its own counts/proportions within ranges that keep its character.
const forms = {
  working: [
    ['orbitN', 0.75, 1.25],
    ['particles', 0.67, 1.34],
  ],
  searching: [
    ['latRings', 0.8, 1.2],
    ['scanMul', 0.8, 1.2],
  ],
  listening: [['rings', 0.8, 1.35]],
  connecting: [
    ['nodeN', 0.8, 1.2],
    ['thr', 0.92, 1.08],
  ],
  weaving: [['turns', 0.67, 1.34]],
  composing: [
    ['lanes', 0.67, 1.67],
    ['wobMul', 0.7, 1.3],
  ],
  breathing: [
    ['lanes', 0.67, 1.34],
    ['wobMul', 0.7, 1.6],
  ],
} as const;
type Form = keyof typeof forms;
// Ink plus soft two-colour tints drawn from the app's palette.
const tints = [
  null,
  ['#3f55d6', '#1f2330'],
  ['#2f7c86', '#284f6e'],
  ['#7a4bb0', '#3f4fae'],
  ['#b4612e', '#8f3446'],
  ['#2f7d55', '#2f6670'],
] as const;
type Variant = {
  id: number;
  form: Form;
  /** The last two forms, so successive taps keep changing character. */
  recent: Form[];
  opts: ModeOpts;
  speed: number;
  phase: number;
  rotation: number;
  mirror: boolean;
  tint: (typeof tints)[number];
};
const between = (low: number, high: number) => low + Math.random() * (high - low);
let variants = 0;
function randomVariant(size: 20 | 64, previous?: Variant): Variant {
  const recent = previous ? [previous.form, ...previous.recent].slice(0, 2) : [];
  const choices = (Object.keys(forms) as Form[]).filter((form) => !recent.includes(form));
  const form = choices[Math.floor(Math.random() * choices.length)]!;
  const preset = resolvePreset(form, size);
  const opts = { ...preset.opts };
  for (const [key, low, high] of forms[form]) {
    const value = opts[key];
    if (value === undefined) continue;
    const varied = value * between(low, high);
    opts[key] = Number.isInteger(value) ? Math.max(2, Math.round(varied)) : varied;
  }
  return {
    id: ++variants,
    form,
    recent,
    opts,
    speed: preset.speed * between(0.85, 1.15),
    phase: Math.random() * 1000,
    rotation: Math.random() * 360,
    mirror: Math.random() < 0.5,
    tint: tints[Math.floor(Math.random() * tints.length)]!,
  };
}
// Idle motion is slow and drawn at a low frame rate; a tap briefly livens it.
const idle = { pace: 0.2, interval: 1000 / 12 };
const lively = { pace: 0.9, interval: 1000 / 30, ms: 2400 };

export function HomeOrb({ size = 64 }: { size?: 20 | 64 }) {
  const [variant, setVariant] = useState(() => randomVariant(size));
  const canvas = useRef<HTMLCanvasElement>(null);
  const tapped = useRef(-Infinity);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    element.width = Math.round(size * ratio);
    element.height = Math.round(size * ratio);
    const draw = MODE_DRAWS[resolvePreset(variant.form, size).mode];
    let time = variant.phase;
    const paint = () => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, size, size);
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      draw(context, size, time, false, variant.opts);
      if (!variant.tint) return;
      // Colour the drawn dots only; their alpha keeps the depth shading.
      const gradient = context.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, variant.tint[0]);
      gradient.addColorStop(1, variant.tint[1]);
      context.globalCompositeOperation = 'source-atop';
      context.globalAlpha = 0.88;
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    let last = performance.now();
    let visible = true;
    const running = () => visible && !document.hidden && !reduced.matches;
    const tick = () => {
      const now = performance.now();
      const since = now - tapped.current;
      const pace =
        since < lively.ms
          ? idle.pace + (lively.pace - idle.pace) * (1 - since / lively.ms) ** 2
          : idle.pace;
      time += (Math.min(now - last, 250) / 1000) * variant.speed * pace;
      last = now;
      paint();
      timer = window.setTimeout(tick, since < lively.ms ? lively.interval : idle.interval);
    };
    const update = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (!running()) return;
      last = performance.now();
      timer = window.setTimeout(tick, idle.interval);
    };
    paint();
    update();
    // Offscreen, hidden and reduced-motion orbs keep one still frame and use no timer.
    const observer =
      'IntersectionObserver' in window
        ? new IntersectionObserver(([entry]) => {
            visible = !!entry?.isIntersecting;
            update();
          })
        : null;
    observer?.observe(element);
    document.addEventListener('visibilitychange', update);
    reduced.addEventListener('change', update);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      reduced.removeEventListener('change', update);
    };
  }, [variant, size]);
  const box = size === 64 ? 80 : 44;
  return (
    <button
      type="button"
      className="home-icon-button home-orb"
      style={{ width: box, height: box }}
      aria-label="Change orb shape"
      title="Tap to change shape"
      data-form={variant.form}
      onClick={() => {
        tapped.current = performance.now();
        setVariant((current) => randomVariant(size, current));
      }}
    >
      <canvas
        key={variant.id}
        ref={canvas}
        className="home-orb-canvas"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          transform: `rotate(${variant.rotation}deg)${variant.mirror ? ' scaleX(-1)' : ''}`,
        }}
      />
    </button>
  );
}
