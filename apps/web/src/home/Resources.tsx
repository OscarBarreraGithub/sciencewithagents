import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Activity, TriangleAlert } from 'lucide-react';
import {
  policyProvider,
  type ResourceCheck,
  type ResourceJob,
  type ResourceSample,
} from '@dock/shared';
import { apiScope } from '../api';
import type { HomeData } from './useHomeData';
import { useScrollHints } from './useScrollHints';
import { HealthAssistant, useHealthModels, type HealthModels } from './HealthAssistant';
import { HealthPlots } from './HealthPlots';
import { AssistantFullscreen } from './AssistantFullscreen';
import {
  ago,
  clock,
  gb,
  percent,
  pressureLabels,
  providerNames,
  useResourceActions,
} from './health-shared';
import './resources.css';

export function ResourceSummary({ reading }: { reading: HomeData['resources'] }) {
  const status = reading.data;
  const fresh = !!status?.latest && !status.stale && !reading.error;
  const findings = fresh ? status.findings : [];
  const title = !fresh
    ? 'Waiting for a health reading'
    : findings.length
      ? findings[0]!.title
      : status.latest?.memoryPressure === 'unknown'
        ? 'Computer health · partial readings'
        : 'Your computer has room to work';
  return (
    <a href="#/resources" className={`resource-home-link ${findings.length ? 'has-pressure' : ''}`}>
      <Activity size={19} />
      <span>
        <strong>{title}</strong>
        <small>
          {findings.length
            ? 'See the readings and ask what’s happening'
            : 'Computer health, app activity & your resource assistant'}
        </small>
      </span>
      <ArrowUpRight size={17} />
    </a>
  );
}

function Metric({
  label,
  value,
  unit,
  detail,
  level,
}: {
  label: string;
  value: string | null;
  unit?: string;
  detail: ReactNode;
  level?: string;
}) {
  return (
    <article className={`health-metric ${level ? `is-${level}` : ''}`}>
      <span>{label}</span>
      {value === null ? (
        <strong className="is-missing">Not measured</strong>
      ) : (
        <strong>
          {level && <i className="health-dot" aria-hidden />}
          {value}
          {unit && <small>{unit}</small>}
        </strong>
      )}
      <p>{detail}</p>
    </article>
  );
}

function Snapshot({ reading, now }: { reading: HomeData['resources']; now: number }) {
  const status = reading.data;
  const sample = status?.latest ?? null;
  const machine = sample?.machine ?? null;
  const stale = !sample || !!status?.stale || reading.error;
  const findings = status?.findings ?? [];
  const pressure = findings.length > 0;
  const freshness = !sample
    ? reading.error
      ? 'Could not reach the watcher on this computer.'
      : 'Waiting for the first reading. The watcher measures every 15 seconds.'
    : stale
      ? `Last reading ${clock(sample.observedAt)} (${ago(sample.observedAt, now)}). Not current: ${reading.error ? 'this page could not reach the watcher' : 'the watcher has not reported recently'}.`
      : `Updated ${ago(sample.observedAt, now)} · measured every 15 seconds`;
  const disk = machine?.diskAvailableBytes ?? null;
  const whole = (n: number | null | undefined) => (n == null ? null : String(Math.round(n)));
  const swap = sample?.swapOutBytesPerSecond ?? null;
  return (
    <section className="health-snapshot" aria-labelledby="health-now">
      <div className="health-section-heading">
        <div>
          <h2 id="health-now">Right now</h2>
          <p className={stale ? 'is-stale' : ''}>{freshness}</p>
        </div>
        {reading.error && <button onClick={reading.retry}>Retry reading</button>}
      </div>
      <div
        className={`health-status ${stale ? 'is-stale' : pressure ? 'is-pressure' : ''}`}
        role="status"
      >
        {pressure || stale ? <TriangleAlert size={18} /> : <Activity size={18} />}
        <div>
          <strong>
            {stale
              ? 'Waiting for fresh readings'
              : pressure
                ? findings[0]!.title
                : sample?.memoryPressure === 'unknown'
                  ? 'No detected pressure · some readings unavailable'
                  : 'No resource pressure detected'}
          </strong>
          {!stale && pressure && <p>{findings[0]!.detail}</p>}
          {stale && sample && <p>The figures below are the saved reading, not the present.</p>}
        </div>
      </div>
      {status?.message && <p className="health-notice">{status.message}</p>}
      <div className={`health-metrics ${stale ? 'is-stale' : ''}`}>
        <Metric
          label="CPU"
          value={whole(machine?.cpuUsedPercent)}
          unit="%"
          detail={
            machine
              ? `Whole computer · ${machine.cpuCount} cores · load ${machine.loadPerCore.toFixed(2)} per core`
              : 'Whole-computer processor use'
          }
        />
        <Metric
          label="Busiest core"
          value={whole(sample?.hottestCorePercent)}
          unit="%"
          detail="One saturated core can slow a single-threaded app"
        />
        <Metric
          label="Memory pressure"
          value={sample ? pressureLabels[sample.memoryPressure] : null}
          level={sample && sample.memoryPressure !== 'unknown' ? sample.memoryPressure : undefined}
          detail={
            machine
              ? `${gb(machine.memoryAvailableBytes)} available of ${gb(machine.memoryTotalBytes)}${machine.memoryBasis === 'free-plus-reclaimable-estimate' ? ' (includes a reclaimable estimate)' : ''}`
              : 'Available memory not measured'
          }
        />
        <Metric
          label="Swap activity"
          value={swap === null ? null : (swap / 1024 ** 2).toFixed(swap >= 10 * 1024 ** 2 ? 0 : 1)}
          unit="MB/s"
          detail={`${gb(sample?.swapUsedBytes) ?? 'Unknown'} swap in use · earlier swap alone can be harmless`}
        />
        <Metric
          label="Storage headroom"
          value={disk === null ? null : (disk / 1024 ** 3).toFixed(disk >= 100 * 1024 ** 3 ? 0 : 1)}
          unit="GB"
          detail={
            disk !== null && sample?.diskTotalBytes
              ? `${Math.round((disk / sample.diskTotalBytes) * 100)}% free of ${gb(sample.diskTotalBytes)} on this workspace’s volume`
              : 'Free space on the volume holding this workspace'
          }
        />
      </div>
      {findings.length > 1 && (
        <ul className="health-findings">
          {findings.slice(1).map((f) => (
            <li key={f.id} className={`is-${f.level}`}>
              <strong>{f.title}</strong>
              <span>{f.detail}</span>
              <small>
                {f.sustained ? 'Sustained' : 'Watching whether it persists'} · since{' '}
                {clock(f.since)}
              </small>
            </li>
          ))}
        </ul>
      )}
      {!!sample?.unavailable.length && (
        <p className="health-footnote">{sample.unavailable.join(' ')}</p>
      )}
    </section>
  );
}

function Apps({ sample }: { sample: ResourceSample | null }) {
  const [order, setOrder] = useState<'cpu' | 'memory'>('cpu');
  const scroll = useRef<HTMLDivElement>(null);
  const hint = useScrollHints(scroll, order);
  const total = sample?.machine?.memoryTotalBytes ?? null;
  const groups = [...(sample?.groups ?? [])].sort((a, b) =>
    order === 'cpu' ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) : b.memoryBytes - a.memoryBytes,
  );
  return (
    <section className="health-panel" aria-labelledby="health-apps">
      <div className="health-section-heading">
        <div>
          <h2 id="health-apps">Apps and processes</h2>
          <p>
            {sample?.processCount == null
              ? 'App readings unavailable'
              : `${sample.processCount} processes, grouped by app`}
          </p>
        </div>
        <div className="health-segmented" role="group" aria-label="Sort apps by">
          <button aria-pressed={order === 'cpu'} onClick={() => setOrder('cpu')}>
            CPU
          </button>
          <button aria-pressed={order === 'memory'} onClick={() => setOrder('memory')}>
            Memory
          </button>
        </div>
      </div>
      <div className="health-table-head" aria-hidden>
        <span>App or process family</span>
        <span>CPU</span>
        <span>Memory</span>
      </div>
      <div className="health-scroll" ref={scroll}>
        {groups.map((group) => {
          const share =
            order === 'cpu'
              ? (group.cpuPercent ?? 0)
              : total
                ? (group.memoryBytes / total) * 100
                : 0;
          const change = group.memoryChangeBytes;
          return (
            <article key={group.name} className="health-row">
              <div>
                <strong>{group.name}</strong>
                <small>
                  {group.processes} processes
                  {change !== null && Math.abs(change) > 50 * 1024 ** 2
                    ? ` · ${change > 0 ? '+' : '−'}${Math.round(Math.abs(change) / 1024 ** 2)} MB since the last reading`
                    : ''}
                </small>
                <i
                  className="health-bar"
                  style={{ width: `${Math.min(100, share)}%` }}
                  aria-hidden
                />
              </div>
              <span>{percent(group.cpuPercent) ?? '—'}</span>
              <span>{gb(group.memoryBytes)}</span>
            </article>
          );
        })}
        {!groups.length && (
          <p className="health-empty">
            No app readings yet. This does not mean no apps are running.
          </p>
        )}
      </div>
      <div className="health-panel-hint" aria-hidden={!hint}>
        {hint}
      </div>
    </section>
  );
}

type ProjectGroup = {
  id: string;
  name: string;
  cpu: number | null;
  memory: number;
  processes: number;
  jobs: ResourceJob[];
};
function Projects({ sample }: { sample: ResourceSample | null }) {
  const scroll = useRef<HTMLDivElement>(null);
  const hint = useScrollHints(scroll, sample?.observedAt ?? '');
  const map = new Map<string, ProjectGroup>();
  for (const job of sample?.jobs ?? []) {
    const id = job.projectId ?? 'none';
    const group = map.get(id) ?? {
      id,
      name: job.projectName ?? 'Not in a project',
      cpu: null,
      memory: 0,
      processes: 0,
      jobs: [],
    };
    group.cpu = job.cpuPercent === null ? group.cpu : (group.cpu ?? 0) + job.cpuPercent;
    group.memory += job.memoryBytes;
    group.processes += job.processes;
    group.jobs.push(job);
    map.set(id, group);
  }
  const groups = [...map.values()].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1));
  return (
    <section className="health-panel" aria-labelledby="health-projects">
      <div className="health-section-heading">
        <div>
          <h2 id="health-projects">Projects and jobs</h2>
          <p>Measured use by app-managed agents and local jobs</p>
        </div>
        <a className="health-link" href="#/work">
          Compare in QUARK <ArrowUpRight size={15} />
        </a>
      </div>
      <div className="health-table-head" aria-hidden>
        <span>Project</span>
        <span>CPU</span>
        <span>Memory</span>
      </div>
      <div className="health-scroll" ref={scroll}>
        {groups.map((group) => (
          <details key={group.id} className="health-project">
            <summary className="health-row">
              <div>
                <strong>{group.name}</strong>
                <small>
                  {group.jobs.length} {group.jobs.length === 1 ? 'job' : 'jobs'} · {group.processes}{' '}
                  processes
                </small>
              </div>
              <span>{percent(group.cpu) ?? '—'}</span>
              <span>{gb(group.memory)}</span>
            </summary>
            <ul>
              {group.jobs.map((job) => (
                <li key={job.id} className="health-row">
                  <div>
                    <strong>{job.name}</strong>
                    <small>
                      {job.kind === 'agent' ? 'Agent' : 'Local job'} · {job.status} ·{' '}
                      {job.processes} processes
                    </small>
                  </div>
                  <span>{percent(job.cpuPercent) ?? '—'}</span>
                  <span>{gb(job.memoryBytes)}</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
        {!groups.length && (
          <p className="health-empty">No app-managed work was visible in this reading.</p>
        )}
      </div>
      <div className="health-panel-hint" aria-hidden={!hint}>
        {hint}
      </div>
      <p className="health-footnote">
        Each job includes its tools and helpers. Work started outside this app, or detached from a
        job, is not attributed here. These are measurements; QUARK’s reservations are planning
        estimates.
      </p>
    </section>
  );
}

function Settings({
  reading,
  modelsState,
}: {
  reading: HomeData['resources'];
  modelsState: HealthModels;
}) {
  const status = reading.data;
  const [automatic, setAutomatic] = useState(false);
  const [hours, setHours] = useState(6);
  const [saved, setSaved] = useState('');
  const save = useResourceActions(() => {
    setSaved('Automatic check settings saved.');
    reading.retry();
  });
  useEffect(() => {
    if (status) {
      setAutomatic(status.settings.automatic);
      setHours(status.settings.checkpointHours);
    }
  }, [status?.settings.automatic, status?.settings.checkpointHours]);
  const policy = modelsState.status?.policy;
  const scheduled = policy ? policyProvider(policy, 'routine', undefined, true) : undefined;
  const scheduledModel = scheduled ? modelsState.routine(scheduled) : null;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // The model name is only listed once this section is opened.
    if (scheduled && open) void modelsState.load(scheduled);
  }, [scheduled, open]);
  return (
    <details className="health-settings" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Automatic checks and what is measured</summary>
      <div className="health-settings-body">
        <label className="health-check">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => {
              setAutomatic(e.target.checked);
              setSaved('');
            }}
          />
          <span>Automatic check-ins</span>
        </label>
        <p>
          Asks the assistant after sustained CPU, memory, swapping or disk pressure, plus a routine
          checkpoint. One check at a time, at least 30 minutes apart, up to six automatic attempts
          per rolling day. Brief spikes do not start an agent; nothing runs while idle.
        </p>
        <label className="health-field">
          <span>Routine checkpoint</span>
          <select
            value={hours}
            onChange={(e) => {
              setHours(Number(e.target.value));
              setSaved('');
            }}
          >
            {[1, 3, 6, 12, 24].map((h) => (
              <option key={h} value={h}>
                Every {h} {h === 1 ? 'hour' : 'hours'}
              </option>
            ))}
          </select>
        </label>
        <p>
          Automatic checks use the central routine-check model
          {scheduled
            ? `: ${providerNames[scheduled]} · ${scheduledModel?.model?.label ?? (scheduledModel?.choice ? `latest ${scheduledModel.choice.family}` : 'default')}`
            : ''}
          , with one grad consultation when needed. <a href="#/models">Change Model settings</a>.
        </p>
        <div className="health-actions">
          <button
            disabled={!!save.busy || !status}
            onClick={() => {
              setSaved('');
              void save.run('/resources/settings', {
                settings: { automatic, checkpointHours: hours },
              });
            }}
          >
            {save.busy ? 'Saving…' : 'Save automatic checks'}
          </button>
        </div>
        {save.failure && (
          <p role="alert" className="health-alert">
            {save.failure.message} Saving again sends the same request.
          </p>
        )}
        {saved && (
          <p role="status" className="health-notice">
            {saved}
          </p>
        )}
        <small>
          {status?.automaticChecksToday ?? 0} of 6 automatic attempts in the last 24 hours.
          {status?.nextCheckpointAt
            ? ` Next checkpoint due ${new Date(status.nextCheckpointAt).toLocaleString()}.`
            : ''}
        </small>
        <p>
          Automatic checks join QUARK as background work; your questions get interactive priority.
          Checks can wait for provider allowance or computer headroom, expire after 15 minutes in
          the queue and stop after about three minutes of running.
        </p>
        <p>
          We collect app names and resource counters, not command arguments, page URLs, environment
          variables or file contents. Readings stay on this computer for 24 hours; reports and their
          evidence stay with the assistant’s saved conversation. A diagnosis sends the selected
          measurements to the provider you chose.
        </p>
        <p>
          Compressed memory: {gb(status?.latest?.compressedBytes) ?? 'not measured'}. Low free
          memory or old swap alone is not a problem.
        </p>
      </div>
    </details>
  );
}

export function Resources({ reading }: { reading: HomeData['resources'] }) {
  const status = reading.data;
  const [now, setNow] = useState(Date.now);
  const target = () => location.hash.split('/')[2] ?? '';
  const [chatTarget, setChatTarget] = useState(target);
  useEffect(() => {
    const changed = () => setChatTarget(target());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const chatOpen = chatTarget === 'chat' || /^[0-9a-f-]{36}$/i.test(chatTarget);
  const closeChat = () => {
    location.hash = '#/resources';
  };
  const modelsState = useHealthModels();
  const stop = useResourceActions(() => reading.retry());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const stale = !status?.latest || status.stale || reading.error;
  const stopCheck = (check: ResourceCheck) =>
    void stop.run('/resources/stop', { checkId: check.id });
  const stopError = stop.failure?.message ?? '';
  return (
    <section className="resource-page health-page">
      <nav className="health-top" aria-label="Computer health">
        <a href="#/work" className="health-link">
          Related jobs in QUARK <ArrowUpRight size={15} />
        </a>
      </nav>
      <header className="health-heading">
        <h1 tabIndex={-1}>Computer health</h1>
        <p>{apiScope() === 'local' ? 'This computer' : 'The selected computer'} · local readings</p>
      </header>
      <Snapshot reading={reading} now={now} />
      <section className="health-section assistant-launch" aria-label="Ask about computer health">
        <div>
          <h2>Resource assistant</h2>
          <p>Ask about this computer or have the assistant look through past readings.</p>
        </div>
        <button
          className="flow-button primary"
          onClick={() => {
            location.hash = '#/resources/chat';
          }}
        >
          Open Resource assistant
        </button>
      </section>
      {chatOpen && (
        <AssistantFullscreen
          title="Resource assistant conversation"
          back="Computer health"
          close={closeChat}
        >
          <HealthAssistant
            status={status}
            stale={!!stale}
            modelsState={modelsState}
            refresh={reading.retry}
            agentId={chatTarget === 'chat' ? undefined : chatTarget}
            onStop={stopCheck}
            stopping={!!stop.busy}
            stopError={stopError}
          />
        </AssistantFullscreen>
      )}
      <HealthPlots samples={status?.history ?? []} now={now} />
      <div className="health-activity">
        <Projects sample={status?.latest ?? null} />
        <Apps sample={status?.latest ?? null} />
      </div>
      <Settings reading={reading} modelsState={modelsState} />
    </section>
  );
}
