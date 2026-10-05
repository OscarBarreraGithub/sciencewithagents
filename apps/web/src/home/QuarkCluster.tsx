import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import {
  clusterNotebooksSchema,
  clusterSignInSchema,
  type ClusterSignIn,
  type ClusterQueueJob,
  type ClusterRecentJob,
  type ClusterSettings,
  type ClusterStatus,
} from '@dock/shared';
import { api } from '../api';
import { ago } from './HomeOverview';
import { useReading, type HomeData } from './useHomeData';
import './quark-cluster.css';

const stateLabels: Record<ClusterStatus['connection']['state'], string> = {
  'not-configured': 'Monitoring off',
  checking: 'Checking…',
  connected: 'Connected',
  'sign-in-needed': 'Sign-in needed',
  'host-key': 'Host key check needed',
  unreachable: 'Cluster not reachable',
  error: 'Reading failed',
};
const unavailableLabels: Record<ClusterStatus['unavailable'][number]['section'], string> = {
  queue: 'queue',
  priority: 'pending priority factors',
  recent: 'recent accounting',
  tracked: 'tracked job accounting',
  version: 'Slurm version',
  groups: 'group membership (partition access)',
  fairshare: 'fairshare',
  assoc: 'your association limits',
  accounts: 'account and parent limits',
  qos: 'QOS limits',
  partitions: 'partition limits',
  sinfo: 'idle CPUs',
  config: 'site limits',
};
const limitText = (item: ClusterStatus['limits']['items'][number]) =>
  [
    item.partition && `partition ${item.partition}`,
    item.maxJobs !== null && `${item.maxJobs} running jobs`,
    item.maxSubmit !== null && `${item.maxSubmit} submitted`,
    item.maxTres && `per job ${item.maxTres}`,
    item.grpJobs !== null && `group ${item.grpJobs} running jobs`,
    item.grpTres && `group ${item.grpTres}`,
    item.maxWall && `max time ${item.maxWall}`,
  ]
    .filter(Boolean)
    .join(' · ') || 'No limits reported at this level';
const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);
const duration = (seconds: number | null) => {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  return hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours
      ? `${hours}h ${Math.floor((seconds % 3600) / 60)}m`
      : `${Math.max(1, Math.round(seconds / 60))}m`;
};
const gib = (bytes: number | null) =>
  bytes === null ? '—' : `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
/** Slurm reports cluster-local time without a zone; show it as given. */
const clusterTime = (value: string | null) => (value ? value.replace('T', ' ').slice(0, 16) : '');
const failed = (state: string) => /FAIL|TIMEOUT|OUT_OF_ME|PREEMPT|DEADLINE|CANCELLED/.test(state);

function Owner({ owner }: { owner: ClusterQueueJob['owner'] }) {
  return owner ? (
    <a href={`#/chat/${owner.agentId}`}>
      {owner.agentName} · {owner.projectName}
    </a>
  ) : null;
}

type NotebookControl = { local: boolean; busy: boolean; open: () => void };
/** Notebook template jobs: one running, numeric job on a single compute node. */
const notebookJob = (job: ClusterQueueJob) =>
  job.state === 'RUNNING' &&
  /^\d+$/.test(job.jobId) &&
  /notebook|jupyter/i.test(job.name) &&
  !!job.nodeList &&
  !/[,[]/.test(job.nodeList);

function QueueJob({ job, notebook }: { job: ClusterQueueJob; notebook?: NotebookControl }) {
  return (
    <li>
      <div>
        <strong>{job.name || job.jobId}</strong>
        <span className={`quark-cluster-state ${job.state === 'RUNNING' ? 'is-running' : ''}`}>
          {job.state.toLowerCase()}
        </span>
      </div>
      <small>
        {job.jobId} · {job.partition || 'no partition'} · {job.account}
        {job.cpus ? ` · ${job.cpus} CPU` : ''}
        {job.memory ? ` · ${job.memory}` : ''}
        {job.gres ? ` · ${job.gres}` : ''}
      </small>
      <small>
        {job.state === 'PENDING'
          ? `Waiting: ${job.reason || 'no reason reported'}${job.startAt ? ` · Slurm estimate ${clusterTime(job.startAt)} (cluster time, can move)` : ''}`
          : `Used ${job.timeUsed || '—'} of ${job.timeLimit || '—'}${job.nodeList ? ` · ${job.nodeList}` : ''}`}
      </small>
      <Owner owner={job.owner} />
      {notebook &&
        (notebook.local ? (
          <button className="flow-button" disabled={notebook.busy} onClick={notebook.open}>
            {notebook.busy ? 'Opening…' : 'Open notebook'}
          </button>
        ) : (
          <small>
            Open this notebook in the browser on the computer connected to the cluster. Its tunnel
            listens only on that computer’s 127.0.0.1.
          </small>
        ))}
    </li>
  );
}

function RecentJob({ job }: { job: ClusterRecentJob }) {
  return (
    <li className={failed(job.state) ? 'is-failed' : undefined}>
      <div>
        <strong>{job.name || job.jobId}</strong>
        <span className="quark-cluster-state">
          {job.state.toLowerCase()}
          {job.exitCode && job.exitCode !== '0:0' ? ` · exit ${job.exitCode}` : ''}
        </span>
      </div>
      <small>
        {job.jobId} · {duration(job.elapsedSeconds)} of {duration(job.timeLimitSeconds)} · CPU
        efficiency {percent(job.cpuEfficiency)} · memory {gib(job.maxRssBytes)} of{' '}
        {gib(job.memoryBytes)} ({percent(job.memoryEfficiency)})
      </small>
      {(job.stdout || job.stderr) && (
        <small className="quark-cluster-path">
          {job.stdout && <>Output {job.stdout}</>}
          {job.stderr && job.stderr !== job.stdout && <> · Errors {job.stderr}</>}
        </small>
      )}
      <Owner owner={job.owner} />
    </li>
  );
}

const signInActive = (state: ClusterSignIn['state']) =>
  state === 'starting' || state === 'prompt' || state === 'waiting';

/** Answers go to native SSH on the computer; the field is cleared as soon as it is sent. */
function ClusterSignInFlow({ label, done }: { label: string; done: () => void }) {
  const [flow, setFlow] = useState<ClusterSignIn | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const active = !!flow && signInActive(flow.state);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void api('/cluster/sign-in')
        .then((value) => setFlow(clusterSignInSchema.parse(value)))
        .catch(() => setError('The computer connection was interrupted. Retry when connected.'));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (flow?.state === 'connected') done();
  }, [flow?.state]);
  async function run(path: string, body: unknown) {
    setError('');
    try {
      setFlow(clusterSignInSchema.parse(await api(path, body)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in could not continue. Try again.');
    }
  }
  if (!flow || !active)
    return (
      <div className="quark-cluster-sign-in">
        {flow && flow.state !== 'idle' && <p role="status">{flow.message}</p>}
        <button
          className="flow-button primary"
          onClick={() => {
            if (flow && !active) key.current = crypto.randomUUID();
            void run('/cluster/sign-in', { key: key.current });
          }}
        >
          Sign in to {label}
        </button>
        <small>
          Your password and verification code go straight to SSH on this computer. They are not
          saved, shown to agents or added to chats.
        </small>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <form
      className="quark-cluster-sign-in"
      onSubmit={(event) => {
        event.preventDefault();
        if (!flow.prompt || !answer) return;
        const response = answer;
        setAnswer('');
        void run('/cluster/sign-in/respond', {
          id: flow.id,
          promptId: flow.prompt.id,
          response,
        });
      }}
    >
      {flow.prompt ? (
        <label>
          {flow.prompt.label}
          <input
            key={flow.prompt.id}
            type={flow.prompt.kind === 'password' ? 'password' : 'text'}
            inputMode={flow.prompt.kind === 'code' ? 'numeric' : undefined}
            autoComplete={flow.prompt.kind === 'password' ? 'current-password' : 'one-time-code'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      ) : (
        <p role="status">{flow.message || 'Waiting for the cluster…'}</p>
      )}
      <div className="quark-cluster-actions">
        {flow.prompt && (
          <button className="flow-button primary" disabled={!answer}>
            Send
          </button>
        )}
        <button
          type="button"
          className="flow-button"
          onClick={() => void run('/cluster/sign-in/cancel', { id: flow.id })}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}

function ClusterSettingsForm({ saved, done }: { saved: ClusterSettings | null; done: () => void }) {
  const [draft, setDraft] = useState<ClusterSettings>(
    saved ?? { enabled: true, alias: '', label: 'Cluster', accountingDays: 3 },
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const receipt = useRef({ signature: '', key: crypto.randomUUID() });
  async function save() {
    setBusy(true);
    setError('');
    const signature = JSON.stringify(draft);
    if (receipt.current.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    try {
      await api('/cluster/settings', { key: receipt.current.key, settings: draft });
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Your entries are retained.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="quark-settings quark-cluster-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        SSH host alias
        <input
          value={draft.alias}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="e.g. hpc"
          onChange={(e) => setDraft({ ...draft, alias: e.target.value })}
        />
      </label>
      <label>
        Name shown here
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </label>
      <label>
        Recent jobs
        <select
          value={draft.accountingDays}
          onChange={(e) => setDraft({ ...draft, accountingDays: Number(e.target.value) })}
        >
          {[1, 2, 3, 4, 5, 6].map((days) => (
            <option key={days} value={days}>
              Last {days} day{days === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>
      <label className="quark-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />{' '}
        Monitor this cluster
      </label>
      <button className="flow-button" disabled={busy || !draft.alias.trim()}>
        {busy ? 'Saving…' : 'Save cluster'}
      </button>
      <small>
        Use the host name you already type after <code>ssh</code> on this computer. Readings use
        your own sign-in, read only Slurm status and add no limits; your site’s rules still apply.
      </small>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}

export function QuarkCluster({ reading }: { reading: HomeData['cluster'] }) {
  const notebooks = useReading('/cluster/notebooks', clusterNotebooksSchema.parse);
  const [opening, setOpening] = useState<string | null>(null);
  const [notebookLink, setNotebookLink] = useState<{ jobId: string; url: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [allPartitions, setAllPartitions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const s = reading.data;
  if (!s)
    return reading.error ? (
      <section className="quark-cluster" aria-label="Slurm cluster">
        <p role="alert">
          Cluster readings could not load.{' '}
          <button className="flow-button" onClick={reading.retry}>
            Retry
          </button>
        </p>
      </section>
    ) : null;
  if (!s.configured)
    return (
      <details className="quark-advanced quark-cluster-connect">
        <summary>
          <Server size={16} /> Slurm cluster · not connected
        </summary>
        <p>
          See your cluster queue, pending reasons, fairshare and native limits here, shared with
          your managers. Managers use your normal SSH access for files and jobs.
        </p>
        <ClusterSettingsForm saved={null} done={reading.retry} />
      </details>
    );
  const now = Date.now();
  const { connection, queue } = s;
  const running = queue.items.filter((job) => job.state === 'RUNNING');
  const pending = queue.items.filter((job) => job.state !== 'RUNNING');
  const partitions = s.limits.partitions.filter((p) => allPartitions || p.accessible !== false);
  // The tunnel URL carries Jupyter's token: it goes to a new tab, never into storage.
  async function openNotebook(jobId: string) {
    const tab = window.open('about:blank', '_blank');
    setOpening(jobId);
    setError('');
    try {
      const opened = await api<{ jobId: string; url: string }>('/cluster/notebooks/open', {
        key: crypto.randomUUID(),
        jobId,
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = opened.url;
      } else setNotebookLink(opened);
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : 'The notebook could not be opened.');
    } finally {
      setOpening(null);
      notebooks.retry();
    }
  }
  async function closeNotebook(jobId: string) {
    setError('');
    try {
      await api('/cluster/notebooks/close', { jobId });
      if (notebookLink?.jobId === jobId) setNotebookLink(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tunnel could not be closed.');
    } finally {
      notebooks.retry();
    }
  }
  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await api('/cluster/refresh', { key: crypto.randomUUID() }, undefined, 90_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh. The last reading is kept.');
    } finally {
      setRefreshing(false);
      reading.retry();
    }
  }
  return (
    <section className="quark-cluster" aria-label={`${s.settings!.label} · Slurm cluster`}>
      <header>
        <div>
          <h2>
            <Server size={18} /> {s.settings!.label}
          </h2>
          <p>
            <span className={`quark-cluster-connection is-${connection.state}`}>
              {stateLabels[connection.state]}
            </span>{' '}
            {s.scheduler && `· Slurm ${s.scheduler.version} `}·{' '}
            {queue.observedAt
              ? `queue read ${ago(queue.observedAt, now)}${s.stale ? ' · old' : ''}`
              : 'no reading yet'}
          </p>
        </div>
        <div className="quark-cluster-actions">
          <button
            className="flow-button"
            disabled={refreshing || s.refreshing || !s.settings!.enabled}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} /> {refreshing || s.refreshing ? 'Reading…' : 'Refresh'}
          </button>
          <button
            className="flow-button"
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            Settings
          </button>
        </div>
      </header>
      {editing && (
        <ClusterSettingsForm
          saved={s.settings}
          done={() => {
            setEditing(false);
            reading.retry();
          }}
        />
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {connection.state !== 'connected' && connection.state !== 'checking' && (
        <p className="quark-cluster-message" role="status">
          {connection.message}
          {connection.state === 'sign-in-needed' &&
            ' Sign in below or with your usual SSH command on this computer; readings resume automatically.'}
          {connection.checkedAt && ` Last attempt ${ago(connection.checkedAt, now)}.`}
        </p>
      )}
      {s.unavailable.length > 0 && (
        <details className="quark-advanced quark-cluster-unavailable">
          <summary>
            Not read in the latest reading:{' '}
            {[...new Set(s.unavailable.map((item) => unavailableLabels[item.section]))].join(', ')}
          </summary>
          <p className="quark-cluster-note">
            Values shown for these may be older or missing. Other sections are current.
          </p>
          <ul className="quark-cluster-list">
            {s.unavailable.map((item) => (
              <li key={item.section}>
                <small>
                  {unavailableLabels[item.section]}: {item.message}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.settings!.enabled &&
        (connection.state === 'sign-in-needed' ||
          (connection.state === 'connected' && connection.master === 'absent')) && (
          <ClusterSignInFlow label={s.settings!.label} done={reading.retry} />
        )}
      <div className="quark-cluster-grid">
        <div>
          <h3>
            Jobs{' '}
            <small>
              {running.length} running · {pending.length} waiting
            </small>
          </h3>
          {queue.error && <p className="quark-cluster-note">{queue.error}</p>}
          {queue.items.length ? (
            <ul className="quark-cluster-list">
              {queue.items.slice(0, 12).map((job) => (
                <QueueJob
                  key={job.jobId}
                  job={job}
                  notebook={
                    notebooks.data && notebookJob(job)
                      ? {
                          local: notebooks.data.localBrowser,
                          busy: opening === job.jobId,
                          open: () => void openNotebook(job.jobId),
                        }
                      : undefined
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="quark-cluster-note">
              {queue.observedAt ? 'No jobs in the queue.' : 'Waiting for the first reading.'}
            </p>
          )}
          {queue.items.length > 12 && (
            <p className="quark-cluster-note">
              {queue.items.length - 12} more in the shared reading; managers see all of them.
            </p>
          )}
        </div>
        <div>
          <h3>Fairshare</h3>
          {s.fairshare.items.length ? (
            <ul className="quark-cluster-fairshare">
              {s.fairshare.items.map((item) => (
                <li key={item.account}>
                  <span>{item.account}</span>
                  <strong>{item.fairShare === null ? '—' : item.fairShare.toFixed(3)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quark-cluster-note">{s.fairshare.error ?? 'Not read yet.'}</p>
          )}
          <p className="quark-cluster-note">
            sshare’s 0–1 factor per account. Higher adds more priority but does not guarantee an
            earlier start. It is not remaining capacity and does not choose an account.
          </p>
        </div>
      </div>
      {notebookLink && (
        <p className="quark-cluster-message">
          <a href={notebookLink.url} target="_blank" rel="noopener noreferrer">
            Open notebook {notebookLink.jobId}
          </a>{' '}
          (your browser blocked the new tab).
        </p>
      )}
      {!!notebooks.data?.notebooks.length && (
        <details className="quark-advanced" open>
          <summary>Notebook tunnels ({notebooks.data.notebooks.length})</summary>
          <ul className="quark-cluster-list">
            {notebooks.data.notebooks.map((notebook) => (
              <li key={notebook.jobId}>
                <div>
                  <strong>Job {notebook.jobId}</strong>
                  <span className="quark-cluster-state">
                    {notebook.running ? 'running' : 'job no longer running'}
                  </span>
                </div>
                <small>
                  {notebook.node} →{' '}
                  {notebooks.data!.localBrowser ? 'this computer' : 'the cluster’s computer'},
                  127.0.0.1:{notebook.localPort} · opened {ago(notebook.openedAt, now)}
                </small>
                <button className="flow-button" onClick={() => void closeNotebook(notebook.jobId)}>
                  Close tunnel
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.tracked.length > 0 && (
        <details className="quark-advanced" open={s.tracked.some((job) => !job.reportedAt)}>
          <summary>Jobs started by your agents ({s.tracked.length})</summary>
          <ul className="quark-cluster-list">
            {s.tracked.slice(0, 20).map((job) => (
              <li key={job.jobId}>
                <div>
                  <strong>{job.jobId}</strong>
                  <span className="quark-cluster-state">
                    {(job.state ?? 'not seen yet').toLowerCase()}
                  </span>
                </div>
                <small>
                  Seen {ago(job.lastSeenAt ?? job.detectedAt, now)}
                  {job.reportedAt ? ' · outcome reported' : ''}
                  {job.alias !== s.settings!.alias &&
                    ` · on ${job.alias}, not followed while another alias is selected`}
                </small>
                <Owner owner={job.owner} />
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="quark-advanced">
        <summary>
          Recent jobs · last {s.settings!.accountingDays} day
          {s.settings!.accountingDays === 1 ? '' : 's'} ({s.recent.items.length})
        </summary>
        {s.recent.error && <p className="quark-cluster-note">{s.recent.error}</p>}
        {s.recent.items.length ? (
          <ul className="quark-cluster-list">
            {[...s.recent.items]
              .reverse()
              .slice(0, 30)
              .map((job) => (
                <RecentJob key={job.jobId} job={job} />
              ))}
          </ul>
        ) : (
          <p className="quark-cluster-note">No finished jobs in this window.</p>
        )}
      </details>
      <details className="quark-advanced">
        <summary>Native account, QOS and partition limits</summary>
        {s.limits.error && <p className="quark-cluster-note">{s.limits.error}</p>}
        <p className="quark-cluster-note">
          A blank field means no limit was reported at that level, not that none applies. Your
          association, its accounts and parents, QOS, partition and site limits all apply, and Slurm
          enforces them, not this app.
        </p>
        <ul className="quark-cluster-list">
          <li>
            <div>
              <strong>Site</strong>
              {s.limits.site?.priorityType && (
                <span className="quark-cluster-state">
                  {s.limits.site.priorityType}
                  {s.limits.site.priorityFlags ? ` · ${s.limits.site.priorityFlags}` : ''}
                </span>
              )}
            </div>
            <small>
              {s.limits.site
                ? [
                    `${s.limits.site.maxArraySize?.toLocaleString() ?? 'not reported'} tasks per job array`,
                    `${s.limits.site.maxJobCount?.toLocaleString() ?? 'not reported'} jobs cluster-wide`,
                    s.limits.site.enforce && `enforces ${s.limits.site.enforce}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'Site limits were not reported.'}
            </small>
          </li>
          {s.limits.items.map((item) => (
            <li key={`${item.account}:${item.partition}`}>
              <div>
                <strong>{item.account}</strong>
                <span className="quark-cluster-state">{item.qos.join(', ')}</span>
              </div>
              <small>You · {limitText(item)}</small>
            </li>
          ))}
          {s.limits.accounts.map((item) => (
            <li key={`account:${item.account}:${item.partition}`}>
              <div>
                <strong>Account {item.account}</strong>
                <span className="quark-cluster-state">
                  {item.parent ? `under ${item.parent}` : 'top level'}
                </span>
              </div>
              <small>Shared by everyone in it · {limitText(item)}</small>
            </li>
          ))}
          {s.limits.qos
            .filter(
              (qos) =>
                qos.maxJobsPerUser !== null ||
                qos.maxSubmitPerUser !== null ||
                qos.maxTresPerUser ||
                qos.maxJobsPerAccount !== null ||
                qos.maxSubmitPerAccount !== null ||
                qos.maxTresPerAccount ||
                qos.maxTres ||
                qos.maxWall ||
                qos.grpTres,
            )
            .map((qos) => (
              <li key={`qos:${qos.name}`}>
                <div>
                  <strong>QOS {qos.name}</strong>
                </div>
                <small>
                  {[
                    qos.maxJobsPerUser !== null && `${qos.maxJobsPerUser} jobs per person`,
                    qos.maxSubmitPerUser !== null && `${qos.maxSubmitPerUser} submitted`,
                    qos.maxTresPerUser && `per person ${qos.maxTresPerUser}`,
                    qos.maxJobsPerAccount !== null && `${qos.maxJobsPerAccount} jobs per account`,
                    qos.maxSubmitPerAccount !== null &&
                      `${qos.maxSubmitPerAccount} submitted per account`,
                    qos.maxTresPerAccount && `per account ${qos.maxTresPerAccount}`,
                    qos.maxTres && `per job ${qos.maxTres}`,
                    qos.grpTres && `group ${qos.grpTres}`,
                    qos.maxWall && `max time ${qos.maxWall}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </li>
            ))}
        </ul>
        <h3>Partitions</h3>
        <ul className="quark-cluster-list">
          {partitions.map((p) => (
            <li key={p.name}>
              <div>
                <strong>{p.name}</strong>
                <span className="quark-cluster-state">
                  {p.accessible === false ? 'not available to you' : p.state.toLowerCase()}
                </span>
              </div>
              <small>
                Max {p.maxTime}
                {p.cpus
                  ? ` · ${p.cpus.idle.toLocaleString()} of ${p.cpus.total.toLocaleString()} CPUs idle now`
                  : ''}
                {p.gres ? ` · ${p.gres}` : ''}
                {p.qos ? ` · QOS ${p.qos}` : ''}
              </small>
            </li>
          ))}
        </ul>
        {s.limits.partitions.some((p) => p.accessible === false) && (
          <button className="flow-button" onClick={() => setAllPartitions(!allPartitions)}>
            {allPartitions ? 'Show only your partitions' : 'Show all partitions'}
          </button>
        )}
      </details>
      <p className="quark-footnote">{s.notice}</p>
    </section>
  );
}
