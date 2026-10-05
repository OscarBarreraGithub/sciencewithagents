import type { ProjectRates } from '@dock/shared';
export function RateHistory({ rate }: { rate?: ProjectRates['rates'][number] }) {
  const points = rate?.history ?? [],
    known = points.filter((point) => point.estimatedPercentPerHour !== null);
  const max = Math.max(1, ...known.map((point) => point.estimatedPercentPerHour!));
  const segments: string[] = [];
  let segment = '';
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous && previous.resetsAt !== point.resetsAt && segment) {
      segments.push(segment);
      segment = '';
    }
    if (point.coverageMinutes < 29.9) {
      if (segment) segments.push(segment);
      segment = '';
      return;
    }
    if (point.estimatedPercentPerHour === null) {
      if (segment) segments.push(segment);
      segment = '';
      return;
    }
    const x = 6 + (index / 23) * 288,
      y = 54 - (point.estimatedPercentPerHour / max) * 44;
    segment += `${segment ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    if (index === points.length - 1 && segment) segments.push(segment);
  });
  return (
    <figure className="quark-rate-history">
      <figcaption>
        Last 12 hours{' '}
        <span>
          {known.length
            ? `${Math.round(rate!.historyCoverageMinutes)} min observed`
            : 'History not yet available'}
        </span>
      </figcaption>
      <svg
        viewBox="0 0 300 64"
        role="img"
        aria-label={`Estimated project usage over the last 12 hours; ${Math.round(rate?.historyCoverageMinutes ?? 0)} minutes of observed coverage. Gaps mean unknown usage.`}
      >
        <path d="M6,54 H294" className="quark-rate-axis" />
        {segments.map((path, index) => (
          <path key={index} d={path} className="quark-rate-line" />
        ))}
        {points.map(
          (point, index) =>
            point.estimatedPercentPerHour !== null && (
              <circle
                key={index}
                cx={6 + (index / 23) * 288}
                cy={54 - (point.estimatedPercentPerHour / max) * 44}
                r="2.4"
                className="quark-rate-point"
              >
                <title>
                  {new Date(point.from).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  : ≈{point.estimatedPercentPerHour.toFixed(1)}% / hour ·{' '}
                  {Math.round(point.coverageMinutes)} min observed
                </title>
              </circle>
            ),
        )}
      </svg>
      <div className="quark-rate-chart-labels">
        <span>12h ago</span>
        <span>
          {known.length ? `Scale 0–${Number(max.toFixed(1))}% / hour` : 'Missing readings are gaps'}
        </span>
        <span>Now</span>
      </div>
    </figure>
  );
}
