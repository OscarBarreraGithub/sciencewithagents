import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  GroupContainer,
  GroupDockerEngine,
  groupContainerSpec,
  assertGroupContainerInspection,
  groupContainerSeccomp,
  groupContainerSourceDigest,
  groupContainerBuildRecipe,
  boundGroupLines,
  GroupNamespaceStopUnverified,
  type GroupContainerPlan,
} from './group-container.js';
import { groupResourceMounts } from './group-isolation.js';
const roots: string[] = [];
afterEach(() => {
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  roots.length = 0;
  vi.restoreAllMocks();
});
function plan(): GroupContainerPlan {
  return {
    context: {
      installationId: randomUUID(),
      groupId: randomUUID(),
      memberId: randomUUID(),
      contextId: randomUUID(),
      visibility: 'private',
    },
    image: 'sha256:' + 'a'.repeat(64),
    workspace: '/synthetic/group/workspace',
    reads: ['/synthetic/group/read'],
    expiresAt: Date.now() + 60000,
    cpuCores: 2,
    memoryMb: 1024,
    outbound: [{ host: 'chatgpt.com', ports: [443] }],
  };
}
function fixtureInspect(p: GroupContainerPlan, volume: string) {
  const spec = groupContainerSpec(p, volume, {});
  return {
    Id: 'b'.repeat(64),
    Config: {
      ...spec,
      Labels: {
        'io.sciencewithagents.group-context': p.context.contextId,
        'io.sciencewithagents.group-runtime-schema': '1',
      },
    },
    HostConfig: { ...spec.HostConfig, PortBindings: {}, Devices: [], DeviceRequests: [] },
    State: { Running: false, Status: 'exited' },
    Mounts: spec.HostConfig.Mounts.map((m) => ({
      Type: m.Type,
      Source: m.Source,
      Destination: m.Target,
      RW: !m.ReadOnly,
      ...(m.Type === 'volume' ? { Name: volume, Driver: 'local' } : {}),
    })),
  };
}
it('guest spec preserves privacy and uses only the admitted CPU/memory estimate', () => {
  const p = plan(),
    spec = groupContainerSpec(p, `swa-group-${randomUUID()}`, {});
  expect(spec.HostConfig.NetworkMode).toBe('none');
  expect(spec.HostConfig.PidMode).toBe('');
  expect(spec.HostConfig.Privileged).toBe(false);
  expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
  expect(spec.HostConfig.CapDrop).toEqual(['ALL']);
  expect(spec.HostConfig.CapAdd).toEqual(['CHOWN']);
  expect(spec.HostConfig.NanoCpus).toBe(2e9);
  expect(spec.HostConfig.Memory).toBe(1024 * 1048576);
  expect(spec.HostConfig.Mounts[0]?.ReadOnly).toBe(true);
  expect(spec.HostConfig.RestartPolicy.Name).toBe('no');
  expect(spec.StdinOnce).toBe(true);
  expect(spec.HostConfig.LogConfig.Type).toBe('none');
});
it('syscalls keep upstream deny-default and explicitly permit nested user/mount namespaces', () => {
  const profile = JSON.parse(groupContainerSeccomp());
  expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  expect(profile.syscalls.at(-1).names).toContain('unshare');
  expect(profile.syscalls.at(-1).names).toContain('mount');
  expect(profile.syscalls.at(-1).names).not.toContain('bpf');
  expect(groupContainerSourceDigest()).toMatch(/^[a-f0-9]{64}$/);
});
it.each([
  'network',
  'pid',
  'caps',
  'socket',
  'write',
  'resources',
  'entrypoint',
  'seccomp',
] as const)('rejects changed %s isolation', (change) => {
  const p = plan(),
    volume = `swa-group-${randomUUID()}`,
    raw = fixtureInspect(p, volume);
  if (change === 'network') raw.HostConfig.NetworkMode = 'host';
  if (change === 'pid') raw.HostConfig.PidMode = 'host';
  if (change === 'caps') raw.HostConfig.CapAdd.push('SYS_ADMIN');
  if (change === 'socket')
    raw.Mounts.push({
      Type: 'bind',
      Source: '/var/run/docker.sock',
      Destination: '/control',
      RW: true,
    });
  if (change === 'write') raw.Mounts[0]!.RW = true;
  if (change === 'resources') raw.HostConfig.Memory++;
  if (change === 'entrypoint') raw.Config.Entrypoint = ['/bin/sh'];
  if (change === 'seccomp') raw.HostConfig.SecurityOpt = ['seccomp=unconfined'];
  expect(() => assertGroupContainerInspection(raw, p, volume)).toThrow();
});
it('expired stopped namespace remains inspectable without admitting a new launch', () => {
  const p = plan(),
    volume = `swa-group-${randomUUID()}`,
    raw = fixtureInspect(p, volume);
  Object.assign(p, { expiresAt: Date.now() - 1 });
  raw.Config.Cmd = [String(p.expiresAt)];
  expect(assertGroupContainerInspection(raw, p, volume).State.Running).toBe(false);
  expect(() => groupContainerSpec(p, volume, {})).toThrow();
});
it('real metadata guards deny external symlink, hardlink and replaced root', () => {
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/container-mounts-'));
  roots.push(root);
  const workspace = join(root, 'workspace'),
    state = join(root, 'state'),
    privateRoot = join(root, 'private');
  [workspace, state, privateRoot].forEach((p) => mkdirSync(p, { mode: 0o700 }));
  const privateFile = join(privateRoot, 'unread-canary');
  writeFileSync(privateFile, 'synthetic');
  symlinkSync(privateFile, join(workspace, 'alias'));
  expect(() => groupResourceMounts(workspace, [], state, [privateRoot])).toThrow(/symlink/);
  rmSync(join(workspace, 'alias'));
  linkSync(privateFile, join(workspace, 'alias'));
  expect(() => groupResourceMounts(workspace, [], state, [privateRoot])).toThrow(/Hard-linked/);
  rmSync(join(workspace, 'alias'));
  const admitted = groupResourceMounts(workspace, [], state, [privateRoot]);
  writeFileSync(join(workspace, 'ordinary-edit'), 'still the admitted directory');
  expect(() => admitted.check()).not.toThrow();
  // Linux may immediately reuse the deleted directory's inode. Its creation
  // generation must still differ, while ordinary directory edits remain valid.
  rmSync(workspace, { recursive: true });
  mkdirSync(workspace);
  expect(() => admitted.check()).toThrow(/identity/);
});
it('unfinished frames are bounded before newline', () => {
  const stream = new PassThrough(),
    stop = vi.fn();
  boundGroupLines(stream, 8, stop);
  stream.write('1234');
  stream.write('56789');
  expect(stop).toHaveBeenCalledOnce();
});
it('unit lifecycle retains uncertainty when exact namespace stop fails', async () => {
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/container-stop-'));
  roots.push(root);
  const engine = new GroupDockerEngine(),
    p = plan(),
    record = vi.fn();
  vi.spyOn(engine, 'create').mockResolvedValue('b'.repeat(64));
  vi.spyOn(engine, 'inspect').mockResolvedValue({
    Id: 'b'.repeat(64),
    Config: { Labels: {}, OpenStdin: true, StdinOnce: true, Tty: false },
    HostConfig: {
      NetworkMode: 'none',
      PidMode: '',
      IpcMode: 'private',
      Privileged: false,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: 'no' },
    },
    State: { Running: true, Status: 'running' },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  vi.spyOn(engine, 'attach').mockImplementation(() => {
    setImmediate(() =>
      child.stdout!.emit(
        'data',
        Buffer.from('{"type":"ready","pid":1,"uid":0,"network":"none"}\n'),
      ),
    );
    return child;
  });
  vi.spyOn(engine, 'exec').mockReturnValue(child);
  vi.spyOn(engine, 'stop').mockRejectedValue(new Error('synthetic unavailable'));
  const container = new GroupContainer(engine, p, () => {}, root, record);
  await container.start();
  await expect(container.close()).rejects.toBeInstanceOf(GroupNamespaceStopUnverified);
  expect(record).toHaveBeenCalledWith(
    'container-stop-unverified',
    expect.objectContaining({ container: 'b'.repeat(64) }),
  );
  expect(record.mock.calls.some(([kind]) => kind === 'container-stopped')).toBe(false);
});

it('public-only pinned build recipe uses an empty owned Docker config and refuses populated config', () => {
  mkdirSync('data/tests', { recursive: true });
  const root = realpathSync.native(mkdtempSync('data/tests/image-recipe-'));
  roots.push(root);
  const config = join(root, 'config');
  mkdirSync(config, { mode: 0o700 });
  const recipe = groupContainerBuildRecipe(config, '/var/run/docker.sock');
  expect(recipe.executable).toBe('/usr/local/bin/docker');
  expect(recipe.args.at(-1)).toMatch(/\/runtime\/group-native\/$/);
  expect(recipe.args).toContain('linux/arm64');
  expect(recipe.environment).toEqual({
    PATH: '/usr/bin:/bin',
    HOME: config,
    DOCKER_CONFIG: config,
  });
  expect(recipe.tag).toMatch(/:[a-f0-9]{64}$/);
  writeFileSync(join(config, 'synthetic-existing-config'), 'not read');
  expect(() => groupContainerBuildRecipe(config, '/var/run/docker.sock')).toThrow(/Fresh private/);
});

it('chat-first guest needs no ambient host input: only its private guest volume is mounted', () => {
  const p = { ...plan(), workspace: null, reads: [] };
  const volume = `swa-group-${randomUUID()}`,
    spec = groupContainerSpec(p, volume, {});
  expect(spec.HostConfig.Mounts).toEqual([
    { Type: 'volume', Source: volume, Target: '/home/agent', VolumeOptions: { NoCopy: true } },
  ]);
});
