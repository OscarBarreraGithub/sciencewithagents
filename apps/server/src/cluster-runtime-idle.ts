import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { RemoteRuntimeIdentity } from '@dock/shared';
import type { Runtime } from './runtime.js';
import type { OwnerTerminals } from './owner-terminal.js';
import type { Terminals } from './terminal.js';
import { Conflict } from './store.js';
import { pythonPipe } from './cluster-transport.js';
import { computeBootstrap } from './cluster-compute.js';
import type { IdleProof } from './cluster-development.js';
import {
  matchesProviderProcess,
  type ProviderProcessIdentity,
} from './provider-process-identity.js';

const count = z.number().int().nonnegative();
export const clusterIdleProofSchema = z
  .object({
    observedAt: z.number().finite(),
    idleSince: z.number().finite(),
    activeTurns: count,
    queuedTurns: count,
    activeHelpers: count,
    activeWork: count,
    ownerTerminals: count,
    pendingAutomation: count,
    drainToken: z.uuid(),
  })
  .strict();
const controlSchema = z.object({ key: z.uuid() }).strict();
const barrierSchema = z
  .object({
    jobId: z.string(),
    leaseToken: z.uuid(),
    key: z.uuid(),
    proof: clusterIdleProofSchema,
    drainToken: z.uuid(),
  })
  .strict();

/** Reject unknown/orphaned native work in this Slurm step, including detached background tools. */
export function verifyIdleStepProcesses(
  allowed: Set<number>,
  proc = '/proc',
  context?: {
    identity: RemoteRuntimeIdentity;
    username: string;
    port: number;
    providerPids: Set<number>;
    providerProcesses?: readonly ProviderProcessIdentity[];
  },
) {
  const membership = readFileSync(join(proc, 'self/cgroup'), 'utf8').trim().split('\n');
  if (!membership.length || membership.some((line) => !/^\d+:[^:]*:\//.test(line)))
    throw new Conflict('Native process ownership is unavailable; retaining this allocation.');
  const groups = context
    ? membership.flatMap((line) => {
        const match = new RegExp(`^(.*?/job_?${context.identity.jobId})(?:/|$)`).exec(line);
        return match ? [match[1]!] : [];
      })
    : membership;
  if (!groups.length)
    throw new Conflict('This site did not expose a verifiable owned-job process group.');
  const verified = new Set(allowed);
  for (const expected of context?.providerProcesses ?? []) {
    const memberships = readFileSync(join(proc, String(expected.pid), 'cgroup'), 'utf8')
      .trim()
      .split('\n');
    if (
      !memberships.some((line) =>
        groups.some((own) => line === own || line.startsWith(own + '/')),
      ) ||
      !matchesProviderProcess(expected, proc)
    )
      throw new Conflict('Native provider process identity changed; retaining allocation.');
    verified.add(expected.pid);
  }
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry) || verified.has(Number(entry))) continue;
    try {
      const memberships = readFileSync(join(proc, entry, 'cgroup'), 'utf8')
        .trim()
        .split('\n');
      if (
        !memberships.some((line) =>
          groups.some((own) => line === own || line.startsWith(own + '/')),
        )
      )
        continue;
      if (context) {
        const args = readFileSync(join(proc, entry, 'cmdline'), 'utf8')
          .split('\0')
          .filter(Boolean);
        // Slurm places its root-owned step managers inside the job alongside user tasks.
        // Recognize only the exact native control leaf, never a user/work descendant.
        const stepManager = /^slurmstepd: \[([0-9]+)\.(extern(?: stepmgr)?|batch|[0-9]+)\]$/.exec(
          args[0] ?? '',
        );
        if (args.length === 1 && stepManager?.[1] === context.identity.jobId) {
          const step = stepManager[2]!.replace(' stepmgr', '');
          const ownedGroups = memberships.filter((line) =>
            groups.some((own) => line === own || line.startsWith(own + '/')),
          );
          if (
            ownedGroups.every((line) => groups.some((own) => line === `${own}/step_${step}/slurm`))
          ) {
            let status: string;
            try {
              status = readFileSync(join(proc, entry, 'status'), 'utf8');
            } catch {
              throw new Conflict(
                'Native Slurm control identity is unavailable; retaining allocation.',
              );
            }
            const uids = /^Uid:[ \t]+([^\n]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
            if (
              /^Name:[ \t]+slurmstepd$/m.test(status) &&
              uids?.length === 4 &&
              uids.every((uid) => uid === '0')
            )
              continue;
          }
        }
        // The fixed native batch script is solely a sleep holder; never exempt other batch work.
        if (
          memberships.some((line) => /\/step_batch(?:\/|$)/.test(line)) &&
          /(?:^|\/)sleep$/.test(args[0] ?? '') &&
          args.length === 2 &&
          /^\d+$/.test(args[1]!)
        )
          continue;
        const command = args.indexOf('-c');
        if (command >= 0 && args[command + 1] === pythonPipe) {
          const parameters = z
            .object({
              jobId: z.string(),
              username: z.string(),
              comment: z.string(),
              port: z.number().int(),
            })
            .strict()
            .parse(JSON.parse(args[command + 2]!));
          if (
            parameters.jobId === context.identity.jobId &&
            parameters.username === context.username &&
            parameters.comment ===
              `swa-development:${context.identity.clusterProjectId}:${context.identity.leaseToken}` &&
            parameters.port === context.port
          )
            continue;
        }
        const stat = readFileSync(join(proc, entry, 'stat'), 'utf8');
        const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (context.providerPids.has(parent)) {
          const wrapper = readFileSync(join(proc, String(parent), 'cmdline'), 'utf8')
            .split('\0')
            .filter(Boolean);
          // Only the known app-managed wrappers may own one leaf CLI; native tools remain unknown work.
          if (
            /(?:^|\/)claude-session-host\.(?:js|ts)$/.test(wrapper[1] ?? '') &&
            args.includes('--input-format') &&
            args[args.indexOf('--input-format') + 1] === 'stream-json' &&
            args.includes('--output-format') &&
            args[args.indexOf('--output-format') + 1] === 'stream-json'
          )
            continue;
        }
      }
      throw new Conflict('A native background process remains in this development allocation.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

/** Compute-only fence. A disconnected browser or controller is never an idle proof. */
export class ClusterRuntimeIdle {
  private fenced = false;
  private mutations = 0;
  private idleSince: number;
  private pending: Promise<IdleProof | null> | null = null;
  private readonly path: string;
  private readonly material = () => {
    this.idleSince = this.now();
  };
  constructor(
    readonly identity: RemoteRuntimeIdentity,
    private readonly runtime: Runtime,
    private readonly terminals: Terminals,
    private readonly owner: OwnerTerminals,
    private readonly metadataPath: string,
    private readonly idleMinutes: number,
    private readonly now: () => number = Date.now,
    private readonly nativeProof?: (allowed: Set<number>) => void,
  ) {
    this.path = join(dirname(metadataPath), 'runtime-drained.json');
    this.idleSince = now();
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 4000
      )
        throw new Error('Private runtime drain barrier changed.');
      const barrier = barrierSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      // A new allocation cannot inherit an old allocation's drain fence.
      if (barrier.jobId === identity.jobId && barrier.leaseToken === identity.leaseToken)
        this.fenced = true;
    }
    const reason = runtime.nativeAdmissionReason,
      consume = runtime.nativeAdmissionConsume,
      verify = runtime.nativeAdmissionVerify;
    runtime.nativeAdmissionReason = (run) =>
      this.fenced
        ? 'The owned idle allocation is draining; reopen this cluster project.'
        : reason(run);
    runtime.nativeAdmissionConsume = (run) => !this.fenced && consume(run);
    runtime.nativeAdmissionVerify = async (run) => {
      this.requireMutable();
      await verify(run);
      this.requireMutable();
    };
    runtime.clusterMutationGuard = () => this.requireMutable();
    const metadataAllowed = runtime.clusterBackgroundMetadataAllowed;
    runtime.clusterBackgroundMetadataAllowed = () => !this.fenced && metadataAllowed();
    owner.beforeOpen = () => this.requireMutable();
    runtime.store.on('event', this.onEvent);
  }
  private onEvent = (event: { type: string }) => {
    if (
      /^(run\.|agent\.|task\.|work_item\.|approval\.|goal\.|managed_goal\.|local_job\.|app\.|terminal\.|entry\.)/.test(
        event.type,
      )
    )
      this.material();
  };
  requireMutable() {
    if (this.fenced)
      throw new Conflict(
        'The owned idle allocation is draining. Reopen this cluster project before starting work.',
      );
  }
  beginMutation() {
    this.requireMutable();
    this.mutations++;
    let finished = false;
    return () => {
      if (!finished) {
        finished = true;
        this.mutations--;
        this.material();
      }
    };
  }
  private counts() {
    const counts = this.runtime.clusterIdleCounts();
    return {
      ...counts,
      activeHelpers: counts.activeHelpers + this.mutations,
      ownerTerminals: this.owner.activeCount() + this.terminals.activeCount(),
    };
  }
  drain(raw: unknown) {
    const { key } = controlSchema.parse(raw);
    if (this.pending) return this.pending;
    const operation = this.drainOnce(key).finally(() => {
      this.pending = null;
    });
    this.pending = operation;
    return operation;
  }
  private async drainOnce(key: string): Promise<IdleProof | null> {
    const previousFence = this.fenced;
    this.fenced = true; // Publish synchronously, before any await/native close.
    try {
      const counts = this.counts();
      if (Object.values(counts).some((n) => n !== 0)) {
        this.material();
        this.fenced = previousFence;
        return null;
      }
      if (this.now() - this.idleSince < this.idleMinutes * 60000) {
        this.fenced = previousFence;
        return null;
      }
      // Account polling can own a temporary native CLI in this job. Pause new reads
      // with the drain fence and let the existing single-flight close before proof.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let metadataSettled: boolean;
      try {
        metadataSettled = await Promise.race([
          this.runtime.settleClusterBackgroundMetadata().then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 15000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!metadataSettled) {
        this.fenced = previousFence;
        return null; // Telemetry alone does not restart the material idle interval.
      }
      if (Object.values(this.counts()).some((n) => n !== 0)) {
        this.material();
        this.fenced = previousFence;
        return null;
      }
      if (this.now() - this.idleSince < this.idleMinutes * 60000) {
        this.fenced = previousFence;
        return null;
      }
      const allowed = new Set([
        process.pid,
        process.ppid,
        ...this.runtime.clusterIdleProviderPids(),
      ]);
      const nativeProof =
        this.nativeProof ??
        ((pids: Set<number>) =>
          verifyIdleStepProcesses(pids, '/proc', {
            identity: this.identity,
            username: computeBootstrap(this.metadataPath).username,
            port: Number(process.env.DOCK_PORT),
            providerPids: new Set(this.runtime.clusterIdleProviderPids()),
            providerProcesses: this.runtime.clusterIdleCodexProcesses(),
          }));
      nativeProof(allowed);
      await this.runtime.closeClusterIdleProviders();
      nativeProof(new Set([process.pid, process.ppid]));
      const latest = this.counts();
      if (Object.values(latest).some((n) => n !== 0)) {
        this.material();
        this.fenced = previousFence;
        return null;
      }
      if (this.now() - this.idleSince < this.idleMinutes * 60000) {
        this.fenced = previousFence;
        return null;
      }
      const prior = existsSync(this.path)
        ? barrierSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
        : null;
      const drainToken =
        prior?.jobId === this.identity.jobId && prior.leaseToken === this.identity.leaseToken
          ? prior.drainToken
          : randomUUID();
      const proof = clusterIdleProofSchema.parse({
        ...latest,
        idleSince: this.idleSince,
        observedAt: this.now(),
        drainToken,
      });
      const temporary = this.path + '.' + randomUUID();
      writeFileSync(
        temporary,
        JSON.stringify({
          jobId: this.identity.jobId,
          leaseToken: this.identity.leaseToken,
          key,
          proof,
          drainToken,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temporary, this.path);
      return proof;
    } catch {
      this.fenced = previousFence;
      return null;
    }
  }
  /** Only the server-owned explicit-open coordinator may call this fixed authenticated route. */
  reopen(raw: unknown) {
    const input = z.object({ jobId: z.string(), leaseToken: z.uuid() }).strict().parse(raw);
    if (input.jobId !== this.identity.jobId || input.leaseToken !== this.identity.leaseToken)
      throw new Conflict('Drain allocation identity changed.');
    if (this.pending)
      throw new Conflict('Idle proof is still being prepared. Retry explicit open.');
    if (existsSync(this.path)) unlinkSync(this.path);
    this.fenced = false;
    this.material();
    this.runtime.kick();
    return { identity: this.identity, drained: false };
  }
  close() {
    this.runtime.store.off('event', this.onEvent);
  }
}
