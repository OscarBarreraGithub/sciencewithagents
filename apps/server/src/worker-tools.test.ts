import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { workerToolsSchema, projectToolsSchema } from '@dock/shared';
import { Store } from './store.js';
import { delegationTools, projectTools } from './worker-tools.js';
import { repoRoot } from './paths.js';

let root: string, store: Store;
afterEach(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('retains project-specific ceilings through restart without extending saved-index access to live search', () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/worker-tools-'));
  const database = join(root, 'dock.sqlite');
  store = new Store(database);
  const p = store.register(root, 'Tool project', '', 'codex');
  const other = store.register(join(root, 'other'), 'Other', '', 'codex');
  const codex = workerToolsSchema.parse({ webSearch: 'indexed', mcpServers: ['research'] });
  store.setSetting(`worker-tools:${p.id}`, projectToolsSchema.parse({ revision: 5, codex }));
  store.close();
  store = new Store(database);
  expect(projectTools(store, p.id).revision).toBe(5);
  expect(delegationTools(store, p.id, 'codex', codex).tools).toEqual(codex);
  expect(
    delegationTools(store, p.id, 'codex', { ...codex, webSearch: 'cached' }).tools.webSearch,
  ).toBe('cached');
  expect(() => delegationTools(store, p.id, 'codex', { ...codex, webSearch: 'live' })).toThrow(
    'allowance',
  );
  expect(() => delegationTools(store, other.id, 'codex', codex)).toThrow('allowance');
  expect(() => delegationTools(store, p.id, 'claude', codex)).toThrow('require a Codex');
  expect(delegationTools(store, p.id, 'claude').tools).toEqual(workerToolsSchema.parse({}));
  expect(delegationTools(store, p.id, 'claude').toolPolicy).toBe('restricted');
  // An explicit restoration survives restart, without deleting the old restricted ceiling.
  store.setSetting(
    `worker-tools:${p.id}`,
    projectToolsSchema.parse({ revision: 6, toolPolicy: 'native', codex }),
  );
  store.close();
  store = new Store(database);
  for (const provider of ['codex', 'claude'] as const)
    expect(delegationTools(store, p.id, provider)).toMatchObject({
      revision: 6,
      toolPolicy: 'native',
    });
  expect(delegationTools(store, p.id, 'codex', codex).toolPolicy).toBe('restricted');
  expect(() => delegationTools(store, p.id, 'codex', { ...codex, webSearch: 'live' })).toThrow(
    'allowance',
  );
});
