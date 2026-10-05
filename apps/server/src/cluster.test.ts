import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSchema } from '@dock/shared';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { ClusterMonitor, clusterIntervals, type ClusterRun } from './cluster.js';
import {
  connectionFailure,
  expandOutputPath,
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
} from './cluster-slurm.js';

// Real read-only Slurm 26.05 replies with people, groups, hosts, paths and IDs replaced.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/cluster/${name}`, import.meta.url), 'utf8');
const fast = splitSections(fixture('fast.txt'));
const slow = splitSections(fixture('slow.txt'));
const lines = (sections: Map<string, { lines: string[] }>, name: string) =>
  sections.get(name)!.lines;

let root: string, store: Store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-cluster-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('parses queue state, pending reasons, array tasks and priority factors', () => {
  const queue = parseQueue(lines(fast, 'squeue'));
  expect(queue).toHaveLength(5);
  expect(queue[0]).toMatchObject({
    jobId: '50593230',
    baseJobId: '50593230',
    state: 'RUNNING',
    reason: '',
    partition: 'gpu_test',
    cpus: 1,
    memory: '8G',
    gres: 'gres/gpu:1',
    nodes: 1,
    startAt: '2026-10-04T23:30:06',
  });
  const pending = queue.find((job) => job.jobId === '50584563_[470-499%30]')!;
  expect(pending).toMatchObject({
    baseJobId: '50584563',
    state: 'PENDING',
    reason: 'JobArrayTaskLimit',
    startAt: null,
    nodeList: '',
  });
  expect(parsePriority(lines(fast, 'sprio'))[0]).toMatchObject({
    jobId: '49398451',
    priority: 2450516,
    age: 1000000,
    fairshare: 1450516,
  });
});

it('folds accounting steps into allocation efficiency and literal output references', () => {
  const jobs = parseAccounting(lines(fast, 'tracked'));
  expect(jobs.map((job) => job.jobId)).toEqual([
    '45088913',
    ...Array.from({ length: 7 }, (_, task) => `45133362_${task}`),
  ]);
  const timeout = jobs[0]!;
  expect(timeout).toMatchObject({
    state: 'TIMEOUT',
    cpus: 8,
    memoryBytes: 16 * 1024 ** 3,
    elapsedSeconds: 252027,
    timeLimitSeconds: 4200 * 60,
    cpuSeconds: 125049,
    maxRssBytes: 16026364 * 1024,
    stdout: '/n/home/researcher/slurm-45088913.out',
  });
  expect(timeout.cpuEfficiency).toBeCloseTo(0.062, 3);
  expect(timeout.memoryEfficiency).toBeCloseTo(0.955, 3);
  const task = jobs[1]!;
  // "CANCELLED by <uid>" keeps the state without an account identity.
  expect(task.state).toBe('CANCELLED');
  expect(task.baseJobId).toBe('45133362');
  expect(task.stdout).toBe(
    '/n/labs/pi_a_lab/Lab/researcher/project-x/logs/review_2026_09_45133362_0.out',
  );
  expect(task.memoryEfficiency).toBeCloseTo((5872812 * 1024) / (48 * 1024 ** 3), 3);
  expect(
    expandOutputPath('out/%x-%j.log', { jobId: '7', name: 'fit', workDir: '/scratch/run/' }),
  ).toBe('/scratch/run/out/fit-7.log');
});

it('reads fairshare and native limits without other users or a remaining allowance', () => {
  const fairshare = parseFairshare(lines(slow, 'fairshare'));
  expect(fairshare).toHaveLength(4);
  expect(fairshare[2]).toEqual({
    account: 'pi_a_lab',
    fairShare: 0.999952,
    levelFairShare: null,
    accountNormShares: 0.000195,
    accountEffectiveUsage: 0,
    accountRawUsage: 10675,
    userRawUsage: 10675,
  });
  const associations = parseAssociations(lines(slow, 'assoc'));
  expect(associations).toHaveLength(4);
  expect(associations[0]).toMatchObject({
    cluster: 'cluster1',
    account: 'pi_c_lab',
    maxJobs: 10100,
    maxSubmit: 10100,
    qos: ['normal'],
    grpTres: '',
  });
  const qos = parseQos(lines(slow, 'qos'));
  expect(qos.find((item) => item.name === 'test')).toMatchObject({
    maxJobsPerUser: 5,
    maxSubmitPerUser: 5,
    maxTresPerUser: 'cpu=112,mem=1000G',
    maxJobsPerAccount: null,
    maxTresPerAccount: '',
  });
  // Inherited account rows up to the parent; nothing names another member.
  const accounts = parseAccountLimits(lines(slow, 'accounts'));
  expect(accounts.map((item) => [item.account, item.parent])).toEqual([
    ['pi_c_lab', 'div_parent'],
    ['inst_d_lab', 'div_parent'],
    ['pi_a_lab', 'div_parent'],
    ['pi_b_lab', 'div_parent'],
    ['div_parent', ''],
  ]);
  expect(accounts[4]).toMatchObject({ maxJobs: 10100, maxSubmit: 10100, grpTres: '' });
  expect(parseAccountLimits(['cluster1|pi_a_lab|div_parent|||||||||||||normal||member'])).toEqual(
    [],
  );
  // The site uses classic fairshare (NO_FAIR_TREE); it is reported, not assumed.
  expect(parseSiteConfig(lines(slow, 'config'))).toEqual({
    maxArraySize: 10000,
    maxJobCount: 300000,
    enforce: 'associations,limits,qos,safe',
    priorityType: 'priority/multifactor',
    priorityFlags: 'NO_FAIR_TREE',
  });
  const groups = lines(slow, 'groups')[0]!.split(' ');
  const partitions = parsePartitions(
    lines(slow, 'partitions'),
    lines(slow, 'sinfo'),
    groups,
    associations.map((item) => item.account),
  );
  expect(partitions.map((p) => p.name)).toEqual([
    'pi_c',
    'pi_c_gpu_a100',
    'inst_d_gpu',
    'gpu',
    'serial_requeue',
    'shared',
    'test',
  ]);
  expect(partitions.find((p) => p.name === 'test')).toMatchObject({
    maxTime: '12:00:00',
    qos: 'test',
    accessible: true,
    cpus: { allocated: 546, idle: 1358, other: 336, total: 2240 },
  });
  expect(partitions.find((p) => p.name === 'pi_c_gpu_a100')!.gres).toContain('gpu=28');
  // Group-restricted partitions follow membership; nothing is guessed without it.
  expect(
    parsePartitions(lines(slow, 'partitions'), [], ['cluster_users'], ['pi_a_lab']).find(
      (p) => p.name === 'pi_c',
    )!.accessible,
  ).toBe(false);
  expect(parsePartitions(lines(slow, 'partitions'), [], [], [])[0]!.accessible).toBeNull();
});

it('keeps remote queries read-only and classifies SSH failures without account names', () => {
  for (const script of [fastScript, slowScript]) {
    expect(script).not.toMatch(
      /\b(sbatch|scancel|srun|salloc|scontrol (update|hold|release|requeue)|rm|find|ls|du|cat)\b/,
    );
  }
  expect(
    connectionFailure(
      'user@login.example: Permission denied (publickey,keyboard-interactive).',
      false,
    ),
  ).toMatchObject({ state: 'sign-in-needed' });
  expect(connectionFailure('Host key verification failed.', false).state).toBe('host-key');
  expect(connectionFailure('', true).state).toBe('unreachable');
  expect(
    connectionFailure('ssh: connect to host login.example port 22: Operation timed out', false)
      .state,
  ).toBe('unreachable');
  expect(connectionFailure('person@cluster.example: odd failure', false).message).not.toContain(
    'person',
  );
});

it('detects native submission confirmations only', () => {
  expect(submittedJobIds('Submitted batch job 50612345\n')).toEqual(['50612345']);
  expect(
    submittedJobIds('{"stdout":"Submitted batch job 7\\nSubmitted batch job 8","stderr":""}'),
  ).toEqual(['7', '8']);
  expect(submittedJobIds('50612346\n', "ssh hpc 'sbatch --parsable run.sh'")).toEqual(['50612346']);
  expect(submittedJobIds('50612346\n', 'squeue --me')).toEqual([]);
});

type Call = { args: string[]; input: string | null };
function monitor(replies: (call: Call) => ClusterRun) {
  let now = Date.parse('2026-10-05T12:00:00Z');
  const calls: Call[] = [];
  const cluster = new ClusterMonitor(
    store,
    async (args, input) => {
      const call = { args, input };
      calls.push(call);
      return replies(call);
    },
    () => now,
  );
  return { cluster, calls, advance: (ms: number) => (now += ms) };
}
const ok = (stdout: string): ClusterRun => ({ code: 0, stdout, stderr: '', timedOut: false });
const master = (call: Call) => call.args[0] === '-O';
const healthy = (call: Call) =>
  master(call)
    ? { code: 0, stdout: '', stderr: 'Master running (pid=1)\n', timedOut: false }
    : ok(fixture(call.input === slowScript ? 'slow.txt' : 'fast.txt'));
const configure = (cluster: ClusterMonitor, alias = 'hpc') =>
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias, label: 'Lab cluster', accountingDays: 3 },
  });

it('collects once per cadence into a shared cache with fixed SSH options', async () => {
  const { cluster, calls, advance } = monitor(healthy);
  await cluster.tick();
  expect(calls).toHaveLength(0);
  expect(cluster.status().connection.state).toBe('not-configured');
  expect(() =>
    cluster.save({
      key: randomUUID(),
      settings: { enabled: true, alias: '-oProxyCommand=x', label: 'x' },
    }),
  ).toThrow();
  configure(cluster);
  expect(cluster.status().connection.state).toBe('checking');
  await cluster.tick();
  expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
    ['-O', 'check'],
    ['-o', 'BatchMode=yes'],
    ['-o', 'BatchMode=yes'],
  ]);
  const query = calls[1]!.args;
  expect(query).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes', 'ControlMaster=no']));
  expect(query.slice(query.indexOf('--'))).toEqual(['--', 'hpc', 'bash', '-s', '--', '3']);
  const status = cluster.status();
  expect(status.connection).toMatchObject({ state: 'connected', master: 'running' });
  expect(status.scheduler).toEqual({ version: '26.05.4', cluster: 'cluster1' });
  expect(status.queue.items).toHaveLength(5);
  expect(status.fairshare.items).toHaveLength(4);
  expect(status.limits.partitions).toHaveLength(7);
  expect(status.limits.accounts).toHaveLength(5);
  expect(status.limits.site).toMatchObject({ maxArraySize: 10000, priorityFlags: 'NO_FAIR_TREE' });
  expect(status.unavailable).toEqual([]);
  expect(cluster.summary()).toMatchObject({
    siteLimits: { maxArraySize: 10000, maxJobCount: 300000 },
    unavailable: [],
  });
  expect(status.stale).toBe(false);
  // Readers never trigger SSH; the next queue read waits for its active interval.
  cluster.status();
  cluster.summary();
  await cluster.tick();
  expect(calls).toHaveLength(3);
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(calls).toHaveLength(5);
  expect(calls[4]!.input).toBe(fastScript);
  // Owner refreshes are coalesced within the manual interval.
  await cluster.refresh({ key: randomUUID() });
  await cluster.refresh({ key: randomUUID() });
  expect(calls).toHaveLength(7);
  expect(inspectSchema.parse({ cluster: true })).toEqual({ cluster: true });
});

it('keeps old readings visible through sign-in loss, backs off and recovers', async () => {
  let signedIn = true;
  const { cluster, calls, advance } = monitor((call) =>
    signedIn
      ? healthy(call)
      : master(call)
        ? {
            code: 255,
            stdout: '',
            stderr: 'Control socket connect(/x): No such file or directory\n',
            timedOut: false,
          }
        : {
            code: 255,
            stdout: '',
            stderr: 'person@login.example: Permission denied (publickey,keyboard-interactive).\n',
            timedOut: false,
          },
  );
  configure(cluster);
  await cluster.tick();
  const observedAt = cluster.status().queue.observedAt;
  signedIn = false;
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  const lost = cluster.status();
  expect(lost.connection).toMatchObject({ state: 'sign-in-needed', master: 'absent' });
  expect(lost.connection.message).not.toContain('person');
  expect(lost.queue.observedAt).toBe(observedAt);
  expect(lost.queue.items).toHaveLength(5);
  const attempts = calls.length;
  advance(30_000);
  await cluster.tick();
  expect(calls).toHaveLength(attempts);
  advance(3 * clusterIntervals.idleMs);
  expect(cluster.status().stale).toBe(true);
  signedIn = true;
  await cluster.tick();
  expect(cluster.status().connection.state).toBe('connected');
  expect(
    store.db
      .prepare("SELECT data FROM events WHERE type='cluster.connection_changed' ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.data)).state),
  ).toEqual(['connected', 'sign-in-needed', 'connected']);
});

it('tracks native submissions with their original session and reports each outcome once', async () => {
  const project = store.register(root, 'Simulation', '');
  const manager = store.agent(project.managerId);
  store.updateAgent(manager.id, { threadId: 'native-thread-1' });
  const { cluster, calls, advance } = monitor(healthy);
  const entry = (id: string, title: string, text: string) =>
    store.entry({
      id,
      agentId: manager.id,
      runId: null,
      kind: 'tool',
      title,
      text,
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
  entry('e0', "ssh hpc 'sbatch run.sh'", 'Submitted batch job 45088913\n');
  expect(cluster.observe(manager.id, 'e0')).toEqual([]);
  configure(cluster);
  entry('e1', 'cat old.log', 'Submitted batch job 45133362\n');
  expect(cluster.observe(manager.id, 'e1')).toEqual([]);
  entry('e2', "ssh hpc 'sbatch run.sh'", 'Submitted batch job 45088913\n');
  entry('e3', 'Bash', '{"stdout":"Submitted batch job 45133362\\n","stderr":""}');
  expect(cluster.observe(manager.id, 'e2')).toEqual(['45088913']);
  expect(cluster.observe(manager.id, 'e3')).toEqual(['45133362']);
  expect(cluster.observe(manager.id, 'e2')).toEqual([]);
  expect(cluster.tracked().find((job) => job.jobId === '45088913')).toMatchObject({
    agentId: manager.id,
    projectId: project.id,
    sessionId: 'native-thread-1',
    reportedAt: null,
  });
  await cluster.tick();
  expect(calls[1]!.args.slice(-3, -2)).toEqual(['3']);
  expect(calls[1]!.args.slice(-2).sort()).toEqual(['45088913', '45133362']);
  const reports = () =>
    store.runs().filter((run) => run.agentId === manager.id && run.kind === 'report');
  expect(reports()).toHaveLength(1);
  expect(reports()[0]!.text).toContain('Slurm job 45088913 finished: TIMEOUT');
  expect(reports()[0]!.text).toContain('Slurm job 45133362 finished: CANCELLED');
  expect(reports()[0]!.text).toContain('/n/home/researcher/slurm-45088913.out');
  const status = cluster.status();
  expect(status.tracked.every((job) => job.reportedAt && job.owner?.agentId === manager.id)).toBe(
    true,
  );
  advance(clusterIntervals.idleMs);
  await cluster.tick();
  expect(reports()).toHaveLength(1);
  // Finished jobs are no longer queried individually.
  expect(calls.at(-1)!.args.slice(-1)).toEqual(['3']);
});

it('discards readings from a previous SSH alias', async () => {
  const { cluster } = monitor(healthy);
  configure(cluster, 'hpc');
  await cluster.tick();
  expect(cluster.status().queue.items).toHaveLength(5);
  configure(cluster, 'other-cluster');
  expect(cluster.status().queue.items).toHaveLength(0);
  expect(cluster.status().connection.state).toBe('checking');
});

it('drops an in-flight reading after an alias change and keeps tracked jobs per alias', async () => {
  const project = store.register(root, 'Simulation', '');
  const manager = store.agent(project.managerId);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let hold = true;
  const { cluster, calls } = monitor(healthy);
  const runner = cluster.runner;
  (cluster as { runner: ClusterMonitor['runner'] }).runner = async (args, input, timeout) => {
    if (hold && input === fastScript) await held;
    return runner(args, input, timeout);
  };
  configure(cluster, 'hpc');
  store.entry({
    id: 'submit',
    agentId: manager.id,
    runId: null,
    kind: 'tool',
    title: "ssh hpc 'sbatch run.sh'",
    text: 'Submitted batch job 45088913\n',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  expect(cluster.observe(manager.id, 'submit')).toEqual(['45088913']);
  const reading = cluster.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  configure(cluster, 'other-cluster');
  hold = false;
  release();
  await reading;
  // The old alias's reply never reaches the new alias's reading or reports.
  expect(store.runs().filter((run) => run.kind === 'report')).toHaveLength(0);
  expect(cluster.tracked()[0]).toMatchObject({ alias: 'hpc', state: null, reportedAt: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await cluster.tick();
  const status = cluster.status();
  expect(status.connection.state).toBe('connected');
  // The other cluster's reply carries finished accounting for the same job ID (the fixture's
  // tracked section); it is not the hpc job and must not finish or report it.
  expect(status.tracked).toMatchObject([{ jobId: '45088913', alias: 'hpc', reportedAt: null }]);
  expect(store.runs().filter((run) => run.kind === 'report')).toHaveLength(0);
  const otherQueries = calls.filter(
    (call) => call.input === fastScript && call.args.includes('other-cluster'),
  );
  expect(otherQueries.at(-1)!.args.slice(-1)).toEqual(['3']);
  expect(cluster.summary()!.tracked).toEqual([
    expect.objectContaining({ jobId: '45088913', alias: 'hpc' }),
  ]);
});

it('lists unsupported or missing native sections instead of reporting them healthy', async () => {
  let degraded = true;
  const { cluster, advance } = monitor((call) => {
    if (master(call) || !degraded) return healthy(call);
    const text = fixture(call.input === slowScript ? 'slow.txt' : 'fast.txt')
      .replace(
        /@@swa-begin sprio@@\n[\s\S]*?@@swa-end sprio 0@@/,
        '@@swa-begin sprio@@\nsprio: error: You are not running a supported priority plugin\n@@swa-end sprio 1@@',
      )
      .replace(/@@swa-begin config@@\n[\s\S]*?@@swa-end config 0@@\n/, '')
      .replace(
        /@@swa-begin qos@@\n[\s\S]*?@@swa-end qos 0@@/,
        '@@swa-begin qos@@\nsacctmgr: error: Access denied\n@@swa-end qos 1@@',
      );
    return ok(text);
  });
  configure(cluster);
  await cluster.tick();
  const status = cluster.status();
  expect(status.connection.state).toBe('connected');
  expect(status.unavailable).toEqual([
    {
      section: 'priority',
      message: 'sprio: error: You are not running a supported priority plugin',
    },
    { section: 'qos', message: 'sacctmgr: error: Access denied' },
    { section: 'config', message: 'Missing from the reply.' },
  ]);
  expect(status.limits.site).toBeNull();
  expect(cluster.summary()!.unavailable).toEqual(['priority', 'qos', 'config']);
  // A fast reading alone keeps the slow sections' verdicts until they are read again.
  degraded = false;
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(cluster.status().unavailable.map((item) => item.section)).toEqual(['qos', 'config']);
  advance(clusterIntervals.slowMs);
  await cluster.tick();
  expect(cluster.status().unavailable).toEqual([]);
  expect(cluster.status().limits.site).not.toBeNull();
});

it('turns thrown probe failures into a visible error instead of a rejected timer', async () => {
  let broken = false;
  const { cluster, advance } = monitor((call) => {
    if (broken && !master(call)) throw new Error('spawn failure');
    return healthy(call);
  });
  configure(cluster);
  await cluster.tick();
  broken = true;
  advance(clusterIntervals.activeMs);
  await expect(cluster.tick()).resolves.toBeUndefined();
  const status = cluster.status();
  expect(status.connection).toMatchObject({ state: 'error' });
  expect(status.connection.message).not.toContain('spawn failure');
  expect(status.queue.items).toHaveLength(5);
  expect(status.refreshing).toBe(false);
  await expect(cluster.refresh({ key: randomUUID() })).resolves.toMatchObject({
    connection: { state: 'error' },
  });
});

it('shares one cached reading with managers, QUARK context and the owner API', async () => {
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  try {
    await runtime.initialize();
    const project = store.register(root, 'Simulation', '');
    const manager = store.agent(project.managerId);
    expect(runtime.context(manager)).toContain('"cluster":null');
    const headers = { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' };
    const saved = await app.inject({
      method: 'POST',
      url: '/api/cluster/settings',
      headers,
      payload: {
        key: randomUUID(),
        settings: { enabled: false, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      configured: true,
      connection: { state: 'not-configured', message: 'Cluster monitoring is turned off.' },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/cluster/settings',
          headers,
          payload: { key: randomUUID(), settings: { enabled: true, alias: 'a b', label: 'x' } },
        })
      ).statusCode,
    ).toBe(400);
    const inspected = (await runtime.tool(manager.id, randomUUID(), 'dock_inspect', {
      cluster: true,
    })) as { configured: boolean; notice: string };
    expect(inspected.configured).toBe(true);
    expect(inspected.notice).toContain('imposes no cluster limits');
    expect(runtime.context(manager)).toContain('"sshAlias":"hpc"');
    // Detection follows the saved tool item, after the store's event notification.
    store.entry({
      id: `${manager.id}:submit`,
      agentId: manager.id,
      runId: null,
      kind: 'tool',
      title: '/bin/zsh -lc "ssh hpc \'cd run && sbatch job.sh\'"',
      text: 'Submitted batch job 51000001\n',
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.cluster.tracked().map((job) => job.jobId)).toEqual(['51000001']);
    expect((await app.inject({ url: '/api/cluster', headers })).json().tracked[0]).toMatchObject({
      jobId: '51000001',
      owner: { agentId: manager.id, projectName: 'Simulation' },
    });
  } finally {
    await app.close();
    await runtime.close();
  }
});

it('offers only the configured alias control socket, from local SSH configuration', async () => {
  let controlPath = '/Users/person/.ssh/sockets/account@login.example-22';
  const { cluster, calls } = monitor((call) =>
    call.args[0] === '-G'
      ? ok(`user account\nhostname login.example\ncontrolpath ${controlPath}\n`)
      : healthy(call),
  );
  expect(await cluster.controlSockets()).toEqual([]);
  expect(calls).toHaveLength(0);
  configure(cluster);
  expect(await cluster.controlSockets()).toEqual([controlPath]);
  expect(calls.at(-1)!.args).toEqual(['-G', '--', 'hpc']);
  await cluster.controlSockets();
  expect(calls.filter((call) => call.args[0] === '-G')).toHaveLength(1);
  controlPath = 'none';
  configure(cluster, 'other-cluster');
  expect(await cluster.controlSockets()).toEqual([]);
});
