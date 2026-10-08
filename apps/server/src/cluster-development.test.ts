import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.js';
import {
  ClusterDevelopmentAllocations,
  developmentControl,
  type DevelopmentInput,
  type DevelopmentLease,
  type IdleProof,
} from './cluster-development.js';
import type { ClusterRunner } from './cluster.js';

const exec = promisify(execFile);
let root: string, store: Store, input: DevelopmentInput;
const clock = 2000000;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-development-'));
  store = new Store(join(root, 'dock.sqlite'));
  input = {
    projectId: randomUUID(),
    alias: 'cluster',
    username: 'owner',
    account: 'owner_lab',
    path: '/home/owner/project',
    resources: {
      cpus: 2,
      memoryMb: 8192,
      timeMinutes: 120,
      idleMinutes: 20,
      partition: 'dev',
      qos: null,
    },
  };
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const ok = (value: unknown) => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  timedOut: false,
});
const job = (lease: DevelopmentLease, state = 'RUNNING') => ({
  id: '812345',
  uid: 1000,
  user: 'owner',
  comment: `swa-development:${lease.projectId}:${lease.token}`,
  name: `swa-dev-${lease.projectId.slice(0, 8)}`,
  state,
  node: 'compute1',
});
const decode = (args: string[]) =>
  JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString()) as {
    operation: string;
    lease: DevelopmentLease;
  };
const proof: IdleProof = {
  observedAt: clock,
  idleSince: clock - 1200001,
  activeTurns: 0,
  queuedTurns: 0,
  activeHelpers: 0,
  activeWork: 0,
  ownerTerminals: 0,
  pendingAutomation: 0,
  drainToken: randomUUID(),
};

it.each(['shared', 'linked'])(
  'refuses a %s durable parent before native cancellation',
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
    const data = join(parent, 'cluster-projects', input.projectId);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const bin = join(root, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    const marker = join(root, 'native-command-called');
    for (const name of ['scontrol', 'scancel'])
      writeFileSync(join(bin, name), '#!/bin/sh\ntouch "$HOME/native-command-called"\nexit 90\n', {
        mode: 0o700,
      });
    const payload = {
      operation: 'release',
      input: { ...input, username: userInfo().username },
      lease: { projectId: input.projectId, token: randomUUID(), jobId: '812345' },
      drainToken: proof.drainToken,
    };
    await expect(
      exec(
        'python3',
        ['-c', developmentControl, Buffer.from(JSON.stringify(payload)).toString('base64')],
        { env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH }, timeout: 3000 },
      ),
    ).rejects.toThrow('Private runtime parent changed before release');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(data, 'runtime-open.lock'))).toBe(false);
  },
);

it('persists submission intent before crossing the boundary and reuses the exact owned allocation', async () => {
  let submissions = 0;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') {
      submissions++;
      expect(store.getSetting(`cluster-development:${input.projectId}`)).toMatchObject({
        token: lease.token,
        state: 'allocating',
        jobId: null,
      });
      return ok({ jobId: '812345' });
    }
    return ok({ uid: 1000, jobs: [job(lease)], absent: false });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  );
  const first = await allocations.ensure(input);
  expect(first).toMatchObject({ state: 'ready', jobId: '812345', node: 'compute1' });
  expect(await allocations.ensure(input)).toEqual(first);
  expect(submissions).toBe(1);
});

it('reconciles lost submission acknowledgement after restart without sending another sbatch', async () => {
  let submit = 0;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') {
      submit++;
      return { code: null, stdout: '', stderr: '', timedOut: true };
    }
    return ok({ uid: 1000, jobs: [job(lease)], absent: false });
  };
  const first = await new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  ).ensure(input);
  expect(first.state).toBe('uncertain');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  const recovered = await new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  ).ensure(input);
  expect(recovered).toMatchObject({ state: 'ready', token: first.token, jobId: '812345' });
  expect(submit).toBe(1);
});

it('does not replay an uncertain unacknowledged submission when the queue shows no candidate', async () => {
  let submissions = 0;
  const runner: ClusterRunner = async (args) => {
    if (decode(args).operation === 'submit') {
      submissions++;
      return { code: null, stdout: '', stderr: 'lost', timedOut: true };
    }
    return ok({ uid: 1000, jobs: [], absent: false });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  );
  await allocations.ensure(input);
  await allocations.ensure(input);
  expect(submissions).toBe(1);
  expect(allocations.get(input.projectId)?.state).toBe('uncertain');
});

it('deduplicates overlapping open requests and reacquires only after a known job is absent', async () => {
  let submissions = 0,
    absent = false;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') {
      submissions++;
      absent = false;
      return ok({ jobId: '812345' });
    }
    return ok({ uid: 1000, jobs: absent ? [] : [job(lease)], absent });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  );
  const [first, second] = await Promise.all([allocations.ensure(input), allocations.ensure(input)]);
  expect(first.token).toBe(second.token);
  expect(submissions).toBe(1);
  absent = true;
  expect((await allocations.ensure(input)).token).not.toBe(first.token);
  expect(submissions).toBe(2);
});

it('refuses mismatched owner or token without adopting or cancelling any job', async () => {
  let mismatch = false,
    cancellations = 0;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') return ok({ jobId: '812345' });
    if (operation === 'release') {
      cancellations++;
      return ok({ released: true });
    }
    return ok({ uid: 1000, jobs: [{ ...job(lease), uid: mismatch ? 2000 : 1000 }], absent: false });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    async () => proof,
    async () => {},
  );
  await allocations.ensure(input);
  mismatch = true;
  await expect(allocations.ensure(input)).rejects.toThrow('identity changed');
  await expect(allocations.releaseIdle(input)).rejects.toThrow('identity changed');
  expect(cancellations).toBe(0);
});

it('requires fresh positive idle evidence including helpers, queued work and owner terminals', async () => {
  let cancellations = 0;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') return ok({ jobId: '812345' });
    if (operation === 'release') {
      cancellations++;
      expect(lease.jobId).toBe('812345');
      return ok({ released: true });
    }
    return ok({ uid: 1000, jobs: [job(lease)], absent: false });
  };
  let evidence = proof;
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    async () => evidence,
    async () => {},
  );
  await allocations.ensure(input);
  for (const field of [
    'activeTurns',
    'queuedTurns',
    'activeHelpers',
    'activeWork',
    'ownerTerminals',
    'pendingAutomation',
  ] as const) {
    evidence = { ...proof, [field]: 1 };
    expect(await allocations.releaseIdle(input)).toBe(false);
  }
  evidence = { ...proof, observedAt: clock - 30001 };
  expect(await allocations.releaseIdle(input)).toBe(false);
  evidence = proof;
  expect(await allocations.releaseIdle(input)).toBe(true);
  expect(cancellations).toBe(1);
  expect(allocations.get(input.projectId)?.state).toBe('released');
});

it('retains a ready allocation when a remote drain barrier is not implemented', async () => {
  const operations: string[] = [];
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    operations.push(operation);
    return operation === 'submit'
      ? ok({ jobId: '812345' })
      : ok({ uid: 1000, jobs: [job(lease)], absent: false });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  );
  await allocations.ensure(input);
  expect(await allocations.releaseIdle(input)).toBe(false);
  expect(operations).not.toContain('release');
});

it('permits a corrected retry after a definite native rejection and pins active resource configuration', async () => {
  let submissions = 0;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') {
      submissions++;
      return submissions === 1
        ? ok({ rejected: true, message: 'Invalid account' })
        : ok({ jobId: '812345' });
    }
    return ok({ uid: 1000, jobs: [job(lease)], absent: false });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async () => {},
  );
  expect((await allocations.ensure(input)).state).toBe('rejected');
  const corrected = { ...input, account: 'confirmed_lab' };
  expect((await allocations.ensure(corrected)).state).toBe('ready');
  await expect(
    allocations.ensure({ ...corrected, resources: { ...corrected.resources, memoryMb: 16384 } }),
  ).rejects.toThrow('resources, account or folder changed');
  expect(submissions).toBe(2);
});

it('uses the post-roundtrip clock for drain freshness and validates ended transports without allocating', async () => {
  let current = clock,
    absent = false,
    submissions = 0,
    releases = 0;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    if (operation === 'submit') {
      submissions++;
      return ok({ jobId: '812345' });
    }
    if (operation === 'release') {
      releases++;
      return ok({ released: true });
    }
    return ok({ uid: 1000, jobs: absent ? [] : [job(lease)], absent });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => current,
    async () => {
      current += 500;
      return { ...proof, observedAt: current };
    },
    async () => {},
  );
  const first = await allocations.ensure(input);
  expect(await allocations.releaseIdle(input)).toBe(true);
  expect(releases).toBe(1);
  absent = true;
  expect(await allocations.verifyCurrent(input, first)).toBe(false);
  expect(submissions).toBe(1);
});

it('reuses one exact allocation review intent while pending before crossing the submission boundary', async () => {
  const tokens: string[] = [],
    native: string[] = [];
  let approved = false;
  const runner: ClusterRunner = async (args) => {
    const { operation, lease } = decode(args);
    native.push(operation);
    return operation === 'submit'
      ? ok({ jobId: '812345' })
      : ok({ uid: 1000, jobs: [job(lease)], absent: false });
  };
  const allocations = new ClusterDevelopmentAllocations(
    store,
    runner,
    () => clock,
    undefined,
    async (_input, lease) => {
      tokens.push(lease.token);
      if (!approved) throw new Error('Review pending');
    },
  );
  await expect(allocations.ensure(input)).rejects.toThrow('Review pending');
  await expect(allocations.ensure(input)).rejects.toThrow('Review pending');
  expect(tokens[1]).toBe(tokens[0]);
  expect(native).toEqual([]);
  expect(allocations.get(input.projectId)).toBeNull();
  approved = true;
  const started = await allocations.ensure(input);
  expect(started.token).toBe(tokens[0]);
  expect(native.filter((item) => item === 'submit')).toHaveLength(1);
});

it.each(['stop', 'plan', 'lease', 'approval'] as const)(
  'rechecks %s after asynchronous review before any submission',
  async (change) => {
    let admitted!: (validate?: () => void) => void;
    const runner = vi.fn<ClusterRunner>();
    const allocations = new ClusterDevelopmentAllocations(
      store,
      runner,
      () => clock,
      undefined,
      () =>
        new Promise<void | (() => void)>((resolve) => {
          admitted = resolve;
        }),
    );
    const pending = allocations.ensure(input);
    const plan = allocations.planned(input)!;
    expect(plan).toMatchObject({ state: 'allocating', jobId: null });
    if (change === 'stop') allocations.stop();
    if (change === 'plan')
      store.setSetting(`cluster-development-plan:${input.projectId}:${plan.configuration}`, {
        ...plan,
        token: randomUUID(),
      });
    if (change === 'lease')
      store.setSetting(`cluster-development:${input.projectId}`, { ...plan, state: 'uncertain' });
    admitted(
      change === 'approval'
        ? () => {
            throw new Error('Approval expired');
          }
        : undefined,
    );
    await expect(pending).rejects.toThrow(
      change === 'stop'
        ? 'controller stopped'
        : change === 'plan'
          ? 'review plan changed'
          : change === 'lease'
            ? 'allocation changed'
            : 'Approval expired',
    );
    expect(runner).not.toHaveBeenCalled();
    expect(allocations.get(input.projectId)?.state ?? null).toBe(
      change === 'lease' ? 'uncertain' : null,
    );
    expect(allocations.planned(input)).not.toBeNull();
  },
);

it('observes only the saved pending job and never replaces an ended or changed lease', async () => {
  let submissions = 0,
    state = 'PENDING',
    absent = false;
  const allocations = new ClusterDevelopmentAllocations(
    store,
    async (args) => {
      const x = decode(args);
      if (x.operation === 'submit') {
        submissions++;
        return ok({ jobId: '812345' });
      }
      return ok({
        uid: 1000,
        absent,
        jobs: absent
          ? []
          : [{ ...job(x.lease, state), reason: state === 'PENDING' ? 'Priority' : null }],
      });
    },
    () => clock,
    undefined,
    async () => {},
  );
  const pending = await allocations.ensure(input);
  expect(pending.message).toBe('PENDING (Priority)');
  state = 'RUNNING';
  expect(await allocations.observeExisting(input, pending)).toMatchObject({
    state: 'ready',
    jobId: pending.jobId,
    token: pending.token,
  });
  state = 'CANCELLED';
  expect(await allocations.observeExisting(input, pending)).toMatchObject({
    state: 'released',
    token: pending.token,
  });
  await expect(allocations.observeExisting(input, pending)).rejects.toThrow('identity changed');
  expect(submissions).toBe(1);
  expect(store.runs()).toEqual([]);
});
