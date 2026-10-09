import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repoRoot } from './paths.js';
import {
  readNativeConnectionProfiles,
  saveNativeConnectionProfiles,
  nativeConnectionsConfigSchema,
} from './native-connections-config.js';
const roots: string[] = [];
function directory() {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  const root = mkdtempSync(join(repoRoot, 'data/tests/native-profiles-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('resolves documented default socket directories without inheriting active tmux or Herdr session markers, preserving saved IDs and paths', () => {
  const root = directory(),
    nativeRoot = directory();
  vi.stubEnv('TMUX_TMPDIR', nativeRoot);
  vi.stubEnv('XDG_CONFIG_HOME', nativeRoot);
  vi.stubEnv('TMPDIR', '/unrelated/macos-temporary');
  vi.stubEnv('TMUX', '/wrong/parent.sock,100,0');
  vi.stubEnv('HERDR_SOCKET_PATH', '/wrong/parent.sock');
  vi.stubEnv('HERDR_SESSION', 'parent');
  const profiles = readNativeConnectionProfiles(root);
  expect(profiles[0]!.socket).toBe(join(nativeRoot, `tmux-${process.getuid?.()}`, 'default'));
  expect(profiles[1]!.socket).toBe(join(nativeRoot, 'herdr/herdr.sock'));
  vi.stubEnv('TMUX_TMPDIR', '/changed');
  vi.stubEnv('XDG_CONFIG_HOME', '/changed');
  expect(readNativeConnectionProfiles(root)).toEqual(profiles);
});
it('accepts only explicit private host profiles and never changes the SSH or native configuration', () => {
  const root = directory(),
    input = join(root, 'owner-input.json');
  const value = {
    version: 1,
    profiles: [
      {
        id: randomUUID(),
        kind: 'tmux',
        label: 'Trusted SSH',
        socket: '/tmp/owner.sock',
        sshAlias: 'configured-host',
        binary: '/usr/bin/tmux',
      },
    ],
  };
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  saveNativeConnectionProfiles(root, input);
  expect(readNativeConnectionProfiles(root)).toEqual(value.profiles);
  expect(readFileSync(input, 'utf8')).toBe(JSON.stringify(value));
  expect(
    nativeConnectionsConfigSchema.safeParse({
      ...value,
      profiles: [{ ...value.profiles[0], sshAlias: 'host; touch /tmp/untrusted' }],
    }).success,
  ).toBe(false);
  expect(
    nativeConnectionsConfigSchema.safeParse({
      ...value,
      profiles: [{ ...value.profiles[0], command: 'shell command' }],
    }).success,
  ).toBe(false);
});
it('refuses public or symlink profile files before replacing an existing saved configuration', () => {
  const root = directory(),
    original = readNativeConnectionProfiles(root),
    input = join(root, 'input.json');
  writeFileSync(input, JSON.stringify({ version: 1, profiles: [] }), { mode: 0o600 });
  chmodSync(input, 0o644);
  expect(() => saveNativeConnectionProfiles(root, input)).toThrow('private');
  expect(readNativeConnectionProfiles(root)).toEqual(original);
  chmodSync(input, 0o600);
  const link = join(root, 'linked.json');
  symlinkSync(input, link);
  expect(() => saveNativeConnectionProfiles(root, link)).toThrow('private');
  expect(readNativeConnectionProfiles(root)).toEqual(original);
});
