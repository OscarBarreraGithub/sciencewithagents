import { it, expect } from 'vitest';
import { homedir } from 'node:os';
import { updatePlan } from './provider-maintenance.js';
it('uses only the matching installer and leaves embedded/custom providers alone', () => {
  const find = (name: string) => `/installed/${name}`;
  expect(
    updatePlan('codex', '/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/1/codex', find)
      ?.args,
  ).toEqual(['upgrade', '--cask', 'codex']);
  expect(
    updatePlan('claude', '/bin/claude', '/opt/homebrew/Caskroom/claude-code@latest/1/claude', find)
      ?.args,
  ).toEqual(['upgrade', '--cask', 'claude-code@latest']);
  expect(
    updatePlan(
      'codex',
      '/custom/bin/codex',
      '/custom/lib/node_modules/@openai/codex/bin/codex.js',
      find,
    )?.args,
  ).toEqual(['install', '--global', '--prefix', '/custom', '@openai/codex@latest']);
  expect(
    updatePlan('claude', '/bin/claude', `${homedir()}/.local/share/claude/versions/1.2.3`, find)
      ?.args,
  ).toEqual(['update']);
  expect(
    updatePlan('codex', '/app/codex', '/Applications/Codex.app/Contents/bin/codex', find),
  ).toBeNull();
  expect(updatePlan('codex', '/x', '/opt/homebrew/Caskroom/codex/1/codex', () => null)).toBeNull();
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { ProviderMaintenance } from './provider-maintenance.js';
it('waits for active work, blocks new admissions and does not repeat a receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-update-'));
  const store = new Store(join(root, 'db'));
  try {
    const target = join(root, 'lib/node_modules/@openai/codex/bin/codex.js');
    mkdirSync(join(root, 'lib/node_modules/@openai/codex/bin'), { recursive: true });
    writeFileSync(target, 'fixture', { mode: 0o700 });
    const entry = join(root, 'codex');
    symlinkSync(target, entry);
    let active = true;
    let versions = 0;
    const calls: string[][] = [];
    const updater = new ProviderMaintenance(
      store,
      { codex: entry, claude: 'missing' },
      () => active,
      async () => {},
      async (_bin, args) => {
        calls.push(args);
        return args[0] === '--version' ? (++versions === 1 ? 'codex 1.0.0' : 'codex 1.1.0') : '';
      },
    );
    const input = { key: randomUUID(), provider: 'codex' };
    expect(updater.request(input).state).toBe('waiting');
    expect(calls).toHaveLength(0);
    expect(updater.blocks('codex')).toBe(true);
    active = false;
    updater.tick();
    await updater.close();
    expect(updater.status('codex')).toMatchObject({
      state: 'updated',
      before: '1.0.0',
      after: '1.1.0',
    });
    const retry = new ProviderMaintenance(
      store,
      { codex: entry, claude: 'missing' },
      () => false,
      async () => {},
      async () => {
        throw Error('must not replay');
      },
    );
    expect(retry.request(input).state).toBe('updated');
    await retry.close();
    expect(calls.filter((a) => a[0] === 'install')).toHaveLength(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('a restart during installation requires inspection instead of replaying an uncertain update', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-recovery-'));
  const store = new Store(join(root, 'db'));
  try {
    store.setSetting('provider:update:codex', {
      provider: 'codex',
      state: 'updating',
      message: 'Updating',
      before: '1.0.0',
      after: null,
      checkedAt: null,
      command: null,
    });
    const updater = new ProviderMaintenance(
      store,
      { codex: 'codex', claude: 'claude' },
      () => false,
      async () => {},
    );
    expect(updater.status('codex').state).toBe('needs-help');
    expect(updater.blocks('codex')).toBe(false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
