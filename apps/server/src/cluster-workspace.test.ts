import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { ClusterMonitor, type ClusterRun } from './cluster.js';
import { ClusterWorkspace, type ClusterWorkspaceSetupApproval } from './cluster-workspace.js';
import { clusterWorkspaceProbe } from './cluster-workspace-probe.js';
import type { HeldClusterClient } from './cluster-connection-lease.js';

let root: string, store: Store;
let disposables: (() => Promise<void>)[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-cluster-workspace-'));
  store = new Store(join(root, 'dock.sqlite'));
  disposables = [];
});
afterEach(async () => {
  for (const close of disposables) await close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
const ok = (stdout = ''): ClusterRun => ({ code: 0, stdout, stderr: '', timedOut: false });
function fixture(onSetupSaved?: (approval: ClusterWorkspaceSetupApproval) => void) {
  const state = {
    master: true,
    pid: 42,
    fail: false,
    username: 'person',
    accounts: ['one', 'two'],
    defaultAccount: 'two',
    probeCount: 0,
    setupError: null as string | null,
    validationPath: null as string | null,
    gate: null as Promise<void> | null,
    limits: null as ReturnType<ClusterMonitor['status']>['limits'] | null,
    fairshare: null as ReturnType<ClusterMonitor['status']>['fairshare'] | null,
  };
  const queries: string[][] = [],
    holders: { closed: boolean; exit: () => void }[] = [];
  const cluster = new ClusterMonitor(store, async (args, input) => {
    queries.push(args);
    if (args[0] === '-O')
      return state.master
        ? { ...ok(), stderr: `Master running (pid=${state.pid})` }
        : { code: 255, stdout: '', stderr: 'No such file', timedOut: false };
    if (input !== clusterWorkspaceProbe)
      return { code: 255, stdout: '', stderr: 'fixture offline', timedOut: false };
    const payload = JSON.parse(Buffer.from(args.at(-1)!, 'base64').toString());
    if (payload.validate)
      return ok(
        JSON.stringify({
          username: state.username,
          directoryOwnerUid: 1234,
          path:
            state.validationPath ??
            payload.validate.canonicalPath +
              (payload.validate.relativePath === '.' ? '' : '/' + payload.validate.relativePath),
          error: null,
        }),
      );
    state.probeCount++;
    await state.gate;
    if (state.fail) return { code: 255, stdout: '', stderr: 'fixture failed', timedOut: false };
    return ok(
      JSON.stringify({
        username: state.username,
        defaultAccount: state.defaultAccount,
        accounts: state.accounts,
        setupError: state.setupError,
        roots: payload.roots.map((saved: { id: string; path: string }) => ({
          id: saved.id,
          canonicalPath: saved.path,
          entries: [
            { relativePath: '.', kind: 'directory', size: null, modifiedAt: null, git: true },
            { relativePath: 'child', kind: 'directory', size: null, modifiedAt: null, git: false },
          ],
          omitted: 0,
          truncated: false,
          error: null,
        })),
      }),
    );
  });
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias: 'lab', label: 'Lab', accountingDays: 3 },
  });
  const base = cluster.status();
  vi.spyOn(cluster, 'status').mockImplementation(() => ({
    ...base,
    limits: state.limits ?? base.limits,
    fairshare: state.fairshare ?? base.fairshare,
    connection: {
      state: state.master ? 'connected' : 'sign-in-needed',
      master: state.master ? 'running' : 'absent',
      checkedAt: new Date().toISOString(),
      connectedAt: new Date().toISOString(),
      message: '',
    },
  }));
  const workspace = new ClusterWorkspace(
    cluster,
    () => {
      const value = { closed: false, exit: () => {} };
      holders.push(value);
      return {
        close() {
          value.closed = true;
          value.exit();
        },
        onExit(listener) {
          value.exit = listener;
        },
      } satisfies HeldClusterClient;
    },
    onSetupSaved,
  );
  disposables.push(async () => {
    await workspace.close();
    await cluster.close();
  });
  const save = (overrides: Record<string, unknown> = {}) =>
    workspace.save({
      key: randomUUID(),
      alias: 'lab',
      revision: workspace.status().revision,
      roots: [{ label: 'Project', path: '/saved/project' }],
      account: null,
      development: {},
      workflow: workspace.status().workflow,
      ...overrides,
    });
  return { state, cluster, workspace, save, holders, queries };
}
it('shares explicit setup approval atomically and suggests test only from the saved FASRC preset and fresh accessible evidence', async () => {
  const approvals = vi.fn((approval: ClusterWorkspaceSetupApproval) => {
    store.setSetting('review-confirmation-test', approval);
    if (approval.account === 'two') throw new Error('review policy conflict');
  });
  const { workspace, save, cluster, state } = fixture(approvals);
  const { clusterPartitionSchema } = await import('@dock/shared');
  const partition = clusterPartitionSchema.parse({
    name: 'test',
    state: 'UP',
    maxTime: '12:00:00',
    defaultTime: 'N/A',
    maxNodes: 'UNLIMITED',
    maxCpusPerNode: 'UNLIMITED',
    defMemPerCpu: 'N/A',
    defMemPerNode: 'N/A',
    maxMemPerNode: 'N/A',
    qos: '',
    preemptMode: '',
    priorityTier: null,
    totalCpus: null,
    totalNodes: null,
    gres: '',
    cpus: null,
    accessible: true,
  });
  state.limits = {
    ...cluster.status().limits,
    observedAt: new Date().toISOString(),
    error: null,
    partitions: [partition],
  };
  await workspace.reconcile();
  expect(workspace.status().setup.suggestedDevelopment).toBeNull();
  expect(approvals).not.toHaveBeenCalled();
  const key = randomUUID();
  const first = save({ key, account: 'one', siteRules: 'fasrc-cannon' });
  await workspace.reconcile();
  expect(workspace.status().development.partition).toBeNull();
  expect(workspace.status().setup.suggestedDevelopment).toMatchObject({
    partition: 'test',
    cpus: 2,
    memoryMb: 8192,
    timeMinutes: 120,
    idleMinutes: 20,
  });
  expect(approvals).toHaveBeenCalledOnce();
  expect(store.getSetting('review-confirmation-test')).toMatchObject({
    key,
    account: 'one',
    siteRules: 'fasrc-cannon',
    workspaceRevision: 1,
  });
  save({ key, revision: 0, account: 'one', siteRules: 'fasrc-cannon' });
  expect(approvals).toHaveBeenCalledOnce();
  expect(first.status).toBe('saved');
  expect(() => save({ account: 'two' })).toThrow('review policy conflict');
  expect(workspace.status().setup.selectedAccount).toBe('one');
  expect(workspace.status().revision).toBe(1);
  expect(store.getSetting('review-confirmation-test')).toMatchObject({ account: 'one' });
  state.limits.observedAt = new Date(Date.now() - 21 * 60000).toISOString();
  const probes = state.probeCount;
  const discoveryAt = workspace.status().setup.observedAt;
  expect(workspace.status().setup.suggestedDevelopment).toBeNull();
  expect(workspace.status().setup.partitions).toEqual([]);
  state.limits.observedAt = new Date().toISOString();
  state.fairshare = {
    ...cluster.status().fairshare,
    observedAt: new Date().toISOString(),
    error: null,
    items: [
      {
        account: 'one',
        fairShare: 0.75,
        levelFairShare: null,
        accountNormShares: null,
        accountEffectiveUsage: null,
        accountRawUsage: null,
        userRawUsage: null,
      },
    ],
  };
  expect(workspace.status().setup.suggestedDevelopment?.partition).toBe('test');
  expect(workspace.status().setup.accounts.find(({ name }) => name === 'one')?.fairShare).toBe(
    0.75,
  );
  expect(workspace.status().setup.observedAt).toBe(discoveryAt);
  expect(state.probeCount).toBe(probes);
});
it('retains saved account consent across a dropped connection and failed setup, while blocking execution and new account choices', async () => {
  const { workspace, save, state } = fixture();
  await workspace.reconcile();
  save({ account: 'one' });
  await workspace.reconcile();
  const rootId = workspace.status().roots[0]!.id;
  state.master = false;
  await workspace.reconcile();
  expect(workspace.status().setup).toMatchObject({
    selectedAccount: 'one',
    accountConfirmed: true,
  });
  expect(
    save({
      account: 'one',
      roots: [{ id: rootId, label: 'Renamed while offline', path: '/saved/project' }],
    }).status,
  ).toBe('saved');
  expect(() => save({ account: 'two' })).toThrow('current cluster setup');
  await expect(workspace.resolveFolder(rootId)).rejects.toThrow('Sign in');
  state.master = true;
  state.pid++;
  state.fail = true;
  await workspace.reconcile();
  expect(workspace.status().setup).toMatchObject({
    selectedAccount: 'one',
    accountConfirmed: true,
  });
  expect(workspace.status().setup.error).not.toBeNull();
  await expect(workspace.resolveFolder(rootId)).rejects.toThrow('Sign in');
  state.fail = false;
  state.setupError = 'Temporary Slurm query failure';
  state.accounts = [];
  await workspace.refresh({ key: randomUUID(), alias: 'lab' });
  expect(workspace.status().setup).toMatchObject({
    selectedAccount: 'one',
    accountConfirmed: true,
  });
  expect(workspace.status().setup.accounts.map(({ name }) => name)).toEqual(['one', 'two']);
  state.setupError = null;
  state.accounts = ['one', 'two'];
  state.username = 'other-person';
  await workspace.refresh({ key: randomUUID(), alias: 'lab' });
  expect(workspace.status().setup).toMatchObject({
    selectedAccount: null,
    accountConfirmed: false,
  });
});
it('keeps multiple accounts unconfirmed despite a Slurm default and resolves only an approved indexed directory', async () => {
  const { workspace, save, state } = fixture();
  await workspace.reconcile();
  expect(workspace.status().setup).toMatchObject({
    defaultAccount: 'two',
    selectedAccount: null,
    accountConfirmed: false,
  });
  const input = {
    key: randomUUID(),
    alias: 'lab',
    revision: 0,
    roots: [{ label: 'Project', path: '/saved/project' }],
    account: null,
    development: {},
    workflow: workspace.status().workflow,
  };
  const first = workspace.save(input);
  await workspace.reconcile();
  const rootId = workspace.status().roots[0]!.id;
  expect(workspace.save(input)).toEqual(first);
  expect(workspace.status().roots[0]!.id).toBe(rootId);
  await expect(workspace.resolveFolder(rootId)).rejects.toThrow('confirm');
  expect(
    save({
      roots: workspace.status().roots.map(({ id, label, path }) => ({ id, label, path })),
      account: 'one',
    }).status,
  ).toBe('saved');
  await workspace.reconcile();
  expect(await workspace.resolveFolder(rootId)).toMatchObject({
    alias: 'lab',
    path: '/saved/project',
    directoryOwnerUid: 1234,
    account: 'one',
    development: { cpus: 2, memoryMb: 8192, timeMinutes: 120, idleMinutes: 20 },
  });
  const childId = workspace
    .status()
    .roots[0]!.index.entries.find((entry) => entry.relativePath === 'child')!.id;
  await expect(workspace.resolveFolder(childId)).resolves.toMatchObject({
    path: '/saved/project/child',
  });
  state.validationPath = '/other/path';
  await expect(workspace.resolveFolder(childId)).rejects.toThrow('changed');
  expect(() => save({ account: 'unknown' })).toThrow('account');
  const conflict = save({ revision: 0 });
  expect(conflict.status).toBe('conflict');
  expect(workspace.status().setup.selectedAccount).toBe('one');
});
it('retains stale metadata on disconnect/failure, indexes each new login once, and preserves stable folder IDs', async () => {
  const { workspace, save, state, cluster } = fixture();
  save();
  await workspace.reconcile();
  const before = workspace.status().roots[0]!.index;
  const probes = state.probeCount;
  await workspace.reconcile();
  expect(state.probeCount).toBe(probes);
  state.master = false;
  await workspace.reconcile();
  expect(workspace.status().roots[0]!.index).toMatchObject({
    state: 'stale',
    entries: before.entries,
  });
  await expect(workspace.resolveFolder(before.entries[0]!.id)).rejects.toThrow('Sign in');
  state.master = true;
  state.pid++;
  state.fail = true;
  await workspace.reconcile();
  expect(workspace.status().roots[0]!.index).toMatchObject({
    state: 'error',
    observedAt: before.observedAt,
    entries: before.entries,
  });
  state.fail = false;
  await workspace.refresh({ key: randomUUID(), alias: 'lab' });
  expect(workspace.status().roots[0]!.index).toMatchObject({
    state: 'ready',
    entries: before.entries,
  });
  const oldConnection = workspace.status().connectionId;
  cluster.signedIn(randomUUID());
  await workspace.reconcile();
  expect(workspace.status().connectionId).not.toBe(oldConnection);
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias: 'other', label: 'Other', accountingDays: 3 },
  });
  expect(workspace.status().roots).toEqual([]);
  expect(() =>
    workspace.save({
      key: randomUUID(),
      alias: 'lab',
      revision: 0,
      roots: [],
      account: null,
      development: {},
      workflow: workspace.status().workflow,
    }),
  ).toThrow('changed');
});
it('replays an agent lease request without extending its deadline after state advances', async () => {
  const { workspace, save, holders } = fixture();
  save();
  await workspace.reconcile();
  const key = randomUUID();
  const first = await workspace.control(key, { action: 'renew', hours: 3 });
  const current = workspace.status();
  expect(current.keepConnected.enabled).toBe(true);
  expect(await workspace.control(key, { action: 'renew', hours: 3 })).toEqual(first);
  expect(workspace.status().revision).toBe(current.revision);
  expect(workspace.status().keepConnected.expiresAt).toBe(current.keepConnected.expiresAt);
  expect(holders.filter((holder) => !holder.closed)).toHaveLength(1);
  await expect(workspace.control(key, { action: 'renew', hours: 4 })).rejects.toThrow();
  await workspace.control(randomUUID(), { action: 'stop' });
  expect(workspace.status().keepConnected.enabled).toBe(false);
  expect(holders.every((holder) => holder.closed)).toBe(true);
});
it('expires and stops only its own held client, shares concurrent renewals, and does not renew duplicate deadlines', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  const { workspace, holders, queries } = fixture();
  await workspace.reconcile();
  const input = { key: randomUUID(), alias: 'lab', revision: 0, hours: 1 };
  await Promise.all([workspace.renew(input), workspace.renew(input)]);
  expect(holders).toHaveLength(1);
  expect(workspace.status().keepConnected.state).toBe('holding');
  const expires = workspace.status().keepConnected.expiresAt;
  await vi.advanceTimersByTimeAsync(3600001);
  expect(holders[0]!.closed).toBe(true);
  expect(workspace.status().keepConnected.state).toBe('expired');
  await workspace.renew(input);
  expect(workspace.status().keepConnected.expiresAt).toBe(expires);
  expect(holders).toHaveLength(1);
  await workspace.renew({
    key: randomUUID(),
    alias: 'lab',
    revision: workspace.status().revision,
    hours: 72,
  });
  expect(holders).toHaveLength(2);
  await workspace.renew({
    key: randomUUID(),
    alias: 'lab',
    revision: workspace.status().revision,
    hours: null,
  });
  expect(holders[1]!.closed).toBe(true);
  expect(workspace.status().keepConnected.state).toBe('off');
  expect(queries.filter((args) => args[0] === '-O').every((args) => args[1] === 'check')).toBe(
    true,
  );
});
it('does not let a late index overwrite a changed lease or an alias/account/root save', async () => {
  const { workspace, save, state } = fixture();
  let release!: () => void;
  state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  save();
  await vi.waitFor(() => expect(state.probeCount).toBe(1));
  await workspace.renew({ key: randomUUID(), alias: 'lab', revision: 1, hours: 2 });
  release();
  await workspace.reconcile();
  expect(workspace.status().keepConnected.expiresAt).not.toBeNull();
  expect(workspace.status().revision).toBe(2);
});
it('the real metadata program bounds traversal and never follows links or emits file contents', async () => {
  const project = join(root, 'project'),
    outside = join(root, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, 'notes.txt'), 'PRIVATE_CONTENT_SENTINEL');
  writeFileSync(join(outside, 'outside-secret.txt'), 'PRIVATE_OUTSIDE_CONTENT');
  symlinkSync(outside, join(project, 'external'));
  mkdirSync(join(project, 'many'));
  for (let i = 0; i < 305; i++) writeFileSync(join(project, 'many', `${i}.txt`), 'fixture');
  const payload = Buffer.from(
    JSON.stringify({ roots: [{ id: randomUUID(), path: project }] }),
  ).toString('base64');
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'bash',
      ['-s', '--', payload],
      { timeout: 35000, maxBuffer: 1000000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(clusterWorkspaceProbe);
  });
  const found = JSON.parse(result).roots[0];
  expect(found.entries).toHaveLength(300);
  expect(found.truncated).toBe(true);
  expect(found.omitted).toBeGreaterThan(0);
  expect(
    found.entries.find((entry: { relativePath: string }) => entry.relativePath === 'external').kind,
  ).toBe('symlink');
  expect(found.entries[0]).toMatchObject({ relativePath: '.', git: true });
  expect(result).not.toContain('PRIVATE_CONTENT_SENTINEL');
  expect(result).not.toContain('PRIVATE_OUTSIDE_CONTENT');
  expect(result).not.toContain('outside-secret.txt');
});

it('an explicitly saved home exposes bounded direct metadata while saved subfolders can be explored, and filesystem root stays rejected', async () => {
  const home = join(root, 'fixture-home'),
    project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, 'nested'));
  writeFileSync(join(project, 'nested', 'deeper-name.txt'), 'PRIVATE_DEEP_CONTENT');
  writeFileSync(join(home, 'visible.txt'), 'PRIVATE_HOME_CONTENT');
  const program = clusterWorkspaceProbe.split("<<'PY'\n")[1]!.split('\nPY\n')[0]!;
  // Substitute only the native identity lookup in this owned fixture. The metadata
  // program itself is unchanged, and never points at the person's real home.
  const harness =
    'import pwd,types,sys; fixture_home=sys.argv[1]; pwd.getpwuid=lambda uid:types.SimpleNamespace(pw_name="fixture",pw_dir=fixture_home); code=bytes.fromhex(sys.argv[3]); sys.argv=["probe",sys.argv[2]]; exec(code)';
  const payload = Buffer.from(
    JSON.stringify({
      roots: [
        { id: randomUUID(), path: home },
        { id: randomUUID(), path: project },
        { id: randomUUID(), path: '/' },
      ],
    }),
  ).toString('base64');
  const output = await new Promise<string>((resolve, reject) =>
    execFile(
      'python3',
      ['-c', harness, home, payload, Buffer.from(program).toString('hex')],
      { timeout: 35000, maxBuffer: 1000000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  const [homeIndex, projectIndex, filesystemIndex] = JSON.parse(output).roots;
  expect(homeIndex.error).toBeNull();
  expect(
    homeIndex.entries.map((entry: { relativePath: string }) => entry.relativePath).sort(),
  ).toEqual(['.', 'project', 'visible.txt']);
  expect(homeIndex.truncated).toBe(true);
  expect(
    projectIndex.entries.some(
      (entry: { relativePath: string }) => entry.relativePath === 'nested/deeper-name.txt',
    ),
  ).toBe(true);
  expect(filesystemIndex.error).not.toBeNull();
  expect(filesystemIndex.entries).toEqual([]);
  expect(output).not.toContain('PRIVATE_DEEP_CONTENT');
  expect(output).not.toContain('PRIVATE_HOME_CONTENT');
});
