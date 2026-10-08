import { readFileSync, lstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fastScript, slowScript } from './cluster-slurm.js';
import { remoteRuntimeIdentitySchema, type ClusterProjectRecord } from '@dock/shared';
import type { ClusterRunner } from './cluster.js';

const bootstrapSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.uuid(),
    projectId: z.uuid(),
    controllerHostId: z.uuid(),
    remoteHostId: z.uuid(),
    remoteProjectId: z.uuid(),
    cpus: z.number().int().min(1).max(128),
    memoryMb: z.number().int().min(512).max(1048576),
    idleMinutes: z.number().int().min(1).max(120).default(20),
    mainPid: z.number().int().positive().optional(),
    jobId: z.string().regex(/^\d{1,20}$/),
    leaseToken: z.uuid(),
    username: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
    alias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
    comment: z.string(),
    node: z.string(),
    startedAt: z.string().datetime(),
  })
  .strict();
/** The fixed compute bootstrap producer and server consumer share this exact private file shape. */
export function createComputeBootstrap(
  record: ClusterProjectRecord,
  identity: {
    attemptId: string;
    hostId: string;
    remoteProjectId: string;
    jobId: string;
    leaseToken: string;
    node: string;
    startedAt: string;
  },
) {
  return bootstrapSchema.parse({
    version: 1,
    attemptId: identity.attemptId,
    projectId: record.id,
    controllerHostId: record.controllerHostId,
    remoteHostId: identity.hostId,
    remoteProjectId: identity.remoteProjectId,
    cpus: record.folder.development.cpus,
    memoryMb: record.folder.development.memoryMb,
    idleMinutes: record.folder.development.idleMinutes,
    jobId: identity.jobId,
    leaseToken: identity.leaseToken,
    username: record.folder.username,
    alias: record.folder.alias,
    comment: `swa-development:${record.id}:${identity.leaseToken}`,
    node: identity.node,
    startedAt: identity.startedAt,
  });
}
export function computeBootstrap(path: string) {
  return bootstrapSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function computeRuntimeIdentity(path: string) {
  const metadata = computeBootstrap(path);
  return remoteRuntimeIdentitySchema.parse({
    controllerHostId: metadata.controllerHostId,
    remoteHostId: metadata.remoteHostId,
    clusterProjectId: metadata.projectId,
    remoteProjectId: metadata.remoteProjectId,
    jobId: metadata.jobId,
    leaseToken: metadata.leaseToken,
  });
}
/** Server startup only. Neither a query parameter nor a browser setting can select this transport. */
export async function computeClusterRunner(
  path: string | undefined,
): Promise<ClusterRunner | undefined> {
  if (!path) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4000 || stat.mode & 0o077 || stat.uid !== process.getuid?.())
    throw new Error('Compute bootstrap must be a private owner file.');
  const metadata = bootstrapSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (
    process.env.SLURM_JOB_ID !== metadata.jobId ||
    metadata.comment !== `swa-development:${metadata.projectId}:${metadata.leaseToken}`
  )
    throw new Error('Compute bootstrap allocation identity changed.');
  const { stdout } = await promisify(execFile)('scontrol', ['show', 'job', '-o', metadata.jobId], {
    timeout: 15000,
    maxBuffer: 64000,
  });
  const fields = Object.fromEntries(
    [...stdout.matchAll(/(\w+)=([^ ]*)/g)].map((m) => [m[1], m[2]]),
  );
  if (
    fields.Comment !== metadata.comment ||
    fields.UserId !== `${metadata.username}(${process.getuid?.()})` ||
    fields.JobState !== 'RUNNING'
  )
    throw new Error('Cannot verify the owned compute allocation.');
  return async (args, input, timeoutMs) => {
    if (args.join(' ') === `-G -- ${metadata.alias}`)
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    if (args.join(' ') === `-O check -- ${metadata.alias}`)
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    const marker = args.indexOf('--');
    const rest = args.slice(marker + 1);
    if (
      marker < 0 ||
      rest[0] !== metadata.alias ||
      rest.slice(1, 4).join(' ') !== 'bash -s --' ||
      (input !== fastScript && input !== slowScript)
    )
      throw new Error('Compute collector supports only its fixed native Slurm observations.');
    return new Promise((resolve) => {
      const child = execFile(
        'bash',
        ['-s', '--', ...rest.slice(4)],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
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
      child.stdin?.end(input);
    });
  };
}
