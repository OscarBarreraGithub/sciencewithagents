import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import type { ResourceCheck, ResourceSample } from '@dock/shared';
import { useScrollHints } from './useScrollHints';
import {
  activeCheck,
  gb,
  mbps,
  percent,
  pressureLabels,
  reasonLabels,
  ReportText,
  stateLabels,
  when,
} from './health-shared';

export type HistoryRequest =
  | { kind: 'list'; nonce: number }
  | { kind: 'reading'; at: string; nonce: number }
  | { kind: 'report'; id: string; nonce: number };
type Open = { kind: 'reading'; at: string } | { kind: 'report'; id: string } | null;
const pageSize = { reports: 6, readings: 8 };

function busy(s: ResourceSample) {
  return (
    s.memoryPressure === 'warning' ||
    s.memoryPressure === 'critical' ||
    (s.swapOutBytesPerSecond ?? 0) > 1024 ** 2 ||
    (s.machine?.cpuUsedPercent ?? 0) >= 80 ||
    (s.hottestCorePercent ?? 0) >= 95
  );
}
export function reportFallback(check: ResourceCheck) {
  return check.state === 'queued'
    ? 'Waiting for its turn in QUARK.'
    : check.state === 'running'
      ? 'Looking at the saved readings and current work…'
      : check.state === 'completed'
        ? 'This check finished without a written report.'
        : 'This check did not finish. It was not replayed; you can ask again.';
}

function ReadingDetail({ sample }: { sample: ResourceSample }) {
  const m = sample.machine;
  const rows: [string, string | null][] = [
    ['Whole-computer CPU', percent(m?.cpuUsedPercent)],
    ['Busiest core', percent(sample.hottestCorePercent)],
    ['Memory pressure', pressureLabels[sample.memoryPressure]],
    ['Memory available', m ? `${gb(m.memoryAvailableBytes)} of ${gb(m.memoryTotalBytes)}` : null],
    ['Compressed memory', gb(sample.compressedBytes)],
    ['Swapping out', mbps(sample.swapOutBytesPerSecond)],
    ['Swap in use', gb(sample.swapUsedBytes)],
    [
      'Storage available',
      m?.diskAvailableBytes != null
        ? `${gb(m.diskAvailableBytes)}${sample.diskTotalBytes ? ` of ${gb(sample.diskTotalBytes)}` : ''}`
        : null,
    ],
    ['Load per core', m ? m.loadPerCore.toFixed(2) : null],
    ['Processes', sample.processCount === null ? null : String(sample.processCount)],
  ];
  return (
    <>
      <dl className="health-detail-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={value === null ? 'is-missing' : ''}>{value ?? 'Not measured'}</dd>
          </div>
        ))}
      </dl>
      <h4>App-managed work at that time</h4>
      {sample.jobs.length ? (
        <ul className="health-detail-jobs">
          {sample.jobs.map((job) => (
            <li key={job.id}>
              <span>
                <strong>{job.projectName ?? 'Not in a project'}</strong>
                <small>
                  {job.name} · {job.kind === 'agent' ? 'agent' : 'local job'} · {job.status}
                </small>
              </span>
              <span>{percent(job.cpuPercent) ?? '—'}</span>
              <span>{gb(job.memoryBytes)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No app-managed work was visible in this reading.</p>
      )}
      <p className="health-footnote">
        App-by-app breakdowns are kept only for the current reading.
        {sample.unavailable.length ? ` ${sample.unavailable.join(' ')}` : ''}
      </p>
    </>
  );
}

export function HealthHistory({
  checks,
  samples,
  modelName,
  request,
  onContinue,
  onStop,
  stopping,
  stopError,
}: {
  checks: ResourceCheck[];
  samples: ResourceSample[];
  modelName: (id: string) => string;
  request: HistoryRequest | null;
  onContinue: (check: ResourceCheck) => void;
  onStop: (check: ResourceCheck) => void;
  stopping: boolean;
  stopError: string;
}) {
  const [tab, setTab] = useState<'reports' | 'readings'>('reports');
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState<'all' | ResourceCheck['reason']>('all');
  const [outcome, setOutcome] = useState<'all' | 'active' | 'answered' | 'unfinished'>('all');
  const [pressureOnly, setPressureOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Open>(null);
  const section = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const hint = useScrollHints(scroll, `${tab}:${page}:${JSON.stringify(open)}`);
  useEffect(() => {
    if (!request) return;
    setTab(request.kind === 'reading' ? 'readings' : 'reports');
    setOpen(
      request.kind === 'reading'
        ? { kind: 'reading', at: request.at }
        : request.kind === 'report'
          ? { kind: 'report', id: request.id }
          : null,
    );
    if (request.kind === 'list') setPage(0);
    section.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [request]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
  }, [open, tab, page]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const reports = checks.filter(
    (c) =>
      (reason === 'all' || c.reason === reason) &&
      (outcome === 'all' ||
        (outcome === 'active'
          ? activeCheck(c)
          : outcome === 'answered'
            ? c.state === 'completed'
            : ['failed', 'interrupted', 'cancelled'].includes(c.state))) &&
      matches(
        [
          reasonLabels[c.reason],
          stateLabels[c.state],
          modelName(c.model),
          c.model,
          when(c.createdAt),
          c.summary,
          c.escalatedFrom ? 'grad consultation' : '',
        ].join(' '),
      ),
  );
  const readings = [...samples]
    .reverse()
    .filter(
      (s) =>
        (!pressureOnly || busy(s)) &&
        matches(
          [
            when(s.observedAt),
            pressureLabels[s.memoryPressure],
            ...s.jobs.map((j) => `${j.projectName ?? ''} ${j.name}`),
          ].join(' '),
        ),
    );
  const list = tab === 'reports' ? reports : readings;
  const size = pageSize[tab];
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(page, pages - 1);
  const openedReport = open?.kind === 'report' ? checks.find((c) => c.id === open.id) : undefined;
  const openedReading =
    open?.kind === 'reading' ? samples.find((s) => s.observedAt === open.at) : undefined;
  const nearest = (iso: string) => {
    const at = Date.parse(iso);
    let best: ResourceSample | undefined;
    for (const s of samples)
      if (
        !best ||
        Math.abs(Date.parse(s.observedAt) - at) < Math.abs(Date.parse(best.observedAt) - at)
      )
        best = s;
    return best && Math.abs(Date.parse(best.observedAt) - at) <= 20 * 60_000 ? best : undefined;
  };
  const reset = () => {
    setPage(0);
    setOpen(null);
  };
  return (
    <section className="health-section" aria-labelledby="health-history" ref={section}>
      <div className="health-section-heading">
        <div>
          <h2 id="health-history">History</h2>
          <p>Earlier diagnoses and saved readings, opened one at a time</p>
        </div>
        <div className="health-segmented" role="group" aria-label="History records">
          <button
            aria-pressed={tab === 'reports'}
            onClick={() => {
              setTab('reports');
              reset();
            }}
          >
            Diagnoses ({checks.length})
          </button>
          <button
            aria-pressed={tab === 'readings'}
            onClick={() => {
              setTab('readings');
              reset();
            }}
          >
            Readings ({samples.length})
          </button>
        </div>
      </div>
      <div className="health-history">
        <div className="health-history-filters">
          <label className="health-search">
            <Search size={16} aria-hidden />
            <span className="health-visually-hidden">Search {tab}</span>
            <input
              type="search"
              value={query}
              maxLength={100}
              placeholder={
                tab === 'reports' ? 'Search reports, models, dates' : 'Search times, projects, jobs'
              }
              onChange={(e) => {
                setQuery(e.target.value);
                reset();
              }}
            />
          </label>
          {tab === 'reports' ? (
            <>
              <label>
                <span>Kind</span>
                <select
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value as typeof reason);
                    reset();
                  }}
                >
                  <option value="all">All kinds</option>
                  <option value="asked">Your questions</option>
                  <option value="pressure">Pressure checks</option>
                  <option value="checkpoint">Routine checks</option>
                </select>
              </label>
              <label>
                <span>Outcome</span>
                <select
                  value={outcome}
                  onChange={(e) => {
                    setOutcome(e.target.value as typeof outcome);
                    reset();
                  }}
                >
                  <option value="all">Any outcome</option>
                  <option value="active">Queued or running</option>
                  <option value="answered">Answered</option>
                  <option value="unfinished">Stopped or unfinished</option>
                </select>
              </label>
            </>
          ) : (
            <label className="health-check">
              <input
                type="checkbox"
                checked={pressureOnly}
                onChange={(e) => {
                  setPressureOnly(e.target.checked);
                  reset();
                }}
              />
              <span>Only busy readings</span>
            </label>
          )}
        </div>
        <div className="health-history-body" ref={scroll}>
          {openedReport || openedReading ? (
            <article className="health-history-detail">
              <button className="health-text-button" onClick={() => setOpen(null)}>
                <ArrowLeft size={16} /> Back to the list
              </button>
              {openedReport ? (
                <>
                  <h3>
                    {reasonLabels[openedReport.reason]}
                    {openedReport.escalatedFrom ? ' · grad consultation' : ''}
                  </h3>
                  <p className="health-meta">
                    {when(openedReport.createdAt)} · {stateLabels[openedReport.state]} ·{' '}
                    {modelName(openedReport.model)}
                  </p>
                  {openedReport.waitReason && (
                    <p className="health-wait">{openedReport.waitReason}</p>
                  )}
                  <ReportText text={openedReport.summary} fallback={reportFallback(openedReport)} />
                  <div className="health-actions">
                    <button onClick={() => onContinue(openedReport)}>Continue in chat</button>
                    {(() => {
                      const reading = nearest(openedReport.createdAt);
                      return reading ? (
                        <button
                          onClick={() => setOpen({ kind: 'reading', at: reading.observedAt })}
                        >
                          Reading near that time
                        </button>
                      ) : null;
                    })()}
                    {activeCheck(openedReport) && (
                      <button disabled={stopping} onClick={() => onStop(openedReport)}>
                        {stopping ? 'Stopping…' : 'Stop this check'}
                      </button>
                    )}
                  </div>
                  {stopError && activeCheck(openedReport) && (
                    <p role="alert" className="health-alert">
                      {stopError}
                    </p>
                  )}
                </>
              ) : (
                openedReading && (
                  <>
                    <h3>Reading · {when(openedReading.observedAt)}</h3>
                    <ReadingDetail sample={openedReading} />
                  </>
                )
              )}
            </article>
          ) : open ? (
            <p className="health-empty">
              That record is no longer in the saved window.{' '}
              <button className="health-text-button" onClick={() => setOpen(null)}>
                Back to the list
              </button>
            </p>
          ) : list.length === 0 ? (
            <p className="health-empty">
              {(tab === 'reports' ? checks.length : samples.length) === 0
                ? tab === 'reports'
                  ? 'No diagnoses yet. Ask above when something seems slow.'
                  : 'No saved readings yet.'
                : 'Nothing matches these filters.'}
            </p>
          ) : (
            <ul className="health-history-list">
              {tab === 'reports'
                ? reports.slice(current * size, current * size + size).map((c) => (
                    <li key={c.id}>
                      <button onClick={() => setOpen({ kind: 'report', id: c.id })}>
                        <span className="health-row-top">
                          <strong>
                            {reasonLabels[c.reason]}
                            {c.escalatedFrom ? ' · grad' : ''}
                          </strong>
                          <span className={`health-state is-${c.state}`}>
                            {stateLabels[c.state]}
                          </span>
                        </span>
                        <small>
                          {when(c.createdAt)} · {modelName(c.model)}
                        </small>
                        <span className="health-row-preview">
                          {c.summary.replace(/[#*_`>]/g, '').slice(0, 220) || reportFallback(c)}
                        </span>
                      </button>
                    </li>
                  ))
                : readings.slice(current * size, current * size + size).map((s) => (
                    <li key={s.observedAt}>
                      <button onClick={() => setOpen({ kind: 'reading', at: s.observedAt })}>
                        <span className="health-row-top">
                          <strong>{when(s.observedAt)}</strong>
                          <span className={`health-state is-${s.memoryPressure}`}>
                            Memory {pressureLabels[s.memoryPressure].toLowerCase()}
                          </span>
                        </span>
                        <small>
                          CPU {percent(s.machine?.cpuUsedPercent) ?? 'not measured'} · busiest core{' '}
                          {percent(s.hottestCorePercent) ?? 'not measured'} · swapping{' '}
                          {mbps(s.swapOutBytesPerSecond) ?? 'not measured'}
                        </small>
                      </button>
                    </li>
                  ))}
            </ul>
          )}
        </div>
        <div className="health-history-foot">
          <span className="health-hint" aria-hidden={!hint}>
            {hint}
          </span>
          {!open && list.length > size && (
            <div className="health-pager">
              <button disabled={current === 0} onClick={() => setPage(current - 1)}>
                Newer
              </button>
              <span>
                {current * size + 1}–{Math.min(list.length, current * size + size)} of {list.length}
              </span>
              <button disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                Older
              </button>
            </div>
          )}
        </div>
      </div>
      <p className="health-footnote">
        Diagnoses: the latest 20 on this computer; each conversation keeps its full saved history.
        Readings: one a minute for 24 hours, listed at up to 96 evenly spaced times.
      </p>
    </section>
  );
}
