import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GroupHost } from './group-host.js';

it('fresh Groups has no maintainer service or network calls, while retained beta work keeps its original default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-own-cloudflare-'));
  const http = vi.fn<typeof fetch>();
  const host = new GroupHost(root, { http });
  try {
    expect(host.configuration()).toBeNull();
    expect((await host.list()).service).toMatchObject({
      configured: false,
      setupCodeRequired: false,
    });
    await expect(
      host.create({ key: crypto.randomUUID(), projectName: 'Own service', displayName: 'Owner' }),
    ).rejects.toMatchObject({ code: 'GROUP_SETUP_REQUIRED' });
    expect(http).not.toHaveBeenCalled();
    host.db
      .prepare('INSERT INTO gh_operations VALUES (?,?,?)')
      .run('old-beta-request', '{}', '{"beta":{}}');
    expect(host.configuration()?.mode).toBe('beta');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
