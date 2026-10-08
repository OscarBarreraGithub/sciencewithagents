import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultModelPolicy,
  defaultSlurmSubmissionPolicy,
  newProjectWorkflow,
  type ClusterFolderDescriptor,
  type SlurmDevelopmentReviewResult,
} from '@dock/shared';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { DemoProvider } from './demo.js';
import { createClusterControllerServices } from './cluster-controller-services.js';
import { sshRunner } from './cluster.js';
import { modelFixture } from './model-policy.fixture.js';
vi.mock('./cluster.js', async (original) => ({
  ...(await original<typeof import('./cluster.js')>()),
  sshRunner: vi.fn(),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
it('holds an exact development proposal and continues the same explicit open after review approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-controller-review-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  store.setSetting('slurm-review:policy', {
    ...defaultSlurmSubmissionPolicy,
    enabled: true,
    confirmedAccount: 'lab',
  });
  writeFileSync(
    join(root, 'cluster-runtime-source.json'),
    JSON.stringify({ revision: 'a'.repeat(40) }),
    { mode: 0o600 },
  );
  const launch = vi.fn(async () => new DemoProvider(root));
  const runtime = new Runtime(store, root, '/unused-cli', launch);
  cleanups.push(async () => {
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  vi.spyOn(runtime, 'kick').mockImplementation(() => {});
  const folder: ClusterFolderDescriptor = {
    alias: 'cluster',
    rootId: randomUUID(),
    folderId: randomUUID(),
    path: '/home/owner/project',
    username: 'owner',
    account: 'lab',
    development: {
      partition: 'test',
      qos: null,
      cpus: 2,
      memoryMb: 4096,
      timeMinutes: 60,
      idleMinutes: 10,
    },
    workflow: newProjectWorkflow(defaultModelPolicy),
    indexObservedAt: new Date().toISOString(),
    connectionId: randomUUID(),
  };
  vi.spyOn(runtime.clusterWorkspace!, 'resolveFolder').mockResolvedValue(folder);
  vi.spyOn(runtime.cluster, 'settings').mockReturnValue({
    enabled: true,
    alias: 'cluster',
    label: 'Cluster',
    accountingDays: 3,
  });
  let settleReview!: () => void;
  vi.spyOn(runtime.slurmReview, 'onSettled').mockImplementation((listener) => {
    settleReview = () => listener({} as never);
    return () => {};
  });
  const services = createClusterControllerServices(runtime, '/unused-source')!;
  cleanups.push(() => services.close());
  const pending: SlurmDevelopmentReviewResult = {
    reviewId: randomUUID(),
    status: 'queued',
    pending: true,
    allowed: false,
    disposition: null,
    message: 'Pending review.',
  };
  const review = vi.spyOn(runtime.slurmReview, 'requestDevelopmentReview').mockReturnValue(pending);
  vi.spyOn(runtime.slurmReview, 'get').mockImplementation(
    () => ({ ...pending, id: pending.reviewId, allowsSubmission: pending.allowed }) as never,
  );
  const project = await services.projects.create({
    key: randomUUID(),
    folderId: folder.folderId,
    name: 'Reviewed cluster',
    description: '',
    manager: { provider: 'claude', model: 'sonnet', effort: 'high' },
  });
  await services.projects.open(project.id, { key: randomUUID() });
  await vi.waitFor(() =>
    expect(services.projects.summary(project.id).opening?.state).toBe('waiting'),
  );
  expect(sshRunner).not.toHaveBeenCalled();
  const proposal = review.mock.calls[0]![0] as { key: string; command: string; script: string };
  expect(proposal.command).toContain('--account=lab');
  expect(proposal.script).toContain('exec sleep 3600');
  pending.status = 'completed';
  pending.pending = false;
  pending.allowed = true;
  pending.disposition = 'approve';
  for (let i = 0; i < 3; i++) services.projects.opened(project.id);
  expect(sshRunner).not.toHaveBeenCalled();
  vi.mocked(sshRunner).mockImplementation(async (args) => {
    const payload = JSON.parse(
      Buffer.from(args.at(-1)!.replace(/^'|'$/g, ''), 'base64').toString(),
    );
    return {
      code: 0,
      stdout: JSON.stringify(
        payload.operation === 'submit'
          ? { jobId: '100' }
          : {
              uid: 1000,
              jobs: [
                {
                  id: '100',
                  uid: 1000,
                  user: 'owner',
                  comment: 'swa-development:' + project.id + ':' + proposal.key,
                  name: 'swa-dev-' + project.id.slice(0, 8),
                  state: 'PENDING',
                  node: null,
                },
              ],
            },
      ),
      stderr: '',
      timedOut: false,
    };
  });
  settleReview();
  await vi.waitFor(() =>
    expect(services.projects.summary(project.id).development.jobId).toBe('100'),
  );
  expect(review).toHaveBeenCalledTimes(2);
  expect(review.mock.calls[1]![0]).toEqual(proposal);
  expect(
    vi
      .mocked(sshRunner)
      .mock.calls.filter(([args]) =>
        Buffer.from(args.at(-1)!.replace(/^'|'$/g, ''), 'base64')
          .toString()
          .includes('"operation":"submit"'),
      ),
  ).toHaveLength(1);
  expect(launch).not.toHaveBeenCalled();
});
