import { expect, it, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { GroupHost } from './group-host.js';
import { repoRoot } from './paths.js';
const secret = () => randomBytes(32).toString('hex');
it.each([true, false])(
  'trusted no-network member registration preserves creator configuration (existing=%s)',
  async (existing) => {
    const root = mkdtempSync(join(tmpdir(), 'swa-join-registration-'));
    const service = (origin: string) => ({
      version: 1,
      mode: 'hosted',
      endpoint: `${origin}/`,
      endpointId: randomUUID(),
      setupCapability: secret(),
      hostingAuthorization: { origin, approvalCapability: secret(), freeApprovalId: randomUUID() },
    });
    const creator = service('https://creator.example.invalid'),
      own = service('https://own.example.invalid');
    const http = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture offline'));
    const host = new GroupHost(root, { http });
    const file = join(host.directory, 'service.json');
    if (existing) writeFileSync(file, JSON.stringify(own), { mode: 0o600 });
    const original = existing ? readFileSync(file, 'utf8') : null;
    const { setupCapability: _private, ...descriptor } = creator;
    const invitation = `${creator.hostingAuthorization.origin}/join#/groups?invite=${encodeURIComponent(JSON.stringify({ groupId: randomUUID(), secret: secret(), name: 'Intended group', service: descriptor }))}`;
    const input = { key: randomUUID(), displayName: 'Existing name', invitation };
    try {
      await expect(host.join(input)).rejects.toMatchObject({
        code: 'GROUP_SERVICE_REGISTRATION_REQUIRED',
      });
      await expect(
        host.join({ ...input, key: randomUUID(), invitation: 'broken invitation' }),
      ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
      expect(http).not.toHaveBeenCalled();
      expect(host.db.prepare('SELECT count(*) n FROM gh_operations').get()?.n).toBe(0);
      const handoff = join(root, 'private-invitation.txt');
      writeFileSync(handoff, invitation, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/group-cloudflare-setup.mjs'), 'join', root, handoff],
        { encoding: 'utf8' },
      );
      rmSync(handoff);
      expect(result.status, result.stderr).toBe(0);
      expect(http).not.toHaveBeenCalled();
      if (existing) {
        expect(readFileSync(file, 'utf8')).toBe(original);
        expect(host.configuration()).toEqual(own);
      }
      const changed = `${creator.hostingAuthorization.origin}/join#/groups?invite=${encodeURIComponent(JSON.stringify({ groupId: randomUUID(), secret: secret(), name: 'Intended group', service: { ...descriptor, hostingAuthorization: { ...descriptor.hostingAuthorization, approvalCapability: secret() } } }))}`;
      await expect(
        host.join({ ...input, key: randomUUID(), invitation: changed }),
      ).rejects.toMatchObject({ code: 'GROUP_INVITATION_SERVICE_CHANGED' });
      expect(http).not.toHaveBeenCalled();
      await expect(host.join(input)).rejects.not.toMatchObject({
        code: 'GROUP_SERVICE_REGISTRATION_REQUIRED',
      });
      expect(http).toHaveBeenCalled();
      expect(String(http.mock.calls[0]![0])).toContain(creator.hostingAuthorization.origin);
      if (existing) expect(readFileSync(file, 'utf8')).toBe(original);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
