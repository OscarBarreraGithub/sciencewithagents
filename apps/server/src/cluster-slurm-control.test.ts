import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyIdleStepProcesses } from './cluster-runtime-idle.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swa-slurm-control-'));
  roots.push(root);
  const job = '/system.slice/slurmstepd.scope/job_51307563';
  mkdirSync(join(root, 'self'));
  writeFileSync(join(root, 'self/cgroup'), `0::${job}/step_4/user/task_0\n`);
  const context = {
    identity: {
      controllerHostId: randomUUID(),
      remoteHostId: randomUUID(),
      clusterProjectId: randomUUID(),
      remoteProjectId: randomUUID(),
      jobId: '51307563',
      leaseToken: randomUUID(),
    },
    username: 'owner',
    port: 4330,
    providerPids: new Set<number>(),
  };
  const process = (
    pid: number,
    step: string,
    options: { argv?: string[]; group?: string; uids?: string; name?: string } = {},
  ) => {
    const path = join(root, String(pid));
    mkdirSync(path);
    writeFileSync(join(path, 'cgroup'), `0::${options.group ?? `${job}/step_${step}/slurm`}\n`);
    writeFileSync(
      join(path, 'cmdline'),
      (
        options.argv ?? [`slurmstepd: [51307563.${step}${step === 'extern' ? ' stepmgr' : ''}]`]
      ).join('\0') + '\0',
    );
    writeFileSync(join(path, 'stat'), `${pid} (slurmstepd) S 1`);
    writeFileSync(
      join(path, 'status'),
      `Name:\t${options.name ?? 'slurmstepd'}\nUid:\t${options.uids ?? '0\t0\t0\t0'}\n`,
    );
    return path;
  };
  return { root, job, process, verify: () => verifyIdleStepProcesses(new Set(), root, context) };
}

it('accepts only exact native root Slurm control processes from the owned-job metadata fixture', () => {
  const f = fixture();
  // The real job's extern manager was the first process rejected before any user/provider work.
  f.process(1833384, 'extern');
  f.process(1833396, 'batch');
  f.process(1835115, '4');
  f.process(1836993, '6');
  expect(f.verify).not.toThrow();
});

it.each([
  ['owner UID', { uids: '65266\t65266\t65266\t65266' }],
  ['mixed root UID', { uids: '65266\t0\t0\t0' }],
  ['unknown root process', { argv: ['bash', 'work.sh'] }],
  ['wrong native name', { name: 'worker' }],
  ['wrong job', { argv: ['slurmstepd: [51307564.4]'] }],
  ['wrong step', { argv: ['slurmstepd: [51307563.6]'] }],
  ['extra argument', { argv: ['slurmstepd: [51307563.4]', 'work'] }],
  ['unknown step suffix', { argv: ['slurmstepd: [51307563.4 worker]'] }],
  ['user task cgroup', { group: '/system.slice/slurmstepd.scope/job_51307563/step_4/user/task_0' }],
  [
    'control descendant',
    { group: '/system.slice/slurmstepd.scope/job_51307563/step_4/slurm/work' },
  ],
] as const)('retains the allocation for %s', (_reason, options) => {
  const f = fixture();
  f.process(1833384, '4', options);
  expect(f.verify).toThrow(/background/);
});

it('retains unknown work beside an exact manager and refuses missing control identity', () => {
  const f = fixture();
  f.process(1833384, 'extern');
  const tool = f.process(1833396, '4', {
    argv: ['python3', 'work.py'],
    group: `${f.job}/step_4/user/task_0`,
    uids: '65266\t65266\t65266\t65266',
  });
  expect(f.verify).toThrow(/background/);
  rmSync(tool, { recursive: true });
  unlinkSync(join(f.root, '1833384/status'));
  expect(f.verify).toThrow(/identity is unavailable/);
});
