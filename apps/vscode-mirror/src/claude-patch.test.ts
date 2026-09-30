import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  claudeBridgeSymbol,
  patchedClaudeSource,
  patchClaude,
  restoreClaude,
} from './claude-patch.js';

// Deliberately synthetic; no provider-owned bundle is redistributed with the tests.
const source = `class Host {
  allComms = new Set; sessionStates = new Map;
  constructor(uri, context) { this.uri = uri; context.constructed++; }
}
globalThis.activate = function(ctx) {
  const host = new Host(ctx.extensionUri, ctx);
  ctx.subscriptions.push(host);
  return host;
};`;
const roots: string[] = [];
const reference = (scope: object) =>
  runInNewContext(`globalThis[Symbol.for(${JSON.stringify(claudeBridgeSymbol)})]`, scope);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-claude-patch-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: 'future-version' }));
  await writeFile(join(root, 'extension.js'), source);
  return {
    root,
    file: join(root, 'extension.js'),
    backup: join(root, 'extension.js.agent-dock-mirror-original'),
  };
}

describe('Claude structural compatibility', () => {
  it.each(['2.1.273', '2.1.274', '99.1.0-future'])(
    'accepts compatible structure regardless of version %s',
    (version) => {
      const patched = patchedClaudeSource(source, version);
      const scope = { activate: undefined as unknown as (ctx: unknown) => unknown };
      runInNewContext(patched, scope);
      const context = { extensionUri: 'fixture', constructed: 0, subscriptions: [] as unknown[] };
      const host = scope.activate(context);
      expect(context.constructed).toBe(1);
      expect(context.subscriptions.at(-1)).toBe(host);
      expect(reference(scope)).toBe(host);
      (context.subscriptions[0] as { dispose(): void }).dispose();
      expect(reference(scope)).toBeUndefined();
    },
  );
  it('tolerates minifier renames, unrelated edits and whitespace', () => {
    const changed =
      source.replaceAll('Host', 'Y7$').replaceAll('ctx', '$').replaceAll('host', 'U') +
      '\n// unrelated provider update';
    expect(patchedClaudeSource(changed, 'new')).toContain('// unrelated provider update');
  });
  it('does not mistake matching text inside strings or comments for executable structure', () => {
    expect(() => patchedClaudeSource(JSON.stringify(source), 'new')).toThrow(
      'internal connection layout',
    );
    expect(() => patchedClaudeSource(`/* ${source} */`, 'new')).toThrow(
      'internal connection layout',
    );
  });
  it('rejects absent, ambiguous, syntactically broken or changed host construction', () => {
    for (const changed of [
      source.replace('allComms', 'removed'),
      source + '\nnew Host(context.extensionUri, context);',
      source + '\nclass Other {allComms = new Set; sessionStates = new Map;}',
      source.replace('new Host(ctx.extensionUri, ctx)', 'new Host(other.extensionUri, ctx)'),
      source + 'this is not valid JavaScript',
    ])
      expect(() => patchedClaudeSource(changed, 'future')).toThrow('Nothing was changed');
  });
  it('does not stop native activation when exposing the bridge fails', () => {
    const scope = { activate: undefined as unknown as (ctx: unknown) => unknown };
    runInNewContext(
      `Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(claudeBridgeSymbol)}), { set() { throw new Error('fixture failure'); } });`,
      scope,
    );
    runInNewContext(patchedClaudeSource(source, 'future'), scope);
    const context = { extensionUri: 'fixture', constructed: 0, subscriptions: [] as unknown[] };
    const host = scope.activate(context);
    expect(context.constructed).toBe(1);
    expect(context.subscriptions).toEqual([host]);
  });
  it('an old disposable cannot clear a replacement host reference', () => {
    const scope = { activate: undefined as unknown as (ctx: unknown) => unknown };
    runInNewContext(patchedClaudeSource(source, 'future'), scope);
    const context = { extensionUri: 'fixture', constructed: 0, subscriptions: [] as unknown[] };
    scope.activate(context);
    const second = scope.activate(context);
    (context.subscriptions[0] as { dispose(): void }).dispose();
    expect(reference(scope)).toBe(second);
  });
});

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
  'Claude file preservation',
  () => {
    it('keeps an exact backup, is idempotent, and restores a future compatible version exactly', async () => {
      const f = await fixture();
      expect(await patchClaude(f.root)).toBe('patched');
      expect(await readFile(f.backup, 'utf8')).toBe(source);
      expect(await patchClaude(f.root)).toBe('already-patched');
      await restoreClaude(f.root);
      expect(await readFile(f.file, 'utf8')).toBe(source);
      await restoreClaude(f.root);
      expect(await patchClaude(f.root)).toBe('patched');
    });
    it('refuses to overwrite subsequent foreign edits during patch or restore', async () => {
      const f = await fixture();
      await patchClaude(f.root);
      const changed = (await readFile(f.file, 'utf8')) + '\n// third-party change';
      await writeFile(f.file, changed);
      await expect(patchClaude(f.root)).rejects.toThrow('modified');
      await expect(restoreClaude(f.root)).rejects.toThrow('Nothing was restored');
      expect(await readFile(f.file, 'utf8')).toBe(changed);
      expect(await readFile(f.backup, 'utf8')).toBe(source);
    });
    it('does not overwrite a different existing backup', async () => {
      const f = await fixture();
      await writeFile(f.backup, 'different original');
      await expect(patchClaude(f.root)).rejects.toThrow();
      expect(await readFile(f.file, 'utf8')).toBe(source);
      expect(await readFile(f.backup, 'utf8')).toBe('different original');
    });
    it('leaves incompatible files unchanged and does not create a backup', async () => {
      const f = await fixture();
      await writeFile(f.file, 'const unrelated = true;');
      await expect(patchClaude(f.root)).rejects.toThrow('future-version');
      expect(await readFile(f.file, 'utf8')).toBe('const unrelated = true;');
      await expect(readFile(f.backup)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('rejects linked extension files', async () => {
      const f = await fixture();
      await rm(f.file);
      await symlink(join(f.root, 'package.json'), f.file);
      await expect(patchClaude(f.root)).rejects.toThrow('linked or non-regular');
    });
  },
);
