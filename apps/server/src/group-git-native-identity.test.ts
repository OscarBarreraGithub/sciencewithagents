import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openNativeGitHubIdentity } from './group-git-native-identity.js';
it('uses only the pinned native auth command and redacts failures without real credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-git-native-identity-'));
  const path = join(root, 'gh');
  try {
    await writeFile(
      path,
      '#!/bin/sh\n[ "$*" = "auth token --hostname github.com" ] || exit 1\nprintf fixture-token\n',
      { mode: 0o700 },
    );
    const identity = await openNativeGitHubIdentity(path, '42');
    expect(await identity.resolve()).toEqual({ token: 'fixture-token', accountId: '42' });
    await writeFile(path, '#!/bin/sh\nprintf secret-on-error >&2\nexit 1\n');
    await expect(identity.resolve()).rejects.toThrow('executable changed');
    const failing = await openNativeGitHubIdentity(path, '42');
    await expect(failing.resolve()).rejects.toThrow('sign-in unavailable');
    await chmod(path, 0o777);
    await expect(openNativeGitHubIdentity(path, '42')).rejects.toThrow('Trusted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
