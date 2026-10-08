import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  defaultSlurmSubmissionPolicy,
  defaultModelPolicy,
  newProjectWorkflow,
  type ClusterProjectRecord,
} from '@dock/shared';
import { Store } from './store.js';
import { initializeClusterProject } from './cluster-bootstrap-store.js';
let root: string, store: Store, record: ClusterProjectRecord;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swa-remote-bootstrap-')));
  const data = join(root, 'private');
  mkdirSync(data);
  const folder = join(root, 'project');
  mkdirSync(folder);
  const metadata = lstatSync(folder);
  store = new Store(join(data, 'dock.sqlite'));
  record = {
    id: randomUUID(),
    controllerHostId: randomUUID(),
    hostId: randomUUID(),
    name: 'Science',
    description: '',
    createdAt: new Date().toISOString(),
    folder: {
      alias: 'cluster',
      rootId: randomUUID(),
      folderId: randomUUID(),
      path: folder,
      directoryIdentity: `${metadata.dev}:${metadata.ino}`,
      directoryOwnerUid: metadata.uid,
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
    manager: { provider: 'codex', model: 'owner-model', effort: 'high' },
    policy: defaultModelPolicy,
    remoteProjectId: null,
    remoteManagerId: null,
    remoteWorkspaceId: null,
  };
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const settings = { alias: 'cluster', label: 'Cluster', enabled: true, accountingDays: 3 };
function prepareGit() {
  execFileSync('git', ['init', '--template=', '--initial-branch=main'], {
    cwd: record.folder.path,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Fixture',
    ],
    { cwd: record.folder.path, stdio: 'ignore' },
  );
}
it('rejects an untracked folder without creating history, then registers after explicit native preparation', async () => {
  await expect(initializeClusterProject(store, record, settings)).rejects.toThrow(
    'explicit Start tracking',
  );
  expect(store.projects()).toEqual([]);
  expect(existsSync(join(record.folder.path, '.git'))).toBe(false);
  expect(store.getSetting(`project-folder:${record.id}`)).toMatchObject({
    root: record.folder.path,
    provider: record.manager.provider,
    name: record.name,
    fresh: true,
  });
  const metadata = lstatSync(record.folder.path);
  const tracked = {
    ...record,
    folder: {
      ...record.folder,
      directoryIdentity: `${metadata.dev}:${metadata.ino}`,
      gitMarker: false,
    },
    trackingConsent: {
      key: randomUUID(),
      folderIdentity: `${metadata.dev}:${metadata.ino}`,
      confirmedAt: new Date().toISOString(),
    },
  };
  const first = await initializeClusterProject(store, tracked, settings);
  expect(existsSync(join(record.folder.path, '.git'))).toBe(true);
  expect(first.project.root).toBe(record.folder.path);
  expect((await initializeClusterProject(store, tracked, settings)).project.id).toBe(
    first.project.id,
  );
  expect(store.agents()).toHaveLength(1);
});
it('reopens the exact manager and native thread while preserving changed native model choices', async () => {
  prepareGit();
  const first = await initializeClusterProject(store, record, settings);
  store.updateAgent(first.project.managerId, {
    threadId: 'native-thread',
    model: 'native-choice',
    effort: 'low',
  });
  const reopened = await initializeClusterProject(
    store,
    {
      ...record,
      remoteWorkspaceId: first.hostId,
      remoteProjectId: first.project.id,
      remoteManagerId: first.project.managerId,
    },
    settings,
  );
  expect(reopened).toEqual(first);
  expect(store.agent(first.project.managerId)).toMatchObject({
    threadId: 'native-thread',
    model: 'native-choice',
    effort: 'low',
  });
  await expect(
    initializeClusterProject(store, { ...record, remoteManagerId: randomUUID() }, settings),
  ).rejects.toThrow('history identity');
  expect(store.agents()).toHaveLength(1);
});

it('imports confirmed controller review defaults and preserves a divergent remote owner policy', async () => {
  prepareGit();
  const policy = {
    ...defaultSlurmSubmissionPolicy,
    confirmedAccount: 'owner_lab',
    defaultPartition: 'test',
    revision: 2,
  };
  await initializeClusterProject(store, { ...record, slurmReviewPolicy: policy }, settings);
  expect(store.getSetting('slurm-review:policy')).toEqual(policy);
  await initializeClusterProject(
    store,
    { ...record, slurmReviewPolicy: { ...policy, revision: 3 } },
    settings,
  );
  expect(store.getSetting('slurm-review:policy')).toMatchObject({
    revision: 3,
    confirmedAccount: 'owner_lab',
  });
  const explicit = { ...policy, revision: 4, labRules: 'Explicit remote owner policy' };
  store.setSetting('slurm-review:policy', explicit);
  await initializeClusterProject(
    store,
    { ...record, slurmReviewPolicy: { ...policy, revision: 5 } },
    settings,
  );
  expect(store.getSetting('slurm-review:policy')).toEqual(explicit);
});

it('keeps project files out of history without explicit consent and refuses a replaced folder identity', async () => {
  const stat = lstatSync(record.folder.path),
    identity = `${stat.dev}:${stat.ino}`;
  const consent = {
    key: randomUUID(),
    folderIdentity: identity,
    confirmedAt: new Date().toISOString(),
  };
  await expect(
    initializeClusterProject(
      store,
      {
        ...record,
        folder: { ...record.folder, directoryIdentity: '0:0' },
        trackingConsent: { ...consent, folderIdentity: '0:0' },
      },
      settings,
    ),
  ).rejects.toThrow('folder identity changed');
  expect(existsSync(join(record.folder.path, '.git'))).toBe(false);
  expect(store.projects()).toEqual([]);
});

it('maps consent from a login mount to compute and reopens the same history on another mount', async () => {
  const metadata = lstatSync(record.folder.path);
  const loginIdentity = `987654:${metadata.ino}`;
  const portable = {
    ...record,
    folder: { ...record.folder, directoryIdentity: loginIdentity },
    trackingConsent: {
      key: randomUUID(),
      folderIdentity: loginIdentity,
      confirmedAt: new Date().toISOString(),
    },
  };
  const first = await initializeClusterProject(store, portable, settings);
  expect(existsSync(join(record.folder.path, '.git'))).toBe(true);
  const key = `project-folder:${record.id}`;
  const receipt = store.getSetting(key) as Record<string, unknown>;
  expect(receipt.identity).toBe(`${metadata.dev}:${metadata.ino}`);
  store.updateAgent(first.project.managerId, { threadId: 'retained-native-thread' });
  // The durable receipt came from a previous compute node's mount namespace.
  store.setSetting(key, { ...receipt, identity: `987655:${metadata.ino}` });
  const reopened = await initializeClusterProject(store, portable, settings);
  expect(reopened).toEqual(first);
  expect(store.agent(first.project.managerId).threadId).toBe('retained-native-thread');
  expect((store.getSetting(key) as Record<string, unknown>).identity).toBe(
    `${metadata.dev}:${metadata.ino}`,
  );
  expect(store.projects()).toHaveLength(1);
  await expect(
    initializeClusterProject(
      store,
      {
        ...portable,
        folder: { ...portable.folder, directoryOwnerUid: metadata.uid + 1 },
      },
      settings,
    ),
  ).rejects.toThrow('folder identity changed');
  expect(store.agent(first.project.managerId).threadId).toBe('retained-native-thread');
});

it('retains exact tracking consent across a partial first checkpoint on a different compute mount', async () => {
  const metadata = lstatSync(record.folder.path);
  const loginIdentity = `987654:${metadata.ino}`;
  const portable = {
    ...record,
    folder: { ...record.folder, directoryIdentity: loginIdentity },
    trackingConsent: {
      key: randomUUID(),
      folderIdentity: loginIdentity,
      confirmedAt: new Date().toISOString(),
    },
  };
  store.setSetting(`project-folder:${record.id}`, {
    root: record.folder.path,
    provider: record.manager.provider,
    requestedProvider: record.manager.provider,
    name: record.name,
    description: record.description,
    fresh: true,
    needsTracking: true,
    identity: `987655:${metadata.ino}`,
  });
  mkdirSync(join(record.folder.path, '.git'), { mode: 0o700 });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(record.folder.path, '.git/sciencewithagents-init'), record.id, {
    mode: 0o600,
  });
  await expect(
    initializeClusterProject(
      store,
      {
        ...portable,
        trackingConsent: { ...portable.trackingConsent, folderIdentity: '0:0' },
      },
      settings,
    ),
  ).rejects.toThrow('explicit Start tracking');
  expect(store.projects()).toHaveLength(0);
  const result = await initializeClusterProject(store, portable, settings);
  expect(store.project(result.project.id).root).toBe(record.folder.path);
  expect(
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: record.folder.path,
      encoding: 'utf8',
    }).trim(),
  ).toMatch(/^[a-f0-9]{40}$/);
});

it('rejects replaced paths, inodes and durable portable bindings before starting tracking', async () => {
  const metadata = lstatSync(record.folder.path);
  const other = join(root, 'other');
  mkdirSync(other);
  const { symlinkSync } = await import('node:fs');
  const linked = join(root, 'linked');
  symlinkSync(record.folder.path, linked);
  for (const path of [other, linked])
    await expect(
      initializeClusterProject(
        store,
        {
          ...record,
          folder: { ...record.folder, path },
        },
        settings,
      ),
    ).rejects.toThrow('folder identity changed');
  store.setSetting('cluster:folder-binding', {
    projectId: record.id,
    path: record.folder.path,
    username: record.folder.username,
    inode: String(metadata.ino),
    ownerUid: metadata.uid + 1,
  });
  await expect(initializeClusterProject(store, record, settings)).rejects.toThrow(
    'folder binding changed',
  );
  expect(existsSync(join(record.folder.path, '.git'))).toBe(false);
  expect(store.projects()).toHaveLength(0);
});
