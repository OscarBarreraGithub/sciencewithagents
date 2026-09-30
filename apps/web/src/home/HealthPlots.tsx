import { useRef, useState, type KeyboardEvent } from 'react';
import type { ResourceSample } from '@dock/shared';
import { clock, gb, mbps, percent, pressureLabels } from './health-shared';

type Series = {
  id: 'cpu' | 'core' | 'memory' | 'swap';
  title: string;
  note: string;
  value: (s: ResourceSample) => number | null;
  format: (n: number | null) => string | null;
  ticks: (max: number) => string[];
};
// Axis labels are bare numbers so they fit phone widths; each note names the unit.
const pctTicks = () => ['100', '50', '0'];
const scaled = (unit: number) => (max: number) => {
  const digits = max / unit < 10 ? 1 : 0;
  return [(max / unit).toFixed(digits), (max / 2 / unit).toFixed(digits), '0'];
};
const series: Series[] = [
  {
    id: 'cpu',
    title: 'Whole-computer CPU',
    note: '% of all cores together',
    value: (s) => s.machine?.cpuUsedPercent ?? null,
    format: percent,
    ticks: pctTicks,
  },
  {
    id: 'core',
    title: 'Busiest core',
    note: '% of the most loaded core',
    value: (s) => s.hottestCorePercent,
    format: percent,
    ticks: pctTicks,
  },
  {
    id: 'memory',
    title: 'Memory available',
    note: 'GB · band shows memory pressure',
    value: (s) => (s.machine ? s.machine.memoryAvailableBytes : null),
    format: gb,
    ticks: scaled(1024 ** 3),
  },
  {
    id: 'swap',
    title: 'Swapping out',
    note: 'MB/s written to disk',
    value: (s) => s.swapOutBytesPerSecond,
    format: mbps,
    ticks: scaled(1024 ** 2),
  },
];
const ranges = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
];
const W = 600,
  H = 120;

function scaleMax(spec: Series, values: number[], totalMemory: number | null) {
  if (spec.id === 'cpu' || spec.id === 'core') return 100;
  if (spec.id === 'memory') return totalMemory ?? Math.max(1024 ** 3, ...values);
  // Keep a visible floor so near-zero swap noise does not look like a spike.
  return Math.max(10 * 1024 ** 2, ...values) * 1.1;
}

/** Break the line at missing values and time gaps rather than drawing across them. */
function paths(points: { x: number; y: number | null; at: number }[], gap: number) {
  let line = '',
    area = '',
    run: { x: number; y: number }[] = [],
    previous: number | null = null;
  const flush = () => {
    const first = run[0],
      last = run[run.length - 1];
    if (first && last) {
      line +=
        run.length === 1
          ? `M${(first.x - 2).toFixed(1)},${first.y.toFixed(1)}H${(first.x + 2).toFixed(1)}`
          : run.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
      area +=
        run.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') +
        `L${last.x.toFixed(1)},${H}L${first.x.toFixed(1)},${H}Z`;
    }
    run = [];
  };
  for (const point of points) {
    if (point.y === null) {
      flush();
      previous = null;
      continue;
    }
    if (previous !== null && point.at - previous > gap) flush();
    run.push({ x: point.x, y: point.y });
    previous = point.at;
  }
  flush();
  return { line, area };
}

function Plot({
  spec,
  samples,
  x,
  gap,
  hover,
  setHover,
  pick,
  open,
  totalMemory,
}: {
  spec: Series;
  samples: ResourceSample[];
  x: (s: ResourceSample) => number;
  gap: number;
  hover: number | null;
  setHover: (index: number | null) => void;
  pick: (clientX: number, rect: DOMRect) => number;
  open: (sample: ResourceSample) => void;
  totalMemory: number | null;
}) {
  const pointer = useRef('mouse');
  const values = samples.map(spec.value);
  const present = values.filter((v): v is number => v !== null);
  const max = scaleMax(spec, present, totalMemory);
  const y = (v: number) => H - 4 - (Math.min(max, Math.max(0, v)) / max) * (H - 10);
  const { line, area } = paths(
    samples.map((s, i) => {
      const v = values[i] ?? null;
      return { x: x(s), y: v === null ? null : y(v), at: Date.parse(s.observedAt) };
    }),
    gap,
  );
  let latest = -1;
  values.forEach((v, i) => {
    if (v !== null) latest = i;
  });
  const shown = hover ?? (latest >= 0 ? latest : null);
  const shownSample = shown !== null ? samples[shown] : undefined;
  const shownValue = shown !== null ? (values[shown] ?? null) : null;
  const highest = present.length ? Math.max(...present) : null;
  const peak = highest === null ? undefined : samples[values.indexOf(highest)];
  const summary =
    highest !== null && peak
      ? `${spec.title}, ${clock(samples[0]!.observedAt)} to ${clock(samples[samples.length - 1]!.observedAt)}. Latest ${spec.format(values[latest] ?? null)}; highest ${spec.format(highest)} at ${clock(peak.observedAt)}.`
      : `${spec.title}: not measured in this period.`;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = hover ?? samples.length - 1;
    const next =
      event.key === 'ArrowLeft'
        ? Math.max(0, current - 1)
        : event.key === 'ArrowRight'
          ? Math.min(samples.length - 1, current + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? samples.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      setHover(next);
    } else if (event.key === 'Enter' && samples[current]) open(samples[current]);
    else if (event.key === 'Escape') setHover(null);
  };
  return (
    <article className="health-plot">
      <header>
        <div>
          <h3>{spec.title}</h3>
          <small>{spec.note}</small>
        </div>
        <p>
          <strong>{shownSample ? (spec.format(shownValue) ?? 'Not measured') : '—'}</strong>
          <span>{hover === null && shownSample ? 'Latest' : ''}</span>
        </p>
      </header>
      <div className="health-plot-body">
        <div className="health-plot-axis" aria-hidden>
          {spec.ticks(max).map((tick, i) => (
            <span key={i}>{tick}</span>
          ))}
        </div>
        <div
          className="health-plot-area"
          role="img"
          tabIndex={0}
          aria-label={`${summary} Arrow keys inspect readings; Enter opens one in History.`}
          onPointerDown={(event) => {
            pointer.current = event.pointerType;
            setHover(pick(event.clientX, event.currentTarget.getBoundingClientRect()));
          }}
          onPointerMove={(event) =>
            setHover(pick(event.clientX, event.currentTarget.getBoundingClientRect()))
          }
          onClick={(event) => {
            // A tap inspects; a mouse click opens the reading directly.
            if (pointer.current !== 'mouse') return;
            const sample =
              samples[pick(event.clientX, event.currentTarget.getBoundingClientRect())];
            if (sample) open(sample);
          }}
          onKeyDown={keys}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
            <path d={`M0 ${H - 4}H${W}M0 ${(H + 2) / 2}H${W}M0 6H${W}`} className="grid" />
            {area && <path d={area} className="fill" />}
            {line && <path d={line} className="line" />}
            {shownSample && hover !== null && (
              <path d={`M${x(shownSample).toFixed(1)} 0V${H}`} className="cross" />
            )}
          </svg>
          {shownSample && shownValue !== null && (
            <span
              className="health-plot-dot"
              style={{
                left: `${(x(shownSample) / W) * 100}%`,
                top: `${(y(shownValue) / H) * 100}%`,
              }}
            />
          )}
          {!present.length && <p className="health-plot-empty">Not measured in this period</p>}
        </div>
      </div>
      {spec.id === 'memory' && (
        <div className="health-pressure-strip" aria-hidden>
          {samples.map((s, i) => {
            const next = samples[i + 1];
            const left = (x(s) / W) * 100;
            const right =
              next && Date.parse(next.observedAt) - Date.parse(s.observedAt) <= gap
                ? (x(next) / W) * 100
                : Math.min(100, left + 0.8);
            return (
              <span
                key={s.observedAt}
                className={`is-${s.memoryPressure}`}
                style={{ left: `${left}%`, width: `${Math.max(0.6, right - left)}%` }}
              />
            );
          })}
        </div>
      )}
    </article>
  );
}

export function HealthPlots({
  samples: all,
  now,
  open,
}: {
  samples: ResourceSample[];
  now: number;
  open: (sample: ResourceSample) => void;
}) {
  const [hours, setHours] = useState(6);
  const [hover, setHover] = useState<number | null>(null);
  const samples = all.filter((s) => Date.parse(s.observedAt) >= now - hours * 3600_000);
  const times = samples.map((s) => Date.parse(s.observedAt));
  const start = times[0] ?? now,
    span = Math.max(60_000, (times[times.length - 1] ?? start) - start);
  const deltas = times
    .slice(1)
    .map((t, i) => t - times[i]!)
    .sort((a, b) => a - b);
  // Sleep and watcher restarts leave gaps; a typical spacing defines what counts as one.
  const gap = Math.max(5 * 60_000, (deltas[Math.floor(deltas.length / 2)] ?? 60_000) * 2.5);
  const totalMemory = samples.reduce<number | null>(
    (max, s) => (s.machine ? Math.max(max ?? 0, s.machine.memoryTotalBytes) : max),
    null,
  );
  const x = (s: ResourceSample) => ((Date.parse(s.observedAt) - start) / span) * W;
  const pick = (clientX: number, rect: DOMRect) => {
    const at = start + ((clientX - rect.left) / Math.max(1, rect.width)) * span;
    let best = 0;
    times.forEach((t, i) => {
      if (Math.abs(t - at) < Math.abs(times[best]! - at)) best = i;
    });
    return best;
  };
  const shown = hover !== null && hover < samples.length ? hover : null;
  const inspected = shown !== null ? samples[shown] : samples[samples.length - 1];
  const minutes = samples.length > 1 ? Math.round(span / 60_000) : 0;
  return (
    <section className="health-section" aria-labelledby="health-trends">
      <div className="health-section-heading">
        <div>
          <h2 id="health-trends">Trends</h2>
          <p>
            {samples.length > 1
              ? `${samples.length} saved readings over ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`}`
              : 'Trends appear once a few readings are saved'}
          </p>
        </div>
        <div className="health-segmented" role="group" aria-label="Time range">
          {ranges.map((r) => (
            <button
              key={r.hours}
              aria-pressed={hours === r.hours}
              onClick={() => {
                setHours(r.hours);
                setHover(null);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {samples.length > 1 && inspected ? (
        <>
          <div className="health-readout" aria-live="polite">
            <span>
              {shown === null ? 'Latest reading' : 'Reading at'}{' '}
              <strong>{clock(inspected.observedAt)}</strong>
            </span>
            <button onClick={() => open(inspected)}>Open this reading</button>
          </div>
          <div
            className="health-plot-grid"
            // Touch keeps the inspected reading after lifting a finger.
            onPointerLeave={(event) => event.pointerType === 'mouse' && setHover(null)}
          >
            {series.map((spec) => (
              <Plot
                key={spec.id}
                spec={spec}
                samples={samples}
                x={x}
                gap={gap}
                hover={shown}
                setHover={setHover}
                pick={pick}
                open={open}
                totalMemory={totalMemory}
              />
            ))}
          </div>
          <div className="health-plot-foot">
            <span>{clock(samples[0]!.observedAt)}</span>
            <ul className="health-pressure-key" aria-label="Memory pressure band">
              {(['normal', 'warning', 'critical', 'unknown'] as const).map((level) => (
                <li key={level}>
                  <i className={`is-${level}`} /> {pressureLabels[level]}
                </li>
              ))}
            </ul>
            <span>{clock(samples[samples.length - 1]!.observedAt)}</span>
          </div>
        </>
      ) : (
        <p className="health-empty">
          The watcher saves one reading a minute while this computer is awake. Nothing before it
          started is shown.
        </p>
      )}
      <p className="health-footnote">
        Up to 96 evenly spaced readings from the last 24 hours. Gaps mean the computer was asleep or
        the watcher was not running; no values are filled in.
      </p>
    </section>
  );
}
