import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';

const shapes = ['breathing', 'shaping', 'connecting', 'weaving', 'solving'] as const;

export function HeaderOrb() {
  const [shape, setShape] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stop = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(stop.current), []);
  return (
    <button
      type="button"
      className="home-icon-button home-orb"
      aria-label="Change orb shape"
      title="Tap to change shape"
      onClick={() => {
        setShape((old) => (old + 1) % shapes.length);
        setPlaying(true);
        window.clearTimeout(stop.current);
        stop.current = window.setTimeout(() => setPlaying(false), 1800);
      }}
    >
      <ThinkingOrb
        state={shapes[shape]}
        size={20}
        speed={0.65}
        theme="light"
        paused={!playing}
        aria-hidden="true"
      />
    </button>
  );
}
