import { expect, test } from '@playwright/test';

test('Help opens a reviewable GitHub issue draft and retains typed text across closing and reload', async ({
  page,
  context,
}) => {
  const sent: string[] = [];
  const githubRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') sent.push(request.url());
  });
  // Never open a live issue or send any report to GitHub during this check.
  await context.route('https://github.com/**', (route) => {
    githubRequests.push(route.request().url());
    return route.fulfill({ contentType: 'text/plain', body: 'Synthetic GitHub draft' });
  });
  await page.goto('/#/work/private-conversation-id?private-query=never-share');
  const open = async () => {
    await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
    const help = page.getByRole('dialog', { name: 'Help and setup', exact: true });
    await expect(
      help.getByRole('button', { name: 'Report a problem on GitHub', exact: true }),
    ).toBeVisible();
    await expect(
      help.getByRole('button', { name: 'Ask an agent to fix a problem', exact: true }),
    ).toBeVisible();
    await expect(help).toContainText('public GitHub draft that you review and submit');
    await expect(help).toContainText('private repair request');
    await expect(help).toContainText('model allowance');
    await expect(help.getByRole('heading', { name: 'Read documents', exact: true })).toHaveCount(0);
    await expect(help.getByRole('link', { name: 'LaTeX / PDF reader', exact: true })).toHaveCount(
      0,
    );
    await help.screenshot({ path: test.info().outputPath('help-menu.png') });
    await help.getByRole('button', { name: 'Report a problem on GitHub', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Report a problem on GitHub', exact: true });
  await expect(dialog).toContainText('GitHub issues are public');
  await expect(dialog).toContainText('require GitHub sign-in');
  await expect(dialog.getByRole('button', { name: 'Open GitHub issue draft' })).toBeDisabled();
  const summary = 'Phone connection fails: café & reconnect #7';
  const description =
    'I opened Phone access.\nExpected: reconnect.\nActual: a blank screen & no retry.';
  await dialog.getByLabel('Summary', { exact: true }).fill(summary);
  await dialog.getByLabel('What happened?', { exact: true }).fill(description);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await open();
  await expect(dialog.getByLabel('Summary', { exact: true })).toHaveValue(summary);
  await expect(dialog.getByLabel('What happened?', { exact: true })).toHaveValue(description);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await open();
  await expect(dialog.getByLabel('Summary', { exact: true })).toHaveValue(summary);
  await expect(dialog.getByLabel('What happened?', { exact: true })).toHaveValue(description);
  const link = dialog.getByRole('link', { name: 'Open GitHub issue draft' });
  const target = new URL((await link.getAttribute('href'))!);
  expect(target.origin + target.pathname).toBe(
    'https://github.com/OscarBarreraGithub/sciencewithagents/issues/new',
  );
  expect(target.searchParams.get('title')).toBe(summary);
  expect(target.searchParams.get('body')).toBe(
    `## What happened?\n${description}\n\n## App screen\nwork`,
  );
  expect(target.href).not.toContain('private-conversation-id');
  expect(target.href).not.toContain('private-query');
  expect(githubRequests).toEqual([]);
  expect(sent).toEqual([]);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('github-issue-draft.png') });
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(target.href);
  expect(githubRequests).toEqual([target.href]);
  await popup.close();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Summary', { exact: true })).toHaveValue(summary);
  await dialog.getByRole('button', { name: 'Clear draft', exact: true }).click();
  await expect(dialog.getByLabel('Summary', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('What happened?', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Open GitHub issue draft' })).toBeDisabled();
  // Long Unicode text stays intact and uses a plain issue plus an explicit copy step.
  const longDescription = '🚀'.repeat(1000);
  await dialog.getByLabel('Summary', { exact: true }).fill(summary);
  await dialog.getByLabel('What happened?', { exact: true }).fill(longDescription);
  await expect(
    dialog.getByRole('link', { name: 'Open GitHub issue', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/OscarBarreraGithub/sciencewithagents/issues/new');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => sessionStorage.setItem('synthetic-copied-issue', text),
      },
    });
  });
  await dialog.getByRole('button', { name: 'Copy report', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Report copied');
  expect(await page.evaluate(() => sessionStorage.getItem('synthetic-copied-issue'))).toBe(
    `${summary}\n\n## What happened?\n${longDescription.trim()}\n\n## App screen\nwork`,
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Synthetic clipboard denial');
        },
      },
    });
  });
  await dialog.getByRole('button', { name: 'Copy report', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Select and copy');
  await expect(dialog.getByLabel('What happened?', { exact: true })).toHaveValue(longDescription);
});
