import { expect, it, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { GroupHost } from './group-host.js';
import { repoRoot } from './paths.js';
import {
  groupServiceHash,
  readRegistryService,
  registerService,
} from '../../../scripts/group-service-registry.mjs';
import Fastify from 'fastify';
import { registerGroupHostRoutes } from './group-host-routes.js';
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

const memberService = (origin = 'https://groups.creator.workers.dev') => ({
  version: 1 as const,
  mode: 'hosted' as const,
  endpoint: `${origin}/`,
  endpointId: randomUUID(),
  hostingAuthorization: { origin, approvalCapability: secret(), freeApprovalId: randomUUID() },
});
const invite = (
  service: ReturnType<typeof memberService>,
  groupId = randomUUID(),
  origin = service.hostingAuthorization.origin,
) =>
  `${origin}/join#/groups?invite=${encodeURIComponent(JSON.stringify({ groupId, secret: secret(), name: 'Intended group', service }))}`;

it.each([false, true])(
  'ordinary authenticated Join registers another creator directly and retries after restart (existing=%s)',
  async (existing) => {
    const root = mkdtempSync(join(tmpdir(), 'swa-direct-join-'));
    const service = memberService(),
      own = { ...memberService('https://own.creator.workers.dev'), setupCapability: secret() };
    const http = vi.fn<typeof fetch>();
    let host = new GroupHost(root, { http, betaProfile: null });
    vi.spyOn(host.updates, 'watch').mockImplementation(() => {});
    const file = join(host.directory, 'service.json');
    if (existing) writeFileSync(file, JSON.stringify(own), { mode: 0o600 });
    const original = existing ? readFileSync(file, 'utf8') : null;
    const invitation = invite(service),
      key = randomUUID();
    const app = Fastify();
    registerGroupHostRoutes(
      app,
      host,
      (request) => request.headers.authorization === 'Owner fixture',
    );
    try {
      const input = { key, displayName: 'Member', invitation };
      expect(
        (await app.inject({ method: 'POST', url: '/api/groups/join', payload: input })).statusCode,
      ).toBe(401);
      expect(existsSync(join(host.directory, 'services'))).toBe(false);
      http.mockRejectedValueOnce(new Error('lost join reply'));
      const failed = await app.inject({
        method: 'POST',
        url: '/api/groups/join',
        headers: { authorization: 'Owner fixture' },
        payload: input,
      });
      expect(failed.json().code).toBe('GROUP_SERVICE_UNAVAILABLE');
      expect(readRegistryService(host.directory, groupServiceHash(service))).toEqual(service);
      expect(readRegistryService(host.directory, groupServiceHash(service), true)).toBeNull();
      const retained = JSON.parse(
        String(host.db.prepare('SELECT body FROM gh_operations').get()!.body),
      );
      const first = http.mock.calls[0]!;
      expect(first[0]).toBe(
        `${service.hostingAuthorization.origin}/v1/groups/${retained.identity.groupId}`,
      );
      expect(new Headers(first[1]!.headers).get('X-Group-Setup')).toBeNull();
      expect(new Headers(first[1]!.headers).get('X-Hosting-Approval')).toBe(
        service.hostingAuthorization.approvalCapability,
      );
      expect(first[1]!.redirect).toBe('error');
      expect(first[1]!.credentials).toBe('omit');
      await app.close();
      await host.close();
      host = new GroupHost(root, { http, betaProfile: null });
      vi.spyOn(host.updates, 'watch').mockImplementation(() => {});
      http.mockImplementation(async () =>
        Response.json({
          ok: true,
          value: {
            kind: 'identity',
            identity: { ...retained.identity, state: 'active' },
          },
        }),
      );
      const joined = await host.join({ ...input, key: randomUUID() });
      expect(joined.group.state).toBe('active');
      const retried = http.mock.calls[1]!;
      expect(retried[0]).toBe(first[0]);
      expect(retried[1]!.body).toBe(first[1]!.body);
      expect(new Headers(retried[1]!.headers).get('Authorization')).toBe(
        new Headers(first[1]!.headers).get('Authorization'),
      );
      expect((await host.join(input)).group.handle).toBe(joined.group.handle);
      expect(readdirSync(join(host.directory, 'services'))).toEqual([
        `${groupServiceHash(service)}.member.json`,
      ]);
      if (existing) {
        expect(readFileSync(file, 'utf8')).toBe(original);
        expect(host.configuration()).toEqual(own);
      } else expect(existsSync(file)).toBe(false);
      expect(existsSync(join(host.directory, 'creator-service.json'))).toBe(false);
    } finally {
      await app.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('direct Join preserves protected approval, disabled configuration and retained missing routes before network', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-direct-guards-'));
  const service = memberService(),
    http = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  const host = new GroupHost(root, { http, betaProfile: null });
  try {
    registerService(host.directory, service);
    const original = readFileSync(
      join(host.directory, 'services', `${groupServiceHash(service)}.member.json`),
      'utf8',
    );
    await expect(
      host.join({
        key: randomUUID(),
        displayName: 'Member',
        invitation: invite({
          ...service,
          hostingAuthorization: { ...service.hostingAuthorization, approvalCapability: secret() },
        }),
      }),
    ).rejects.toMatchObject({ code: 'GROUP_INVITATION_SERVICE_CHANGED' });
    expect(
      readFileSync(
        join(host.directory, 'services', `${groupServiceHash(service)}.member.json`),
        'utf8',
      ),
    ).toBe(original);
    const disabled = JSON.stringify({ version: 1, mode: 'disabled' });
    writeFileSync(join(host.directory, 'service.json'), disabled, { mode: 0o600 });
    await expect(
      host.join({ key: randomUUID(), displayName: 'Member', invitation: invite(memberService()) }),
    ).rejects.toMatchObject({ code: 'GROUP_SETUP_REQUIRED' });
    expect(readFileSync(join(host.directory, 'service.json'), 'utf8')).toBe(disabled);
    expect(http).not.toHaveBeenCalled();
    rmSync(join(host.directory, 'service.json'));
    const invitation = invite(service),
      input = { key: randomUUID(), displayName: 'Member', invitation };
    await expect(host.join(input)).rejects.toMatchObject({ code: 'GROUP_SERVICE_UNAVAILABLE' });
    http.mockClear();
    rmSync(join(host.directory, 'services', `${groupServiceHash(service)}.member.json`));
    await expect(host.join(input)).rejects.toMatchObject({ code: 'GROUP_SERVICE_CHANGED' });
    expect(http).not.toHaveBeenCalled();
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ['https://groups.creator.workers.dev', 'https://other.creator.workers.dev', 'INVALID_INVITATION'],
  ['https://groups.creator.workers.dev:8443', undefined, 'GROUP_SERVICE_REGISTRATION_REQUIRED'],
  [
    'https://groups.creator.workers.dev.attacker.test',
    undefined,
    'GROUP_SERVICE_REGISTRATION_REQUIRED',
  ],
  ['https://127.0.0.1', undefined, 'INVALID_INVITATION'],
  ['https://service.local', undefined, 'INVALID_INVITATION'],
  ['https://groups.creator.workers.dev', 'http://groups.creator.workers.dev', 'INVALID_INVITATION'],
])('refuses an unsafe/unmatched automatic service: %s / %s', async (origin, envelope, code) => {
  const root = mkdtempSync(join(tmpdir(), 'swa-direct-origin-'));
  const http = vi.fn<typeof fetch>(),
    host = new GroupHost(root, { http, betaProfile: null });
  try {
    await expect(
      host.join({
        key: randomUUID(),
        displayName: 'Member',
        invitation: invite(memberService(origin), randomUUID(), envelope),
      }),
    ).rejects.toMatchObject({ code });
    expect(http).not.toHaveBeenCalled();
    expect(existsSync(join(host.directory, 'services'))).toBe(false);
    expect(host.db.prepare('SELECT count(*) n FROM gh_operations').get()!.n).toBe(0);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
