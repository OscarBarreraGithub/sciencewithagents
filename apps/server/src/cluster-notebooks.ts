import { createServer } from 'node:net';
import { z } from 'zod';
import {
  clusterNotebookCloseSchema,
  clusterNotebookOpenSchema,
  clusterNotebookSchema,
  type ClusterNotebook,
} from '@dock/shared';
import { Conflict } from './store.js';
import { queryOptions, type ClusterMonitor } from './cluster.js';

const key = 'cluster:v1:notebooks';
const changed = 'The cluster alias changed. Open the notebook again.';
/**
 * Reads the one private connection file a notebook job wrote for itself. It is mode 600,
 * owned by this account and named by the numeric job ID; nothing else is listed or read.
 */
export const notebookScript = String.raw`set +e
case "$1" in ''|*[!0-9]*) exit 2 ;; esac
f="$HOME/.sciencewithagents/notebooks/$1.json"
if [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %a "$f" 2>/dev/null)" = 600 ] && [ "$(stat -c %u "$f" 2>/dev/null)" = "$(id -u)" ]; then head -c 2048 "$f"; else exit 3; fi
`;
const connectionSchema = z
  .object({
    node: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
    port: z.number().int().min(1024).max(65535),
    token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();
const same = (a: ClusterNotebook, b: ClusterNotebook) =>
  a.alias === b.alias &&
  a.jobId === b.jobId &&
  a.node === b.node &&
  a.remotePort === b.remotePort &&
  a.localPort === b.localPort;
type Target = ReturnType<ClusterMonitor['target']>;

/** An unused loopback port on this computer. */
export const freeLoopbackPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port')),
      );
    });
  });

/**
 * Private notebook tunnels through the owner's existing SSH sign-in. Jupyter runs inside a
 * compute allocation; the forward listens only on this computer's loopback address. Each
 * forward belongs to the alias it was opened through and is only reissued or closed there.
 */
export class ClusterNotebooks {
  /** Repeated or concurrent opens of one job share a single attempt and forward. */
  private opening = new Map<string, Promise<{ jobId: string; url: string }>>();
  constructor(
    private cluster: ClusterMonitor,
    private freePort = freeLoopbackPort,
  ) {
    cluster.onTargetChange(({ alias }) => void this.retarget(alias).catch(() => {}));
  }
  private saved(): ClusterNotebook[] {
    return z.array(clusterNotebookSchema).catch([]).parse(this.cluster.store.getSetting(key));
  }
  private save(notebooks: ClusterNotebook[]) {
    this.cluster.store.setSetting(key, notebooks.slice(-8));
  }
  /** Removes exactly these records, keeping any opened meanwhile. */
  private remove(notebooks: ClusterNotebook[]) {
    this.save(this.saved().filter((item) => !notebooks.some((gone) => same(gone, item))));
  }
  list() {
    const status = this.cluster.status();
    const running = new Set(
      status.queue.items.filter((job) => job.state === 'RUNNING').map((job) => job.jobId),
    );
    return this.saved().map((notebook) => ({
      ...notebook,
      running: notebook.alias === status.settings?.alias && running.has(notebook.jobId),
    }));
  }
  private forward(notebook: ClusterNotebook, action: 'forward' | 'cancel') {
    return this.cluster.runner(
      [
        '-O',
        action,
        '-L',
        `127.0.0.1:${notebook.localPort}:${notebook.node}:${notebook.remotePort}`,
        '--',
        notebook.alias,
      ],
      null,
      10_000,
    );
  }
  /** Best effort: a forward disappears with its sign-in anyway. */
  private async cancel(notebook: ClusterNotebook) {
    if ((await this.cluster.masterState(notebook.alias)) === 'running')
      await this.forward(notebook, 'cancel').catch(() => {});
  }
  async open(raw: unknown) {
    const { jobId } = clusterNotebookOpenSchema.parse(raw);
    const target = this.cluster.target();
    if (!target.alias || !this.cluster.settings()?.enabled)
      throw new Conflict('Connect a cluster in QUARK first.');
    const id = `${target.generation}:${target.alias}:${jobId}`;
    let opening = this.opening.get(id);
    if (!opening) {
      opening = this.openOnce(jobId, target).finally(() => this.opening.delete(id));
      this.opening.set(id, opening);
    }
    return opening;
  }
  private async openOnce(jobId: string, target: Target) {
    const alias = target.alias!;
    const current = () => {
      if (!this.cluster.isCurrent(target)) throw new Conflict(changed);
    };
    if ((await this.cluster.masterState(alias)) !== 'running')
      throw new Conflict('Sign in to the cluster first; the tunnel uses your shared sign-in.');
    current();
    const status = this.cluster.status();
    const job = status.queue.items.find((item) => item.jobId === jobId);
    if (
      status.settings?.alias !== alias ||
      !job ||
      job.state !== 'RUNNING' ||
      !job.nodeList ||
      /[,[\s]/.test(job.nodeList) ||
      !status.queue.observedAt ||
      this.cluster.now() - Date.parse(status.queue.observedAt) > 10 * 60_000
    )
      throw new Conflict(
        'Open a notebook once its job is running on one compute node in a fresh cluster reading.',
      );
    const result = await this.cluster.runner(
      [...queryOptions, '--', alias, 'bash', '-s', '--', jobId],
      notebookScript,
      20_000,
    );
    current();
    let connection: z.infer<typeof connectionSchema>;
    try {
      connection = connectionSchema.parse(JSON.parse(result.code === 0 ? result.stdout : ''));
    } catch {
      throw new Conflict(
        'This job has not written a private notebook connection file. Start notebooks with the cluster notebook template.',
      );
    }
    // The connection file must name the allocation Slurm reports, never a login node.
    if (connection.node !== job.nodeList)
      throw new Conflict('The notebook does not belong to this job’s compute node.');
    const saved = this.saved();
    const previous = saved.find((item) => item.alias === alias && item.jobId === jobId);
    const reuse =
      previous?.node === connection.node && previous.remotePort === connection.port
        ? previous
        : null;
    if (!previous && saved.length >= 8)
      throw new Conflict('Eight notebook tunnels are open. Close one before opening another.');
    const notebook: ClusterNotebook = reuse ?? {
      alias,
      jobId,
      node: connection.node,
      remotePort: connection.port,
      localPort: await this.freePort(),
      openedAt: new Date().toISOString(),
    };
    current();
    const forwarded = await this.forward(notebook, 'forward');
    if (!this.cluster.isCurrent(target)) {
      if (forwarded.code === 0) await this.forward(notebook, 'cancel').catch(() => {});
      throw new Conflict(changed);
    }
    if (forwarded.code !== 0)
      throw new Conflict('The private tunnel could not be opened. Refresh and try again.');
    // A job now on another node or port leaves its old forward behind; close it.
    if (previous && !reuse) await this.forward(previous, 'cancel').catch(() => {});
    this.save([
      ...this.saved().filter((item) => !(item.alias === alias && item.jobId === jobId)),
      notebook,
    ]);
    this.cluster.store.event('cluster.notebook_opened', null, null, { jobId });
    // The token stays out of storage; this reply goes only to the owner's local browser.
    return {
      jobId,
      url: `http://127.0.0.1:${notebook.localPort}/lab?token=${encodeURIComponent(connection.token)}`,
    };
  }
  async close(raw: unknown) {
    const { jobId } = clusterNotebookCloseSchema.parse(raw);
    const closing = this.saved().filter((item) => item.jobId === jobId);
    this.remove(closing);
    // Each forward is cancelled through the sign-in that carries it, not the current alias.
    for (const notebook of closing) await this.cancel(notebook);
    return { notebooks: this.list() };
  }
  /** The owner chose another alias: close this computer's tunnels through the old one. */
  private async retarget(alias: string) {
    const stale = this.saved().filter((item) => item.alias !== alias);
    if (!stale.length) return;
    this.remove(stale);
    for (const notebook of stale) {
      await this.cancel(notebook);
      this.cluster.store.event('cluster.notebook_closed', null, null, {
        jobId: notebook.jobId,
        reason: 'alias-changed',
      });
    }
  }
  /** After each reading: restore forwards lost with an old sign-in, close finished jobs. */
  async reconcile() {
    const target = this.cluster.target();
    const status = this.cluster.status();
    const alias = status.settings?.enabled ? status.settings.alias : null;
    if (!alias || alias !== target.alias) return;
    const mine = this.saved().filter((item) => item.alias === alias);
    // Only a queue read successfully in this same reading can show that a job ended; an
    // outage, a failed queue section or an older reading keeps the saved tunnels.
    const fresh =
      status.connection.state === 'connected' &&
      !status.queue.error &&
      !!status.queue.observedAt &&
      status.queue.observedAt === status.connection.checkedAt;
    if (!mine.length || !fresh) return;
    const master = (await this.cluster.masterState(alias)) === 'running';
    const ended: ClusterNotebook[] = [];
    for (const notebook of mine) {
      if (!this.cluster.isCurrent(target)) return;
      const job = status.queue.items.find((item) => item.jobId === notebook.jobId);
      // A queue cut at its row limit cannot prove a missing job ended.
      if (!job && status.queue.omitted > 0) continue;
      if (job?.state !== 'RUNNING' || job.nodeList !== notebook.node) {
        ended.push(notebook);
        if (master) await this.forward(notebook, 'cancel').catch(() => {});
        continue;
      }
      if (!master) continue;
      // A duplicate forward is accepted by the same master; a new sign-in needs it again.
      const forwarded = await this.forward(notebook, 'forward').catch(() => null);
      if (forwarded?.code === 0 && !this.cluster.isCurrent(target))
        await this.forward(notebook, 'cancel').catch(() => {});
    }
    if (ended.length) {
      this.remove(ended);
      for (const notebook of ended)
        this.cluster.store.event('cluster.notebook_closed', null, null, {
          jobId: notebook.jobId,
          reason: 'job-ended',
        });
    }
  }
}
