import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Aperture,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  Layers3,
  LayoutGrid,
  MessageCircle,
  Plus,
  WifiOff,
} from 'lucide-react';
import {
  attention,
  projectRatesSchema,
  workItemSchema,
  workItemsSchema,
  type Snapshot,
  type WorkItem,
} from '@dock/shared';
import { api, apiScope } from '../api';
import { mirrorDaemon } from '../useMirrorChats';
import { useReading, type HomeData } from './useHomeData';
import './home-overview.css';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const chat = (agentId: string) => `#/chat/${encodeURIComponent(agentId)}`;

export const providerName = (provider: string) =>
  provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
export function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className={`provider-mark provider-mark-${provider}`} aria-hidden="true">
      {provider === 'claude' ? '✳' : provider === 'codex' ? <Aperture size={15} /> : provider[0]}
    </span>
  );
}
export function ago(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** Internal assistant projects stay out of the owner's project lists. */
function ownerProjects(data: HomeData) {
  const internal = [data.resources.data?.projectId, data.frontdesk.data?.projectId];
  return (data.snapshot.data?.projects ?? []).filter(
    (p) => !p.internal && !internal.includes(p.id),
  );
}

// Adapt the shared accounting contract to the drawn provider/window rows.
type ProjectRate = {
  projectId: string | null;
  provider: string;
  windowLabel: string;
  percentPerHour: number | null;
  basis: 'measured' | 'estimated' | 'insufficient' | 'stale';
  intervalMinutes: number | null;
};
function parseProjectRates(value: unknown): ProjectRate[] {
  return projectRatesSchema.parse(value).rates.map((rate) => ({
    projectId: rate.projectId,
    provider: rate.provider,
    windowLabel: rate.label,
    percentPerHour: rate.estimatedPercentPerHour,
    basis: rate.stale
      ? 'stale'
      : rate.estimatedPercentPerHour === null
        ? 'insufficient'
        : 'estimated',
    intervalMinutes:
      rate.from && rate.to
        ? Math.max(0, Date.parse(rate.to) - Date.parse(rate.from)) / 60_000
        : null,
  }));
}

function Destinations({ data }: { data: HomeData }) {
  const state = data.snapshot.data;
  const projects = new Set(ownerProjects(data).map((p) => p.id));
  const managers =
    state?.agents.filter((a) => a.role === 'manager' && projects.has(a.projectId)).length ?? 0;
  const live = data.mirrors.data?.filter((w) => w.threadId && w.status !== 'offline');
  const editor = live?.filter((w) => !mirrorDaemon(w)).length;
  const sessions = live?.filter(mirrorDaemon).length ?? 0;
  const jobs = [...(data.work.data?.jobs ?? []), ...(data.local.data?.jobs ?? [])];
  const running = jobs.filter((j) => j.status === 'running').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const queueKnown = data.work.loaded && data.local.loaded && !data.work.error && !data.local.error;
  const items: { href: string; label: string; icon: ReactNode; detail: string; tone: string }[] = [
    {
      href: '#/chats',
      label: 'Chats',
      icon: <MessageCircle size={22} />,
      tone: 'chats',
      detail: data.snapshot.error
        ? 'Computer connection interrupted'
        : !state
          ? 'Reading your conversations…'
          : `${plural(managers, 'project manager')}${
              editor === undefined ? '' : ` · ${plural(editor, 'VS Code chat')}`
            }${sessions ? ` · ${plural(sessions, 'Codex session')}` : ''}`,
    },
    {
      href: '#/apps',
      label: 'Apps',
      icon: <LayoutGrid size={22} />,
      tone: 'apps',
      detail: 'No apps added yet',
    },
    {
      href: '#/work',
      label: 'QUARK',
      icon: <Layers3 size={22} />,
      tone: 'quark',
      detail: queueKnown
        ? `${running} running · ${queued} queued`
        : data.work.error || data.local.error
          ? 'Queue status unavailable'
          : 'Reading the work queue…',
    },
  ];
  return (
    <nav className="overview-destinations" aria-label="Main destinations">
      {items.map((item) => (
        <a key={item.href} href={item.href} className={`destination destination-${item.tone}`}>
          <span className="destination-icon">{item.icon}</span>
          <span className="destination-text">
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </span>
          <ChevronRight size={20} aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}

function ResourcePanel({ data, now }: { data: HomeData; now: number }) {
  const status = data.resources.data;
  const latest = status?.latest ?? null;
  const fresh = !!latest && !status?.stale && !data.resources.error;
  const capacityMachine = data.capacity.data?.machine;
  const machine =
    (fresh ? latest.machine : null) ??
    (capacityMachine &&
    !data.capacity.error &&
    now - Date.parse(capacityMachine.observedAt) < 30_000
      ? capacityMachine
      : null);
  const observed = fresh ? latest.observedAt : (machine?.observedAt ?? null);
  const finding = fresh ? status?.findings[0] : undefined;
  const pressure = fresh ? latest.memoryPressure : 'unknown';
  const swapOut = fresh ? latest.swapOutBytesPerSecond : null;
  const stats: { label: string; value: string; note: string }[] = [
    {
      label: 'CPU in use',
      value:
        machine?.cpuUsedPercent === null || !machine
          ? '—'
          : `${Math.round(machine.cpuUsedPercent)}%`,
      note: machine
        ? `${machine.cpuCount} cores${
            fresh && latest.hottestCorePercent !== null
              ? ` · busiest ${Math.round(latest.hottestCorePercent)}%`
              : ''
          }`
        : 'Not measured',
    },
    {
      label: 'Memory available',
      value: machine ? gb(machine.memoryAvailableBytes) : '—',
      note: machine
        ? `of ${gb(machine.memoryTotalBytes)}${pressure === 'unknown' ? '' : ` · pressure ${pressure}`}`
        : 'Not measured',
    },
    {
      label: 'Swap',
      value:
        swapOut === null ? '—' : swapOut > 0 ? `${(swapOut / 1024 ** 2).toFixed(1)} MB/s` : 'None',
      note:
        swapOut === null ? 'Not measured' : swapOut > 0 ? 'Writing to disk now' : 'No swapping now',
    },
    {
      label: 'Disk free',
      value: machine?.diskAvailableBytes == null ? '—' : gb(machine.diskAvailableBytes),
      note:
        fresh && latest.diskTotalBytes
          ? `of ${gb(latest.diskTotalBytes)}`
          : machine
            ? ''
            : 'Not measured',
    },
  ];
  return (
    <a
      href="#/resources"
      className={`overview-panel overview-resources ${finding ? 'has-finding' : ''}`}
      aria-label="Resource snapshot. Open computer health to see full details and ask the resource agent."
    >
      <div className="overview-panel-head">
        <h2>Resource snapshot</h2>
        <span className={`overview-fresh ${observed ? '' : 'muted'}`}>
          {observed ? `Read ${ago(observed, now)}` : 'No fresh reading'}
        </span>
      </div>
      {finding && <p className="resource-finding">{finding.title}</p>}
      <dl className="resource-stats">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
            {stat.note && <small>{stat.note}</small>}
          </div>
        ))}
      </dl>
      <span className="overview-cta">
        Full details and ask the resource agent <ArrowUpRight size={16} />
      </span>
    </a>
  );
}

type SortKey = string; // 'name' | 'attention' | `rate:${provider}`
type Sort = { key: SortKey; dir: 'asc' | 'desc' };
const sortStorage = 'swa:home-running-sort';
function savedSort(): Sort {
  try {
    const value = JSON.parse(localStorage.getItem(sortStorage) ?? 'null') as Sort | null;
    if (value && typeof value.key === 'string' && ['asc', 'desc'].includes(value.dir)) return value;
  } catch {
    // An unreadable saved sort falls back to the default order.
  }
  return { key: 'attention', dir: 'desc' };
}

function RateCell({
  rates,
  reading,
}: {
  rates: ProjectRate[];
  reading: ReturnType<typeof useRates>;
}) {
  if (!reading.data) return <span className="rate-unknown">—</span>;
  if (!rates.length) return <span className="rate-unknown">No use seen</span>;
  return (
    <span className="rate-list">
      {rates.map((rate) => (
        <span key={rate.windowLabel} className={`rate rate-${rate.basis}`}>
          <strong>
            {rate.percentPerHour === null || rate.basis === 'insufficient'
              ? 'Not enough data'
              : `${rate.percentPerHour.toFixed(1)} %/h`}
          </strong>
          <small>
            {rate.windowLabel}
            {rate.basis === 'estimated' ? ' · estimate' : rate.basis === 'stale' ? ' · stale' : ''}
          </small>
        </span>
      ))}
    </span>
  );
}
const useRates = () => useReading('/project-rates', parseProjectRates);

function RunningPanel({ data, needs }: { data: HomeData; needs: Map<string, number> }) {
  const state = data.snapshot.data;
  const rates = useRates();
  const [sort, setSort] = useState(savedSort);
  const choose = (next: Sort) => {
    setSort(next);
    localStorage.setItem(sortStorage, JSON.stringify(next));
  };
  const toggle = (key: SortKey) =>
    choose(
      sort.key === key
        ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' },
    );
  const providers = [
    ...new Set([
      ...(data.capacity.data?.providers.map((p) => p.provider) ?? []),
      ...(rates.data?.map((r) => r.provider) ?? []),
    ]),
  ];
  const agentProject = new Map(state?.agents.map((a) => [a.id, a.projectId]));
  const active = new Set<string>();
  for (const agent of state?.agents ?? [])
    if (agent.status === 'running' || agent.status === 'waiting') active.add(agent.projectId);
  for (const job of data.work.data?.jobs ?? []) {
    const project = agentProject.get(job.agentId);
    if (job.status === 'running' && project) active.add(project);
  }
  for (const job of data.local.data?.jobs ?? [])
    if (job.status === 'running' && job.projectId) active.add(job.projectId);
  const peak = (list: ProjectRate[]) =>
    list.reduce((max, r) => Math.max(max, r.percentPerHour ?? -1), -1);
  const rows = ownerProjects(data)
    .filter((p) => active.has(p.id))
    .map((p) => ({
      ...p,
      needs: needs.get(p.id) ?? 0,
      rates: new Map(
        providers.map((provider) => [
          provider,
          rates.data?.filter((r) => r.projectId === p.id && r.provider === provider) ?? [],
        ]),
      ),
    }))
    .sort((a, b) => {
      const order =
        sort.key === 'name'
          ? a.name.localeCompare(b.name)
          : sort.key === 'attention'
            ? a.needs - b.needs
            : peak(a.rates.get(sort.key.slice(5)) ?? []) -
              peak(b.rates.get(sort.key.slice(5)) ?? []);
      return (
        (sort.dir === 'asc' ? order : -order) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
      );
    });
  const unattributed = rates.data?.filter((r) => r.projectId === null) ?? [];
  const interval = rates.data?.find((r) => r.intervalMinutes)?.intervalMinutes;
  const header = (key: SortKey, label: ReactNode, className = '') => (
    <th
      scope="col"
      className={className}
      aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" onClick={() => toggle(key)}>
        {label}
        {sort.key !== key ? (
          <ArrowUpDown size={14} aria-hidden="true" />
        ) : sort.dir === 'asc' ? (
          <ArrowUp size={14} aria-hidden="true" />
        ) : (
          <ArrowDown size={14} aria-hidden="true" />
        )}
      </button>
    </th>
  );
  return (
    <section className="overview-panel overview-running" aria-labelledby="running-heading">
      <div className="overview-panel-head">
        <h2 id="running-heading">Currently running</h2>
        <label className="running-sort">
          <span>Sort</span>
          <select
            value={`${sort.key}:${sort.dir}`}
            onChange={(event) => {
              const value = event.target.value;
              const cut = value.lastIndexOf(':');
              choose({ key: value.slice(0, cut), dir: value.slice(cut + 1) as Sort['dir'] });
            }}
          >
            <option value="attention:desc">Needs attention first</option>
            <option value="name:asc">Project name A–Z</option>
            <option value="name:desc">Project name Z–A</option>
            {providers.map((p) => (
              <option key={p} value={`rate:${p}:desc`}>
                Highest {providerName(p)} rate
              </option>
            ))}
            {sort.key === 'attention' && sort.dir === 'asc' && (
              <option value="attention:asc">Needs attention last</option>
            )}
            {sort.key.startsWith('rate:') && sort.dir === 'asc' && (
              <option value={`${sort.key}:asc`}>
                Lowest {providerName(sort.key.slice(5))} rate
              </option>
            )}
          </select>
        </label>
      </div>
      {!state ? (
        <p className="overview-empty">
          {data.snapshot.error ? 'Reconnect to see running work.' : 'Reading running work…'}
        </p>
      ) : rows.length ? (
        <div className="running-scroll">
          <table className="running-table">
            <thead>
              <tr>
                {header('name', 'Project')}
                {providers.map((p) =>
                  header(
                    `rate:${p}`,
                    <>
                      <ProviderMark provider={p} />
                      <span>{providerName(p)} %/h</span>
                    </>,
                    'running-rate-col',
                  ),
                )}
                {header('attention', 'Needs attention?')}
                <th scope="col">
                  <span className="home-sr-only">Open manager chat</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className="running-name">{row.name}</span>
                    <span className="running-inline-rates">
                      {providers.map((p) => (
                        <span key={p}>
                          <ProviderMark provider={p} />
                          <RateCell rates={row.rates.get(p) ?? []} reading={rates} />
                        </span>
                      ))}
                    </span>
                  </th>
                  {providers.map((p) => (
                    <td key={p} className="running-rate-col">
                      <RateCell rates={row.rates.get(p) ?? []} reading={rates} />
                    </td>
                  ))}
                  <td>
                    {row.needs ? (
                      <span className="running-flag">Yes · {row.needs}</span>
                    ) : (
                      <span className="running-no">No</span>
                    )}
                  </td>
                  <td className="running-open-cell">
                    <a
                      className="running-open"
                      href={chat(row.managerId)}
                      aria-label={`Open the ${row.name} manager chat`}
                    >
                      <ChevronRight size={19} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="overview-empty">No project is running work right now.</p>
      )}
      <div className="running-notes">
        <p>
          {rates.data
            ? `%/h: estimated percentage points of each allowance window used per hour${
                interval ? `, over the last ${interval} min` : ''
              }.`
            : rates.error
              ? 'Allowance rates per project are not available on this computer yet.'
              : 'Reading allowance rates…'}
          {unattributed.length > 0 &&
            ` Not attributed to a project: ${unattributed
              .map((r) =>
                r.percentPerHour === null
                  ? `${providerName(r.provider)} unknown`
                  : `${providerName(r.provider)} ${r.percentPerHour.toFixed(1)} %/h`,
              )
              .join(', ')}.`}
        </p>
        <a href="#/work" className="home-text-link">
          Queued and paused work is in QUARK <ArrowUpRight size={15} />
        </a>
      </div>
    </section>
  );
}

type Need = {
  key: string;
  href: string;
  project: string;
  label: string;
  title: string;
  detail: string;
};
function needsFor(state: Snapshot | null, items: WorkItem[], data: HomeData): Need[] {
  if (!state) return [];
  const projects = new Map(state.projects.map((p) => [p.id, p.name]));
  const approvals = new Map(state.approvals.map((a) => [a.id, a]));
  const snapshotNeeds = attention(state).items.map((item): Need => {
    const approval = item.kind === 'approval' ? approvals.get(item.id) : undefined;
    return {
      key: `${item.kind}:${item.id}`,
      href:
        item.destination === 'workspace' && item.taskId
          ? `#/review/${encodeURIComponent(item.taskId)}`
          : chat(item.agentId),
      project: item.projectName,
      label: approval
        ? approval.kind === 'input'
          ? 'Question'
          : approval.kind.startsWith('mcp')
            ? 'Tool request'
            : 'Permission request'
        : {
            approval: 'Permission request',
            decision: 'Decision needed',
            failed: 'Stopped work',
            interrupted: 'Stopped work',
            integration: 'Changes ready for review',
            backup: 'Source backup',
          }[item.kind],
      title: item.title,
      detail: approval?.questions[0]?.question || item.description,
    };
  });
  // A manager's saved ask for a person, answered in its original conversation.
  const asks = items
    .filter((i) => i.kind === 'human' && i.status === 'waiting' && !i.humanReply && i.managerId)
    .map(
      (i): Need => ({
        key: `ask:${i.id}`,
        href: chat(i.managerId!),
        project: (i.projectId && projects.get(i.projectId)) || 'Project',
        label: 'Question',
        title: i.title,
        detail: i.detail || 'Open the manager chat to answer.',
      }),
    );
  const local = (data.local.data?.jobs ?? [])
    .filter((j) => j.status === 'failed' || j.status === 'interrupted')
    .map(
      (j): Need => ({
        key: `local:${j.id}`,
        href: '#/transcribe',
        project: (j.projectId && projects.get(j.projectId)) || 'Local work',
        label: 'Stopped local job',
        title: 'Video transcript stopped',
        detail: 'Open local work to see what happened and choose whether to retry.',
      }),
    );
  return [...snapshotNeeds, ...asks, ...local];
}

function AttentionPanel({
  needs,
  known,
  error,
}: {
  needs: Need[];
  known: boolean;
  error: boolean;
}) {
  return (
    <section className="overview-attention" aria-labelledby="attention-heading">
      <div className="overview-panel-head">
        <h2 id="attention-heading">For your attention</h2>
        <span className={`overview-count ${needs.length ? 'is-active' : ''}`}>
          {known ? needs.length : '—'}
        </span>
      </div>
      {!known ? (
        <p className="overview-empty">
          {error ? 'Requests will appear when the computer reconnects.' : 'Checking for requests…'}
        </p>
      ) : needs.length ? (
        <ul className="attention-list">
          {needs.map((need) => (
            <li key={need.key}>
              <a href={need.href} className="attention-item">
                <span className="attention-meta">
                  <span>{need.project}</span>
                  <span>{need.label}</span>
                </span>
                <strong>{need.title}</strong>
                <span className="attention-detail">{need.detail}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="overview-empty">Nothing needs you right now.</p>
      )}
      <p className="attention-foot">
        Opening a request shows it in its original chat. Nothing is answered or approved until you
        choose there.
      </p>
    </section>
  );
}

const statusNames: Record<WorkItem['status'], string> = {
  open: 'Not started',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
};
function TodoPanel({
  data,
  reading,
}: {
  data: HomeData;
  reading: ReturnType<typeof useWorkItems>;
}) {
  const projects = ownerProjects(data);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const general = reading.data?.items.filter((i) => i.kind === 'general') ?? [];
  const open = general.filter((i) => i.status !== 'done');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  // Keep one idempotency key per unconfirmed request, so retrying after a lost
  // response returns the saved result instead of adding or assigning twice.
  const save = async (name: string, body: Record<string, unknown>) => {
    const storage = `dock:${apiScope()}:home-todo:${name}`;
    const request = JSON.stringify(body);
    const pending = JSON.parse(sessionStorage.getItem(storage) ?? 'null') as {
      key: string;
      request: string;
    } | null;
    const key = pending?.request === request ? pending.key : crypto.randomUUID();
    sessionStorage.setItem(storage, JSON.stringify({ key, request }));
    const item = workItemSchema.parse(await api('/work-items', { key, ...body }));
    sessionStorage.removeItem(storage);
    return item;
  };
  const run = async (id: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError({
        id,
        message: reason instanceof Error ? reason.message : 'Could not save. Try again.',
      });
    } finally {
      setBusy(null);
      reading.retry();
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    const title = text.trim();
    if (!title) return;
    void run('add', async () => {
      await save('add', { kind: 'general', title });
      setText('');
    });
  };
  const send = (event: FormEvent, item: WorkItem) => {
    event.preventDefault();
    const project = projects.find((p) => p.id === target);
    if (!project) return;
    void run(item.id, async () => {
      const saved = await save(`send:${item.id}`, {
        id: item.id,
        expectedRevision: item.revision,
        managerId: project.managerId,
      });
      setChoosing(null);
      location.hash = chat(saved.managerId ?? project.managerId);
    });
  };
  const unavailable = reading.error && !reading.data;
  return (
    <section className="overview-todo" aria-labelledby="todo-heading">
      <div className="overview-panel-head">
        <h2 id="todo-heading">To-do · General</h2>
        <span className="overview-count">{reading.data ? open.length : '—'}</span>
      </div>
      <form className="todo-add" onSubmit={add}>
        <label className="home-sr-only" htmlFor="todo-new">
          New to-do
        </label>
        <input
          id="todo-new"
          value={text}
          maxLength={240}
          autoComplete="off"
          placeholder="Add a to-do"
          disabled={unavailable}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={!text.trim() || !!busy || unavailable}>
          <Plus size={17} />
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error?.id === 'add' && (
        <p className="todo-error" role="alert">
          {error.message} Your text is kept; try again.
        </p>
      )}
      {unavailable ? (
        <p className="overview-empty">
          Could not load your to-dos.{' '}
          <button type="button" className="todo-inline-button" onClick={reading.retry}>
            Try again
          </button>
        </p>
      ) : !reading.data ? (
        <p className="overview-empty">Reading your to-dos…</p>
      ) : open.length ? (
        <ul className="todo-list">
          {open.map((item) => (
            <li key={item.id}>
              <div className="todo-row">
                {item.managerId ? (
                  <span className="todo-sent" aria-hidden="true">
                    <ArrowUpRight size={16} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="todo-done"
                    disabled={!!busy}
                    aria-label={`Mark “${item.title}” done`}
                    onClick={() =>
                      void run(item.id, async () => {
                        await save(`done:${item.id}`, {
                          id: item.id,
                          expectedRevision: item.revision,
                          status: 'done',
                        });
                      })
                    }
                  >
                    <Check size={16} />
                  </button>
                )}
                <span className="todo-text">
                  <strong>{item.title}</strong>
                  <small>
                    {item.managerId
                      ? `Sent to ${(item.projectId && names.get(item.projectId)) || 'a project'} · ${statusNames[item.status]}`
                      : 'General'}
                  </small>
                </span>
                {item.managerId ? (
                  <a className="todo-action" href={chat(item.managerId)}>
                    Open chat
                  </a>
                ) : (
                  <button
                    type="button"
                    className="todo-action"
                    aria-expanded={choosing === item.id}
                    disabled={!projects.length}
                    onClick={() => {
                      setChoosing(choosing === item.id ? null : item.id);
                      setTarget('');
                    }}
                  >
                    Send to project
                  </button>
                )}
              </div>
              {choosing === item.id && (
                <form className="todo-send" onSubmit={(event) => send(event, item)}>
                  <label htmlFor={`todo-target-${item.id}`}>Send to</label>
                  <select
                    id={`todo-target-${item.id}`}
                    value={target}
                    required
                    onChange={(event) => setTarget(event.target.value)}
                  >
                    <option value="">Choose a project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit" disabled={!target || !!busy}>
                    {busy === item.id ? 'Sending…' : 'Send'}
                  </button>
                  <button type="button" onClick={() => setChoosing(null)}>
                    Cancel
                  </button>
                  <small>Its manager gets this to-do once. QUARK still schedules the work.</small>
                </form>
              )}
              {error?.id === item.id && (
                <p className="todo-error" role="alert">
                  {error.message} The to-do is kept; try again.
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="overview-empty">No open to-dos. Add one above.</p>
      )}
    </section>
  );
}
const useWorkItems = () => useReading('/work-items', workItemsSchema.parse);

export function HomeOverview({ data, now }: { data: HomeData; now: number }) {
  const state = data.snapshot.data;
  const workItems = useWorkItems();
  const needs = needsFor(state, workItems.data?.items ?? [], data);
  const needsByProject = new Map<string, number>();
  for (const item of state ? attention(state).items : [])
    needsByProject.set(item.projectId, (needsByProject.get(item.projectId) ?? 0) + 1);
  for (const item of workItems.data?.items ?? [])
    if (item.kind === 'human' && item.status === 'waiting' && !item.humanReply && item.projectId)
      needsByProject.set(item.projectId, (needsByProject.get(item.projectId) ?? 0) + 1);
  const known = !!state && !data.snapshot.error && data.local.loaded;
  return (
    <div className="overview">
      <h1 className="home-sr-only" tabIndex={-1}>
        Home
      </h1>
      {data.snapshot.error && (
        <div className="home-connection-note" role="status">
          <WifiOff size={18} />
          <span>
            Computer connection interrupted.{' '}
            {state ? 'Showing the last saved view.' : 'Your work will appear when it reconnects.'}
          </span>
          <button onClick={() => window.dispatchEvent(new Event('swa:refresh-home'))}>Retry</button>
        </div>
      )}
      {state?.provider.version === 'demo' && (
        <div className="home-demo">Demonstration workspace · example data, no model calls</div>
      )}
      <div className="overview-grid">
        <Destinations data={data} />
        <aside className="overview-panel overview-side" aria-label="Requests and to-dos">
          <AttentionPanel needs={needs} known={known} error={data.snapshot.error} />
          <TodoPanel data={data} reading={workItems} />
        </aside>
        <RunningPanel data={data} needs={needsByProject} />
        <ResourcePanel data={data} now={now} />
      </div>
    </div>
  );
}
