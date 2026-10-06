import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { patch, restore } from './patch.js';
import { patchClaude, restoreClaude } from './claude-patch.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root = '';
let server: Server | undefined;
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
const providers = [
  {
    name: 'Codex',
    patch,
    restore,
    file: 'out/extension.js',
    source: `class Connection {
      providers = new Map; initialized = false;
      registerProvider() {} sendRequest() {} sendProviderRequest() {}
    }
    function activate(context) { return new Connection(context.extensionUri, {}); }`,
  },
  {
    name: 'Claude',
    patch: patchClaude,
    restore: restoreClaude,
    file: 'extension.js',
    source: `class Host { allComms = new Set; sessionStates = new Map; }
    function activate(context) { return new Host(context.extensionUri, context); }`,
  },
];
async function fixture(provider: (typeof providers)[number]) {
  root = mkdtempSync(process.platform === 'darwin' ? '/private/tmp/swa-setup-' : '/tmp/swa-setup-');
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 'future-version' }));
  const file = join(root, provider.file);
  writeFileSync(file, provider.source);
  const socketPath = join(root, 'bridge.sock');
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  return { file, socketPath, backup: file + '.agent-dock-mirror-original' };
}

describe.runIf(process.platform !== 'win32')('explicit remote provider setup', () => {
  it.each(providers)(
    'prepares and restores $name on Linux through a checked Unix socket',
    async (p) => {
      const f = await fixture(p);
      await expect(p.patch(root)).rejects.toThrow('Local setup');
      expect(await p.patch(root, f.socketPath)).toBe('patched');
      expect(readFileSync(f.backup, 'utf8')).toBe(p.source);
      expect(await p.patch(root, f.socketPath)).toBe('already-patched');
      await p.restore(root);
      expect(readFileSync(f.file, 'utf8')).toBe(p.source);
    },
  );
  it.each(providers)(
    'verifies an exact existing $name hook at startup while its forward is absent',
    async (p) => {
      const f = await fixture(p);
      await p.patch(root, f.socketPath);
      const prepared = readFileSync(f.file, 'utf8');
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      expect(await p.patch(root, f.socketPath)).toBe('already-patched');
      expect(readFileSync(f.file, 'utf8')).toBe(prepared);
      expect(readFileSync(f.backup, 'utf8')).toBe(p.source);
      await expect(p.patch(root, root + '/out/../bridge.sock')).rejects.toThrow('canonical');
    },
  );
  it.each(providers)(
    'refuses unsafe $name setup before creating a backup or changing provider bytes',
    async (p) => {
      const f = await fixture(p);
      chmodSync(f.socketPath, 0o666);
      await expect(p.patch(root, f.socketPath)).rejects.toThrow('0600');
      chmodSync(f.socketPath, 0o600);
      await expect(p.patch(root, root + '/out/../bridge.sock')).rejects.toThrow('canonical');
      await expect(p.patch(root, root + '/missing.sock')).rejects.toThrow();
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      await expect(p.patch(root, f.socketPath)).rejects.toThrow('Unix socket');
      expect(readFileSync(f.file, 'utf8')).toBe(p.source);
      expect(() => readFileSync(f.backup)).toThrow();
    },
  );
});
