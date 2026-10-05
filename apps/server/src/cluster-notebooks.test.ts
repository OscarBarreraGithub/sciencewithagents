import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { ClusterMonitor, clusterIntervals, type ClusterRun } from './cluster.js';
import { ClusterNotebooks, notebookScript } from './cluster-notebooks.js';
import { fastScript, slowScript } from './cluster-slurm.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/cluster/${name}`, import.meta.url), 'utf8');
// The anonymized queue's first job runs on one compute node, node201.
const fast = fixture('fast.txt');
const finished = fast.replace(
  /@@swa-begin squeue@@\n[\s\S]*?@@swa-end squeue 0@@/,
  '@@swa-begin squeue@@\n\n@@swa-end squeue 0@@',
);
const token = 'k'.repeat(40);

let root: string, store: Store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-cluster-notebooks-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function setup() {
  let now = Date.parse('2026-10-05T12:00:00Z');
  const state = {
    queue: fast,
    connection: { node: 'node201', port: 45678, token },
    signedIn: true,
    hold: null as Promise<void> | null,
  };
  const controls: string[][] = [];
  const cluster = new ClusterMonitor(
    store,
    async (args, input): Promise<ClusterRun> => {
      if (input === notebookScript) await state.hold;
      if (args[0] === '-O') {
        if (args[1] !== 'check') controls.push(args);
        return state.signedIn
          ? { code: 0, stdout: '', stderr: 'Master running (pid=9)', timedOut: false }
          : { code: 255, stdout: '', stderr: 'No such file or directory', timedOut: false };
      }
      if (!state.signedIn)
        return { code: 255, stdout: '', stderr: 'Permission denied', timedOut: false };
      if (input === notebookScript)
        return { code: 0, stdout: JSON.stringify(state.connection), stderr: '', timedOut: false };
      return {
        code: 0,
        stdout:
          input === slowScript ? fixture('slow.txt') : input === fastScript ? state.queue : '',
        stderr: '',
        timedOut: false,
      };
    },
    () => now,
  );
  const notebooks = new ClusterNotebooks(cluster, async () => 43210);
  cluster.afterCollect = () => notebooks.reconcile();
  return { cluster, notebooks, state, controls, advance: (ms: number) => (now += ms) };
}
const open = (notebooks: ClusterNotebooks, jobId = '50593230') =>
  notebooks.open({ key: randomUUID(), jobId });

it('opens a loopback tunnel to the running allocation without storing its token', async () => {
  const { cluster, notebooks, controls } = setup();
  await expect(open(notebooks)).rejects.toThrow('Connect a cluster');
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
  });
  await cluster.tick();
  const opened = await open(notebooks);
  expect(opened).toEqual({ jobId: '50593230', url: `http://127.0.0.1:43210/lab?token=${token}` });
  expect(controls).toEqual([['-O', 'forward', '-L', '127.0.0.1:43210:node201:45678', '--', 'hpc']]);
  expect(notebooks.list()).toMatchObject([
    { alias: 'hpc', jobId: '50593230', localPort: 43210, running: true },
  ]);
  const saved = JSON.stringify(
    ['settings', 'events', 'operations'].map((table) =>
      store.db.prepare(`SELECT * FROM ${table}`).all(),
    ),
  );
  expect(saved).not.toContain(token);
  // Pending jobs and array summaries have no single allocation to reach.
  await expect(open(notebooks, '50584563')).rejects.toThrow('running on one compute node');
});

it('refuses connection files that name another host and stale readings', async () => {
  const { cluster, notebooks, state, advance, controls } = setup();
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
  });
  await cluster.tick();
  state.connection = { node: 'login01', port: 45678, token };
  await expect(open(notebooks)).rejects.toThrow('compute node');
  state.connection = { node: 'node201', port: 80, token };
  await expect(open(notebooks)).rejects.toThrow('connection file');
  state.connection = { node: 'node201', port: 45678, token };
  advance(11 * 60_000);
  await expect(open(notebooks)).rejects.toThrow('fresh cluster reading');
  expect(controls).toEqual([]);
});

it('restores tunnels after a new sign-in, keeps them through outages and closes ended jobs', async () => {
  const { cluster, notebooks, state, controls, advance } = setup();
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
  });
  await cluster.tick();
  await open(notebooks);
  controls.length = 0;
  state.signedIn = false;
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(cluster.status().connection.state).toBe('sign-in-needed');
  expect(notebooks.list()).toHaveLength(1);
  expect(controls).toEqual([]);
  state.signedIn = true;
  cluster.signedIn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await cluster.tick();
  expect(controls).toContainEqual([
    '-O',
    'forward',
    '-L',
    '127.0.0.1:43210:node201:45678',
    '--',
    'hpc',
  ]);
  controls.length = 0;
  state.queue = finished;
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(controls).toEqual([['-O', 'cancel', '-L', '127.0.0.1:43210:node201:45678', '--', 'hpc']]);
  expect(notebooks.list()).toEqual([]);
});

const configure = (cluster: ClusterMonitor, alias = 'hpc') =>
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias, label: 'Lab cluster', accountingDays: 3 },
  });
const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('shares one forward between concurrent opens and replaces an obsolete one', async () => {
  const { cluster, notebooks, state, controls } = setup();
  configure(cluster);
  await cluster.tick();
  const held = gate();
  state.hold = held.promise;
  const first = open(notebooks);
  const second = open(notebooks);
  held.open();
  expect(await first).toEqual(await second);
  expect(controls).toEqual([['-O', 'forward', '-L', '127.0.0.1:43210:node201:45678', '--', 'hpc']]);
  state.hold = null;
  // Jupyter restarted on another port inside the same job: the old forward is closed.
  controls.length = 0;
  state.connection = { node: 'node201', port: 45999, token };
  await open(notebooks);
  expect(controls).toEqual([
    ['-O', 'forward', '-L', '127.0.0.1:43210:node201:45999', '--', 'hpc'],
    ['-O', 'cancel', '-L', '127.0.0.1:43210:node201:45678', '--', 'hpc'],
  ]);
  expect(notebooks.list()).toMatchObject([{ remotePort: 45999 }]);
});

it('never reissues or cancels a tunnel through a newly selected alias', async () => {
  const { cluster, notebooks, state, controls, advance } = setup();
  configure(cluster);
  await cluster.tick();
  await open(notebooks);
  controls.length = 0;
  configure(cluster, 'other-cluster');
  await settle();
  await settle();
  // The old alias's own sign-in closes its forward; the record is gone.
  expect(controls).toEqual([['-O', 'cancel', '-L', '127.0.0.1:43210:node201:45678', '--', 'hpc']]);
  expect(notebooks.list()).toEqual([]);
  controls.length = 0;
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(controls).toEqual([]);

  // An open in flight when the alias changes is refused and leaves no forward or record.
  configure(cluster);
  await cluster.tick();
  const held = gate();
  state.hold = held.promise;
  const pending = open(notebooks);
  await settle();
  configure(cluster, 'other-cluster');
  held.open();
  await expect(pending).rejects.toThrow('alias changed');
  expect(controls.filter((args) => args[1] === 'forward')).toEqual([]);
  expect(notebooks.list()).toEqual([]);
});

it('keeps tunnels when the queue reading failed or was cut short', async () => {
  const { cluster, notebooks, state, controls, advance } = setup();
  configure(cluster);
  await cluster.tick();
  await open(notebooks);
  controls.length = 0;
  state.queue = fast.replace(
    /@@swa-begin squeue@@\n[\s\S]*?@@swa-end squeue 0@@/,
    '@@swa-begin squeue@@\nslurm_load_jobs error: Socket timed out\n@@swa-end squeue 1@@',
  );
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(cluster.status().queue.error).toContain('Socket timed out');
  expect(controls.filter((args) => args[1] === 'cancel')).toEqual([]);
  expect(notebooks.list()).toHaveLength(1);
  // 501 rows means the reply hit its limit; a job missing from it may still be running.
  const row = /@@swa-begin squeue@@\n(.*)\n/.exec(fast)![1]!.replace('50593230', '1');
  state.queue = fast.replace(
    /@@swa-begin squeue@@\n[\s\S]*?@@swa-end squeue 0@@/,
    `@@swa-begin squeue@@\n${Array.from({ length: 501 }, () => row).join('\n')}\n@@swa-end squeue 0@@`,
  );
  advance(clusterIntervals.activeMs);
  await cluster.tick();
  expect(cluster.status().queue.omitted).toBeGreaterThan(0);
  expect(controls.filter((args) => args[1] === 'cancel')).toEqual([]);
  expect(notebooks.list()).toHaveLength(1);
});
