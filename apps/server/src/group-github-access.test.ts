import { expect, it, vi } from 'vitest';
import { GroupGitHubAccess, type GitHubRead } from './group-github-access.js';
const repo = { full_name: 'Owner/Repo', private: true, permissions: { push: true } };
function fixture(
  collaborators: unknown[] = [{ login: 'Confirmed' }],
  invitations: unknown[] = [{ invitee: { login: 'Pending' }, expired: false }],
) {
  return vi.fn<GitHubRead>(async ([path]) =>
    path === 'user'
      ? { login: 'Viewer' }
      : path === 'repos/owner/repo'
        ? repo
        : path.includes('/collaborators?')
          ? collaborators
          : invitations,
  );
}
it('coalesces native checks, confirms positives and only proves absence after full authorized lists', async () => {
  const read = fixture(),
    service = new GroupGitHubAccess(read);
  const [a, b] = await Promise.all([service.check('Owner/Repo'), service.check('owner/repo')]);
  expect(a).toEqual(b);
  expect(read).toHaveBeenCalledTimes(4);
  expect(a).toMatchObject({
    confirmed: ['confirmed'],
    invited: ['pending'],
    authoritative: true,
    viewer: 'Viewer',
  });
  expect(a.confirmed).not.toContain('missing');
  expect(a.invited).not.toContain('missing');
  await service.check('Owner/Repo');
  expect(read).toHaveBeenCalledTimes(4);
});
it.each(['user', 'repo', 'collaborators', 'invitations'])(
  'auth/private/network failure at %s never proves No access',
  async (where) => {
    const base = fixture();
    const service = new GroupGitHubAccess(async (args) => {
      const path = args[0];
      if ((where === 'repo' && path === 'repos/owner/repo') || path.includes(where))
        throw new Error('401/403/404/rate limit');
      return base(args);
    });
    const result = await service.check('owner/repo');
    expect(result.authoritative).toBe(false);
    if (where === 'invitations') expect(result.confirmed).toEqual(['confirmed']);
  },
);
it('enumerates later pages, bounds unknown tails and never reports false absence', async () => {
  const read = fixture();
  read.mockImplementation(async ([path]) =>
    path === 'user'
      ? { login: 'Viewer' }
      : path === 'repos/owner/repo'
        ? repo
        : path.includes('collaborators')
          ? path.endsWith('page=1')
            ? Array.from({ length: 100 }, (_, i) => ({ login: `user${i}` }))
            : [{ login: 'Later' }]
          : [],
  );
  const result = await new GroupGitHubAccess(read).check('owner/repo');
  expect(result.confirmed).toContain('later');
  expect(result.authoritative).toBe(true);
  read.mockImplementation(async ([path]) =>
    path === 'user'
      ? { login: 'Viewer' }
      : path === 'repos/owner/repo'
        ? repo
        : Array.from({ length: 100 }, (_, i) => ({ login: `user${i}` })),
  );
  const bounded = await new GroupGitHubAccess(read).check('owner/repo');
  expect(bounded.authoritative).toBe(false);
});
it('requires private repo and actual viewer write authority, and rejects path/command input', async () => {
  const read = fixture();
  read.mockImplementation(async ([path]) =>
    path === 'user' ? { login: 'Viewer' } : { ...repo, permissions: { push: false } },
  );
  expect((await new GroupGitHubAccess(read).check('owner/repo')).authoritative).toBe(false);
  expect(() => new GroupGitHubAccess(read).check('owner/../evil')).toThrow();
});

it('counts documented open invitations, excludes explicit expiry and rejects malformed expiry', async () => {
  const result = await new GroupGitHubAccess(
    fixture(
      [],
      [
        { invitee: { login: 'Expired' }, expired: true },
        { invitee: { login: 'Pending' }, expired: false },
        { invitee: { login: 'Open' } },
      ],
    ),
  ).check('owner/repo');
  expect(result.invited).toEqual(['pending', 'open']);
  expect(result.authoritative).toBe(true);
  expect(result.message).toContain('resend a new invitation');
  const malformed = await new GroupGitHubAccess(
    fixture([], [{ invitee: { login: 'Unknown' }, expired: 'false' }]),
  ).check('owner/repo');
  expect(malformed.invited).toEqual([]);
  expect(malformed.authoritative).toBe(false);
});
