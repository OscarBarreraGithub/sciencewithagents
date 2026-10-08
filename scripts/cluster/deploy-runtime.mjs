#!/usr/bin/env node
// Server-operated packaging; installation/building is permitted only in the owned compute job.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  openSync,
  closeSync,
  readSync,
  fsyncSync,
  readdirSync,
  lstatSync,
  renameSync,
  rmSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const nodeVersion = '24.21.0';
export const pnpmVersion = '10.17.1';
export const nodeChecksums = {
  x64: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  arm64: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
};
const pnpmIntegrity =
  'F8Vg/KSGeulHOjiZrYSogzSRTzeb5G1FXL+S5c9LOdNJhdRS0lg7rxmWf6dstcF7yeJFUp0LmHRXIapyAOyveg==';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args) => execFileSync('git', args, { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const fail = (message) => {
  throw new Error(message);
};
function cacheWrite(file, bytes, mode) {
  const temporary = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { mode, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function packageSource(repo, revision, output, requireBootstrap = true) {
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('An exact immutable source revision is required.');
  if (
    git(repo, ['rev-parse', `${revision}^{commit}`])
      .toString()
      .trim() !== revision
  )
    fail('Source revision is not a commit.');
  const entries = git(repo, ['ls-tree', '-rz', revision]).toString().split('\0').filter(Boolean);
  const files = {};
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\n\r]+)$/.exec(entry);
    if (!match) fail('Source bundles cannot contain symlinks, submodules or unsafe names.');
    const path = match[3];
    if (
      path.startsWith('/') ||
      path.split('/').some((p) => p === '..' || p === '.git' || p === 'node_modules') ||
      /(^|\/)data(\/|$)|(^|\/)\.env(?:\.|$)|(^|\/)(credentials?|cookies?)(\.|\/|$)/i.test(path)
    )
      fail('Tracked runtime or credential material is not bundle source.');
    files[path] = sha256(git(repo, ['cat-file', 'blob', match[2]]));
  }
  if (
    requireBootstrap &&
    (!files['scripts/cluster/development-runtime.mjs'] ||
      !files['scripts/cluster/deploy-runtime.mjs'] ||
      !files['scripts/cluster/compute-scratch.py'])
  )
    fail('Frozen source must contain both runtime bootstrap and installer.');
  const pkg = JSON.parse(git(repo, ['show', `${revision}:package.json`]).toString());
  if (pkg.packageManager !== `pnpm@${pnpmVersion}`)
    fail('Frozen source requires a different package manager.');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const archive = git(repo, ['archive', '--format=tar', revision]);
  if (archive.length > 64 * 1024 * 1024) fail('Source bundle exceeds its bounded size.');
  cacheWrite(join(output, 'source.tar'), archive, 0o600);
  return { revision, files, sourceSha256: sha256(archive) };
}

async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit)
    fail('Pinned toolchain download failed.');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      fail('Toolchain download exceeds its bounded size.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function prepareRuntimeBundle({ repo, revision, output, arch }) {
  if (!Object.hasOwn(nodeChecksums, arch)) fail('Unsupported compute architecture.');
  const source = packageSource(repo, revision, output);
  const nodeFile = `node-v${nodeVersion}-linux-${arch}.tar.xz`;
  const node = existsSync(join(output, 'node.tar.xz'))
    ? readFileSync(join(output, 'node.tar.xz'))
    : await download(`https://nodejs.org/dist/v${nodeVersion}/${nodeFile}`, 64 * 1024 * 1024);
  if (sha256(node) !== nodeChecksums[arch]) fail('Node archive checksum mismatch.');
  const pnpm = existsSync(join(output, 'pnpm.tgz'))
    ? readFileSync(join(output, 'pnpm.tgz'))
    : await download(`https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`, 16 * 1024 * 1024);
  if (createHash('sha512').update(pnpm).digest('base64') !== pnpmIntegrity)
    fail('pnpm archive integrity mismatch.');
  cacheWrite(join(output, 'node.tar.xz'), node, 0o600);
  cacheWrite(join(output, 'pnpm.tgz'), pnpm, 0o600);
  const manifest = {
    version: 1,
    ...source,
    arch,
    nodeVersion,
    pnpmVersion,
    assets: {
      'source.tar': source.sourceSha256,
      'node.tar.xz': sha256(node),
      'pnpm.tgz': sha256(pnpm),
    },
  };
  cacheWrite(join(output, 'manifest.json'), JSON.stringify(manifest), 0o600);
  cacheWrite(join(output, 'install-runtime.sh'), installer, 0o700);
  return manifest;
}

export function verifyAllocation(input, job, uid, environmentJob) {
  if (
    !uuid.test(input.projectId) ||
    !uuid.test(input.token) ||
    !/^\d{1,20}$/.test(input.jobId) ||
    !safeName.test(input.username) ||
    !safeName.test(input.account)
  )
    fail('Invalid allocation identity.');
  if (
    environmentJob !== input.jobId ||
    job.JobId !== input.jobId ||
    job.Comment !== `swa-development:${input.projectId}:${input.token}` ||
    job.JobName !== `swa-dev-${input.projectId.slice(0, 8)}` ||
    job.UserId !== `${input.username}(${uid})` ||
    job.Account !== input.account ||
    job.JobState !== 'RUNNING'
  )
    fail('Installation requires the exact running owner development allocation.');
}

export function reclaimableLock(marker, observation, uid, revision, arch, username) {
  const x = marker?.allocation;
  if (
    marker?.revision !== revision ||
    marker?.arch !== arch ||
    !x ||
    !uuid.test(x.projectId) ||
    !uuid.test(x.token) ||
    !/^\d{1,20}$/.test(x.jobId) ||
    x.username !== username ||
    !safeName.test(x.account)
  )
    return false;
  if (observation.absent === true) return true;
  const job = observation.job;
  return (
    !!job &&
    job.JobId === x.jobId &&
    job.UserId === `${username}(${uid})` &&
    job.Account === x.account &&
    job.Comment === `swa-development:${x.projectId}:${x.token}` &&
    job.JobName === `swa-dev-${x.projectId.slice(0, 8)}` &&
    /^(COMPLETED|CANCELLED|FAILED|TIMEOUT|OUT_OF_MEMORY|PREEMPTED|BOOT_FAIL|DEADLINE)$/.test(
      job.JobState,
    )
  );
}

function treeHashes(root) {
  const result = {};
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        relative = prefix + name,
        st = lstatSync(path);
      if (st.isDirectory()) walk(path, relative + '/');
      else if (st.isFile()) result[relative] = sha256(readFileSync(path));
      else fail('Unexpected link in compiled artifacts.');
    }
  }
  walk(root);
  return result;
}
export function writeBuildProvenance(root, manifest) {
  const provenance = {
    sourceRevision: manifest.revision,
    sourceSha256: manifest.sourceSha256,
    nodeVersion,
    pnpmVersion,
    arch: manifest.arch,
  };
  const files = {};
  for (const dir of ['packages/shared/dist', 'apps/server/dist', 'apps/web/dist']) {
    writeFileSync(join(root, dir, 'source-provenance.json'), JSON.stringify(provenance), {
      mode: 0o600,
    });
    for (const [name, digest] of Object.entries(treeHashes(join(root, dir))))
      files[`${dir}/${name}`] = digest;
  }
  return files;
}
function verifyFiles(root, files) {
  for (const [path, digest] of Object.entries(files)) {
    const file = resolve(root, path);
    if (
      !file.startsWith(resolve(root) + '/') ||
      !lstatSync(file).isFile() ||
      sha256(readFileSync(file)) !== digest
    )
      fail('Runtime file integrity mismatch.');
  }
}
export function runComputeBuildCommand(command, args, cwd, env, log, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail('Compute build exceeded its deadline.');
  const descriptor = openSync(log, 'a', 0o600);
  appendFileSync(
    descriptor,
    `\n[${new Date().toISOString()}] command started; remaining=${remaining}ms\n`,
  );
  let result;
  try {
    // Direct private descriptors preserve progress even while a child/remote filesystem stalls.
    result = spawnSync(command, args, {
      cwd,
      env,
      stdio: ['ignore', descriptor, descriptor],
      timeout: remaining,
    });
  } finally {
    try {
      closeSync(descriptor);
    } catch {}
  }
  try {
    appendFileSync(
      log,
      `\n[${new Date().toISOString()}] command ended; status=${result.status}; signal=${result.signal ?? 'none'}; error=${result.error?.code ?? 'none'}\n`,
      { mode: 0o600 },
    );
  } catch {}
  if (result.status !== 0) {
    const error = new Error(
      'Compute dependency installation or build failed; inspect the private stage build log.',
    );
    error.uncertainWriter = true;
    throw error;
  }
}
const run = runComputeBuildCommand;

/** Only called after the compute allocation guard; never changes the parent environment. */
export function computeCompilerEnvironment(env, working, log, deadline, launch = spawnSync) {
  const flags = `${env.LDFLAGS ?? ''} -static-libstdc++`.trim();
  const executable = join(working, `.compiler-probe-${randomUUID()}`);
  const options = (candidate) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('Compute build exceeded its deadline.');
    return {
      cwd: working,
      env: candidate,
      encoding: 'utf8',
      timeout: Math.min(15_000, remaining),
      maxBuffer: 1024 * 1024,
    };
  };
  const observed = (result) => {
    if (result.signal || (result.error && result.error.code !== 'ENOENT')) {
      const error = new Error(
        'Compute compiler probe did not finish; inspect the private build log.',
      );
      error.uncertainWriter = true;
      throw error;
    }
    return result.status === 0;
  };
  const usable = (candidate) => {
    const result = launch(
      candidate.CXX || 'g++',
      ['-std=gnu++20', '-static-libstdc++', '-x', 'c++', '-', '-o', executable],
      {
        ...options(candidate),
        input:
          "#include <string>\nstatic_assert(__cplusplus >= 202002L);\nint main(){return std::string(100, 'x').size()!=100;}\n",
      },
    );
    appendFileSync(
      log,
      `\nC++20 compiler probe: status=${result.status}; ${String(result.stderr ?? '').slice(0, 4000)}\n`,
      { mode: 0o600 },
    );
    // Verify without the module environment, just like the relocated runtime smoke.
    return observed(result) && observed(launch(executable, [], options(env)));
  };
  try {
    if (usable(env)) return { ...env, LDFLAGS: flags };
    const result = launch(
      '/bin/bash',
      [
        '-lc',
        `set -e
module load gcc >/dev/null
export CC="$(command -v gcc)" CXX="$(command -v g++)"
env -0`,
      ],
      options(env),
    );
    appendFileSync(
      log,
      `\nSite gcc module: status=${result.status}; ${String(result.stderr ?? '').slice(0, 4000)}\n`,
      { mode: 0o600 },
    );
    if (!observed(result))
      fail('A C++20 compiler is required; site gcc module could not be loaded.');
    const candidate = Object.fromEntries(
      result.stdout
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=');
          if (separator < 1) fail('Site compiler environment could not be read.');
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
    );
    if (env.HOME === undefined) delete candidate.HOME;
    else candidate.HOME = env.HOME;
    if (!candidate.CC || !candidate.CXX || !usable(candidate))
      fail('The site gcc module does not supply a usable C++20 compiler.');
    appendFileSync(log, '\nUsing the site gcc module for this compute build only.\n', {
      mode: 0o600,
    });
    return { ...candidate, LDFLAGS: flags };
  } finally {
    rmSync(executable, { force: true });
  }
}
/** Preserve app-owned failure evidence; recursive network-filesystem deletion is never on this path. */
export function preserveFailedBuild(working, manifest, error) {
  const stat = lstatSync(working);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    fail('Failed build stage ownership changed.');
  cacheWrite(
    join(working, 'runtime-failed.json'),
    JSON.stringify({
      version: 1,
      revision: manifest.revision,
      arch: manifest.arch,
      allocation: manifest.allocation,
      failedAt: new Date().toISOString(),
      message: String(error instanceof Error ? error.message : error).slice(0, 1000),
    }),
    0o600,
  );
}

export const nativeRuntimeSmoke = `
const {DatabaseSync}=await import('node:sqlite');
const db=new DatabaseSync(':memory:');
try { db.exec('CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES(7)'); if(db.prepare('SELECT value FROM proof').get().value!==7) throw new Error('SQLite smoke failed'); } finally { db.close(); }
const pty=(await import('node-pty')).default;
await new Promise((resolve,reject)=>{
 const terminal=pty.spawn('/bin/sh',['-c','printf swa-native-pty'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});
 let output=''; const timer=setTimeout(()=>{try{terminal.kill();}catch{} reject(new Error('PTY smoke timed out'));},5000);
 terminal.onData(data=>output+=data);
 terminal.onExit(({exitCode})=>{clearTimeout(timer);exitCode===0 && output.includes('swa-native-pty')?resolve():reject(new Error('PTY smoke failed'));});
});`;

export function preserveBuildLogTail(log, target) {
  if (!existsSync(log)) return;
  const size = lstatSync(log).size,
    length = Math.min(size, 1024 * 1024),
    buffer = Buffer.allocUnsafe(length),
    descriptor = openSync(log, 'r');
  let count;
  try {
    count = readSync(descriptor, buffer, 0, length, Math.max(0, size - length));
  } finally {
    closeSync(descriptor);
  }
  cacheWrite(target, buffer.subarray(0, count), 0o600);
}

function providerPath(name, env) {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { env, encoding: 'utf8' });
  const path = result.status === 0 ? result.stdout.trim() : '';
  return path.startsWith('/') && !/[\r\n\0]/.test(path) ? path : null;
}

function fileDigest(file) {
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(1024 * 1024),
    descriptor = openSync(file, 'r');
  try {
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}
function ownedDirectory(path) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    fail('Runtime artifact directory is not private and owned.');
}
export function verifyRuntimeTree(root, manifest, receipt) {
  if (
    receipt.revision !== manifest.revision ||
    receipt.arch !== manifest.arch ||
    receipt.sourceSha256 !== manifest.sourceSha256
  )
    fail('Runtime artifact provenance changed.');
  verifyFiles(root, manifest.files);
  verifyFiles(root, receipt.buildFiles);
  if (sha256(readFileSync(join(root, '.toolchain/node/bin/node'))) !== receipt.nodeSha256)
    fail('Installed Node integrity mismatch.');
}
export function publishRuntimeArtifact(working, target, manifest, verifyBeforePublish) {
  if (typeof verifyBeforePublish !== 'function')
    fail('Private relocated verification is required before publication.');
  ownedDirectory(working);
  const receipt = JSON.parse(readFileSync(join(working, 'runtime-ready.json'), 'utf8'));
  verifyRuntimeTree(working, manifest, receipt);
  // Creating tar's output inside its input changes the root directory during GNU tar's scan.
  // Keep it in an owned private sibling; failed builds retain their archive evidence.
  ownedDirectory(join(working, '..'));
  const archiveDirectory = mkdtempSync(join(working, '../.runtime-artifact-'));
  const archive = join(archiveDirectory, 'runtime.tar.gz');
  // Exclude only regenerable package-store and diagnostics, retaining installed runtime dependencies.
  execFileSync(
    'tar',
    [
      '-czf',
      archive,
      '--exclude=./.runtime-artifact.tar.gz',
      '--exclude=./.toolchain/store',
      '--exclude=./.toolchain/npm-cache',
      '--exclude=./.toolchain/pnpm-cache',
      '--exclude=./.toolchain/pnpm-state',
      '--exclude=./.toolchain/node-gyp',
      '--exclude=./runtime-build.log',
      '-C',
      working,
      '.',
    ],
    { timeout: 120_000 },
  );
  const size = lstatSync(archive).size;
  if (size > 2 * 1024 ** 3) fail('Runtime archive exceeds its persistent size bound.');
  const archiveSha256 = fileDigest(archive);
  verifyBeforePublish(archive, receipt);
  if (fileDigest(archive) !== archiveSha256) fail('Private verified runtime archive changed.');
  const publishing = join(join(target, '..'), `.publish-${randomUUID()}`);
  mkdirSync(publishing, { mode: 0o700 });
  copyFileSync(archive, join(publishing, 'runtime.tar.gz'));
  chmodSync(join(publishing, 'runtime.tar.gz'), 0o600);
  const descriptor = openSync(join(publishing, 'runtime.tar.gz'), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (fileDigest(join(publishing, 'runtime.tar.gz')) !== archiveSha256)
    fail('Persistent runtime archive copy changed.');
  const outer = { ...receipt, version: 2, archiveSize: size, archiveSha256 };
  cacheWrite(join(publishing, 'runtime-ready.json'), JSON.stringify(outer), 0o600);
  renameSync(publishing, target);
  rmSync(archiveDirectory, { recursive: true });
  return outer;
}
export function materializeRuntimeArtifact(target, localTarget, manifest, helper) {
  ownedDirectory(target);
  const receipt = JSON.parse(readFileSync(join(target, 'runtime-ready.json'), 'utf8'));
  if (
    receipt.version !== 2 ||
    receipt.revision !== manifest.revision ||
    receipt.arch !== manifest.arch ||
    receipt.sourceSha256 !== manifest.sourceSha256 ||
    !Number.isInteger(receipt.archiveSize) ||
    receipt.archiveSize > 2 * 1024 ** 3
  )
    fail('Persistent runtime archive provenance changed.');
  const archive = join(target, 'runtime.tar.gz');
  if (
    !lstatSync(archive).isFile() ||
    lstatSync(archive).uid !== process.getuid() ||
    lstatSync(archive).mode & 0o077 ||
    lstatSync(archive).size !== receipt.archiveSize
  )
    fail('Persistent runtime archive checksum mismatch.');
  if (existsSync(localTarget)) {
    ownedDirectory(localTarget);
    if (fileDigest(archive) !== receipt.archiveSha256)
      fail('Persistent runtime archive checksum mismatch.');
    verifyRuntimeTree(localTarget, manifest, receipt);
    return localTarget;
  }
  const copiedArchive = join(join(localTarget, '..'), `.artifact-${randomUUID()}.tar.gz`);
  copyFileSync(archive, copiedArchive);
  if (
    lstatSync(copiedArchive).size !== receipt.archiveSize ||
    fileDigest(copiedArchive) !== receipt.archiveSha256
  )
    fail('Persistent runtime archive checksum mismatch.');
  const local = verifyPrivateRuntimeArchive(copiedArchive, localTarget, manifest, receipt, helper);
  rmSync(copiedArchive);
  return local;
}
export function verifyPrivateRuntimeArchive(archive, localTarget, manifest, receipt, helper) {
  const archiveSha256 = fileDigest(archive);
  if (existsSync(localTarget)) {
    ownedDirectory(localTarget);
    const proof = JSON.parse(readFileSync(join(localTarget, 'runtime-materialized.json'), 'utf8'));
    if (proof.archiveSha256 !== archiveSha256)
      fail('Existing scratch runtime belongs to different archive bytes.');
    verifyRuntimeTree(localTarget, manifest, receipt);
    return localTarget;
  }
  const stage = join(join(localTarget, '..'), `.materialize-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  const program =
    "import runpy,sys; h=runpy.run_path(sys.argv[1],run_name='artifact_helper'); h['extract_runtime_archive'](sys.argv[2],sys.argv[3])";
  execFileSync('python3', ['-c', program, helper, archive, stage], { timeout: 120_000 });
  verifyRuntimeTree(stage, manifest, receipt);
  cacheWrite(join(stage, 'runtime-materialized.json'), JSON.stringify({ archiveSha256 }), 0o600);
  renameSync(stage, localTarget);
  return localTarget;
}

export function installRuntime(stage) {
  process.umask(0o077);
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  const jobText = execFileSync('scontrol', ['show', 'job', '-o', manifest.allocation.jobId], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  verifyAllocation(
    manifest.allocation,
    Object.fromEntries([...jobText.matchAll(/(\w+)=([^ ]*)/g)].map((m) => [m[1], m[2]])),
    process.getuid(),
    process.env.SLURM_JOB_ID,
  );
  if (
    process.platform !== 'linux' ||
    process.arch !== manifest.arch ||
    manifest.nodeVersion !== nodeVersion ||
    manifest.pnpmVersion !== pnpmVersion ||
    !/^[a-f0-9]{40}$/.test(manifest.revision)
  )
    fail('Pinned Linux toolchain does not match this compute host.');
  if (
    process.versions.node !== nodeVersion ||
    manifest.assets['node.tar.xz'] !== nodeChecksums[manifest.arch] ||
    createHash('sha512')
      .update(readFileSync(join(stage, 'pnpm.tgz')))
      .digest('base64') !== pnpmIntegrity
  )
    fail('Toolchain pin integrity mismatch.');
  for (const [name, digest] of Object.entries(manifest.assets))
    if (
      !['source.tar', 'node.tar.xz', 'pnpm.tgz'].includes(name) ||
      sha256(readFileSync(join(stage, name))) !== digest
    )
      fail('Deployment asset integrity mismatch.');
  const parent = join(homedir(), '.sciencewithagents', 'runtime');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  for (const path of [join(homedir(), '.sciencewithagents'), parent]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
      fail('Runtime parent is not an owned directory.');
  }
  if (lstatSync(parent).mode & 0o077) fail('Runtime prefix must be private.');
  const helper = join(stage, 'bootstrap-source/scripts/cluster/compute-scratch.py');
  if (sha256(readFileSync(helper)) !== manifest.files['scripts/cluster/compute-scratch.py'])
    fail('Compute scratch helper differs from frozen source.');
  const observed = JSON.parse(
    execFileSync(
      'python3',
      [helper, Buffer.from(JSON.stringify(manifest.allocation)).toString('base64')],
      { encoding: 'utf8', timeout: 20_000 },
    ),
  );
  if (observed.arch !== manifest.arch || observed.scratchRoot !== manifest.compute?.scratchRoot)
    fail('Native compute scratch identity changed.');
  const target = join(parent, manifest.revision),
    ready = join(target, 'runtime-ready.json'),
    localTarget = join(observed.scratchRoot, `runtime-${manifest.revision}`);
  const installedResult = (local) => {
    const env = {
      ...process.env,
      PATH: `${join(local, '.toolchain/node/bin')}:${process.env.PATH ?? ''}`,
    };
    return {
      bundlePath: local,
      nodePath: join(local, '.toolchain/node/bin/node'),
      codexPath: providerPath('codex', env),
      claudePath: providerPath('claude', env),
    };
  };
  const reuse = () => {
    const local = materializeRuntimeArtifact(target, localTarget, manifest, helper);
    const env = {
      ...process.env,
      PATH: `${join(local, '.toolchain/node/bin')}:${process.env.PATH ?? ''}`,
    };
    run(
      join(local, '.toolchain/node/bin/node'),
      ['--input-type=module', '-e', nativeRuntimeSmoke],
      join(local, 'apps/server'),
      env,
      join(stage, 'reuse-check.log'),
      Date.now() + 15_000,
    );
    return installedResult(local);
  };
  if (existsSync(target)) return reuse();
  const lock = join(parent, `.lock-${manifest.revision}`);
  const lockDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({
          revision: manifest.revision,
          arch: manifest.arch,
          allocation: manifest.allocation,
          pid: process.pid,
        }),
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (existsSync(ready)) return reuse();
      try {
        const stat = lstatSync(lock),
          markerPath = join(lock, 'owner.json'),
          ownerStat = lstatSync(markerPath);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid() ||
          stat.mode & 0o077 ||
          !ownerStat.isFile() ||
          ownerStat.uid !== process.getuid() ||
          ownerStat.mode & 0o077 ||
          ownerStat.size > 2000
        )
          fail('Runtime install lock is not private and owned.');
        const bytes = readFileSync(markerPath),
          marker = JSON.parse(bytes);
        if (
          !reclaimableLock(
            marker,
            { absent: true },
            process.getuid(),
            manifest.revision,
            manifest.arch,
            manifest.allocation.username,
          )
        )
          fail('Install lock has different provenance.');
        let observation;
        try {
          const text = execFileSync(
            'scontrol',
            ['show', 'job', '-o', String(marker.allocation?.jobId)],
            { encoding: 'utf8', timeout: 15_000 },
          );
          observation = {
            job: Object.fromEntries([...text.matchAll(/(\w+)=([^ ]*)/g)].map((m) => [m[1], m[2]])),
          };
        } catch (readError) {
          if (
            !/Invalid job id/.test(String(readError.stderr ?? '') + String(readError.stdout ?? ''))
          )
            throw readError;
          observation = { absent: true };
        }
        if (
          reclaimableLock(
            marker,
            observation,
            process.getuid(),
            manifest.revision,
            manifest.arch,
            manifest.allocation.username,
          ) &&
          readFileSync(markerPath).equals(bytes) &&
          lstatSync(lock).ino === stat.ino
        ) {
          const abandoned = join(parent, `.ended-lock-${randomUUID()}`);
          renameSync(lock, abandoned);
          rmSync(abandoned, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* Unknown/live locks are retained; a job or a missing marker is not proof of termination. */
      }
      if (Date.now() >= lockDeadline)
        fail(
          'This runtime version is still being prepared. Its owned lock was retained; reconcile readiness before retrying.',
        );
      spawnSync('/bin/sleep', ['1']);
    }
  }
  const working = join(observed.scratchRoot, `.install-${randomUUID()}`);
  mkdirSync(working, { mode: 0o700 });
  const log = join(working, 'runtime-build.log'),
    deadline = Date.now() + 540_000;
  let retainLock = false;
  try {
    execFileSync('tar', ['-xf', join(stage, 'source.tar'), '-C', working]);
    verifyFiles(working, manifest.files);
    const tools = join(working, '.toolchain');
    mkdirSync(tools, { mode: 0o700 });
    const node = join(tools, 'node');
    mkdirSync(node);
    execFileSync('tar', ['-xJf', join(stage, 'node.tar.xz'), '--strip-components=1', '-C', node]);
    const pnpm = join(tools, 'pnpm');
    mkdirSync(pnpm);
    execFileSync('tar', ['-xzf', join(stage, 'pnpm.tgz'), '--strip-components=1', '-C', pnpm]);
    const nodePath = join(node, 'bin/node'),
      pnpmPath = join(pnpm, 'bin/pnpm.cjs');
    const baseEnv = {
      ...process.env,
      CI: 'true',
      npm_config_cache: join(tools, 'npm-cache'),
      npm_config_cache_dir: join(tools, 'pnpm-cache'),
      npm_config_state_dir: join(tools, 'pnpm-state'),
      npm_config_devdir: join(tools, 'node-gyp'),
      PATH: `${join(node, 'bin')}:${process.env.PATH ?? ''}`,
    };
    const env = computeCompilerEnvironment(baseEnv, working, log, deadline);
    // Login initialization may replace PATH; keep all package scripts on pinned Node.
    env.PATH = `${join(node, 'bin')}:${env.PATH ?? ''}`;
    run(
      nodePath,
      [pnpmPath, 'install', '--frozen-lockfile', '--store-dir', join(tools, 'store')],
      working,
      env,
      log,
      deadline,
    );
    for (const pkg of ['@dock/shared', '@dock/server', '@dock/web'])
      run(nodePath, [pnpmPath, '--filter', pkg, 'build'], working, env, log, deadline);
    run(
      nodePath,
      ['--input-type=module', '-e', nativeRuntimeSmoke],
      join(working, 'apps/server'),
      env,
      log,
      deadline,
    );
    writeFileSync(join(working, 'runtime-source-manifest.json'), JSON.stringify(manifest), {
      mode: 0o600,
    });
    const buildFiles = writeBuildProvenance(working, manifest);
    writeFileSync(
      join(working, 'runtime-ready.json'),
      JSON.stringify({
        revision: manifest.revision,
        arch: manifest.arch,
        sourceSha256: manifest.sourceSha256,
        nodeSha256: sha256(readFileSync(nodePath)),
        buildFiles,
      }),
      { mode: 0o600 },
    );
    publishRuntimeArtifact(working, target, manifest, (archive, receipt) => {
      verifyPrivateRuntimeArchive(archive, localTarget, manifest, receipt, helper);
      const localEnv = {
        ...process.env,
        PATH: `${join(localTarget, '.toolchain/node/bin')}:${process.env.PATH ?? ''}`,
      };
      run(
        join(localTarget, '.toolchain/node/bin/node'),
        ['--input-type=module', '-e', nativeRuntimeSmoke],
        join(localTarget, 'apps/server'),
        localEnv,
        log,
        Date.now() + 15_000,
      );
    });
    return installedResult(localTarget);
  } catch (error) {
    retainLock = error?.uncertainWriter === true;
    // Diagnostic persistence is best effort and must never replace the original failure.
    try {
      if (existsSync(working)) preserveFailedBuild(working, manifest, error);
    } catch {}
    try {
      cacheWrite(
        join(parent, `.failed-${manifest.revision}-${manifest.allocation.token}.json`),
        JSON.stringify({
          allocation: manifest.allocation,
          revision: manifest.revision,
          failedAt: new Date().toISOString(),
          scratchStage: working,
          uncertainWriter: retainLock,
          message: String(error.message ?? error).slice(0, 1000),
        }),
        0o600,
      );
    } catch {}
    try {
      preserveBuildLogTail(
        log,
        join(parent, `.failed-${manifest.revision}-${manifest.allocation.token}.log`),
      );
    } catch {}
    throw error;
  } finally {
    if (!retainLock) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {}
    }
  }
}

// Python is the bootstrap dependency; no Node/package build is run on a login node.
export const installer = `#!/bin/sh
set -eu
umask 077
stage=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 - "$stage" <<'PY'
import json,os,re,subprocess,sys,hashlib,platform,base64
stage=sys.argv[1]; m=json.load(open(os.path.join(stage,'manifest.json'))); x=m['allocation']
assert re.fullmatch(r'[a-f0-9-]{36}',x['projectId']) and re.fullmatch(r'[a-f0-9-]{36}',x['token'])
assert re.fullmatch(r'[0-9]{1,20}',x['jobId']) and os.environ.get('SLURM_JOB_ID')==x['jobId'], 'Compute allocation required'
job=dict(re.findall(r'(\\w+)=([^ ]*)',subprocess.check_output(['scontrol','show','job','-o',x['jobId']],text=True,timeout=15)))
assert job.get('JobId')==x['jobId'] and job.get('Comment')=='swa-development:'+x['projectId']+':'+x['token'] and job.get('JobName')=='swa-dev-'+x['projectId'][:8] and job.get('UserId')==x['username']+'('+str(os.getuid())+')' and job.get('Account')==x['account'] and job.get('JobState')=='RUNNING', 'Allocation ownership changed'
assert platform.system()=='Linux' and {'x86_64':'x64','aarch64':'arm64'}.get(platform.machine())==m['arch'], 'Unsupported architecture'
libc,version=platform.libc_ver(); assert libc=='glibc' and tuple(map(int,version.split('.')[:2]))>=(2,28), 'Node 24 requires glibc 2.28+'
assert tuple(map(int,platform.release().split('.')[:2]))>=(4,18), 'Node 24 requires Linux 4.18+'
assert m['nodeVersion']=='${nodeVersion}' and m['pnpmVersion']=='${pnpmVersion}' and m['assets']['node.tar.xz']==${JSON.stringify(nodeChecksums)}[m['arch']], 'Toolchain pin changed'
assert base64.b64encode(hashlib.sha512(open(os.path.join(stage,'pnpm.tgz'),'rb').read()).digest()).decode()=='${pnpmIntegrity}', 'pnpm integrity changed'
for name,digest in m['assets'].items():
 assert name in ('source.tar','node.tar.xz','pnpm.tgz') and hashlib.sha256(open(os.path.join(stage,name),'rb').read()).hexdigest()==digest, 'Asset checksum changed'
import tarfile
with tarfile.open(os.path.join(stage,'source.tar')) as source:
 helper=source.extractfile('scripts/cluster/compute-scratch.py').read()
assert hashlib.sha256(helper).hexdigest()==m['files']['scripts/cluster/compute-scratch.py'], 'Scratch helper checksum changed'
namespace={'__name__':'bootstrap_helper'}; exec(compile(helper,'frozen-compute-scratch.py','exec'),namespace)
namespace['verify_compute_node'](job)
with open('/proc/self/mountinfo') as f: mounts=f.read()
scratch=namespace['native_scratch'](x,mounts)['scratchRoot']
assert scratch==m['compute']['scratchRoot'], 'Native scratch identity changed'
bootstrap=os.path.join(scratch,'bootstrap-'+os.path.basename(stage)); os.mkdir(bootstrap,0o700)
node=os.path.join(bootstrap,'node'); os.mkdir(node,0o700)
source=os.path.join(bootstrap,'source'); os.mkdir(source,0o700)
subprocess.check_call(['tar','-xJf',os.path.join(stage,'node.tar.xz'),'--strip-components=1','-C',node])
subprocess.check_call(['tar','-xf',os.path.join(stage,'source.tar'),'-C',source])
# Only one small link lives in the persistent upload stage; their targets are verified owned scratch.
os.symlink(source,os.path.join(stage,'bootstrap-source'))
os.execv(os.path.join(node,'bin/node'),[os.path.join(node,'bin/node'),os.path.join(source,'scripts/cluster/deploy-runtime.mjs'),'install',stage])
PY
`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'install')
    console.log(JSON.stringify(installRuntime(resolve(process.argv[3]))));
  else if (process.argv[2] === 'package') {
    const [repo, revision, output, arch] = process.argv.slice(3);
    await prepareRuntimeBundle({ repo: resolve(repo), revision, output: resolve(output), arch });
    console.log(JSON.stringify({ revision, output: resolve(output), arch }));
  } else
    fail(
      'Use package <repo> <exact revision> <owned output> <x64|arm64>, or compute-only install <stage>.',
    );
}
