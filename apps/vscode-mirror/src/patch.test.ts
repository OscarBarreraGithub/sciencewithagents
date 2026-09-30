import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { bridgeSymbol, patchedSource, patch, restore } from './patch.js';

// Synthetic contract only. Never redistribute a provider-owned JavaScript bundle.
const source = `var Connection = class {
  providers = new Map; initialized = false;
  constructor(uri, options) { this.uri = uri; this.options = options; options.constructed++; }
  registerProvider() {} sendRequest() {} sendProviderRequest() {}
};
globalThis.activate = function(context, options) {
  const connection = new Connection(context.extensionUri, options);
  context.subscriptions.push(connection);
  return connection;
};`;
const roots: string[] = [];
const reference = (scope: object) =>
  runInNewContext(`globalThis[Symbol.for(${JSON.stringify(bridgeSymbol)})]`, scope);
const vm = (script: string) => {
  const scope = {
    activate: undefined as unknown as (context: unknown, options: unknown) => unknown,
  };
  runInNewContext(script, scope);
  return scope;
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-codex-patch-'));
  roots.push(root);
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: 'future-version' }));
  const file = join(root, 'out/extension.js');
  await writeFile(file, source);
  return { root, file, backup: `${file}.agent-dock-mirror-original` };
}

describe('Codex structural compatibility', () => {
  it.each(['26.908.40401', '26.909.1', '99.1.0-future'])(
    'accepts a compatible connection without release/hash pinning: %s',
    (version) => {
      const scope = vm(patchedSource(source, version));
      const context = { extensionUri: 'fixture', subscriptions: [] as unknown[] };
      const options = { constructed: 0 };
      const connection = scope.activate(context, options);
      expect(options.constructed).toBe(1);
      expect(context.subscriptions.at(-1)).toBe(connection);
      expect(reference(scope)).toBe(connection);
      (context.subscriptions[0] as { dispose(): void }).dispose();
      expect(reference(scope)).toBeUndefined();
    },
  );
  it('tolerates minifier renames, whitespace and unrelated bundle changes', () => {
    const changed =
      source.replaceAll('Connection', 'Y7$').replaceAll('context', '$') +
      '\n// unrelated change in a newer build';
    const scope = vm(patchedSource(changed, 'new'));
    const context = { extensionUri: 'fixture', subscriptions: [] as unknown[] };
    expect(reference(scope)).toBeUndefined();
    expect(scope.activate(context, { constructed: 0 })).toBe(reference(scope));
  });
  it('supports declared, named expression and assigned classes', () => {
    for (const changed of [
      source.replace('var Connection = class {', 'class Connection {'),
      source.replace('var Connection = class {', 'var Connection = class Internal {'),
      source.replace('var Connection = class {', 'let Connection; Connection = class {'),
    ]) {
      const scope = vm(patchedSource(changed, 'new'));
      const context = { extensionUri: 'fixture', subscriptions: [] as unknown[] };
      expect(scope.activate(context, { constructed: 0 })).toBe(reference(scope));
    }
  });
  it('ignores fake anchors or matching source inside strings/comments', () => {
    for (const changed of [
      JSON.stringify(source),
      `/* ${source} */`,
      'let b=new vI(t.extensionUri,c);e.push(b);',
    ])
      expect(() => patchedSource(changed, 'new')).toThrow('not supported');
  });
  it('rejects missing or ambiguous capabilities and invalid construction/syntax', () => {
    for (const changed of [
      source.replace('providers', 'removed'),
      source.replace('providers = new Map', 'static providers = new Map'),
      source.replace('new Map', 'new Set'),
      source.replace('initialized', 'removed'),
      source.replace('sendProviderRequest()', 'removed()'),
      source + '\nnew Connection(context.extensionUri, options);',
      source + '\n' + source.replaceAll('Connection', 'Other'),
      source.replace('context.extensionUri', 'context.otherProperty'),
      source + 'this is not valid JavaScript',
    ])
      expect(() => patchedSource(changed, 'future')).toThrow('Nothing was changed');
  });
  it('does not shadow a provider identifier with the injected hook parameter', () => {
    const changed = source.replaceAll('context', '__agentDockConnection');
    const scope = vm(patchedSource(changed, 'future'));
    const context = { extensionUri: 'fixture', subscriptions: [] as unknown[] };
    expect(scope.activate(context, { constructed: 0 })).toBe(reference(scope));
  });
  it('native construction still succeeds if the optional bridge cannot be exposed', () => {
    const scope =
      vm(`Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(bridgeSymbol)}), {
      set() { throw new Error('fixture failure'); }
    });\n${patchedSource(source, 'future')}`);
    const context = { extensionUri: 'fixture', subscriptions: [] as unknown[] };
    const options = { constructed: 0 };
    const connection = scope.activate(context, options);
    expect(options.constructed).toBe(1);
    expect(context.subscriptions.at(-1)).toBe(connection);
  });
  it('an older disposable cannot clear a replacement connection', () => {
    const scope = vm(patchedSource(source, 'future'));
    const context = { extensionUri: 'fixture', subscriptions: [] as unknown[] };
    scope.activate(context, { constructed: 0 });
    const replacement = scope.activate(context, { constructed: 0 });
    (context.subscriptions[0] as { dispose(): void }).dispose();
    expect(reference(scope)).toBe(replacement);
  });
});

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
  'Codex file preservation',
  () => {
    it('backs up exactly, patches idempotently, restores and reapplies a future compatible build', async () => {
      const f = await fixture();
      expect(await patch(f.root)).toBe('patched');
      expect(await readFile(f.backup, 'utf8')).toBe(source);
      expect(await patch(f.root)).toBe('already-patched');
      await restore(f.root);
      expect(await readFile(f.file, 'utf8')).toBe(source);
      await restore(f.root);
      expect(await patch(f.root)).toBe('patched');
      expect(await readdir(join(f.root, 'out'))).toEqual([
        'extension.js',
        'extension.js.agent-dock-mirror-original',
      ]);
    });
    it('preserves subsequent edits and refuses a mismatched existing backup', async () => {
      const f = await fixture();
      await patch(f.root);
      const changed = (await readFile(f.file, 'utf8')) + '\n// third-party edit';
      await writeFile(f.file, changed);
      await expect(patch(f.root)).rejects.toThrow('modified');
      await expect(restore(f.root)).rejects.toThrow('Nothing was restored');
      expect(await readFile(f.file, 'utf8')).toBe(changed);
      expect(await readFile(f.backup, 'utf8')).toBe(source);
      await writeFile(f.file, source);
      await writeFile(f.backup, 'unrelated original');
      await expect(patch(f.root)).rejects.toThrow();
      expect(await readFile(f.file, 'utf8')).toBe(source);
      expect(await readFile(f.backup, 'utf8')).toBe('unrelated original');
    });
    it('does not write a backup or alter an incompatible build', async () => {
      const f = await fixture();
      await writeFile(f.file, 'const unrelated = true;');
      await expect(patch(f.root)).rejects.toThrow('future-version');
      expect(await readFile(f.file, 'utf8')).toBe('const unrelated = true;');
      await expect(readFile(f.backup)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('rejects linked provider files and linked backups', async () => {
      const f = await fixture();
      await rm(f.file);
      await symlink(join(f.root, 'package.json'), f.file);
      await expect(patch(f.root)).rejects.toThrow('linked or non-regular');
      await rm(f.file);
      await writeFile(f.file, source);
      await symlink(f.file, f.backup);
      await expect(patch(f.root)).rejects.toThrow('linked or non-regular');
      expect(await readFile(f.file, 'utf8')).toBe(source);
    });
  },
);
