import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModelPolicy, newProjectWorkflow, clusterProjectRecordSchema } from '@dock/shared';
import {
  createComputeBootstrap,
  computeBootstrap,
  computeRuntimeIdentity,
  computeClusterRunner,
} from './cluster-compute.js';
it('round trips the exact compute metadata and remote identity before server startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compute-contract-'));
  try {
    const record = clusterProjectRecordSchema.parse({
      id: randomUUID(),
      controllerHostId: randomUUID(),
      hostId: randomUUID(),
      name: 'Fixture',
      description: '',
      createdAt: new Date().toISOString(),
      folder: {
        alias: 'cluster',
        rootId: randomUUID(),
        folderId: randomUUID(),
        path: '/home/owner/project',
        username: 'owner',
        account: 'owner_lab',
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
      },
      manager: { provider: 'codex', model: null, effort: 'high' },
      policy: defaultModelPolicy,
      remoteProjectId: null,
      remoteManagerId: null,
      remoteWorkspaceId: null,
    });
    const identity = {
      attemptId: randomUUID(),
      hostId: randomUUID(),
      remoteProjectId: randomUUID(),
      jobId: '12345',
      leaseToken: randomUUID(),
      node: 'compute1',
      startedAt: new Date().toISOString(),
    };
    const produced = createComputeBootstrap(record, identity);
    produced.mainPid = 42;
    const file = join(root, 'runtime-bootstrap.json');
    writeFileSync(file, JSON.stringify(produced), { mode: 0o600 });
    expect(computeBootstrap(file)).toEqual(produced);
    expect(computeRuntimeIdentity(file)).toMatchObject({
      controllerHostId: record.controllerHostId,
      remoteHostId: identity.hostId,
      remoteProjectId: identity.remoteProjectId,
      jobId: identity.jobId,
      leaseToken: identity.leaseToken,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects public, linked or oversized bootstrap files before invoking native Slurm', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compute-private-'));
  try {
    expect(await computeClusterRunner(undefined)).toBeUndefined();
    const publicFile = join(root, 'public.json');
    writeFileSync(publicFile, '{}', { mode: 0o644 });
    chmodSync(publicFile, 0o644);
    await expect(computeClusterRunner(publicFile)).rejects.toThrow('private owner file');
    const link = join(root, 'linked.json');
    symlinkSync(publicFile, link);
    await expect(computeClusterRunner(link)).rejects.toThrow('private owner file');
    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, ' '.repeat(4001), { mode: 0o600 });
    await expect(computeClusterRunner(oversized)).rejects.toThrow('private owner file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
