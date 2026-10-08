import { pythonPipe } from './cluster-transport.js';
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import type { Terminals } from './terminal.js';
import type { OwnerTerminals } from './owner-terminal.js';
import { ClusterRuntimeIdle, verifyIdleStepProcesses } from './cluster-runtime-idle.js';
import { captureCodexProcessIdentity } from './provider-process-identity.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swa-idle-'));
  roots.push(root);
  let now = 0;
  const counts = {
    activeTurns: 0,
    queuedTurns: 0,
    activeHelpers: 0,
    activeWork: 0,
    pendingAutomation: 0,
  };
  const store = new EventEmitter();
  const close = vi.fn(async () => {}),
    native = vi.fn();
  const runtime = {
    store,
    nativeAdmissionReason: () => null,
    nativeAdmissionConsume: () => true,
    nativeAdmissionVerify: async () => {},
    clusterBackgroundMetadataAllowed: () => true,
    settleClusterBackgroundMetadata: async () => {},
    clusterMutationGuard: () => {},
    clusterIdleCounts: () => counts,
    clusterIdleProviderPids: () => [9123],
    closeClusterIdleProviders: close,
    kick: vi.fn(),
  };
  const owner = { activeCount: () => 0, beforeOpen: () => {} };
  const identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: randomUUID(),
    remoteProjectId: randomUUID(),
    jobId: '41234',
    leaseToken: randomUUID(),
  };
  const idle = new ClusterRuntimeIdle(
    identity,
    runtime as unknown as Runtime,
    { activeCount: () => 0 } as Terminals,
    owner as OwnerTerminals,
    join(root, 'runtime-bootstrap.json'),
    20,
    () => now,
    native,
  );
  return {
    root,
    counts,
    store,
    runtime,
    owner,
    idle,
    identity,
    close,
    native,
    advance: () => {
      now += 1200001;
    },
  };
}
it.each([
  'activeTurns',
  'queuedTurns',
  'activeHelpers',
  'activeWork',
  'pendingAutomation',
] as const)('retains allocation for %s, with no native close or idle proof', async (field) => {
  const f = fixture();
  f.advance();
  f.counts[field] = 1;
  expect(await f.idle.drain({ key: randomUUID() })).toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  expect(existsSync(join(f.root, 'runtime-drained.json'))).toBe(false);
  expect(() => f.runtime.clusterMutationGuard()).not.toThrow();
  f.idle.close();
});
it('retains active owner terminals and restarts the idle interval on material activity', async () => {
  const f = fixture();
  f.advance();
  f.owner.activeCount = () => 1;
  expect(await f.idle.drain({ key: randomUUID() })).toBeNull();
  f.owner.activeCount = () => 0;
  f.advance();
  f.store.emit('event', { type: 'entry.updated' });
  expect(await f.idle.drain({ key: randomUUID() })).toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  f.idle.close();
});
it('retains in-flight mutations that could save queued input after an async boundary', async () => {
  const f = fixture();
  f.advance();
  const finish = f.idle.beginMutation();
  expect(await f.idle.drain({ key: randomUUID() })).toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  finish();
  finish();
  f.advance();
  expect(await f.idle.drain({ key: randomUUID() })).not.toBeNull();
  f.idle.close();
});
it('fences starts and terminal openings before async close, retains exact unknown cancellation, and reopens without changing history', async () => {
  const f = fixture();
  f.advance();
  writeFileSync(join(f.root, 'native-history.jsonl'), 'same native history');
  let finish!: () => void;
  f.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const key = randomUUID(),
    pending = f.idle.drain({ key });
  expect(() => f.runtime.clusterMutationGuard()).toThrow(/draining/);
  expect(() => f.owner.beforeOpen()).toThrow(/draining/);
  expect(f.runtime.nativeAdmissionConsume()).toBe(false);
  expect(f.runtime.nativeAdmissionReason()).toMatch(/draining/);
  expect(() => f.idle.reopen({ jobId: '41234', leaseToken: f.identity.leaseToken })).toThrow(
    /prepared/,
  );
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  finish();
  const proof = await pending;
  expect(proof).toMatchObject({ activeTurns: 0, ownerTerminals: 0 });
  const barrier = JSON.parse(readFileSync(join(f.root, 'runtime-drained.json'), 'utf8'));
  expect(barrier).toMatchObject({
    jobId: '41234',
    leaseToken: f.identity.leaseToken,
    key,
    drainToken: proof!.drainToken,
  });
  f.close.mockResolvedValue();
  f.native.mockImplementation(() => {
    throw new Error('Unknown native activity');
  });
  expect(await f.idle.drain({ key })).toBeNull();
  expect(() => f.runtime.clusterMutationGuard()).toThrow(/draining/); // No uncertain-release unfence.
  expect(() => f.idle.reopen({ jobId: 'wrong', leaseToken: f.identity.leaseToken })).toThrow(
    /identity/,
  );
  expect(existsSync(join(f.root, 'runtime-drained.json'))).toBe(true);
  expect(f.idle.reopen({ jobId: '41234', leaseToken: f.identity.leaseToken })).toMatchObject({
    drained: false,
  });
  expect(() => f.runtime.clusterMutationGuard()).not.toThrow();
  expect(readFileSync(join(f.root, 'native-history.jsonl'), 'utf8')).toBe('same native history');
  f.idle.close();
});
it('rejects orphaned/background native work in the same step and nested cgroups', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-proc-'));
  roots.push(root);
  mkdirSync(join(root, 'self'));
  writeFileSync(join(root, 'self/cgroup'), '0::/slurm/job_41234/step_0\n');
  for (const [pid, group] of [
    [11, '/slurm/job_41234/step_0'],
    [12, '/slurm/job_41234/step_0/tool'],
    [13, '/slurm/job_other/step_0'],
  ] as const) {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), 'cgroup'), '0::' + group + '\n');
  }
  expect(() => verifyIdleStepProcesses(new Set([11]), root)).toThrow(/background/);
  expect(() => verifyIdleStepProcesses(new Set([11, 12]), root)).not.toThrow();
});

it('checks the whole owned job, exempts only its fixed holder/transport, and retains other development steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-job-proc-'));
  roots.push(root);
  mkdirSync(join(root, 'self'));
  writeFileSync(join(root, 'self/cgroup'), '0::/slurm/job_41234/step_0\n');
  const identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: randomUUID(),
    remoteProjectId: randomUUID(),
    jobId: '41234',
    leaseToken: randomUUID(),
  };
  const context = { identity, username: 'owner', port: 4330, providerPids: new Set<number>() };
  const process = (pid: number, group: string, args: string[]) => {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), 'cgroup'), '0::' + group + '\n');
    writeFileSync(join(root, String(pid), 'cmdline'), args.join('\0') + '\0');
    writeFileSync(join(root, String(pid), 'stat'), `${pid} (process) S 1`);
  };
  process(21, '/slurm/job_41234/step_batch', ['/usr/bin/sleep', '7200']);
  process(22, '/slurm/job_41234/step_1', [
    'python3',
    '-c',
    pythonPipe,
    JSON.stringify({
      jobId: '41234',
      username: 'owner',
      comment: `swa-development:${identity.clusterProjectId}:${identity.leaseToken}`,
      port: 4330,
    }),
  ]);
  process(23, '/slurm/job_99999/step_batch', ['python', 'production.py']);
  expect(() => verifyIdleStepProcesses(new Set(), root, context)).not.toThrow();
  process(24, '/slurm/job_41234/step_2', ['python', 'development.py']);
  expect(() => verifyIdleStepProcesses(new Set(), root, context)).toThrow(/background/);
});

function providerTree(npm: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'swa-owned-codex-'));
  roots.push(root);
  const proc = join(root, 'proc'),
    node = join(root, 'node'),
    host = join(root, 'provider-host.js');
  const binary = join(root, npm ? 'codex.js' : 'codex');
  const native = join(root, 'vendor', 'codex');
  mkdirSync(join(proc, 'self'), { recursive: true });
  mkdirSync(join(root, 'vendor'));
  for (const path of [node, host, binary, native]) writeFileSync(path, 'owned executable');
  writeFileSync(join(proc, 'self/cgroup'), '0::/slurm/job_41234/step_0\n');
  const add = (pid: number, parent: number, executable: string, argv: string[]) => {
    mkdirSync(join(proc, String(pid), 'task', String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), 'cgroup'), '0::/slurm/job_41234/step_0\n');
    const fields = Array<string>(20).fill('0');
    fields[0] = 'S';
    fields[1] = String(parent);
    fields[19] = String(pid * 100);
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (process) ${fields.join(' ')}`);
    writeFileSync(join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
    writeFileSync(join(proc, String(pid), 'task', String(pid), 'children'), '');
    symlinkSync(
      existsSync(executable) ? realpathSync(executable) : executable,
      join(proc, String(pid), 'exe'),
    );
  };
  const args = [
    'app-server',
    '--listen',
    'unix:///private/exact.sock',
    '-c',
    'analytics.enabled=false',
  ];
  add(11, 10, node, [node, host, binary, JSON.stringify(args)]);
  add(12, 11, npm ? node : binary, npm ? ['node', binary, ...args] : [binary, ...args]);
  writeFileSync(join(proc, '11/task/11/children'), '12');
  if (npm) {
    add(13, 12, native, [native, ...args]);
    writeFileSync(join(proc, '12/task/12/children'), '13');
  }
  const captured = captureCodexProcessIdentity(11, node, host, binary, args, proc);
  expect(captured).toHaveLength(npm ? 3 : 2);
  const context = {
    identity: {
      controllerHostId: randomUUID(),
      remoteHostId: randomUUID(),
      clusterProjectId: randomUUID(),
      remoteProjectId: randomUUID(),
      jobId: '41234',
      leaseToken: randomUUID(),
    },
    username: 'owner',
    port: 4330,
    providerPids: new Set([11]),
    providerProcesses: captured!,
  };
  return { proc, node, host, binary, args, context, add, leaf: npm ? 13 : 12 };
}

it.each([false, true])(
  'recognizes the captured owned Codex chain (npm=%s), but keeps the post-close check strict',
  (npm) => {
    const f = providerTree(npm);
    expect(() => verifyIdleStepProcesses(new Set([10, 11]), f.proc, f.context)).not.toThrow();
    expect(() =>
      verifyIdleStepProcesses(new Set([10]), f.proc, {
        ...f.context,
        providerPids: new Set(),
        providerProcesses: [],
      }),
    ).toThrow(/background/);
  },
);

it.each([
  'socket',
  'argv',
  'binary',
  'replacement-pid',
  'cgroup',
  'tool-child',
  'unrelated',
] as const)('rejects a captured provider with changed %s or unknown work', (change) => {
  const f = providerTree(true),
    path = join(f.proc, String(f.leaf));
  if (change === 'socket' || change === 'argv') {
    const argv = [...f.context.providerProcesses.at(-1)!.argv];
    if (change === 'socket') argv[3] = 'unix:///private/wrong.sock';
    else argv.push('--unknown');
    writeFileSync(join(path, 'cmdline'), argv.join('\0') + '\0');
  } else if (change === 'binary') {
    unlinkSync(join(path, 'exe'));
    symlinkSync('/unrelated/codex', join(path, 'exe'));
  } else if (change === 'replacement-pid') {
    writeFileSync(
      join(path, 'stat'),
      readFileSync(join(path, 'stat'), 'utf8').replace(/1300$/, '9999'),
    );
  } else if (change === 'cgroup') {
    writeFileSync(join(path, 'cgroup'), '0::/slurm/job_other/step_0\n');
  } else {
    f.add(14, change === 'tool-child' ? f.leaf : 10, '/usr/bin/python', ['python', 'work.py']);
  }
  expect(() => verifyIdleStepProcesses(new Set([10, 11]), f.proc, f.context)).toThrow();
});

it('does not capture a changed wrapper launch, and missing process metadata stays conservative', () => {
  const f = providerTree(false);
  expect(
    captureCodexProcessIdentity(11, f.node, f.host, f.binary, [...f.args, '--changed'], f.proc),
  ).toBeNull();
  unlinkSync(join(f.proc, '12/exe'));
  expect(captureCodexProcessIdentity(11, f.node, f.host, f.binary, f.args, f.proc)).toBeNull();
});

it('retains a quiet runtime with owner-enabled automatic resource checkpoints and preserves its setting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-idle-auto-'));
  roots.push(root);
  const store = new Store(join(root, 'dock.sqlite')),
    runtime = new Runtime(store, root, '/unused-fixture-cli');
  vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  runtime.resources.save({ key: randomUUID(), settings: { automatic: true, checkpointHours: 6 } });
  const identity = {
    controllerHostId: randomUUID(),
    remoteHostId: randomUUID(),
    clusterProjectId: randomUUID(),
    remoteProjectId: randomUUID(),
    jobId: '41234',
    leaseToken: randomUUID(),
  };
  let now = 0;
  const native = vi.fn();
  const idle = new ClusterRuntimeIdle(
    identity,
    runtime,
    { activeCount: () => 0 } as Terminals,
    { activeCount: () => 0, beforeOpen: () => {} } as OwnerTerminals,
    join(root, 'runtime-bootstrap.json'),
    20,
    () => now,
    native,
  );
  try {
    now = 1200001;
    expect(runtime.clusterIdleCounts()).toMatchObject({
      activeTurns: 0,
      queuedTurns: 0,
      activeHelpers: 0,
      activeWork: 0,
      pendingAutomation: 1,
    });
    expect(await idle.drain({ key: randomUUID() })).toBeNull();
    expect(native).not.toHaveBeenCalled();
    expect(runtime.resources.settings().automatic).toBe(true);
    expect(store.runs()).toEqual([]);
    expect(runtime.clients.size).toBe(0);
  } finally {
    idle.close();
    await runtime.close();
    store.close();
  }
});
