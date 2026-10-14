import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { prepareBrowserHandoff } from '../../../server/dist/local-browser-handoff.js';
test('GitHub member access statuses and contextual creator invitation remain explicit and model-free', async ({
  page,
}, info) => {
  const root = JSON.parse(
    readFileSync(resolve('../../data/groups-only-browser/installation/active.json'), 'utf8'),
  ).root;
  const own = randomUUID();
  const members = ['Access confirmed', 'Invitation pending', 'No access', 'Not checked'].map(
    (status, i) => ({
      memberId: i === 0 ? own : randomUUID(),
      displayName: ['Creator', 'Joining member', 'Missing access', 'Unknown check'][i],
      username: ['creator-gh', 'joiner-gh', 'missing-gh', 'unknown-gh'][i],
      status,
    }),
  );
  const calls: Record<string, unknown>[] = [];
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { githubPrompt?: string }).githubPrompt = text;
        },
      },
    }),
  );
  await page.route('**/api/groups/github', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        ownMemberId: own,
        creator: true,
        repository: 'owner/intended-private-repo',
        pending: [],
        members,
        checkedAt: new Date().toISOString(),
        viewer: 'native-owner',
        complete: true,
        message: 'Checked usernames; this does not verify personal identity.',
      },
    });
  });
  await page.goto((await prepareBrowserHandoff(root, 4372))!);
  await page.getByRole('button', { name: /Groups-only preview/ }).click();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'Manage group' });
  await expect(manage.getByText('Members and GitHub access', { exact: true })).toBeVisible();
  for (const status of ['Access confirmed', 'Invitation pending', 'No access', 'Not checked'])
    await expect(manage.locator('.group-github-member').filter({ hasText: status })).toHaveCount(1);
  await manage.getByRole('button', { name: 'Check GitHub access', exact: true }).click();
  await expect.poll(() => calls.filter((value) => value.action === 'check').length).toBe(1);
  await manage
    .getByRole('button', { name: 'Prepare GitHub invitation for Joining member', exact: true })
    .click();
  const before = calls.length;
  await manage.getByRole('button', { name: 'Copy GitHub invitation prompt', exact: true }).click();
  const copied = await page.evaluate(
    () => (window as Window & { githubPrompt?: string }).githubPrompt,
  );
  expect(copied).toContain('"repository":"owner/intended-private-repo"');
  expect(copied).toContain('"githubUsername":"joiner-gh"');
  expect(copied).toContain('No admin or organization-wide grant');
  expect(calls).toHaveLength(before);
  expect(calls.every((value) => ['status', 'check'].includes(String(value.action)))).toBe(true);
  await page.screenshot({ path: info.outputPath('github-member-access.png') });
});
