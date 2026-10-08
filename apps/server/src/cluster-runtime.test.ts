import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeCoordinator } from './cluster-runtime.js';
const exec = promisify(execFile);
let root: string, bin: string, projectId: string, token: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-startup-retry-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
  projectId = randomUUID();
  token = randomUUID();
  writeFileSync(
    join(bin, 'scontrol'),
    `#!/usr/bin/env python3
import os
print('JobId=41234 Comment=swa-development:${projectId}:${token} UserId=owner('+str(os.getuid())+') Account=owner_lab JobState=RUNNING')
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'srun'),
    `#!/usr/bin/env python3
import sys,os,subprocess
args=sys.argv[1:]
if 'python3' in args:
 os.environ['SLURM_JOB_ID']='41234'
 sys.exit(subprocess.run(args[args.index('python3'):]).returncode)
raise RuntimeError('A second runtime must not start')
`,
    { mode: 0o700 },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it.each(['visible', 'delayed parents', 'slow initial probe'])(
  'reaches compute through the exact fixed-shell argv with %s',
  async (kind) => {
    const data = join(root, '.sciencewithagents', 'cluster-projects', projectId);
    const script = join(root, 'compute bootstrap.mjs');
    const payload = {
      record: {
        id: projectId,
        folder: { username: 'owner', account: 'owner_lab' },
        brief: 'literal $(touch unintended) with "quotes"',
      },
      lease: { jobId: '41234', token, node: hostname().split('.')[0] },
      bundle: {
        nodePath: '/compute only/$(touch unintended)/node',
        bundlePath: '/compute source with spaces',
        codexPath: null,
        claudePath: null,
      },
      clusterSettings: {},
      pollAttempts: 8,
    };
    writeFileSync(
      script,
      `import {writeFileSync} from 'node:fs';
const p=JSON.parse(Buffer.from(process.argv[2],'base64').toString());
writeFileSync(${JSON.stringify(join(data, 'received.json'))},JSON.stringify(p),{mode:0o600});
writeFileSync(${JSON.stringify(join(data, 'runtime-handshake.json'))},JSON.stringify({version:1,hostId:'${randomUUID()}',projectId:'${randomUUID()}',managerId:'${randomUUID()}',port:41235,credential:'a'.repeat(64),attemptId:p.attemptId,jobId:p.jobId,leaseToken:p.leaseToken}),{mode:0o600});
`,
      { mode: 0o600 },
    );
    const delayedReadiness =
      kind === 'delayed parents'
        ? `import os,json
original_lstat=os.lstat
counter_path=${JSON.stringify(join(root, 'parent-probes.json'))}
expected_parent=os.path.join(os.path.realpath(os.environ['HOME']),'.sciencewithagents')
def delayed_parent(path,*args,**kwargs):
 if str(path)==expected_parent:
  try: count=json.load(open(counter_path))
  except FileNotFoundError: count=0
  count+=1
  with open(counter_path,'w') as f:json.dump(count,f)
  if count<=2:raise FileNotFoundError('compute parent visibility delayed')
 return original_lstat(path,*args,**kwargs)
os.lstat=delayed_parent
`
        : '';
    const slowProbe =
      kind === 'slow initial probe'
        ? `import subprocess,time,json
original_clock=time.monotonic
original_output=subprocess.check_output
shift=[0];timeouts=[]
time.monotonic=lambda:original_clock()+shift[0]
def slow_probe(*args,**kwargs):
 timeouts.append(kwargs['timeout'])
 with open(${JSON.stringify(join(root, 'probe-timeouts.json'))},'w') as f:json.dump(timeouts,f)
 result=original_output(*args,**kwargs)
 if len(timeouts)==1:shift[0]=40
 return result
subprocess.check_output=slow_probe
`
        : '';
    writeFileSync(
      join(bin, 'srun'),
      `#!/usr/bin/env python3
import sys,os,json,subprocess
args=sys.argv[1:]
if 'python3' in args:
 os.environ['SLURM_JOB_ID']='41234'
 command=args[args.index('python3'):]
 command[2]=${JSON.stringify(delayedReadiness)}+command[2]
 sys.exit(subprocess.run(command).returncode)
with open(${JSON.stringify(join(root, 'srun-argv.json'))},'w') as f:json.dump(args,f)
with open(${JSON.stringify(join(root, 'bootstrap-count'))},'a') as f:f.write('started\\n')
# Emulate native srun's login-side executable check, then the node-local filesystem.
command=args[4:]
if not os.path.isfile(command[0]):sys.exit(1)
if command[0]!='/bin/sh' or command[4]!=${JSON.stringify(payload.bundle.nodePath)}:sys.exit(2)
command[4]=${JSON.stringify(process.execPath)}
command[5]=${JSON.stringify(script)}
sys.exit(subprocess.run(command).returncode)
`,
      { mode: 0o700 },
    );
    const result = await exec(
      'python3',
      [
        '-c',
        slowProbe + runtimeCoordinator,
        Buffer.from(JSON.stringify(payload)).toString('base64'),
      ],
      {
        env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH },
        timeout: 6000,
      },
    );
    const args = JSON.parse(readFileSync(join(root, 'srun-argv.json'), 'utf8')) as string[];
    expect(args.slice(0, 4)).toEqual(['--jobid=41234', '--overlap', '--nodes=1', '--ntasks=1']);
    expect(args.slice(4, 10)).toEqual([
      '/bin/sh',
      '-c',
      'exec "$@"',
      'swa-compute-runtime',
      payload.bundle.nodePath,
      join(payload.bundle.bundlePath, 'scripts/cluster/development-runtime.mjs'),
    ]);
    const received = JSON.parse(readFileSync(join(data, 'received.json'), 'utf8'));
    expect(received.record).toEqual(payload.record);
    expect(received.clusterSettings).toEqual(payload.clusterSettings);
    expect(JSON.parse(result.stdout).attemptId).toBe(received.attemptId);
    expect(existsSync(join(root, 'unintended'))).toBe(false);
    expect(readFileSync(join(root, 'bootstrap-count'), 'utf8').trim().split('\n')).toHaveLength(1);
    if (kind === 'delayed parents')
      expect(
        JSON.parse(readFileSync(join(root, 'parent-probes.json'), 'utf8')),
      ).toBeGreaterThanOrEqual(3);
    if (kind === 'slow initial probe') {
      const timeouts = JSON.parse(
        readFileSync(join(root, 'probe-timeouts.json'), 'utf8'),
      ) as number[];
      expect(timeouts).toHaveLength(2);
      expect(timeouts[0]).toBeLessThanOrEqual(65);
      expect(timeouts[1]).toBeLessThan(25);
      expect(timeouts[1]).toBeGreaterThan(20);
    }
  },
);

it('retains remote locks and history after local startup-client exit without replaying srun', async () => {
  writeFileSync(
    join(bin, 'scontrol'),
    '#!/usr/bin/env python3\nimport os\nprint("JobId=41234 Comment=swa-development:' +
      projectId +
      ':' +
      token +
      ' UserId=owner("+str(os.getuid())+") Account=owner_lab JobState=RUNNING")\n',
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, 'srun'),
    `#!/usr/bin/env python3
import sys,os,json,base64,subprocess
args=sys.argv[1:]
if 'python3' in args:
 os.environ['SLURM_JOB_ID']='41234'
 sys.exit(subprocess.run(args[args.index('python3'):]).returncode)
p=json.loads(base64.b64decode(sys.argv[-1])); root=os.path.join(os.environ['HOME'],'.sciencewithagents','cluster-projects',p['record']['id']); flag=os.path.join(root,'attempted')
open(os.path.join(root,'srun-attempts'),'a').write(p['attemptId']+'\\n')
if not os.path.exists(flag):
 open(flag,'w').write('1'); os.chmod(flag,0o600)
 with open(os.path.join(root,'runtime-bootstrap.json'),'w') as f: json.dump(dict(projectId=p['record']['id'],jobId=p['jobId'],leaseToken=p['leaseToken'],attemptId=p['attemptId'],mainPid=42),f)
 os.chmod(os.path.join(root,'runtime-bootstrap.json'),0o600)
 open(os.path.join(root,'server.lock'),'w').write('42')
 open(os.path.join(root,'native-history.jsonl'),'w').write('persistent history')
 sys.exit(1)
with open(os.path.join(root,'runtime-handshake.json'),'w') as f: json.dump(dict(version=1,hostId='${randomUUID()}',projectId='${randomUUID()}',managerId='${randomUUID()}',port=41235,credential='a'*64,jobId=p['jobId'],leaseToken=p['leaseToken'],attemptId=p['attemptId']),f)
os.chmod(os.path.join(root,'runtime-handshake.json'),0o600)
`,
    { mode: 0o700 },
  );
  const payload = {
    record: { id: projectId, folder: { username: 'owner', account: 'owner_lab' } },
    lease: { jobId: '41234', token, node: hostname().split('.')[0] },
    bundle: {
      nodePath: '/fixture/node',
      bundlePath: '/fixture/source',
      codexPath: null,
      claudePath: null,
    },
    clusterSettings: {},
    pollAttempts: 8,
  };
  const run = () =>
    exec(
      'python3',
      ['-c', runtimeCoordinator, Buffer.from(JSON.stringify(payload)).toString('base64')],
      { env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH }, timeout: 6000 },
    );
  await expect(run()).rejects.toThrow('Command failed');
  const data = join(root, '.sciencewithagents', 'cluster-projects', projectId);
  expect(existsSync(join(data, 'runtime-start-' + token, 'exit.json'))).toBe(true);
  const retries = await Promise.allSettled([run(), run()]);
  expect(retries.every((value) => value.status === 'rejected')).toBe(true);
  expect(readFileSync(join(data, 'srun-attempts'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(join(data, 'native-history.jsonl'), 'utf8')).toBe('persistent history');
  expect(readFileSync(join(data, 'server.lock'), 'utf8')).toBe('42');
  expect(existsSync(join(data, 'runtime-bootstrap.json'))).toBe(true);
  expect(existsSync(join(data, 'runtime-start-' + token, 'intent.json'))).toBe(true);
});

it.each(['shared', 'linked'])(
  'refuses a %s durable runtime parent before native control',
  async (kind) => {
    const parent = join(root, '.sciencewithagents');
    if (kind === 'shared') {
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o755);
    } else {
      const target = join(root, 'unrelated');
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, parent);
    }
    const payload = {
      record: { id: projectId, folder: { username: 'owner', account: 'owner_lab' } },
      lease: { jobId: '41234', token, node: hostname().split('.')[0] },
      bundle: {},
      pollAttempts: 1,
    };
    await expect(
      exec(
        'python3',
        ['-c', runtimeCoordinator, Buffer.from(JSON.stringify(payload)).toString('base64')],
        { env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH }, timeout: 3000 },
      ),
    ).rejects.toThrow('Private runtime parent changed');
    expect(existsSync(join(parent, 'cluster-projects'))).toBe(false);
  },
);
it('retains an uncertain startup intent and never starts a second srun', async () => {
  const data = join(root, '.sciencewithagents', 'cluster-projects', projectId),
    lock = join(data, 'runtime-start-' + token);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lock, 'intent.json'),
    JSON.stringify({ attemptId: randomUUID(), jobId: '41234', leaseToken: token }),
    { mode: 0o600 },
  );
  writeFileSync(join(bin, 'srun'), readFileSync(join(bin, 'srun'), 'utf8'), { mode: 0o700 });
  const payload = {
    record: { id: projectId, folder: { username: 'owner', account: 'owner_lab' } },
    lease: { jobId: '41234', token, node: hostname().split('.')[0] },
    bundle: {},
    pollAttempts: 1,
  };
  await expect(
    exec(
      'python3',
      ['-c', runtimeCoordinator, Buffer.from(JSON.stringify(payload)).toString('base64')],
      { env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH }, timeout: 3000 },
    ),
  ).rejects.toThrow('Command failed');
  expect(existsSync(join(lock, 'intent.json'))).toBe(true);
  expect(existsSync(join(lock, 'exit.json'))).toBe(false);
});

it('refuses a mismatched saved handshake before deleting any startup or data-lock proof', async () => {
  const data = join(root, '.sciencewithagents', 'cluster-projects', projectId),
    lock = join(data, 'runtime-start-' + token);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  const proof = { attemptId: randomUUID(), jobId: '41234', leaseToken: token };
  for (const [name, value] of [
    ['intent.json', proof],
    ['exit.json', { ...proof, code: 1 }],
  ] as const)
    writeFileSync(join(lock, name), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(
    join(data, 'runtime-bootstrap.json'),
    JSON.stringify({ ...proof, projectId, mainPid: 42 }),
    { mode: 0o600 },
  );
  writeFileSync(join(data, 'server.lock'), '42', { mode: 0o600 });
  writeFileSync(
    join(data, 'runtime-handshake.json'),
    JSON.stringify({ ...proof, attemptId: randomUUID() }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(bin, 'scontrol'),
    '#!/usr/bin/env python3\nimport os\nprint("JobId=41234 Comment=swa-development:' +
      projectId +
      ':' +
      token +
      ' UserId=owner("+str(os.getuid())+") Account=owner_lab JobState=RUNNING")\n',
    { mode: 0o700 },
  );
  const payload = {
    record: { id: projectId, folder: { username: 'owner', account: 'owner_lab' } },
    lease: { jobId: '41234', token, node: hostname().split('.')[0] },
    bundle: {},
    pollAttempts: 1,
  };
  await expect(
    exec(
      'python3',
      ['-c', runtimeCoordinator, Buffer.from(JSON.stringify(payload)).toString('base64')],
      { env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH }, timeout: 3000 },
    ),
  ).rejects.toThrow('another startup attempt');
  expect(readFileSync(join(data, 'server.lock'), 'utf8')).toBe('42');
  expect(existsSync(join(data, 'runtime-bootstrap.json'))).toBe(true);
  expect(existsSync(join(lock, 'exit.json'))).toBe(true);
});

it.each(['matching', 'attempt', 'project', 'account', 'node'])(
  'uses compute readiness while login visibility is stale, with %s identity',
  async (kind) => {
    const data = join(root, '.sciencewithagents', 'cluster-projects', projectId);
    const lock = join(data, 'runtime-start-' + token);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const attemptId = randomUUID();
    const handshake = {
      version: 1,
      hostId: randomUUID(),
      projectId: randomUUID(),
      managerId: randomUUID(),
      port: 41235,
      credential: 'a'.repeat(64),
      attemptId,
      jobId: '41234',
      leaseToken: token,
    };
    writeFileSync(
      join(lock, 'intent.json'),
      JSON.stringify({ attemptId, jobId: '41234', leaseToken: token }),
      { mode: 0o600 },
    );
    writeFileSync(join(data, 'native-history.jsonl'), 'retained native thread and history', {
      mode: 0o600,
    });
    const payload = {
      record: {
        id: projectId,
        folder: { username: 'owner', account: kind === 'account' ? 'another_lab' : 'owner_lab' },
        remoteProjectId: kind === 'project' ? randomUUID() : handshake.projectId,
      },
      lease: {
        jobId: '41234',
        token,
        node: kind === 'node' ? 'another-node' : hostname().split('.')[0],
      },
      bundle: {},
      clusterSettings: {},
      pollAttempts: 1,
    };
    writeFileSync(
      join(data, 'runtime-handshake.json'),
      JSON.stringify({ ...handshake, attemptId: kind === 'attempt' ? randomUUID() : attemptId }),
      { mode: 0o600 },
    );
    // The login process sees a cached negative. The srun child sees the real compute file.
    const staleLogin = `import os
original_lstat=os.lstat
def login_lstat(path,*args,**kwargs):
 if str(path).endswith('/runtime-handshake.json'): raise FileNotFoundError('cached login negative')
 return original_lstat(path,*args,**kwargs)
os.lstat=login_lstat
try: os.lstat(${JSON.stringify(join(data, 'runtime-handshake.json'))}); raise AssertionError('Fixture must hide login handshake')
except FileNotFoundError: pass
`;
    const operation = exec(
      'python3',
      [
        '-c',
        staleLogin + runtimeCoordinator,
        Buffer.from(JSON.stringify(payload)).toString('base64'),
      ],
      {
        env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH },
        timeout: 6000,
      },
    );
    if (kind === 'matching') expect(JSON.parse((await operation).stdout)).toEqual(handshake);
    else
      await expect(operation).rejects.toThrow(
        kind === 'attempt'
          ? 'another startup attempt'
          : kind === 'project'
            ? 'history identity changed'
            : kind === 'account'
              ? 'allocation identity changed'
              : 'Wrong readiness allocation or node',
      );
    expect(readFileSync(join(data, 'native-history.jsonl'), 'utf8')).toBe(
      'retained native thread and history',
    );
    expect(JSON.parse(readFileSync(join(lock, 'intent.json'), 'utf8')).attemptId).toBe(attemptId);
    expect(existsSync(join(lock, 'exit.json'))).toBe(false);
    expect(existsSync(join(data, 'runtime-private.log'))).toBe(false); // No bootstrap supervisor.
  },
);
