import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  Aperture,
  ArrowUpRight,
  ChevronRight,
  Layers3,
  LayoutGrid,
  MessageCircle,
  WifiOff,
} from 'lucide-react';
import {
  attention,
  conversationVisibilityIdentity,
  projectRatesSchema,
  workItemsSchema,
  type Snapshot,
  type WorkItem,
} from '@dock/shared';
import claudeMark from '../assets/claude.svg';
import { mirrorDaemon, useMirrorChats } from '../useMirrorChats';
import { chatAgentKind } from './conversation-list';
import { useConversationVisibility } from './useConversationVisibility';
import { useReading, type HomeData } from './useHomeData';
import { OwnerWorkBoard, type ProjectIdeaSeed } from './OwnerWorkBoard';
import './home-overview.css';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const chat = (agentId: string) => `#/chat/${encodeURIComponent(agentId)}`;
const needsHumanAnswer = (item: WorkItem) =>
  item.kind === 'human' && item.status !== 'done' && !item.humanReply && !!item.managerId;

export const providerName = (provider: string) =>
  provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
export function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className={`provider-mark provider-mark-${provider}`} aria-hidden="true">
      {provider === 'claude' ? (
        <img src={claudeMark} width={16} height={16} alt="" />
      ) : provider === 'codex' ? (
        <Aperture size={15} />
      ) : (
        provider[0]
      )}
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
    (p) =>
      !p.internal &&
      !internal.includes(p.id) &&
      data.snapshot.data?.agents.some(
        (a) => a.projectId === p.id && a.role === 'manager' && !a.archivedAt,
      ),
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
  const visibility = useConversationVisibility();
  const mirrors = useMirrorChats(true);
  const records = new Map(
    (visibility.data ?? []).map((record) => [
      conversationVisibilityIdentity(record.target),
      record,
    ]),
  );
  const context = {
    personalId: data.frontdesk.data?.agentId,
    personalProjectId: data.frontdesk.data?.projectId,
    resourceProjectId: data.resources.data?.projectId,
  };
  const visibleAgents =
    state?.agents.filter(
      (agent) =>
        chatAgentKind(agent, state, context) &&
        !records.get(conversationVisibilityIdentity({ kind: 'agent', agentId: agent.id }))
          ?.archived,
    ) ?? [];
  const managers = visibleAgents.filter(
    (agent) => chatAgentKind(agent, state!, context) === 'manager',
  ).length;
  const misc = visibleAgents.length - managers;
  const shared = new Map(
    mirrors.chats
      .filter((chat) => chat.threadId)
      .map((chat) => [
        conversationVisibilityIdentity({
          kind: 'shared',
          provider: chat.provider ?? 'codex',
          threadId: chat.threadId!,
        }),
        { daemon: mirrorDaemon(chat) },
      ]),
  );
  for (const record of visibility.data ?? []) {
    if (
      record.target.kind === 'shared' &&
      !shared.has(conversationVisibilityIdentity(record.target))
    )
      shared.set(conversationVisibilityIdentity(record.target), {
        daemon: record.source === 'codex-daemon',
      });
  }
  const visibleShared = [...shared]
    .filter(([identity]) => !records.get(identity)?.archived)
    .map(([, chat]) => chat);
  const editor = mirrors.loaded ? visibleShared.filter((chat) => !chat.daemon).length : undefined;
  const sessions = visibleShared.filter((chat) => chat.daemon).length;
  const jobs = [...(data.work.data?.jobs ?? []), ...(data.local.data?.jobs ?? [])];
  const running = jobs.filter((j) => j.status === 'running').length;
  const queued = jobs.filter(
    (j) => j.status === 'queued' && !('coordination' in j && j.coordination),
  ).length;
  const updates = jobs.reduce(
    (n, j) =>
      n + (j.status === 'queued' && 'coordination' in j ? (j.coordination?.updates ?? 0) : 0),
    0,
  );
  const queueKnown = data.work.loaded && data.local.loaded && !data.work.error && !data.local.error;
  const items: { href: string; label: string; icon: ReactNode; detail: string; tone: string }[] = [
    {
      href: '#/chats',
      label: 'Chats',
      icon: <MessageCircle size={22} />,
      tone: 'chats',
      detail: data.snapshot.error
        ? 'Computer connection interrupted'
        : visibility.error && !visibility.data
          ? 'Conversation visibility unavailable'
          : !state || !visibility.data
            ? 'Reading your conversations…'
            : `${plural(managers, 'project manager')}${misc ? ` · ${plural(misc, 'saved conversation')}` : ''}${
                editor === undefined ? '' : ` · ${plural(editor, 'VS Code chat')}`
              }${sessions ? ` · ${plural(sessions, 'Codex session')}` : ''}`,
    },
    {
      href: '#/apps',
      label: 'Apps',
      icon: <LayoutGrid size={22} />,
      tone: 'apps',
      detail: 'Tools you add',
    },
    {
      href: '#/work',
      label: 'QUARK',
      icon: <Layers3 size={22} />,
      tone: 'quark',
      detail: queueKnown
        ? `${running} running · ${queued} queued${updates ? ` · ${plural(updates, 'team update')}` : ''}`
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

function RateCell({
  rates,
  reading,
}: {
  rates: ProjectRate[];
  reading: ReturnType<typeof useRates>;
}) {
  if (!reading.data)
    return <span className="rate-unknown">{reading.error ? 'Unavailable' : '—'}</span>;
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

/** Specific retained evidence only: running task titles, then open task work, then the turn. */
function currentWork(projectId: string, data: HomeData) {
  const state = data.snapshot.data;
  if (!state) return '';
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const agents = state.agents.filter((agent) => agent.projectId === projectId && !agent.archivedAt);
  const running = agents.filter((agent) => ['running', 'waiting'].includes(agent.status));
  const titles = [
    ...new Set(
      running.flatMap((agent) => {
        const task = agent.taskId ? tasks.get(agent.taskId) : undefined;
        return task ? [task.title] : [];
      }),
    ),
  ];
  if (titles.length)
    return `Working on ${titles[0]!.slice(0, 160)}${titles.length > 1 ? ` (+${titles.length - 1} more)` : ''}`;
  const reviewing = state.tasks.find(
    (task) => task.projectId === projectId && task.status === 'review',
  );
  const manager = running.find((agent) => agent.role === 'manager');
  if (manager?.status === 'waiting') return 'Manager is waiting for your input';
  // Without a task, the manager's saved checkpoint is the most specific retained record.
  // It is labelled as a checkpoint, never presented as the work happening now.
  const checkpoint = agents
    .find((agent) => agent.role === 'manager' && !agent.parentId)
    ?.checkpoint.replace(/\s+/g, ' ')
    .trim();
  const lastCheckpoint = checkpoint ? `Last checkpoint: ${checkpoint.slice(0, 160)}` : '';
  if (manager) return lastCheckpoint || 'Manager is replying in its chat';
  const queued = (data.work.data?.jobs ?? []).find(
    (job) => job.status === 'queued' && agents.some((agent) => agent.id === job.agentId),
  );
  if (queued)
    return `Queued: ${(queued.taskId && tasks.get(queued.taskId)?.title) || queued.agentName}`;
  if (reviewing) return `In review: ${reviewing.title}`;
  return lastCheckpoint ? `Idle · ${lastCheckpoint}` : 'Idle';
}

function ProjectAttention({
  data,
  needs,
  known,
  error,
}: {
  data: HomeData;
  needs: Need[];
  known: boolean;
  error: boolean;
}) {
  const state = data.snapshot.data;
  const rates = useRates();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const providers = ['codex', 'claude'].filter(
    (provider) =>
      data.capacity.data?.providers.some((p) => p.provider === provider) ||
      rates.data?.some((r) => r.provider === provider),
  );
  const active = new Set<string>();
  const agentProject = new Map(state?.agents.map((a) => [a.id, a.projectId]));
  for (const agent of state?.agents ?? [])
    if (agent.status === 'running' || agent.status === 'waiting') active.add(agent.projectId);
  for (const job of data.work.data?.jobs ?? []) {
    const project = agentProject.get(job.agentId);
    if (job.status === 'running' && project) active.add(project);
  }
  for (const job of data.local.data?.jobs ?? [])
    if (job.status === 'running' && job.projectId) active.add(job.projectId);
  const projects = ownerProjects(data);
  const listed = new Set(projects.map((p) => p.id));
  const rows = projects
    .map((p) => ({
      key: p.id,
      name: p.name,
      href: chat(p.managerId),
      work: currentWork(p.id, data),
      needs: needs.filter((need) => need.projectId === p.id),
      rates: new Map(
        providers.map((provider) => [
          provider,
          rates.data?.filter((r) => r.projectId === p.id && r.provider === provider) ?? [],
        ]),
      ),
    }))
    .filter((row) => active.has(row.key) || row.needs.length)
    .sort(
      (a, b) =>
        b.needs.length - a.needs.length ||
        a.name.localeCompare(b.name) ||
        a.key.localeCompare(b.key),
    );
  // Computer, cluster and unassigned requests keep their own row.
  const other = needs.filter((need) => !need.projectId || !listed.has(need.projectId));
  if (other.length)
    rows.push({
      key: 'other',
      name: 'Computer and other requests',
      href: other[0]!.href,
      work: '',
      needs: other,
      rates: new Map(),
    });
  const toggle = (key: string) =>
    setOpen((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <section
      className="overview-panel overview-attention"
      aria-labelledby="attention-heading"
      style={{ '--rate-columns': providers.length } as CSSProperties}
    >
      <div className="overview-panel-head">
        <h2 id="attention-heading">For your attention</h2>
        <span className={`overview-count ${needs.length ? 'is-active' : ''}`}>
          {known ? needs.length : '—'}
        </span>
      </div>
      {!state ? (
        <p className="overview-empty">
          {data.snapshot.error ? 'Reconnect to see projects.' : 'Reading projects…'}
        </p>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="attention-columns" aria-hidden="true">
              <span>Project</span>
              {providers.map((p) => (
                <span key={p}>
                  <ProviderMark provider={p} /> {providerName(p)} %/h
                </span>
              ))}
              <span />
            </div>
          )}
          <ul className="attention-projects" aria-label="Projects and requests">
            {rows.map((row) => {
              const expanded = open.has(row.key) && row.needs.length > 0;
              return (
                <li key={row.key} className={`attention-project${expanded ? ' is-open' : ''}`}>
                  <div className="attention-project-row">
                    <a className="attention-project-name" href={row.href}>
                      <strong>{row.name}</strong>
                      {row.work && <small title={row.work}>{row.work}</small>}
                    </a>
                    {providers.map((p) =>
                      row.key === 'other' ? (
                        <span key={p} className="attention-project-rate is-none" />
                      ) : (
                        <span key={p} className="attention-project-rate">
                          {/* Visible when narrow rows stack rates under the name; the
                              column header labels them on wider frames. */}
                          <span className="attention-rate-label">
                            <ProviderMark provider={p} /> {providerName(p)} %/h
                          </span>
                          <RateCell rates={row.rates.get(p) ?? []} reading={rates} />
                        </span>
                      ),
                    )}
                    {row.needs.length ? (
                      <button
                        type="button"
                        className="attention-project-count"
                        aria-expanded={expanded}
                        aria-label={`${row.needs.length} ${row.needs.length === 1 ? 'request' : 'requests'} for ${row.name}`}
                        onClick={() => toggle(row.key)}
                      >
                        {row.needs.length}
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="attention-project-count is-empty" />
                    )}
                  </div>
                  {expanded && (
                    <ul className="overview-attention-list">
                      {row.needs.map((need) => (
                        <li key={need.key}>
                          <a href={need.href} className="attention-item">
                            <span className="attention-meta">
                              <span>{need.label}</span>
                              {row.key === 'other' && <span>{need.project}</span>}
                            </span>
                            <strong>{need.title}</strong>
                            <span className="attention-detail">{need.detail}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {!rows.length && (
            <p className="overview-empty">
              {!known
                ? error
                  ? 'Requests will appear when the computer reconnects.'
                  : 'Checking for requests…'
                : 'Nothing needs you and no project is running work.'}
            </p>
          )}
          {known || !rows.length ? null : (
            <p className="overview-note">
              {error
                ? 'Some requests could not be read. Showing saved items.'
                : 'Checking for requests…'}
            </p>
          )}
          {rates.error && (
            <p className="overview-note">Allowance rates per project are not available yet.</p>
          )}
          <a href="#/work" className="home-text-link">
            Queued and paused work is in QUARK <ArrowUpRight size={15} />
          </a>
        </>
      )}
    </section>
  );
}

type Need = {
  key: string;
  projectId: string | null;
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
  const agents = new Map(state.agents.map((agent) => [agent.id, agent]));
  const internal = new Set(
    state.projects.filter((project) => project.internal).map((project) => project.id),
  );
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const stopped = new Map<string, Need>();
  const snapshotNeeds = attention(state)
    .items.filter((item) => {
      // Keep real questions; routine checks and already finished workers are history.
      if (item.kind === 'approval') return true;
      if (internal.has(item.projectId)) return false;
      if (['failed', 'interrupted'].includes(item.kind)) {
        const task = item.taskId ? tasks.get(item.taskId) : undefined;
        if (task && ['done', 'integrated', 'split', 'cancelled'].includes(task.status))
          return false;
        if (!stopped.has(item.projectId))
          stopped.set(item.projectId, {
            key: `stopped:${item.projectId}`,
            projectId: item.projectId,
            href: '#/work',
            project: item.projectName,
            label: 'Stopped work',
            title: `${item.projectName}: stopped work to review`,
            detail: 'Open QUARK to inspect the reason and continue when ready.',
          });
        return false;
      }
      return !!agents.get(item.agentId);
    })
    .map((item): Need => {
      const approval = item.kind === 'approval' ? approvals.get(item.id) : undefined;
      return {
        key: `${item.kind}:${item.id}`,
        projectId: item.projectId,
        href:
          item.destination === 'workspace' && item.taskId
            ? `#/review/${encodeURIComponent(item.taskId)}`
            : item.kind === 'backup'
              ? `#/project/${item.projectId}`
              : item.kind === 'decision' && item.taskId
                ? `#/task/${item.taskId}`
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
  const asks = items.filter(needsHumanAnswer).map(
    (i): Need => ({
      key: `ask:${i.id}`,
      projectId: i.projectId,
      href: `${chat(i.managerId!)}/answer/${i.id}`,
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
        projectId: j.projectId,
        href: '#/transcribe',
        project: (j.projectId && projects.get(j.projectId)) || 'Local work',
        label: 'Stopped local job',
        title: 'Video transcript stopped',
        detail: 'Open local work to see what happened and choose whether to retry.',
      }),
    );
  const budgets = new Map<string, Need>();
  for (const job of data.work.data?.jobs ?? []) {
    const agent = agents.get(job.agentId);
    if (
      job.status !== 'queued' ||
      job.eligible ||
      job.held ||
      !job.budgetBlock ||
      !agent ||
      internal.has(agent.projectId)
    )
      continue;
    const target = job.budgetBlock.targetId;
    budgets.set(target, {
      key: `budget:${target}`,
      projectId: agent.projectId,
      href: `#/work/${target}`,
      project: projects.get(agent.projectId) ?? job.projectName,
      label: 'Budget needs attention',
      title: `${tasks.get(target)?.title ?? job.projectName}: queued work needs budget`,
      detail: job.reason,
    });
  }
  // A cluster sign-in only the owner can restore; running batch jobs continue meanwhile.
  const cluster = data.cluster.data;
  const clusterNeeds: Need[] =
    cluster?.settings?.enabled &&
    (cluster.connection.state === 'sign-in-needed' || cluster.connection.state === 'host-key')
      ? [
          {
            key: 'cluster:connection',
            projectId: null,
            href: '#/work',
            project: cluster.settings.label,
            label: cluster.connection.state === 'host-key' ? 'Cluster host key' : 'Cluster sign-in',
            title:
              cluster.connection.state === 'host-key'
                ? `${cluster.settings.label}: check the changed host key`
                : `${cluster.settings.label}: sign in again`,
            detail: cluster.connection.message,
          },
        ]
      : [];
  return [
    ...asks,
    ...snapshotNeeds,
    ...stopped.values(),
    ...budgets.values(),
    ...local,
    ...clusterNeeds,
  ];
}

const useWorkItems = () => useReading('/work-items', workItemsSchema.parse);

export function HomeOverview({
  data,
  now,
  onSeedProject,
}: {
  data: HomeData;
  now: number;
  onSeedProject?: (seed: ProjectIdeaSeed) => void;
}) {
  const state = data.snapshot.data;
  const workItems = useWorkItems();
  const needs = needsFor(state, workItems.data?.items ?? [], data);
  const attentionError =
    data.snapshot.error || workItems.error || data.local.error || data.work.error;
  const known =
    !!state && !attentionError && workItems.loaded && data.local.loaded && data.work.loaded;
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
        <div className="overview-main">
          <Destinations data={data} />
          <div className="overview-panel overview-todo-slot">
            <OwnerWorkBoard
              projects={ownerProjects(data)}
              tasks={state?.tasks ?? []}
              reading={workItems}
              onSeedProject={onSeedProject}
            />
          </div>
          <ResourcePanel data={data} now={now} />
        </div>
        <ProjectAttention data={data} needs={needs} known={known} error={!!attentionError} />
      </div>
    </div>
  );
}

export function resetLabel(value: string | null, now: number) {
  if (!value) return 'Reset time not reported';
  const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
  if (minutes <= 0) return 'Reset time passed · waiting for a new reading';
  if (minutes >= 1440)
    return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return `Resets in ${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60}m`;
}
