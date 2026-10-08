import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  existsSync,
  lstatSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import {
  installer,
  preserveFailedBuild,
  packageSource,
  verifyAllocation,
  reclaimableLock,
  writeBuildProvenance,
  sha256,
  computeCompilerEnvironment,
} from './deploy-runtime.mjs';

const projectId = 'dc4968b1-e377-402d-99af-9f4f745ef705';
const input = {
  projectId,
  token: '14d6b5ed-190e-4a91-ad05-9f7c8518f4de',
  jobId: '1234',
  username: 'owner',
  account: 'lab',
};
const job = {
  JobId: input.jobId,
  Comment: `swa-development:${projectId}:${input.token}`,
  JobName: 'swa-dev-dc4968b1',
  UserId: 'owner(42)',
  Account: 'lab',
  JobState: 'RUNNING',
};

test('allocation guard accepts only the exact compute lease, including account and UID', () => {
  verifyAllocation(input, job, 42, '1234');
  for (const change of [
    { Account: 'other' },
    { UserId: 'owner(43)' },
    { Comment: 'unrelated' },
    { JobName: 'other' },
    { JobState: 'PENDING' },
    { JobId: '9999' },
  ])
    assert.throws(
      () => verifyAllocation(input, { ...job, ...change }, 42, '1234'),
      /exact running/,
    );
  assert.throws(() => verifyAllocation(input, job, 42, undefined), /exact running/);
});

test('an interrupted lock is reclaimed only after its owned allocation is proven ended or absent', () => {
  const revision = '1'.repeat(40),
    marker = { revision, arch: 'x64', allocation: input };
  const allowed = (observation, change = {}) =>
    reclaimableLock({ ...marker, ...change }, observation, 42, revision, 'x64', 'owner');
  assert.equal(allowed({ job }), false);
  assert.equal(allowed({}), false);
  assert.equal(allowed({ job: { ...job, JobState: 'COMPLETING' } }), false);
  assert.equal(allowed({ job: { ...job, JobState: 'COMPLETED' } }), true);
  assert.equal(allowed({ job: { ...job, JobState: 'COMPLETED', Comment: 'unrelated' } }), false);
  assert.equal(allowed({ job: { ...job, JobState: 'COMPLETED', UserId: 'owner(43)' } }), false);
  assert.equal(allowed({ absent: true }), true);
  assert.equal(allowed({ absent: true }, { revision: '2'.repeat(40) }), false);
});

test('archive builds retain the exact source revision across all three artifact trees without Git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-provenance-'));
  try {
    const manifest = { revision: '1'.repeat(40), sourceSha256: '2'.repeat(64), arch: 'x64' };
    for (const path of ['packages/shared/dist', 'apps/server/dist', 'apps/web/dist'])
      mkdirSync(join(root, path), { recursive: true });
    const hashes = writeBuildProvenance(root, manifest);
    for (const path of Object.keys(hashes)) {
      const bytes = readFileSync(join(root, path));
      assert.equal(JSON.parse(bytes).sourceRevision, manifest.revision);
      assert.equal(hashes[path], sha256(bytes));
    }
    assert.equal(Object.keys(hashes).length, 3);
    assert.equal(existsSync(join(root, '.git')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function repository(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'swa-bundle-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.17.1' }));
    writeFileSync(join(dir, 'source.txt'), 'tracked source');
    const commit = () => {
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'fixture',
        ],
        { cwd: dir },
      );
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    };
    fn(dir, commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bundle is pinned to tracked revision; untracked private files are excluded', () =>
  repository((dir, commit) => {
    const revision = commit();
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'private.txt'), 'fixture private sentinel');
    writeFileSync(join(dir, 'source.txt'), 'uncommitted replacement');
    const output = join(dir, 'data', 'bundle');
    const manifest = packageSource(dir, revision, output, false);
    assert.equal(manifest.files['source.txt'], sha256('tracked source'));
    assert.deepEqual(Object.keys(manifest.files), ['package.json', 'source.txt']);
    const listing = execFileSync('tar', ['-tf', join(output, 'source.tar')], { encoding: 'utf8' });
    assert(!listing.includes('private.txt'));
    assert(
      !readFileSync(join(output, 'source.tar')).includes(Buffer.from('uncommitted replacement')),
    );
    assert.equal(manifest.sourceSha256, sha256(readFileSync(join(output, 'source.tar'))));
  }));

test('tracked private runtime material and source symlinks are refused', () => {
  for (const name of ['data/private.txt', '.env', 'credentials.json'])
    repository((dir, commit) => {
      if (name.includes('/')) mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, name), 'fixture');
      assert.throws(
        () => packageSource(dir, commit(), join(dir, 'output'), false),
        /runtime or credential/,
      );
    });
  repository((dir, commit) => {
    symlinkSync('source.txt', join(dir, 'linked'));
    assert.throws(() => packageSource(dir, commit(), join(dir, 'output'), false), /symlinks/);
  });
});

test('missing bootstrap or incompatible package manager never produces a deployable bundle', () =>
  repository((dir, commit) => {
    assert.throws(() => packageSource(dir, commit(), join(dir, 'output')), /both runtime/);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0' }));
    assert.throws(
      () => packageSource(dir, commit(), join(dir, 'output'), false),
      /different package/,
    );
  }));

test('shell bootstrap refuses a login context before extraction or dependency installation', () => {
  const stage = mkdtempSync(join(tmpdir(), 'swa-install-'));
  try {
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ allocation: input }));
    writeFileSync(join(stage, 'install-runtime.sh'), installer);
    const env = { ...process.env };
    delete env.SLURM_JOB_ID;
    const result = spawnSync('/bin/sh', [join(stage, 'install-runtime.sh')], {
      env,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Compute allocation required/);
    assert.equal(existsSync(join(stage, 'bootstrap-node')), false);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('failed compute build preserves its owned package tree and private diagnostic receipt', () => {
  const working = mkdtempSync(join(tmpdir(), '.install-failure-'));
  try {
    mkdirSync(join(working, 'node_modules'));
    writeFileSync(join(working, 'node_modules/fixture'), 'partial regenerable files');
    writeFileSync(join(working, 'runtime-build.log'), 'timed out after package extraction', {
      mode: 0o600,
    });
    const manifest = { revision: 'a'.repeat(40), arch: 'x64', allocation: input };
    preserveFailedBuild(working, manifest, new Error('Build deadline reached'));
    assert.equal(
      readFileSync(join(working, 'node_modules/fixture'), 'utf8'),
      'partial regenerable files',
    );
    assert.equal(
      readFileSync(join(working, 'runtime-build.log'), 'utf8'),
      'timed out after package extraction',
    );
    const receipt = JSON.parse(readFileSync(join(working, 'runtime-failed.json'), 'utf8'));
    assert.equal(receipt.revision, manifest.revision);
    assert.deepEqual(receipt.allocation, input);
    assert.equal(receipt.message, 'Build deadline reached');
  } finally {
    rmSync(working, { recursive: true, force: true });
  }
});
test('compute command progress is visible privately before the child exits', async () => {
  const working = mkdtempSync(join(tmpdir(), '.install-progress-')),
    log = join(working, 'runtime-build.log');
  const module = pathToFileURL(new URL('./deploy-runtime.mjs', import.meta.url).pathname).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {runComputeBuildCommand} from ${JSON.stringify(module)}; runComputeBuildCommand(process.execPath,['-e',"console.log('package-progress');setTimeout(()=>console.log('finished'),500)"],${JSON.stringify(working)},process.env,${JSON.stringify(log)},Date.now()+5000);`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  try {
    const deadline = Date.now() + 4000;
    while (
      (!existsSync(log) || !readFileSync(log, 'utf8').includes('package-progress')) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const progress = readFileSync(log, 'utf8');
    assert.match(progress, /command started/);
    assert.match(progress, /package-progress/);
    assert.doesNotMatch(progress, /finished/);
    assert.equal(child.exitCode, null);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.match(readFileSync(log, 'utf8'), /command ended/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    rmSync(working, { recursive: true, force: true });
  }
});

test('runtime archive creation leaves its input directory unchanged on a fresh build', async () => {
  const { publishRuntimeArtifact } = await import('./deploy-runtime.mjs');
  const root = mkdtempSync(join(tmpdir(), 'swa-artifact-output-'));
  try {
    const working = join(root, 'build'),
      target = join(root, 'published');
    mkdirSync(join(working, '.toolchain/node/bin'), { recursive: true, mode: 0o700 });
    writeFileSync(join(working, '.toolchain/node/bin/node'), 'fixture-node');
    writeFileSync(join(working, 'payload'), 'frozen-runtime');
    const manifest = {
      revision: '1'.repeat(40),
      arch: 'x64',
      sourceSha256: '2'.repeat(64),
      files: { payload: sha256('frozen-runtime') },
    };
    const receipt = { ...manifest, nodeSha256: sha256('fixture-node'), buildFiles: {} };
    writeFileSync(join(working, 'runtime-ready.json'), JSON.stringify(receipt));
    const before = lstatSync(working, { bigint: true }).mtimeNs;
    let temporary;
    publishRuntimeArtifact(working, target, manifest, (archive) => {
      temporary = join(archive, '..');
      assert.equal(
        lstatSync(working, { bigint: true }).mtimeNs,
        before,
        'creating an archive must not mutate the directory GNU tar is scanning',
      );
      const members = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
      assert.match(members, /\.\/payload/);
      assert.doesNotMatch(members, /runtime-artifact/);
    });
    assert.equal(existsSync(temporary), false);
    assert.equal(existsSync(join(target, 'runtime.tar.gz')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent runtime archive materializes in a new job without reinstalling dependencies', async () => {
  const { publishRuntimeArtifact, materializeRuntimeArtifact, verifyPrivateRuntimeArchive } =
    await import('./deploy-runtime.mjs');
  const root = mkdtempSync(join(tmpdir(), 'swa-artifact-'));
  try {
    const working = join(root, 'build'),
      persistent = join(root, 'persistent'),
      nextJob = join(root, 'second-job');
    mkdirSync(working, { mode: 0o700 });
    mkdirSync(nextJob, { mode: 0o700 });
    for (const dir of [
      'packages/shared/dist',
      'apps/server/dist',
      'apps/web/dist',
      '.toolchain/node/bin',
      'node_modules/.pnpm/fixture/node_modules/fixture',
      '.toolchain/store',
    ])
      mkdirSync(join(working, dir), { recursive: true });
    writeFileSync(join(working, 'source.txt'), 'frozen');
    writeFileSync(join(working, '.toolchain/node/bin/node'), 'native-binary-fixture');
    writeFileSync(
      join(working, 'node_modules/.pnpm/fixture/node_modules/fixture/index.js'),
      'dependency',
    );
    symlinkSync('.pnpm/fixture/node_modules/fixture', join(working, 'node_modules/fixture'));
    writeFileSync(join(working, '.toolchain/store/unused'), 'regenerable-store');
    const manifest = {
      revision: '1'.repeat(40),
      arch: 'x64',
      sourceSha256: '2'.repeat(64),
      files: { 'source.txt': sha256('frozen') },
    };
    const receipt = {
      revision: manifest.revision,
      arch: manifest.arch,
      sourceSha256: manifest.sourceSha256,
      nodeSha256: sha256('native-binary-fixture'),
      buildFiles: writeBuildProvenance(working, manifest),
    };
    writeFileSync(join(working, 'runtime-ready.json'), JSON.stringify(receipt));
    const helper = new URL('./compute-scratch.py', import.meta.url).pathname;
    const verified = join(root, 'first-job-verified');
    const { runComputeBuildCommand } = await import('./deploy-runtime.mjs');
    assert.throws(
      () =>
        publishRuntimeArtifact(working, persistent, manifest, () =>
          runComputeBuildCommand(
            process.execPath,
            ['-e', 'process.exit(1)'],
            working,
            process.env,
            join(working, 'runtime-build.log'),
            Date.now() + 2000,
          ),
        ),
      (error) => error.uncertainWriter === true,
    );
    assert.equal(
      existsSync(persistent),
      false,
      'failed native validation must not publish readiness',
    );
    symlinkSync('../../../outside', join(working, 'node_modules/escape'));
    assert.throws(
      () =>
        publishRuntimeArtifact(working, persistent, manifest, (archive, receipt) =>
          verifyPrivateRuntimeArchive(
            archive,
            join(root, 'unsafe-local'),
            manifest,
            receipt,
            helper,
          ),
        ),
      /escapes/,
    );
    assert.equal(
      existsSync(persistent),
      false,
      'failed member validation must not publish readiness',
    );
    unlinkSync(join(working, 'node_modules/escape'));

    const sourceDirectoryTime = lstatSync(working, { bigint: true }).mtimeNs;
    let privateArchive;
    const published = publishRuntimeArtifact(working, persistent, manifest, (archive, receipt) => {
      privateArchive = archive;
      assert.equal(
        lstatSync(working, { bigint: true }).mtimeNs,
        sourceDirectoryTime,
        'archive output must not change the source directory while tar scans it',
      );
      assert.equal(archive.startsWith(working + '/'), false);
      assert.equal(lstatSync(join(archive, '..')).mode & 0o077, 0);
      return verifyPrivateRuntimeArchive(archive, verified, manifest, receipt, helper);
    });
    assert.equal(
      existsSync(privateArchive),
      false,
      'successful publication removes its own archive',
    );
    assert.equal(existsSync(join(privateArchive, '..')), false);
    assert.equal(published.version, 2);
    assert.deepEqual(
      execFileSync('ls', ['-A', persistent], { encoding: 'utf8' }).trim().split('\n').sort(),
      ['runtime-ready.json', 'runtime.tar.gz'],
    );
    const destination = join(nextJob, 'runtime');
    assert.equal(
      materializeRuntimeArtifact(persistent, destination, manifest, helper),
      destination,
    );
    assert.equal(
      readFileSync(join(destination, 'node_modules/fixture/index.js'), 'utf8'),
      'dependency',
    );
    assert.equal(existsSync(join(destination, '.toolchain/store')), false);
    writeFileSync(join(destination, '.toolchain/node/bin/node'), 'different-native-binary');
    assert.throws(
      () => materializeRuntimeArtifact(persistent, destination, manifest, helper),
      /Node integrity/,
    );
    writeFileSync(join(destination, '.toolchain/node/bin/node'), 'native-binary-fixture');
    writeFileSync(
      join(destination, 'apps/server/dist/source-provenance.json'),
      'different compiled source',
    );
    assert.throws(
      () => materializeRuntimeArtifact(persistent, destination, manifest, helper),
      /file integrity/,
    );
    writeFileSync(
      join(destination, 'apps/server/dist/source-provenance.json'),
      readFileSync(join(working, 'apps/server/dist/source-provenance.json')),
    );

    assert.equal(
      materializeRuntimeArtifact(persistent, destination, manifest, helper),
      destination,
    );
    assert.throws(
      () =>
        materializeRuntimeArtifact(
          persistent,
          join(nextJob, 'wrong-source'),
          { ...manifest, revision: '3'.repeat(40) },
          helper,
        ),
      /provenance/,
    );
    writeFileSync(join(persistent, 'runtime.tar.gz'), 'corrupted');
    assert.throws(
      () => materializeRuntimeArtifact(persistent, join(nextJob, 'corrupt'), manifest, helper),
      /checksum/,
    );
    assert.equal(existsSync(join(nextJob, 'corrupt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive links cannot write outside scratch and scratch rejects network mounts', () => {
  const helper = new URL('./compute-scratch.py', import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), 'swa-archive-guard-'));
  try {
    const script = `import runpy,sys,tarfile,io,os,json
h=runpy.run_path(sys.argv[1],run_name='test_helper'); root=os.path.realpath(sys.argv[2])
a={'jobId':'1234','token':'14d6b5ed-190e-4a91-ad05-9f7c8518f4de'}
device=os.stat(root).st_dev; device=str(os.major(device))+':'+str(os.minor(device))
mount='1 0 '+device+' / '+root+' rw - nfs server rw'
assert h['mount_type'](root,mount+chr(10)+'2 0 999:999 / '+root+' rw - xfs fixture rw')=='nfs'
try: h['mount_type'](root,mount+chr(10)+'3 0 '+device+' / '+root+' rw - xfs fixture rw'); raise AssertionError('ambiguous stack accepted')
except RuntimeError as e: assert 'ambiguous' in str(e)
try: h['prepare_scratch'](a,root,mount); raise AssertionError('network mount accepted')
except RuntimeError as e: assert 'node-local' in str(e)
local='1 0 '+device+' / '+root+' rw - ext4 /dev/fixture rw'
created=h['prepare_scratch'](a,root,local)
assert h['prepare_scratch'](a,root,local)['scratchRoot']==created['scratchRoot']
marker=os.path.join(created['scratchRoot'],'allocation.json')
with open(marker,'w') as f: json.dump({'jobId':'different'},f)
try: h['prepare_scratch'](a,root,local); raise AssertionError('changed marker accepted')
except RuntimeError as e: assert 'another allocation' in str(e)

for mode in ('escape','through-link','device'):
 archive=os.path.join(root,mode+'.tar'); destination=os.path.join(root,mode); os.mkdir(destination)
 with tarfile.open(archive,'w') as tar:
  m=tarfile.TarInfo('link'); m.type=tarfile.SYMTYPE; m.linkname='../outside' if mode=='escape' else 'internal'
  if mode=='device': m.type=tarfile.CHRTYPE
  tar.addfile(m)
  if mode=='through-link':
   m=tarfile.TarInfo('link/write'); m.size=1; tar.addfile(m,io.BytesIO(b'x'))
 try: h['extract_runtime_archive'](archive,destination); raise AssertionError('unsafe archive accepted')
 except RuntimeError: pass
 assert not os.listdir(destination)
assert not os.path.exists(os.path.join(root,'outside'))
print('safe')`;
    assert.match(
      execFileSync('python3', ['-c', script, helper, root], { encoding: 'utf8' }),
      /safe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive symlink resolution cannot escape through another internal link', () => {
  const helper = new URL('./compute-scratch.py', import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), 'swa-archive-chain-'));
  try {
    const script = `import runpy,sys,os,tarfile
h=runpy.run_path(sys.argv[1],run_name='test_helper'); root=sys.argv[2]
destination=os.path.join(root,'stage'); os.mkdir(destination)
archive=os.path.join(root,'runtime.tar')
with tarfile.open(archive,'w') as tar:
 for name,target in [('inside','.'),('escape','inside/../outside')]:
  member=tarfile.TarInfo(name); member.type=tarfile.SYMTYPE; member.linkname=target; tar.addfile(member)
try: h['extract_runtime_archive'](archive,destination); raise AssertionError('chained symlink escape accepted')
except RuntimeError as e: assert 'escapes' in str(e)
assert os.listdir(destination)==[], 'archive must be refused before writing any member'
print('safe')`;
    assert.match(
      execFileSync('python3', ['-c', script, helper, root], { encoding: 'utf8' }),
      /safe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected native TMPDIR precedes unsafe fixed scratch on the same local device', () => {
  const helper = new URL('./compute-scratch.py', import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), 'swa-native-tmpdir-'));
  try {
    const script = `import runpy,sys,os,stat,json
from types import SimpleNamespace
from unittest.mock import patch
h=runpy.run_path(sys.argv[1],run_name='test_helper'); root=os.path.realpath(sys.argv[2])
a={'jobId':'50932178','token':'14d6b5ed-190e-4a91-ad05-9f7c8518f4de'}
parents={os.path.join(root,'scratch'):(0o777,os.makedev(253,1),386),os.path.join(root,'tmp'):(0o1777,os.makedev(253,1),386),os.path.join(root,'var-tmp'):(0o1777,os.makedev(253,0),36),os.path.join(root,'slurm-tmp'):(0o700,os.makedev(253,1),386)}
for path in parents: os.mkdir(path)
native=os.path.join(root,'tmp'); slurm=os.path.join(root,'slurm-tmp'); scratch=os.path.join(root,'scratch')
real_stat=os.stat; real_realpath=os.path.realpath
def parent_stat(path,*args,**kwargs):
 if path in parents:
  mode,device,_=parents[path]
  return SimpleNamespace(st_mode=stat.S_IFDIR|mode,st_uid=0,st_dev=device)
 return real_stat(path,*args,**kwargs)
free_inodes=200000
def parent_free(path): return SimpleNamespace(f_bavail=parents[path][2]*1024**3//4096,f_frsize=4096,f_favail=free_inodes)
mounts=chr(10).join(str(i+1)+' 0 '+str(os.major(device))+':'+str(os.minor(device))+' / '+path+' rw - xfs /dev/fixture rw' for i,(path,(_,device,_)) in enumerate(parents.items()))
with patch.dict(os.environ,{'TMPDIR':native},clear=True),patch.object(os,'stat',parent_stat),patch.object(os,'statvfs',parent_free),patch.object(os.path,'realpath',lambda path:scratch if path=='/scratch' else real_realpath(path)):
 try: h['prepare_scratch'](a,scratch,mounts); raise AssertionError('unprotected site scratch accepted')
 except RuntimeError as e: assert 'not protected' in str(e)
 selected=h['native_scratch'](a,mounts)
 assert selected['scratchRoot'].startswith(native+'/sciencewithagents-')
 assert selected['availableBytes']==386*1024**3
 child=selected['scratchRoot']; marker=os.path.join(child,'allocation.json')
 assert stat.S_IMODE(os.lstat(child).st_mode)==0o700 and os.lstat(child).st_uid==os.getuid()
 assert stat.S_IMODE(os.lstat(marker).st_mode)==0o600
 with open(marker) as f: assert json.load(f)==dict(a,uid=os.getuid())
 assert h['native_scratch'](a,mounts)==selected
 os.environ['SLURM_TMPDIR']=slurm
 assert h['native_scratch'](a,mounts)['scratchRoot'].startswith(slurm+'/sciencewithagents-')
 del os.environ['SLURM_TMPDIR']
 free_inodes=149999
 try: h['native_scratch'](a,mounts); raise AssertionError('insufficient inodes accepted')
 except RuntimeError as e: assert 'inodes' in str(e)
 free_inodes=200000
 parents[native]=(0o1777,os.makedev(253,1),3)
 try: h['native_scratch'](a,mounts); raise AssertionError('insufficient space accepted')
 except RuntimeError as e: assert '4 GiB' in str(e)
 parents[native]=(0o777,os.makedev(253,1),386)
 try: h['native_scratch'](a,mounts); raise AssertionError('unprotected native TMPDIR accepted')
 except RuntimeError as e: assert 'not protected' in str(e)
 parents[native]=(0o1777,os.makedev(253,1),386)
 os.chmod(child,0o755)
 try: h['native_scratch'](a,mounts); raise AssertionError('changed private child accepted')
 except RuntimeError as e: assert 'directory changed' in str(e)
print('safe')`;
    assert.match(
      execFileSync('python3', ['-c', script, helper, root], { encoding: 'utf8' }),
      /safe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one frozen scratch helper serves native probe, bootstrap and artifact extraction', () => {
  repository((dir, commit) => {
    mkdirSync(join(dir, 'scripts/cluster'), { recursive: true });
    const helper = readFileSync(new URL('./compute-scratch.py', import.meta.url));
    writeFileSync(join(dir, 'scripts/cluster/compute-scratch.py'), helper);
    writeFileSync(join(dir, 'scripts/cluster/deploy-runtime.mjs'), 'fixture');
    writeFileSync(join(dir, 'scripts/cluster/development-runtime.mjs'), 'fixture');
    const revision = commit(),
      output = join(dir, 'output');
    const manifest = packageSource(dir, revision, output);
    const packed = execFileSync('tar', [
      '-xOf',
      join(output, 'source.tar'),
      'scripts/cluster/compute-scratch.py',
    ]);
    assert.equal(sha256(packed), manifest.files['scripts/cluster/compute-scratch.py']);
    assert.deepEqual(packed, helper);
    assert.match(installer, /source\.extractfile\('scripts\/cluster\/compute-scratch\.py'\)/);
    assert.match(installer, /scratch==m\['compute'\]\['scratchRoot'\]/);
    assert.doesNotMatch(installer, /mkdir "\$stage\/bootstrap-node"/);
  });
});

test('a failed build command conservatively retains unknown descendant-writer disposition', async () => {
  const { runComputeBuildCommand } = await import('./deploy-runtime.mjs');
  const root = mkdtempSync(join(tmpdir(), 'swa-build-writer-'));
  try {
    assert.throws(
      () =>
        runComputeBuildCommand(
          process.execPath,
          ['-e', 'process.exit(1)'],
          root,
          process.env,
          join(root, 'log'),
          Date.now() + 2000,
        ),
      (error) => error.uncertainWriter === true,
    );
    assert.equal(
      reclaimableLock(
        { revision: '1'.repeat(40), arch: 'x64', allocation: input },
        { job: { ...job, JobState: 'NODE_FAIL' } },
        42,
        '1'.repeat(40),
        'x64',
        'owner',
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable failure log retains only its bounded private tail', async () => {
  const { preserveBuildLogTail } = await import('./deploy-runtime.mjs');
  const root = mkdtempSync(join(tmpdir(), 'swa-build-tail-'));
  try {
    const log = join(root, 'build.log'),
      tail = join(root, 'failure.log');
    writeFileSync(log, 'x'.repeat(2 * 1024 * 1024) + 'last-progress');
    preserveBuildLogTail(log, tail);
    const result = readFileSync(tail);
    assert.equal(result.length, 1024 * 1024);
    assert.equal(result.subarray(-13).toString(), 'last-progress');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relocated runtime smoke exercises actual local PTY spawn and SQLite open', async () => {
  const { nativeRuntimeSmoke } = await import('./deploy-runtime.mjs');
  const cwd = new URL('../../apps/server', import.meta.url).pathname;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', nativeRuntimeSmoke], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a usable inherited C++20 compiler keeps its environment and adds portable C++ runtime linking', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compiler-'));
  const env = {
    PATH: '/owned/node/bin:/usr/bin',
    CXX: '/chosen/c++',
    LDFLAGS: '-Wl,--as-needed',
    HOME: '/native/home',
  };
  const original = { ...env };
  const calls = [];
  try {
    const selected = computeCompilerEnvironment(
      env,
      root,
      join(root, 'log'),
      Date.now() + 2000,
      (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    );
    assert.deepEqual(env, original, 'parent/native environment must not be mutated');
    assert.deepEqual(selected, { ...env, LDFLAGS: '-Wl,--as-needed -static-libstdc++' });
    assert.equal(calls.length, 2, 'a usable inherited compiler must not load modules');
    assert.equal(calls[0].command, env.CXX);
    assert.ok(calls[0].args.includes('-std=gnu++20'));
    assert.ok(calls[0].args.includes('-static-libstdc++'));
    assert.deepEqual(calls[1].options.env, env);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an old compiler falls back to site gcc only for the build and smokes with the original environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compiler-'));
  const env = { PATH: '/owned/node/bin:/usr/bin', HOME: '/native/home' };
  const loaded = {
    ...env,
    HOME: '/profile/home',
    PATH: '/site/gcc/bin:' + env.PATH,
    CC: '/site/gcc/bin/gcc',
    CXX: '/site/gcc/bin/g++',
    LD_LIBRARY_PATH: '/site/gcc/lib64',
  };
  const calls = [];
  try {
    const selected = computeCompilerEnvironment(
      env,
      root,
      join(root, 'log'),
      Date.now() + 2000,
      (command, args, options) => {
        calls.push({ command, args, options });
        if (command === 'g++') return { status: 1, stderr: 'unrecognized -std=gnu++20' };
        if (command === '/bin/bash')
          return {
            status: 0,
            stdout:
              Object.entries(loaded)
                .map(([key, value]) => `${key}=${value}`)
                .join('\0') + '\0',
          };
        return { status: 0 };
      },
    );
    assert.equal(selected.CXX, loaded.CXX);
    assert.equal(selected.HOME, env.HOME);
    assert.equal(selected.LDFLAGS, '-static-libstdc++');
    assert.equal(calls[1].args[0], '-lc');
    assert.match(calls[1].args[1], /module load gcc/);
    assert.equal(calls[2].command, loaded.CXX);
    assert.deepEqual(calls[2].options.env, { ...loaded, HOME: env.HOME });
    assert.deepEqual(
      calls[3].options.env,
      env,
      'module library paths must not mask runtime linkage failures',
    );
    assert.deepEqual(env, { PATH: '/owned/node/bin:/usr/bin', HOME: '/native/home' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler module whose artifact cannot run without module libraries fails before installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compiler-'));
  try {
    assert.throws(
      () =>
        computeCompilerEnvironment(
          { PATH: '/usr/bin' },
          root,
          join(root, 'log'),
          Date.now() + 2000,
          (command) => {
            if (command === '/bin/bash')
              return { status: 0, stdout: 'PATH=/site/bin\0CC=/site/gcc\0CXX=/site/g++\0' };
            if (command === '/site/g++') return { status: 0 };
            return { status: 1 };
          },
        ),
      /usable C\+\+20 compiler/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compiler probes retain the build deadline and uncertain writer disposition', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compiler-'));
  try {
    let called = false;
    assert.throws(
      () =>
        computeCompilerEnvironment({}, root, join(root, 'log'), Date.now() - 1, () => {
          called = true;
        }),
      /deadline/,
    );
    assert.equal(called, false);
    assert.throws(
      () =>
        computeCompilerEnvironment({}, root, join(root, 'log'), Date.now() + 2000, () => ({
          status: null,
          error: { code: 'ETIMEDOUT' },
        })),
      (error) => error.uncertainWriter === true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
