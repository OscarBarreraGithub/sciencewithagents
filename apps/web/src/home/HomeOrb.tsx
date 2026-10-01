import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';

// Keep the flowing particle forms; omit the polygon outline and Rubik-like preset.
const shapes = [
  'working',
  'searching',
  'listening',
  'connecting',
  'weaving',
  'composing',
  'breathing',
] as const;

function randomOrb(previous?: OrbState) {
  const choices = shapes.filter((shape) => shape !== previous);
  return {
    shape: choices[Math.floor(Math.random() * choices.length)]!,
    rotation: Math.random() * 360,
    speed: 0.55 + Math.random() * 0.2,
  };
}

export function HomeOrb({ size = 64 }: { size?: 20 | 64 }) {
  const [orb, setOrb] = useState(() => randomOrb());
  const [playing, setPlaying] = useState(false);
  const stop = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(stop.current), []);
  return (
    <button
      type="button"
      className="home-icon-button home-orb"
      style={{ width: size === 64 ? 80 : 44, height: size === 64 ? 80 : 44 }}
      aria-label="Change orb shape"
      title="Tap to change shape"
      onClick={() => {
        setOrb(randomOrb(orb.shape));
        setPlaying(true);
        window.clearTimeout(stop.current);
        stop.current = window.setTimeout(() => setPlaying(false), 1800);
      }}
    >
      <ThinkingOrb
        state={orb.shape}
        size={size}
        speed={orb.speed}
        style={{ transform: `rotate(${orb.rotation}deg)` }}
        theme="light"
        paused={!playing}
        aria-hidden="true"
      />
    </button>
  );
}
