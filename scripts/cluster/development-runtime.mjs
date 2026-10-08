#!/usr/bin/env node
// This fixed bootstrap runs inside one verified owner development allocation.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { clusterProjectRecordSchema } from '../../packages/shared/dist/index.js';
import { remoteAdmissionSnapshotSchema } from '../../packages/shared/dist/index.js';
import { localAuthorization } from '../../packages/shared/dist/local-authorization.js';
import { Store } from '../../apps/server/dist/store.js';
import { createComputeBootstrap } from '../../apps/server/dist/cluster-compute.js';
import { initializeClusterProject } from '../../apps/server/dist/cluster-bootstrap-store.js';
import { prepareLocalAccess } from '../../apps/server/dist/local-access.js';

process.umask(0o077);
const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
const record = clusterProjectRecordSchema.parse(payload.record);
const jobId = String(payload.jobId),
  token = String(payload.leaseToken);
if (
  !/^\d{1,20}$/.test(jobId) ||
  !/^[a-f0-9-]{36}$/.test(token) ||
  process.env.SLURM_JOB_ID !== jobId
)
  throw new Error('Runtime bootstrap requires its owned Slurm allocation.');
function inspect(id) {
  try {
    const output = execFileSync('scontrol', ['show', 'job', '-o', id], {
      encoding: 'utf8',
      timeout: 15000,
    });
    return Object.fromEntries([...output.matchAll(/(\w+)=([^ ]*)/g)].map((m) => [m[1], m[2]]));
  } catch (error) {
    if (/Invalid job id/.test(String(error.stderr))) return null;
    throw new Error('Unable to verify native development allocation.');
  }
}
const job = inspect(jobId),
  comment = `swa-development:${record.id}:${token}`;
if (
  !job ||
  job.Comment !== comment ||
  job.UserId !== `${record.folder.username}(${process.getuid()})` ||
  job.JobState !== 'RUNNING'
)
  throw new Error('Development allocation identity changed.');
const attemptId = String(payload.attemptId);
if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw new Error('Startup attempt identity is required.');
const root = join(homedir(), '.sciencewithagents', 'cluster-projects', record.id);
// This is durable history, not the regenerable node-local build directory. Never
// repair permissions or follow replaced parents while preparing an allocation.
let parent = homedir();
for (const component of ['.sciencewithagents', 'cluster-projects', record.id]) {
  parent = join(parent, component);
  try {
    mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('Private runtime parent changed.');
}
function readPrivate(path, limit = 10000) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit)
      throw new Error('Private runtime state changed.');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function savePrivate(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
const handshakePath = join(root, 'runtime-handshake.json'),
  metadataPath = join(root, 'runtime-bootstrap.json');
if (existsSync(metadataPath)) {
  const previous = JSON.parse(readPrivate(metadataPath));
  if (
    previous.projectId !== record.id ||
    !/^\d{1,20}$/.test(previous.jobId) ||
    !/^[a-f0-9-]{36}$/.test(previous.leaseToken)
  )
    throw new Error('Persistent remote project identity changed.');
  if (previous.jobId === jobId && previous.leaseToken === token) {
    // The coordinator should reuse this instance; never create two writers for one SQLite history.
    throw new Error(
      'This allocation already has a runtime bootstrap. Reconcile its saved handshake.',
    );
  }
  const oldJob = inspect(previous.jobId);
  if (
    oldJob &&
    (oldJob.Comment !== `swa-development:${record.id}:${previous.leaseToken}` ||
      oldJob.UserId !== `${record.folder.username}(${process.getuid()})`)
  )
    throw new Error('Previous allocation identity changed; history was retained.');
  if (
    oldJob &&
    !/^(COMPLETED|CANCELLED|FAILED|TIMEOUT|NODE_FAIL|OUT_OF_MEMORY|PREEMPTED|BOOT_FAIL|DEADLINE)/.test(
      oldJob.JobState ?? '',
    )
  )
    throw new Error('Previous project allocation is still active; refusing a second runtime.');
  // Only after native Slurm proves that previous runtime cannot still be running.
  if (existsSync(join(root, 'server.lock'))) {
    if (
      !Number.isSafeInteger(previous.mainPid) ||
      readPrivate(join(root, 'server.lock'), 100) !== String(previous.mainPid)
    )
      throw new Error('Another service owns this project data lock. Inspect it before reopening.');
    unlinkSync(join(root, 'server.lock'));
  }
}
if (existsSync(handshakePath)) unlinkSync(handshakePath);
savePrivate(metadataPath, {
  version: 1,
  projectId: record.id,
  jobId,
  leaseToken: token,
  attemptId,
});
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const access = prepareLocalAccess(root, port);
const store = new Store(join(root, 'dock.sqlite'));
let remoteProject, hostId;
try {
  const initialized = await initializeClusterProject(store, record, payload.clusterSettings);
  remoteProject = initialized.project;
  hostId = initialized.hostId;
} finally {
  store.close();
}
const bootstrap = createComputeBootstrap(record, {
  attemptId,
  hostId,
  remoteProjectId: remoteProject.id,
  jobId,
  leaseToken: token,
  node: hostname(),
  startedAt: new Date().toISOString(),
});
savePrivate(metadataPath, bootstrap);
const bundle = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const environment = {
  ...process.env,
  DOCK_DATA_DIR: root,
  DOCK_PORT: String(port),
  DOCK_CLUSTER_BOOTSTRAP_FILE: metadataPath,
  DOCK_LAUNCHER_LIFETIME: '1',
  PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''),
};
// Executables come only from the owner-installed runtime deployment descriptor.
if (payload.codexPath) environment.DOCK_CODEX_BIN = payload.codexPath;
if (payload.claudePath) environment.DOCK_CLAUDE_BIN = payload.claudePath;
const child = spawn(process.execPath, [join(bundle, 'apps/server/dist/main.js')], {
  cwd: bundle,
  env: environment,
  stdio: ['pipe', 'inherit', 'inherit'],
});
bootstrap.mainPid = child.pid;
savePrivate(metadataPath, bootstrap);
const finished = new Promise((resolve) => {
  child.once('exit', (code) => resolve(code ?? 1));
  child.once('error', () => resolve(1));
});
let started = false;
const origin = `http://127.0.0.1:${port}`;
// A healthy generic app is not enough: the exact compute admission boundary must
// be installed before exposing this runtime's private handshake to its controller.
const admissionPath = '/api/cluster/runtime/admission';
const deadline = Date.now() + 45000;
for (; Date.now() < deadline; ) {
  if (child.exitCode !== null) break;
  try {
    const authorization = await localAuthorization(
      origin,
      access.host,
      'host',
      'GET',
      admissionPath,
    );
    const reply = await fetch(origin + admissionPath, {
      headers: { authorization, origin, 'x-dock-target-host': hostId },
      signal: AbortSignal.timeout(2000),
    });
    if (reply.ok) {
      const { identity } = remoteAdmissionSnapshotSchema.parse(await reply.json());
      if (
        identity.remoteHostId !== hostId ||
        identity.remoteProjectId !== remoteProject.id ||
        identity.controllerHostId !== record.controllerHostId ||
        identity.clusterProjectId !== record.id ||
        identity.jobId !== jobId ||
        identity.leaseToken !== token
      )
        throw new Error('Compute runtime identity changed during startup.');
      started = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!started) {
  child.kill('SIGTERM');
  await finished;
  throw new Error('Remote runtime did not start. Inspect its private bootstrap log.');
}
const handshake = {
  version: 1,
  hostId,
  projectId: remoteProject.id,
  managerId: remoteProject.managerId,
  port,
  credential: access.host,
  attemptId,
  jobId,
  leaseToken: token,
};
savePrivate(handshakePath, handshake);
// The handshake stays in a private file. stdout is an ordinary private runtime log.
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
process.exitCode = await finished;
