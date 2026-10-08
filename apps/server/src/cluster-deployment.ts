import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ClusterProjectRecord } from '@dock/shared';
import { queryOptions, type ClusterRunner } from './cluster.js';
import type { DevelopmentLease } from './cluster-development.js';
import type { PrepareClusterBundle } from './cluster-runtime.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const resultSchema = z
  .object({
    bundlePath: z.string().startsWith('/'),
    nodePath: z.string().startsWith('/'),
    codexPath: z.string().startsWith('/').nullable(),
    claudePath: z.string().startsWith('/').nullable(),
  })
  .strict();
const assets = [
  'source.tar',
  'node.tar.xz',
  'pnpm.tgz',
  'manifest.json',
  'install-runtime.sh',
] as const;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Fixed programs receive only server-derived records. Package installation never runs here.
async function frozenComputeHelper(repo: string, revision: string): Promise<string> {
  return new Promise((accept, reject) =>
    execFile(
      'git',
      ['show', `${revision}:scripts/cluster/compute-scratch.py`],
      { cwd: repo, timeout: 15_000, maxBuffer: 128_000, encoding: 'utf8' },
      (error, stdout) =>
        error
          ? reject(new Error('Frozen release lacks the verified compute scratch helper.'))
          : accept(stdout),
    ),
  );
}

export const receiveBundle = `import sys,os,json,base64,hashlib,re,stat
stageid=sys.argv[1]; assert re.fullmatch(r'[a-f0-9-]{36}',stageid)
raw=sys.stdin.buffer.read(256*1024*1024+1); assert len(raw)<=256*1024*1024
p=json.loads(raw); assert set(p)=={'files'} and set(p['files'])=={'source.tar','node.tar.xz','pnpm.tgz','manifest.json','install-runtime.sh'}
parent=os.path.join(os.path.expanduser('~'),'.sciencewithagents','runtime-staging'); os.makedirs(parent,mode=0o700,exist_ok=True)
for path in (os.path.dirname(parent),parent):
 s=os.lstat(path); assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid()
assert not os.stat(parent).st_mode&0o077
stage=os.path.join(parent,stageid); os.mkdir(stage,0o700)
for name,item in p['files'].items():
 assert set(item)=={'sha256','data'}; data=base64.b64decode(item['data'],validate=True); assert hashlib.sha256(data).hexdigest()==item['sha256']
 fd=os.open(os.path.join(stage,name),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700 if name=='install-runtime.sh' else 0o600)
 with os.fdopen(fd,'wb') as f: f.write(data)
print(json.dumps({'stage':stage}))`;
const cleanupStage = `import os,sys,stat,shutil,re
stageid=sys.argv[1]; assert re.fullmatch(r'[a-f0-9-]{36}',stageid)
path=os.path.join(os.path.expanduser('~'),'.sciencewithagents','runtime-staging',stageid)
s=os.lstat(path); assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and not s.st_mode&0o077
shutil.rmtree(path)`;

function packageLocal(
  script: string,
  repo: string,
  revision: string,
  output: string,
  arch: string,
) {
  return new Promise<void>((accept, reject) =>
    execFile(
      process.execPath,
      [script, 'package', repo, revision, output, arch],
      { timeout: 300_000, maxBuffer: 100_000 },
      (error) =>
        error
          ? reject(
              new Error(
                'Preparing the pinned cluster bundle failed. No remote installation was started.',
              ),
            )
          : accept(),
    ),
  );
}

/** Bind this to an immutable installed release, never a browser path or implicit Git HEAD. */
export function createClusterBundlePreparer(options: {
  runner: ClusterRunner;
  sourceRepo: string;
  revision: string;
  cacheDir: string;
}): PrepareClusterBundle {
  if (!/^[a-f0-9]{40}$/.test(options.revision))
    throw new Error('Cluster deployment needs an exact installed source revision.');
  const pending = new Map<
    string,
    Promise<{
      bundlePath: string;
      nodePath: string;
      codexPath: string | null;
      claudePath: string | null;
    }>
  >();
  const installations = new Map<string, Promise<z.infer<typeof resultSchema>>>();
  async function prepare(record: ClusterProjectRecord, lease: DevelopmentLease) {
    if (
      lease.state !== 'ready' ||
      !lease.jobId ||
      lease.projectId !== record.id ||
      lease.alias !== record.folder.alias ||
      lease.username !== record.folder.username ||
      !record.folder.account
    )
      throw new Error('A verified ready allocation and confirmed account are required.');
    const native = async (args: string[], input: string | null, timeout = 60_000) => {
      const reply = await options.runner(
        [
          ...queryOptions,
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ForwardAgent=no',
          '-o',
          'PermitLocalCommand=no',
          '--',
          record.folder.alias,
          ...args,
        ],
        input,
        timeout,
      );
      if (reply.code !== 0 || reply.timedOut)
        throw new Error(
          reply.timedOut
            ? 'Runtime preparation timed out. Reconcile its private readiness before retrying.'
            : 'Runtime preparation failed. Inspect the private compute build log or cluster setup.',
        );
      return reply.stdout.trim();
    };
    const allocation = {
      projectId: record.id,
      token: lease.token,
      jobId: lease.jobId,
      username: record.folder.username,
      account: record.folder.account,
    };
    const encoded = Buffer.from(JSON.stringify(allocation)).toString('base64');
    const run = ['srun', `--jobid=${lease.jobId}`, '--overlap', '--nodes=1', '--ntasks=1'];
    const inspectCompute = await frozenComputeHelper(resolve(options.sourceRepo), options.revision);
    const compute = z
      .object({
        arch: z.enum(['x64', 'arm64']),
        scratchRoot: z.string().startsWith('/').max(2000),
        availableBytes: z
          .number()
          .finite()
          .min(4 * 1024 ** 3),
      })
      .strict()
      .parse(
        JSON.parse(await native([...run, 'python3', '-c', quote(inspectCompute), encoded], null)),
      );
    const { arch } = compute;
    if (
      /[\r\n\0]/.test(compute.scratchRoot) ||
      !compute.scratchRoot.endsWith(`-${lease.jobId}-${lease.token}`)
    )
      throw new Error('Native scratch allocation identity changed.');
    const sharedKey = `${record.folder.alias}:${options.revision}:${arch}:${lease.jobId}:${lease.token}`;
    const shared = installations.get(sharedKey);
    if (shared) return shared;
    const install = (async () => {
      const cache = join(resolve(options.cacheDir), `${options.revision}-${arch}`);
      await mkdir(cache, { recursive: true, mode: 0o700 });
      await packageLocal(
        join(resolve(options.sourceRepo), 'scripts/cluster/deploy-runtime.mjs'),
        resolve(options.sourceRepo),
        options.revision,
        cache,
        arch,
      );
      const manifest = JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8')) as {
        revision: string;
        arch: string;
        assets: Record<string, string>;
      };
      if (manifest.revision !== options.revision || manifest.arch !== arch)
        throw new Error('Cluster bundle provenance changed.');
      const files: Record<string, { sha256: string; data: string }> = {};
      for (const name of assets) {
        const bytes =
          name === 'manifest.json'
            ? Buffer.from(JSON.stringify({ ...manifest, allocation, compute }))
            : await readFile(join(cache, name));
        if (name in manifest.assets && digest(bytes) !== manifest.assets[name])
          throw new Error('Cluster bundle asset changed.');
        files[name] = { sha256: digest(bytes), data: bytes.toString('base64') };
      }
      const stageId = randomUUID();
      const { stage } = z
        .object({ stage: z.string().startsWith('/').max(2000) })
        .strict()
        .parse(
          JSON.parse(
            await native(
              ['python3', '-c', quote(receiveBundle), stageId],
              JSON.stringify({ files }),
              180_000,
            ),
          ),
        );
      if (
        !stage.endsWith(`/.sciencewithagents/runtime-staging/${stageId}`) ||
        /[\r\n\0]/.test(stage)
      )
        throw new Error('Remote staging identity changed.');
      const result = resultSchema.parse(
        JSON.parse(
          await native([...run, 'bash', quote(join(stage, 'install-runtime.sh'))], null, 900_000),
        ),
      );
      if (
        result.bundlePath !== join(compute.scratchRoot, `runtime-${options.revision}`) ||
        result.nodePath !== join(result.bundlePath, '.toolchain/node/bin/node')
      )
        throw new Error('Remote runtime provenance changed.');
      await native(['python3', '-c', quote(cleanupStage), stageId], null);
      return result;
    })().finally(() => installations.delete(sharedKey));
    installations.set(sharedKey, install);
    return install;
  }
  return (record, lease) => {
    const key = `${record.id}:${lease.token}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = prepare(record, lease).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
