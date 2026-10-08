import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModelPolicy, newProjectWorkflow, type ClusterFolderDescriptor } from '@dock/shared';
import { Store } from './store.js';
import { ClusterProjects } from './cluster-projects.js';
import { ClusterProjectRuntimes, developmentInput } from './cluster-runtime.js';
import { ClusterDevelopmentAllocations, DevelopmentReviewHeld } from './cluster-development.js';

let root: string, store: Store, folder: ClusterFolderDescriptor;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-cluster-project-'));
  store = new Store(join(root, 'dock.sqlite'));
  folder = {
    alias: 'cluster',
    rootId: randomUUID(),
    folderId: randomUUID(),
    path: '/home/owner/project',
    username: 'owner',
    account: 'confirmed_lab',
    development: {
      partition: 'test',
      qos: null,
      cpus: 2,
      memoryMb: 8192,
      timeMinutes: 120,
      idleMinutes: 20,
    },
    workflow: newProjectWorkflow(defaultModelPolicy),
    indexObservedAt: new Date().toISOString(),
    connectionId: randomUUID(),
  };
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const input = () => ({
  key: randomUUID(),
  folderId: folder.folderId,
  name: 'Cluster science',
  description: 'An explicit cluster project',
  manager: { provider: 'claude', model: 'sonnet', effort: 'high' },
});
const service = (resolve = async () => folder) =>
  new ClusterProjects(
    store,
    { resolveFolder: resolve },
    new ClusterProjectRuntimes(store, new ClusterDevelopmentAllocations(store), async () => {
      throw new Error('No deployment was requested by creating a project.');
    }),
    () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
  );

it('persists a separate stable cluster destination without starting any local manager or native turn', async () => {
  let resolutions = 0;
  const projects = service(async () => {
      resolutions++;
      return folder;
    }),
    request = input();
  const first = await projects.create(request);
  expect(first).toMatchObject({
    provider: 'claude',
    development: { state: 'absent' },
    remoteProjectId: null,
    remoteManagerId: null,
  });
  expect(store.projects()).toEqual([]);
  expect(store.agents()).toEqual([]);
  expect(store.runs()).toEqual([]);
  expect(await projects.create(request)).toEqual(first);
  expect(resolutions).toBe(1);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  expect(service().list()).toEqual([first]);
});

it('rejects retry key changes and never exposes remote folder paths or host gateway credentials', async () => {
  const projects = service(),
    request = input();
  const created = await projects.create(request);
  await expect(projects.create({ ...request, name: 'Changed' })).rejects.toThrow('different input');
  expect(JSON.stringify(created)).not.toContain(folder.path);
  expect(JSON.stringify(created)).not.toContain('credential');
  expect(projects.record(created.id).manager).toEqual(request.manager);
});

it('does not submit compute when development review capability is absent', async () => {
  const projects = service(),
    created = await projects.create(input());
  expect(await projects.open(created.id, { key: randomUUID() })).toMatchObject({
    destination: null,
    project: { opening: { state: 'preparing' } },
  });
  await vi.waitFor(() =>
    expect(projects.summary(created.id).opening).toMatchObject({
      state: 'error',
      message: expect.stringContaining('review needs setup'),
    }),
  );
  expect(projects.summary(created.id).development.state).toBe('absent');
  expect(store.runs()).toEqual([]);
});

it('requires explicit tracking before allocation and durably binds consent to the indexed directory', async () => {
  folder = { ...folder, directoryIdentity: '1:42', gitMarker: false };
  const projects = service(),
    request = input();
  const project = await projects.create(request);
  expect(project.needsTracking).toBe(true);
  expect(await projects.open(project.id, { key: randomUUID() })).toMatchObject({
    destination: null,
    project: { needsTracking: true, development: { state: 'absent' } },
  });
  const key = randomUUID(),
    first = await projects.enableTracking(project.id, { key });
  expect(first.needsTracking).toBe(false);
  expect(await projects.enableTracking(project.id, { key })).toEqual(first);
  const consent = projects.record(project.id).trackingConsent;
  expect(consent?.folderIdentity).toBe('1:42');
  folder = { ...folder, directoryIdentity: '1:43' };
  await expect(projects.enableTracking(project.id, { key: randomUUID() })).rejects.toThrow(
    'folder identity changed',
  );
  expect(projects.record(project.id).trackingConsent).toEqual(consent);
  expect(store.runs()).toEqual([]);
});

it('returns prompt preparation, joins concurrent opens, and exposes only cached verified readiness', async () => {
  const projects = service(),
    project = await projects.create(input()),
    key = randomUUID();
  let resolve!: (value: Awaited<ReturnType<ClusterProjectRuntimes['open']>>) => void;
  const native = vi.spyOn(projects.runtimes, 'open').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  vi.spyOn(projects.runtimes, 'hasGateway').mockReturnValue(true);
  const first = await projects.open(project.id, { key });
  expect(first).toMatchObject({ destination: null, project: { opening: { state: 'preparing' } } });
  expect(await projects.open(project.id, { key })).toMatchObject({ destination: null });
  expect(native).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) expect(projects.opened(project.id).destination).toBeNull();
  expect(native).toHaveBeenCalledTimes(1);
  const handshake = {
    version: 1 as const,
    hostId: randomUUID(),
    projectId: randomUUID(),
    managerId: randomUUID(),
    port: 4330,
    credential: 'a'.repeat(64),
    jobId: '41234',
    leaseToken: randomUUID(),
    attemptId: randomUUID(),
  };
  const lease: Awaited<ReturnType<ClusterProjectRuntimes['open']>>['lease'] = {
    projectId: project.id,
    token: handshake.leaseToken,
    username: 'owner',
    alias: 'cluster',
    configuration: 'a'.repeat(64),
    state: 'ready',
    jobId: '41234',
    node: 'compute',
    createdAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    message: 'Ready',
  };
  store.setSetting(`cluster-development:${project.id}`, lease);
  resolve({ handshake, lease });
  await vi.waitFor(() =>
    expect(projects.opened(project.id).destination).toMatchObject({
      hostId: project.hostId,
      projectId: handshake.projectId,
      managerId: handshake.managerId,
    }),
  );
  expect(store.runs()).toEqual([]);
  expect(store.agents()).toEqual([]);
  store.setSetting(`cluster-development:${project.id}`, { ...lease, state: 'released' });
  expect(projects.opened(project.id)).toMatchObject({
    destination: null,
    project: {
      opening: { state: 'waiting', message: expect.stringContaining('Explicitly reopen') },
    },
  });
  expect(native).toHaveBeenCalledTimes(1);
  const restarted = service();
  expect(restarted.opened(project.id)).toMatchObject({
    destination: null,
    project: { opening: { state: 'error' } },
  });
  expect(native).toHaveBeenCalledTimes(1);
});
it.each([
  'continue',
  'restart',
  'close',
  'connection-stop',
  'plan-changed',
  'lease-uncertain',
  'review-replaced',
  'released-prior',
  'ended-prior',
  'absent-prior',
  'submission-uncertain',
  'continuation-limit',
] as const)('fences pending submission review continuation: %s', async (mode) => {
  let review = {
    reviewId: randomUUID(),
    status: 'queued' as 'queued' | 'completed',
    pending: true,
    allowed: false,
    disposition: null as null | 'approve',
    message: 'Reviewing the owned development allocation.',
  };
  let submits = 0;
  const tokens: string[] = [];
  const allocations = new ClusterDevelopmentAllocations(
    store,
    async (args) => {
      const payload = JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString());
      if (payload.operation === 'submit') {
        submits++;
        if (mode === 'submission-uncertain') throw new Error('Lost submission receipt');
        return {
          code: 0,
          stdout: JSON.stringify({ jobId: '812345' }),
          stderr: '',
          timedOut: false,
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          uid: 1000,
          absent: mode === 'absent-prior' && submits === 0,
          jobs:
            mode === 'submission-uncertain' || (mode === 'absent-prior' && submits === 0)
              ? []
              : [
                  {
                    id: mode === 'ended-prior' && submits === 0 ? '712345' : '812345',
                    uid: 1000,
                    user: 'owner',
                    comment: `swa-development:${payload.lease.projectId}:${payload.lease.token}`,
                    name: 'swa-dev-' + payload.lease.projectId.slice(0, 8),
                    state: mode === 'ended-prior' && submits === 0 ? 'COMPLETED' : 'PENDING',
                    node: null,
                  },
                ],
        }),
        stderr: '',
        timedOut: false,
      };
    },
    undefined,
    undefined,
    async (_input, lease) => {
      tokens.push(lease.token);
      if (mode === 'continuation-limit' && tokens.length > 1) {
        review.reviewId = randomUUID();
        review.allowed = false;
        review.pending = true;
        review.status = 'queued';
      }
      if (!review.allowed) throw new DevelopmentReviewHeld(review);
    },
  );
  const projects = new ClusterProjects(
    store,
    { resolveFolder: async () => folder },
    new ClusterProjectRuntimes(store, allocations, async () => {
      throw new Error('No pending allocation should bootstrap.');
    }),
    () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
    () => review,
  );
  const project = await projects.create(input()),
    key = randomUUID();
  if (['released-prior', 'ended-prior', 'absent-prior'].includes(mode))
    store.setSetting(`cluster-development:${project.id}`, {
      projectId: project.id,
      token: randomUUID(),
      username: 'owner',
      alias: 'cluster',
      configuration: 'b'.repeat(64),
      state: mode === 'released-prior' ? 'released' : 'ready',
      jobId: '712345',
      node: null,
      createdAt: new Date().toISOString(),
      observedAt: null,
      message: 'Previous owned lease released.',
    });
  expect(await projects.open(project.id, { key })).toMatchObject({ destination: null });
  await vi.waitFor(() =>
    expect(projects.summary(project.id)).toMatchObject({
      opening: { state: 'waiting' },
      review: { pending: true, reviewId: review.reviewId },
    }),
  );
  expect(submits).toBe(0);
  expect(allocations.get(project.id)?.state ?? null).toBe(
    ['released-prior', 'ended-prior', 'absent-prior'].includes(mode) ? 'released' : null,
  );
  const plan = allocations.planned(developmentInput(projects.record(project.id)))!;
  expect(store.getSetting(`cluster-project-opening:${project.id}`)).toMatchObject({
    key,
    pendingReview: {
      reviewId: review.reviewId,
      token: plan.token,
      configuration: plan.configuration,
    },
  });
  review = {
    ...review,
    status: 'completed',
    pending: false,
    allowed: true,
    disposition: 'approve',
    message: 'Approved fixed request.',
  };
  for (let i = 0; i < 3; i++)
    expect(projects.opened(project.id).project.review?.allowed).toBe(true);
  expect(submits).toBe(0);
  expect(tokens).toHaveLength(1);
  let continuing = projects;
  if (mode === 'restart') {
    continuing = new ClusterProjects(
      store,
      { resolveFolder: async () => folder },
      projects.runtimes,
      () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
      () => review,
    );
    expect(continuing.summary(project.id).opening?.state).toBe('error');
  }
  if (mode === 'close') projects.close();
  if (mode === 'connection-stop') {
    store.event('cluster.connection_lease', null, null, { enabled: false });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(projects.summary(project.id).opening?.state).toBe('error');
  }
  if (mode === 'plan-changed')
    store.setSetting(`cluster-development-plan:${project.id}:${plan.configuration}`, {
      ...plan,
      token: randomUUID(),
    });
  if (mode === 'lease-uncertain')
    store.setSetting(`cluster-development:${project.id}`, { ...plan, state: 'uncertain' });
  if (mode === 'review-replaced') review.reviewId = randomUUID();
  await Promise.all([continuing.tickPending(), continuing.tickPending()]);
  if (mode === 'continuation-limit') {
    review.allowed = true;
    review.pending = false;
    review.status = 'completed';
    await projects.tickPending();
    review.allowed = true;
    review.pending = false;
    review.status = 'completed';
    await projects.tickPending();
    expect(tokens).toHaveLength(3);
    expect(submits).toBe(0);
    expect(projects.summary(project.id).opening).toMatchObject({ state: 'error' });
    return;
  }
  if (
    !['continue', 'released-prior', 'ended-prior', 'absent-prior', 'submission-uncertain'].includes(
      mode,
    )
  ) {
    expect(submits).toBe(0);
    expect(tokens).toHaveLength(1);
    expect(allocations.planned(developmentInput(projects.record(project.id)))).not.toBeNull();
    return;
  }
  if (mode === 'submission-uncertain') {
    expect(allocations.get(project.id)?.state).toBe('uncertain');
    await projects.tickPending();
    await projects.open(project.id, { key: randomUUID() });
    await vi.waitFor(() => expect(projects.summary(project.id).opening?.state).toBe('waiting'));
    expect(submits).toBe(1);
    return;
  }
  expect(projects.summary(project.id).development.jobId).toBe('812345');
  expect(tokens[1]).toBe(tokens[0]);
  expect(submits).toBe(1);
  expect(store.runs()).toEqual([]);
});

it('continues the exact queued allocation server-side without another POST or submission', async () => {
  let nativeState = 'PENDING',
    submissions = 0,
    preparations = 0;
  const tokens: string[] = [];
  const allocations = new ClusterDevelopmentAllocations(
    store,
    async (args) => {
      const x = JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString());
      tokens.push(x.lease.token);
      if (x.operation === 'submit') {
        submissions++;
        return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ jobId: '41234' }) };
      }
      return {
        code: 0,
        timedOut: false,
        stderr: '',
        stdout: JSON.stringify({
          uid: 1000,
          absent: false,
          jobs: [
            {
              id: '41234',
              uid: 1000,
              user: 'owner',
              comment: `swa-development:${x.lease.projectId}:${x.lease.token}`,
              name: 'swa-dev-' + x.lease.projectId.slice(0, 8),
              state: nativeState,
              node: nativeState === 'RUNNING' ? 'compute' : null,
              reason: 'Priority',
            },
          ],
        }),
      };
    },
    undefined,
    undefined,
    async () => {},
  );
  const runtimes = new ClusterProjectRuntimes(store, allocations, async () => {
    preparations++;
    throw new Error('Fixture stops before native runtime launch.');
  });
  const projects = new ClusterProjects(
    store,
    { resolveFolder: async () => folder },
    runtimes,
    () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
    () => ({
      reviewId: randomUUID(),
      status: 'completed',
      pending: false,
      allowed: true,
      disposition: 'approve',
      message: 'Rerun the same command.',
    }),
  );
  const project = await projects.create(input()),
    key = randomUUID();
  await projects.open(project.id, { key });
  await vi.waitFor(() =>
    expect(projects.summary(project.id).opening).toMatchObject({
      state: 'waiting',
      message: 'PENDING (Priority)',
    }),
  );
  expect(preparations).toBe(0);
  await projects.tickPending();
  expect(preparations).toBe(0);
  nativeState = 'RUNNING';
  await Promise.all([projects.tickPending(), projects.tickPending()]);
  expect(preparations).toBe(1);
  expect(submissions).toBe(1);
  expect(new Set(tokens).size).toBe(1);
  expect(store.getSetting(`cluster-project-opening:${project.id}`)).toMatchObject({
    key,
    status: { state: 'error', message: 'Fixture stops before native runtime launch.' },
  });
  expect(store.runs()).toEqual([]);
  expect(store.agents()).toEqual([]);
});

it('retains queued identity on restart and requires explicit reopen before any continuation', async () => {
  const projects = service(),
    project = await projects.create(input()),
    key = randomUUID();
  store.setSetting(`cluster-project-opening:${project.id}`, {
    key,
    status: {
      state: 'waiting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: 'PENDING',
    },
    pendingAllocation: { jobId: '41234', token: randomUUID(), configuration: 'a'.repeat(64) },
  });
  const restarted = service();
  const continuation = vi.spyOn(restarted.runtimes, 'continueOpen');
  await restarted.tickPending();
  expect(continuation).not.toHaveBeenCalled();
  expect(store.getSetting(`cluster-project-opening:${project.id}`)).toMatchObject({
    key,
    status: { state: 'error', message: expect.stringContaining('controller restarted') },
  });
  expect(restarted.opened(project.id).destination).toBeNull();
});

it.each(['controller', 'connection'] as const)(
  'stops queued continuation before bootstrap after %s stop',
  async (stop) => {
    let submits = 0,
      reads = 0,
      prepare = 0;
    let resume!: () => void;
    const allocations = new ClusterDevelopmentAllocations(
      store,
      async (args) => {
        const x = JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString());
        if (x.operation === 'submit') {
          submits++;
          return {
            code: 0,
            timedOut: false,
            stderr: '',
            stdout: JSON.stringify({ jobId: '61234' }),
          };
        }
        reads++;
        if (reads > 1)
          await new Promise<void>((done) => {
            resume = done;
          });
        return {
          code: 0,
          timedOut: false,
          stderr: '',
          stdout: JSON.stringify({
            uid: 1000,
            absent: false,
            jobs: [
              {
                id: '61234',
                uid: 1000,
                user: 'owner',
                comment: `swa-development:${x.lease.projectId}:${x.lease.token}`,
                name: 'swa-dev-' + x.lease.projectId.slice(0, 8),
                state: reads > 1 ? 'RUNNING' : 'PENDING',
                node: reads > 1 ? 'compute' : null,
              },
            ],
          }),
        };
      },
      undefined,
      undefined,
      async () => {},
    );
    const runtimes = new ClusterProjectRuntimes(store, allocations, async () => {
      prepare++;
      throw new Error('unexpected');
    });
    const projects = new ClusterProjects(
      store,
      { resolveFolder: async () => folder },
      runtimes,
      () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
    );
    const created = await projects.create(input()),
      key = randomUUID();
    await projects.open(created.id, { key });
    await vi.waitFor(() => expect(projects.summary(created.id).opening?.state).toBe('waiting'));
    const token = allocations.get(created.id)!.token;
    const tick = projects.tickPending();
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    if (stop === 'controller') {
      projects.close();
      await runtimes.close();
    } else {
      store.event('cluster.connection_lease', null, null, { enabled: false });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    resume();
    await tick;
    expect(prepare).toBe(0);
    expect(submits).toBe(1);
    expect(store.getSetting(`cluster-project-opening:${created.id}`)).toMatchObject(
      stop === 'controller'
        ? { key, pendingAllocation: { jobId: '61234', token } }
        : { key, status: { state: 'error' } },
    );
    const restarted = service();
    expect(restarted.summary(created.id).opening).toMatchObject({
      state: 'error',
      message: expect.stringContaining('Explicitly reopen'),
    });
    await restarted.tickPending();
    expect(prepare).toBe(0);
    expect(submits).toBe(1);
  },
);

it('rotates bounded pending polls so a third running allocation is not starved by two queued jobs', async () => {
  let submissions = 0,
    active = 0,
    peak = 0;
  const jobs = new Map<string, string>(),
    prepared: string[] = [];
  let running: string | null = null;
  const allocations = new ClusterDevelopmentAllocations(
    store,
    async (args) => {
      const x = JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString());
      if (x.operation === 'submit') {
        submissions++;
        jobs.set(x.lease.projectId, String(70000 + submissions));
        return {
          code: 0,
          timedOut: false,
          stderr: '',
          stdout: JSON.stringify({ jobId: jobs.get(x.lease.projectId) }),
        };
      }
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      const ready = x.lease.projectId === running;
      return {
        code: 0,
        timedOut: false,
        stderr: '',
        stdout: JSON.stringify({
          uid: 1000,
          absent: false,
          jobs: [
            {
              id: jobs.get(x.lease.projectId),
              uid: 1000,
              user: 'owner',
              comment: `swa-development:${x.lease.projectId}:${x.lease.token}`,
              name: 'swa-dev-' + x.lease.projectId.slice(0, 8),
              state: ready ? 'RUNNING' : 'PENDING',
              node: ready ? 'compute' : null,
            },
          ],
        }),
      };
    },
    undefined,
    undefined,
    async () => {},
  );
  const runtimes = new ClusterProjectRuntimes(store, allocations, async (record) => {
    prepared.push(record.id);
    throw new Error('Fixture stops before runtime launch.');
  });
  const projects = new ClusterProjects(
    store,
    { resolveFolder: async () => folder },
    runtimes,
    () => ({ alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 }),
  );
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    folder = { ...folder, folderId: randomUUID(), path: `/home/owner/project-${i}` };
    const created = await projects.create(input());
    ids.push(created.id);
    await projects.open(created.id, { key: randomUUID() });
    await vi.waitFor(() => expect(projects.summary(created.id).opening?.state).toBe('waiting'));
  }
  peak = 0;
  await projects.tickPending();
  expect(prepared).toEqual([]);
  running = ids[2]!;
  await projects.tickPending();
  expect(prepared).toEqual([ids[2]]);
  expect(submissions).toBe(3);
  expect(peak).toBeLessThanOrEqual(2);
  expect(projects.summary(ids[0]!).development.state).toBe('pending');
  expect(projects.summary(ids[1]!).development.state).toBe('pending');
});
