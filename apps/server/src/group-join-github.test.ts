import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const fixture = vi.hoisted(() => ({ api: vi.fn(), scope: 'original' }));
vi.mock('../../web/src/api', () => ({ api: fixture.api, apiScope: () => fixture.scope }));
import { retainJoinGitHub } from '../../web/src/groups/group-join-github';
afterEach(() => {
  vi.unstubAllGlobals();
  fixture.api.mockReset();
  fixture.scope = 'original';
});
it('retains the supplied username after pending or lost-ACK Resume, without replaying membership', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const handle = randomUUID(),
    storage = `swa:groups:original:github-join-profile:${handle}`;
  await retainJoinGitHub('original', { handle, state: 'pending' }, 'Given-Username', () => true);
  expect(fixture.api).not.toHaveBeenCalled();
  const exact = values.get(storage);
  fixture.api.mockRejectedValue(new Error('Optional profile transport unavailable'));
  await retainJoinGitHub('original', { handle, state: 'active' }, 'Given-Username', () => true);
  expect(values.get(storage)).toBe(exact);
  expect(fixture.api.mock.calls.every(([path]) => path === '/groups/open')).toBe(true);
  await retainJoinGitHub('original', { handle, state: 'active' }, 'Given-Username', () => true);
  expect(values.get(storage)).toBe(exact);
});
it('refuses a scope change before sending an original profile to another host', async () => {
  fixture.scope = 'other';
  await expect(
    retainJoinGitHub('original', { handle: randomUUID(), state: 'active' }, 'Member', () => true),
  ).rejects.toThrow('original computer changed');
  expect(fixture.api).not.toHaveBeenCalled();
});
