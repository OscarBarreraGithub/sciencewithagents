import { execFile } from 'node:child_process';
import { z } from 'zod';
import {
  clusterRefreshSchema,
  clusterSettingsRequestSchema,
  clusterSettingsSchema,
  clusterStatusSchema,
  clusterTrackedJobSchema,
  type ClusterConnection,
  type ClusterSettings,
  type ClusterStatus,
  type ClusterTrackedJob,
  type ClusterTrackedOwner,
} from '@dock/shared';
import { join } from 'node:path';
import { Conflict, type Store } from './store.js';
import { repoRoot } from './paths.js';
import {
  connectionFailure,
  fastScript,
  parseAccountLimits,
  parseAccounting,
  parseAssociations,
  parseFairshare,
  parsePartitions,
  parsePriority,
  parseQos,
  parseQueue,
  parseSiteConfig,
  slowScript,
  splitSections,
  submittedJobIds,
  textValue,
  type Section,
} from './cluster-slurm.js';

const prefix = 'cluster:v1:';
export const clusterNotice =
  'Read-only observations of native Slurm state through your own SSH sign-in. sciencewithagents imposes no cluster limits or submission gate; native account, partition, QOS and site rules apply. A blank limit means none was reported at that level, not that none applies. Fairshare contributes to scheduling priority; it is not a remaining allowance or a start-time promise. AI allowance limits are separate from cluster resources.';
export const clusterIntervals = {
  activeMs: 120_000,
  idleMs: 300_000,
  slowMs: 900_000,
  manualMs: 20_000,
  maxBackoffMs: 600_000,
};
const activeStates =
  /^(PENDING|RUNNING|REQUEUED|REQUEUE_HOLD|REQUEUE_FED|RESIZING|SUSPENDED|CONFIGURING|COMPLETING|STAGE_OUT|SIGNALING|STOPPED)/;

export type ClusterRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
export type ClusterRunner = (
  args: string[],
  input: string | null,
  timeoutMs: number,
) => Promise<ClusterRun>;

/** Native OpenSSH with fixed options; the alias is validated and follows `--`. */
export const sshRunner: ClusterRunner = (args, input, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(
      'ssh',
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          code: failure ? (typeof failure.code === 'number' ? failure.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr).slice(0, 8000),
          timedOut: !!failure?.killed,
        });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

/** Options for every collector query: never prompt, never accept host keys, never become a master. */
export const queryOptions = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=2',
];

type Cache = {
  /** The alias this reading came from. */
  alias?: string;
  connection: ClusterConnection;
  scheduler: ClusterStatus['scheduler'];
  queue: ClusterStatus['queue'];
  fairshare: ClusterStatus['fairshare'];
  limits: ClusterStatus['limits'];
  recent: ClusterStatus['recent'];
  /** Latest accounting rows for tracked jobs outside the recent window. */
  trackedRows: ClusterStatus['recent']['items'];
  unavailable: ClusterStatus['unavailable'];
};
type Unavailable = ClusterStatus['unavailable'][number]['section'];
/** Reply sections and the reading each one feeds. */
const fastSections: [string, Unavailable][] = [
  ['squeue', 'queue'],
  ['sprio', 'priority'],
  ['sacct', 'recent'],
  ['tracked', 'tracked'],
];
const slowSections: [string, Unavailable][] = [
  ['version', 'version'],
  ['groups', 'groups'],
  ['fairshare', 'fairshare'],
  ['assoc', 'assoc'],
  ['accounts', 'accounts'],
  ['qos', 'qos'],
  ['partitions', 'partitions'],
  ['sinfo', 'sinfo'],
  ['config', 'config'],
];
const emptySection = { observedAt: null, error: null, items: [], omitted: 0 };
const emptyCache = (): Cache => ({
  connection: {
    state: 'not-configured',
    master: 'unknown',
    checkedAt: null,
    connectedAt: null,
    message: 'No cluster is connected on this computer.',
  },
  scheduler: null,
  queue: { ...emptySection, priority: [] },
  fairshare: { ...emptySection },
  limits: { ...emptySection, accounts: [], qos: [], partitions: [], site: null },
  recent: { ...emptySection },
  trackedRows: [],
  unavailable: [],
});
const okStatus = (section: Section | undefined) =>
  !!section && (section.status === 0 || section.status === 141);
const sectionError = (section: Section | undefined, fallback: string) =>
  !section
    ? fallback
    : okStatus(section)
      ? null
      : (section.lines
          .find(Boolean)
          ?.replace(/\S+@\S+/g, 'account@host')
          .slice(0, 300) ?? fallback);

export type ClusterTargetChange = { previous: string | null; alias: string };

export class ClusterMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  /** Bumped whenever the saved alias changes; in-flight work for an older target is discarded. */
  private generation = 0;
  private targetListeners = new Set<(change: ClusterTargetChange) => void>();
  private signInListeners = new Set<(connectionId?: string) => void>();
  private failures = 0;
  private nextFast = 0;
  private nextSlow = 0;
  private lastManual = 0;
  /** Runs after each successful reading, e.g. to restore notebook tunnels. */
  afterCollect: () => Promise<void> = async () => {};
  constructor(
    readonly store: Store,
    readonly runner: ClusterRunner = sshRunner,
    private clock = Date.now,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS cluster_tracked_jobs (alias TEXT NOT NULL, job_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (alias, job_id))',
    );
  }
  /** Notified synchronously when the owner saves a different alias. */
  onTargetChange(listener: (change: ClusterTargetChange) => void) {
    this.targetListeners.add(listener);
    return () => this.targetListeners.delete(listener);
  }
  onSignedIn(listener: (connectionId?: string) => void) {
    this.signInListeners.add(listener);
    return () => this.signInListeners.delete(listener);
  }
  settings(): ClusterSettings | null {
    const saved = clusterSettingsSchema.safeParse(this.store.getSetting(prefix + 'settings'));
    return saved.success ? saved.data : null;
  }
  now() {
    return this.clock();
  }
  revision() {
    return z
      .number()
      .int()
      .nonnegative()
      .catch(0)
      .parse(this.store.getSetting(prefix + 'revision'));
  }
  /** The saved reading for this alias only; another alias's reading is never shown or merged. */
  private cache(alias: string): Cache {
    const saved = this.store.getSetting(prefix + 'cache') as Partial<Cache> | null;
    if (saved?.alias !== alias) return emptyCache();
    return { ...emptyCache(), ...saved };
  }
  private saveCache(alias: string, cache: Cache) {
    this.store.setSetting(prefix + 'cache', { ...cache, alias });
    this.touch();
  }
  // Manager notices read the summary on every coordination reply; reuse an unchanged reading.
  private version = 0;
  private memo: { version: number; at: number; value: ClusterStatus } | null = null;
  private touch() {
    this.version += 1;
  }
  /** Saving is owner configuration. A changed alias discards readings from the old target. */
  save(raw: unknown) {
    const input = clusterSettingsRequestSchema.parse(raw);
    let change: ClusterTargetChange | null = null;
    const result = this.store.operation(input.key, { kind: 'cluster.settings', ...input }, () => {
      const previous = this.settings();
      const changed = previous?.alias !== input.settings.alias;
      this.store.setSetting(prefix + 'settings', input.settings);
      this.store.setSetting(prefix + 'revision', this.revision() + 1);
      if (changed) {
        this.saveCache(input.settings.alias, emptyCache());
        this.store.setSetting(prefix + 'connection-state', null);
        change = { previous: previous?.alias ?? null, alias: input.settings.alias };
      }
      this.store.event('cluster.settings_saved', null, null, {
        enabled: input.settings.enabled,
        accountingDays: input.settings.accountingDays,
        ...(changed ? { aliasChanged: true } : {}),
      });
      return { saved: true };
    });
    this.nextFast = this.nextSlow = 0;
    this.failures = 0;
    this.touch();
    if (change) {
      this.generation += 1;
      this.sockets = null;
      for (const listener of this.targetListeners)
        try {
          listener(change);
        } catch {
          // One listener cannot undo a saved owner choice; each re-checks the target later.
        }
    }
    return result;
  }
  /** The current alias and a token that changes with it, for work that spans awaits. */
  target() {
    const settings = this.settings();
    return { alias: settings?.alias ?? null, generation: this.generation };
  }
  isCurrent(target: { alias: string | null; generation: number }) {
    return !this.closed && target.generation === this.generation && !!target.alias;
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }
  /** One collector per computer; managers and the UI read its cache. */
  async tick() {
    try {
      const settings = this.settings();
      if (this.closed || this.running || !settings?.enabled) return;
      const now = this.clock();
      if (now < this.nextFast && now < this.nextSlow) return;
      await this.collect(settings, now >= this.nextSlow);
    } catch {
      // Timer and fire-and-forget callers must never see a rejection; collect records failures.
    }
  }
  /** Owner-requested refresh; bounded so repeated taps reuse the same SSH session. */
  async refresh(raw: unknown) {
    clusterRefreshSchema.parse(raw);
    const settings = this.settings();
    if (!settings?.enabled) throw new Conflict('Connect a cluster in QUARK before refreshing it.');
    const now = this.clock();
    if (!this.running && now - this.lastManual >= clusterIntervals.manualMs) {
      this.lastManual = now;
      const cache = this.cache(settings.alias);
      const slowAge = cache.fairshare.observedAt
        ? now - Date.parse(cache.fairshare.observedAt)
        : Infinity;
      await this.collect(settings, slowAge > clusterIntervals.slowMs / 3);
    } else await this.running?.catch(() => {});
    return this.status();
  }
  private backoff() {
    this.failures += 1;
    const delay = Math.min(clusterIntervals.maxBackoffMs, 60_000 * 2 ** (this.failures - 1));
    this.nextFast = this.nextSlow = this.clock() + delay;
  }
  /**
   * One reading for one alias. It never rejects: SSH, parser and storage failures become a
   * visible connection error, and a reading whose alias was replaced meanwhile is dropped.
   */
  private collect(settings: ClusterSettings, slow: boolean) {
    const target = { alias: settings.alias, generation: this.generation };
    let discarded = false;
    const current = () => {
      if (!this.isCurrent(target)) discarded = true;
      return !discarded;
    };
    const run = (async () => {
      let cache = emptyCache();
      try {
        cache = this.cache(settings.alias);
        const master = await this.masterState(settings.alias);
        const tracked = this.pendingTracked(settings.alias);
        const fast = await this.query(settings, fastScript, [
          String(settings.accountingDays),
          ...tracked,
        ]);
        if (!current()) return;
        const checkedAt = new Date(this.clock()).toISOString();
        if (!fast.ok) {
          this.backoff();
          cache.connection = {
            state: fast.failure.state,
            master,
            checkedAt,
            connectedAt: cache.connection.connectedAt,
            message: fast.failure.message,
          };
          this.saveCache(settings.alias, cache);
          this.recordConnection(cache.connection);
          return;
        }
        this.failures = 0;
        cache.connection = {
          state: 'connected',
          master,
          checkedAt,
          connectedAt: checkedAt,
          message:
            master === 'running'
              ? 'Connected through your existing SSH sign-in.'
              : 'Connected with your SSH key. No shared sign-in session is running on this computer.',
        };
        this.applyFast(cache, fast.sections, checkedAt);
        this.markUnavailable(
          cache,
          fast.sections,
          fastSections.filter(([name]) => name !== 'tracked' || tracked.length > 0),
          fastSections,
        );
        if (slow) {
          const result = await this.query(settings, slowScript, []);
          if (!current()) return;
          if (result.ok) {
            this.applySlow(cache, result.sections, new Date(this.clock()).toISOString());
            this.markUnavailable(cache, result.sections, slowSections, slowSections);
          } else {
            cache.fairshare.error = cache.limits.error = result.failure.message;
            this.markUnavailable(
              cache,
              new Map(),
              slowSections,
              slowSections,
              result.failure.message,
            );
          }
          this.nextSlow = this.clock() + clusterIntervals.slowMs;
        }
        const active =
          cache.queue.items.length > 0 ||
          this.tracked(settings.alias).some((job) => !job.state || activeStates.test(job.state));
        this.nextFast =
          this.clock() + (active ? clusterIntervals.activeMs : clusterIntervals.idleMs);
        this.store.transaction(() => {
          this.saveCache(settings.alias, cache);
          this.reconcileTracked(cache, checkedAt, settings.alias);
        });
        this.recordConnection(cache.connection);
      } catch {
        if (!current()) return;
        this.backoff();
        cache.connection = {
          ...cache.connection,
          state: 'error',
          checkedAt: new Date(this.clock()).toISOString(),
          message: 'The cluster reply could not be processed. The last reading is kept.',
        };
        try {
          this.saveCache(settings.alias, cache);
          this.recordConnection(cache.connection);
        } catch {
          // Storage itself failed; the next reading retries after the backoff.
        }
        return;
      }
      await Promise.resolve()
        .then(() => this.afterCollect())
        .catch(() => {});
    })().finally(() => {
      this.running = null;
      this.touch();
      // A reading for a replaced alias was dropped; read the new one now.
      if (discarded && !this.closed) void this.tick();
    });
    this.running = run;
    this.touch();
    return run;
  }
  private recordConnection(connection: ClusterConnection) {
    const previous = this.store.getSetting(prefix + 'connection-state');
    if (previous === connection.state) return;
    this.store.setSetting(prefix + 'connection-state', connection.state);
    this.store.event('cluster.connection_changed', null, null, {
      state: connection.state,
      master: connection.master,
    });
  }
  private sockets: { alias: string; at: number; paths: string[] } | null = null;
  /** The configured alias's native control socket from `ssh -G`; local, no connection. */
  async controlSockets(): Promise<string[]> {
    const settings = this.settings();
    if (!settings?.enabled) return [];
    const now = this.clock();
    if (this.sockets?.alias === settings.alias && now - this.sockets.at < 600_000)
      return this.sockets.paths;
    const result = await this.runner(['-G', '--', settings.alias], null, 5000);
    const path = /^controlpath (.+)$/m.exec(result.code === 0 ? result.stdout : '')?.[1]?.trim();
    const paths =
      path && path !== 'none' && path.startsWith('/') && path.length <= 400 ? [path] : [];
    this.sockets = { alias: settings.alias, at: now, paths };
    return paths;
  }
  /** Local control-socket check for an alias, by default the configured one. */
  async masterState(alias = this.settings()?.alias): Promise<ClusterConnection['master']> {
    if (!alias) return 'unknown';
    // A local socket check only; it never opens a network connection or a master.
    const result = await this.runner(['-O', 'check', '--', alias], null, 5000);
    if (result.code === 0) return 'running';
    return /No such file|Connection refused/i.test(result.stderr) ? 'absent' : 'unknown';
  }
  /** A restored sign-in resumes collection immediately instead of waiting out a backoff. */
  signedIn(connectionId?: string) {
    for (const listener of this.signInListeners) {
      try {
        listener(connectionId);
      } catch {
        /* Metadata observers cannot undo sign-in. */
      }
    }
    this.failures = 0;
    this.nextFast = this.nextSlow = 0;
    void this.tick();
  }
  /** Identity of the owner's current native master; this check never signs in. */
  async masterIdentity(alias = this.settings()?.alias): Promise<string | null> {
    if (!alias) return null;
    const result = await this.runner(['-O', 'check', '--', alias], null, 5000);
    if (result.code !== 0) return null;
    const pid = /Master running \(pid=(\d+)\)/.exec(result.stderr + result.stdout)?.[1];
    return pid ? `master:${pid}` : 'master:present';
  }
  private async query(settings: ClusterSettings, script: string, args: string[]) {
    const result = await this.runner(
      [...queryOptions, '--', settings.alias, 'bash', '-s', '--', ...args],
      script,
      60_000,
    );
    const sections = splitSections(result.stdout);
    if (result.code === 0 && sections.size) return { ok: true as const, sections };
    return {
      ok: false as const,
      failure:
        result.code === 0
          ? { state: 'error' as const, message: 'The cluster returned an unreadable reply.' }
          : connectionFailure(result.stderr, result.timedOut),
    };
  }
  private applyFast(cache: Cache, sections: Map<string, Section>, at: string) {
    const squeue = sections.get('squeue');
    const queue = okStatus(squeue) ? parseQueue(squeue!.lines) : [];
    cache.queue = {
      observedAt: okStatus(squeue) ? at : cache.queue.observedAt,
      error: sectionError(squeue, 'The queue reading was missing.'),
      items: okStatus(squeue)
        ? queue.slice(0, 500).map((job) => ({ ...job, owner: null }))
        : cache.queue.items,
      // The remote reply is capped at 501 rows, so a positive count means "at least".
      omitted: okStatus(squeue) ? Math.max(0, queue.length - 500) : cache.queue.omitted,
      // Factors belong to jobs pending in this reading; never keep ones for started jobs.
      priority: okStatus(sections.get('sprio'))
        ? parsePriority(sections.get('sprio')!.lines)
            .filter((factor) =>
              queue.some((job) => job.state === 'PENDING' && job.jobId === factor.jobId),
            )
            .slice(0, 200)
        : [],
    };
    const sacct = sections.get('sacct');
    if (okStatus(sacct)) {
      const jobs = parseAccounting(sacct!.lines);
      cache.recent = {
        observedAt: at,
        error: null,
        items: jobs.slice(-400).map((job) => ({ ...job, owner: null })),
        omitted: Math.max(0, jobs.length - 400),
      };
    } else
      cache.recent = { ...cache.recent, error: sectionError(sacct, 'Accounting was missing.') };
    const tracked = sections.get('tracked');
    if (okStatus(tracked))
      cache.trackedRows = parseAccounting(tracked!.lines)
        .slice(-400)
        .map((job) => ({ ...job, owner: null }));
  }
  /**
   * Lists each expected section that failed, was unsupported or was missing, replacing the
   * previous verdicts for this group. Kept values from older readings stay visible but flagged.
   */
  private markUnavailable(
    cache: Cache,
    sections: Map<string, Section>,
    expected: [string, Unavailable][],
    group: [string, Unavailable][],
    failure?: string,
  ) {
    const names = new Set(group.map(([, section]) => section));
    cache.unavailable = [
      ...cache.unavailable.filter((item) => !names.has(item.section)),
      ...expected
        .filter(([name]) => !okStatus(sections.get(name)))
        .map(([name, section]) => ({
          section,
          message: failure ?? sectionError(sections.get(name), 'Missing from the reply.')!,
        })),
    ].slice(0, 20);
  }
  private applySlow(cache: Cache, sections: Map<string, Section>, at: string) {
    const version = sections.get('version');
    const associations = okStatus(sections.get('assoc'))
      ? parseAssociations(sections.get('assoc')!.lines)
      : null;
    cache.scheduler = okStatus(version)
      ? {
          version: textValue(version!.lines[0]?.replace(/^slurm\s+/i, ''), 40),
          cluster: associations?.[0]?.cluster ?? cache.scheduler?.cluster ?? '',
        }
      : cache.scheduler;
    const fairshare = sections.get('fairshare');
    cache.fairshare = okStatus(fairshare)
      ? {
          observedAt: at,
          error: null,
          items: parseFairshare(fairshare!.lines).slice(0, 50),
          omitted: 0,
        }
      : { ...cache.fairshare, error: sectionError(fairshare, 'Fairshare was missing.') };
    // Group membership decides partition access here and is not retained.
    const groups = okStatus(sections.get('groups'))
      ? (sections.get('groups')!.lines[0] ?? '').split(/\s+/).filter(Boolean)
      : [];
    const partitions = sections.get('partitions');
    cache.limits = {
      observedAt: associations ? at : cache.limits.observedAt,
      error: sectionError(sections.get('assoc'), 'Account limits were missing.'),
      items: associations?.slice(0, 50) ?? cache.limits.items,
      omitted: associations ? Math.max(0, associations.length - 50) : cache.limits.omitted,
      accounts: okStatus(sections.get('accounts'))
        ? parseAccountLimits(sections.get('accounts')!.lines).slice(0, 100)
        : cache.limits.accounts,
      qos: okStatus(sections.get('qos'))
        ? parseQos(sections.get('qos')!.lines).slice(0, 100)
        : cache.limits.qos,
      site: okStatus(sections.get('config'))
        ? parseSiteConfig(sections.get('config')!.lines)
        : cache.limits.site,
      partitions: okStatus(partitions)
        ? parsePartitions(
            partitions!.lines,
            sections.get('sinfo')?.lines ?? [],
            groups,
            (associations ?? cache.limits.items).map((item) => item.account),
          ).slice(0, 200)
        : cache.limits.partitions,
    };
  }
  /** Tracked jobs not yet seen in a terminal state, newest first, bounded per query. */
  private pendingTracked(alias: string) {
    // An ID never seen in a week was not this account's job; stop asking about it.
    const cutoff = this.clock() - 7 * 86_400_000;
    return this.tracked(alias)
      .filter((job) => !job.reportedAt && (job.state || Date.parse(job.detectedAt) > cutoff))
      .slice(0, 50)
      .map((job) => job.jobId);
  }
  /** Tracked jobs, newest first: every cluster's history, or one alias's jobs only. */
  tracked(alias?: string): ClusterTrackedJob[] {
    const order = "ORDER BY json_extract(body,'$.detectedAt') DESC LIMIT 200";
    return (
      alias === undefined
        ? this.store.db.prepare(`SELECT body FROM cluster_tracked_jobs ${order}`).all()
        : this.store.db
            .prepare(`SELECT body FROM cluster_tracked_jobs WHERE alias=? ${order}`)
            .all(alias)
    ).map((row) => clusterTrackedJobSchema.parse(JSON.parse(String(row.body))));
  }
  private owner(agentId: string): ClusterTrackedOwner | null {
    try {
      const agent = this.store.agent(agentId);
      return {
        agentId,
        agentName: agent.name.slice(0, 200),
        projectId: agent.projectId,
        projectName: this.store.project(agent.projectId).name.slice(0, 200),
      };
    } catch {
      return null;
    }
  }
  /** Record native sbatch confirmations from a completed tool item. Idempotent by job ID. */
  observe(agentId: string, entryId: string) {
    const settings = this.settings();
    if (!settings) return [];
    const entry = this.store.savedEntry(agentId, entryId);
    if (!entry || entry.kind !== 'tool' || entry.status !== 'complete') return [];
    // Codex titles carry the command; a printed log alone is not a submission.
    if (entry.title !== 'Bash' && !/\bsbatch\b/.test(entry.title)) return [];
    const ids = submittedJobIds(entry.text, entry.title);
    if (!ids.length) return [];
    const agent = this.store.agent(agentId);
    const detectedAt = new Date(this.clock()).toISOString();
    const recorded: string[] = [];
    this.store.transaction(() => {
      for (const jobId of ids) {
        const job = clusterTrackedJobSchema.parse({
          jobId,
          alias: settings.alias,
          agentId,
          projectId: agent.projectId,
          runId: entry.runId,
          sessionId: agent.threadId ?? null,
          entryId: entryId.slice(0, 400),
          detectedAt,
          source: 'submission-output',
          state: null,
          lastSeenAt: null,
          reportedAt: null,
        });
        const inserted = this.store.db
          .prepare('INSERT OR IGNORE INTO cluster_tracked_jobs VALUES(?,?,?)')
          .run(settings.alias, jobId, JSON.stringify(job));
        if (inserted.changes) {
          this.touch();
          recorded.push(jobId);
          this.store.event('cluster.job_tracked', agent.projectId, agentId, {
            jobId,
            alias: settings.alias,
            runId: entry.runId,
          });
        }
      }
    });
    if (recorded.length) this.nextFast = 0;
    return recorded;
  }
  /** Merge this alias's Slurm states into its tracked jobs and report each finished one once. */
  private reconcileTracked(cache: Cache, at: string, alias: string) {
    const rows = [...cache.recent.items, ...cache.trackedRows];
    const finished = new Map<string, ClusterTrackedJob[]>();
    for (const job of this.tracked(alias)) {
      const queued = cache.queue.items.filter((item) => item.baseJobId === job.jobId);
      const accounted = rows.filter((row) => row.baseJobId === job.jobId);
      const states = queued.length
        ? queued.map((item) => item.state)
        : accounted.map((row) => row.state);
      if (!states.length) continue;
      const active = states.some((state) => activeStates.test(state));
      const summary = [...new Set(states)].join(', ').slice(0, 80);
      const next: ClusterTrackedJob = { ...job, state: summary, lastSeenAt: at };
      if (!active && !job.reportedAt) {
        next.reportedAt = at;
        finished.set(job.agentId, [...(finished.get(job.agentId) ?? []), next]);
      }
      this.store.db
        .prepare('UPDATE cluster_tracked_jobs SET body=? WHERE alias=? AND job_id=?')
        .run(JSON.stringify(next), alias, job.jobId);
      this.touch();
    }
    for (const [agentId, jobs] of finished) {
      const lines = jobs.map((job) => {
        const job_rows = rows.filter((row) => row.baseJobId === job.jobId);
        const first = job_rows[0];
        const efficiency =
          first?.cpuEfficiency !== null && first?.cpuEfficiency !== undefined
            ? ` CPU efficiency ${Math.round(first.cpuEfficiency * 100)}%.`
            : '';
        const output = first?.stdout ? ` Output: ${first.stdout}.` : '';
        return `Slurm job ${job.jobId} finished: ${job.state}${first?.exitCode ? ` (exit ${first.exitCode})` : ''}.${efficiency}${output}`;
      });
      try {
        this.store.requireActiveAgent(agentId);
        this.store.enqueue(
          agentId,
          `cluster-report:${jobs.map((job) => job.jobId).join(',')}`,
          `${lines.join('\n')}\nThis is a read-only cluster observation, not new owner instructions. Inspect logs and outputs with your native SSH access before deciding the next step; do not resubmit automatically. dock_inspect {cluster:true} has the shared reading.`,
          'report',
        );
      } catch {
        // A removed manager keeps its history; finished jobs remain visible in QUARK.
      }
    }
  }
  status(): ClusterStatus {
    if (this.memo?.version === this.version && this.clock() - this.memo.at < 5000)
      return this.memo.value;
    const value = this.readStatus();
    this.memo = { version: this.version, at: this.clock(), value };
    return value;
  }
  private readStatus(): ClusterStatus {
    const settings = this.settings();
    const cache = settings ? this.cache(settings.alias) : emptyCache();
    const now = this.clock();
    const owners = new Map<string, ClusterTrackedOwner | null>();
    const ownerOf = (agentId: string) => {
      if (!owners.has(agentId)) owners.set(agentId, this.owner(agentId));
      return owners.get(agentId)!;
    };
    const tracked = this.tracked();
    // Job IDs repeat across clusters; only this alias's tracked jobs own its readings.
    const byJob = new Map(
      tracked.filter((job) => job.alias === settings?.alias).map((job) => [job.jobId, job.agentId]),
    );
    const withOwner = <T extends { baseJobId: string }>(item: T) => ({
      ...item,
      owner: byJob.has(item.baseJobId) ? ownerOf(byJob.get(item.baseJobId)!) : null,
    });
    const observed = cache.queue.observedAt ? Date.parse(cache.queue.observedAt) : null;
    const connection: ClusterConnection = !settings
      ? emptyCache().connection
      : !settings.enabled
        ? {
            ...cache.connection,
            state: 'not-configured',
            message: 'Cluster monitoring is turned off.',
          }
        : cache.connection.checkedAt
          ? cache.connection
          : { ...cache.connection, state: 'checking', message: 'Checking the cluster connection…' };
    return clusterStatusSchema.parse({
      configured: !!settings,
      settings,
      revision: this.revision(),
      connection,
      scheduler: cache.scheduler,
      queue: { ...cache.queue, items: cache.queue.items.map(withOwner) },
      fairshare: cache.fairshare,
      limits: cache.limits,
      recent: { ...cache.recent, items: cache.recent.items.map(withOwner) },
      tracked: tracked.map((job) => ({ ...job, owner: ownerOf(job.agentId) })),
      unavailable: cache.unavailable,
      refreshing: !!this.running,
      nextRefreshAt:
        settings?.enabled && this.nextFast ? new Date(this.nextFast).toISOString() : null,
      stale:
        !!settings?.enabled && (observed === null || now - observed > 3 * clusterIntervals.idleMs),
      notice: clusterNotice,
    });
  }
  /** Compact, bounded view for manager and QUARK context; full detail is one inspect away. */
  summary() {
    const status = this.status();
    if (!status.configured) return null;
    const recentFailures = status.recent.items.filter((job) =>
      /FAIL|TIMEOUT|OUT_OF_ME|NODE_FAIL|PREEMPT|BOOT_FAIL|DEADLINE/.test(job.state),
    );
    return {
      label: status.settings!.label,
      sshAlias: status.settings!.alias,
      enabled: status.settings!.enabled,
      connection: {
        state: status.connection.state,
        master: status.connection.master,
        checkedAt: status.connection.checkedAt,
        message: status.connection.message,
      },
      stale: status.stale,
      queueObservedAt: status.queue.observedAt,
      jobs: {
        running: status.queue.items.filter((job) => job.state === 'RUNNING').length,
        pending: status.queue.items.filter((job) => job.state === 'PENDING').length,
        pendingReasons: [
          ...new Set(
            status.queue.items.filter((job) => job.state === 'PENDING').map((job) => job.reason),
          ),
        ].slice(0, 6),
        recentFailures: recentFailures.length,
      },
      fairshare: status.fairshare.items.map(({ account, fairShare }) => ({ account, fairShare })),
      siteLimits: status.limits.site && {
        maxArraySize: status.limits.site.maxArraySize,
        maxJobCount: status.limits.site.maxJobCount,
      },
      unavailable: status.unavailable.map((item) => item.section),
      tracked: status.tracked.slice(0, 10).map(({ jobId, alias, agentId, state, reportedAt }) => ({
        jobId,
        alias,
        agentId,
        state,
        reportedAt,
      })),
      notebookTemplate: join(repoRoot, 'scripts/cluster/notebook.sbatch'),
      details:
        'dock_inspect {cluster:true} returns the full cached queue, pending reasons, fairshare, native limits (own, account and parent associations, QOS, partitions, site caps) and recent accounting. Read-only and advisory; no app cluster limit applies. A blank limit is not proof that none applies.',
    };
  }
}
