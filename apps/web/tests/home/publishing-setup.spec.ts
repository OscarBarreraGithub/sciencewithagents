import { expect, test, type Page } from '@playwright/test';

// Browser-only sign-in results. The demo server never runs gh or Wrangler.
type State = 'unchecked' | 'connected' | 'signed_out' | 'missing' | 'unavailable';
const checkedAt = new Date().toISOString();
const messages: Record<State, string> = {
  unchecked: 'Not checked yet.',
  connected: 'Signed in.',
  signed_out: 'Wrangler is installed but not signed in. The setup prompt signs it in.',
  missing: 'Not installed.',
  unavailable: 'Cloudflare could not confirm the Wrangler sign-in. Nothing was changed.',
};
function accounts(github: State, cloudflare: State, checking = false) {
  return {
    available: true,
    checking,
    accounts: [
      {
        id: 'github',
        state: github,
        identity: github === 'connected' ? 'octo-lab' : null,
        message: github === 'connected' ? 'Signed in to GitHub as octo-lab.' : messages[github],
        checkedAt: github === 'unchecked' ? null : checkedAt,
      },
      {
        id: 'cloudflare',
        state: cloudflare,
        identity: null,
        message:
          cloudflare === 'connected'
            ? 'Signed in to Cloudflare with Wrangler.'
            : messages[cloudflare],
        checkedAt: cloudflare === 'unchecked' ? null : checkedAt,
      },
    ],
  };
}
async function serve(page: Page, prefix: string, saved: object, checks: (object | null)[]) {
  const bodies: unknown[] = [];
  await page.route(`**${prefix}/publishing-accounts`, (route) => route.fulfill({ json: saved }));
  await page.route(`**${prefix}/publishing-accounts/check`, (route) => {
    bodies.push(route.request().postDataJSON());
    const next = checks.length > 1 ? checks.shift()! : checks[0]!;
    return next
      ? route.fulfill({ json: next })
      : route.fulfill({ status: 502, json: { error: 'This computer is unavailable.' } });
  });
  return bodies;
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('verified sign-in collapses finished steps, explains failures and hides a complete shortcut', async ({
  page,
}, info) => {
  const bodies = await serve(page, '/api', accounts('unchecked', 'unchecked'), [
    null,
    accounts('connected', 'signed_out'),
    accounts('connected', 'connected'),
  ]);
  await page.goto('/#/apps');
  const shortcut = page.locator('.apps-setup');
  await page.locator('.apps-setup > summary').click();
  await expect(shortcut.getByRole('alert')).toContainText('Sign-in could not be checked');
  await shortcut.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('.apps-setup > summary')).toContainText('1 of 2 done');
  const [github, cloudflare] = [shortcut.locator('li').nth(0), shortcut.locator('li').nth(1)];
  await expect(github).toContainText('Signed in to GitHub as octo-lab.');
  await expect(github.locator('.setup-prompt')).toBeHidden();
  await github.getByText('Show setup prompt').click();
  await expect(github.locator('.setup-prompt')).toBeVisible();
  await expect(cloudflare).toContainText('Wrangler is installed but not signed in');
  await expect(cloudflare.locator('.setup-prompt')).toBeVisible();
  await expect(shortcut.getByRole('alert')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('setup-progress.png'), fullPage: true });
  expect(bodies).toEqual([{ force: false }, { force: true }]);

  await page.reload();
  await expect(page.locator('.apps-setup-complete')).toContainText(
    'GitHub (octo-lab) and Cloudflare are signed in',
  );
  await expect(page.locator('.apps-setup')).toHaveCount(0);
  // Help keeps both prompts reachable after completion.
  await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Help and setup', exact: true });
  await expect(help.locator('.setup-step-done')).toHaveCount(2);
  await help.getByText('Show setup prompt').last().click();
  await expect(help.locator('.setup-prompt').last()).toContainText('Set up Cloudflare sign-in');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('setup-help-complete.png') });
});

test('setup checks follow the selected computer', async ({ page }) => {
  const host = '33333333-3333-4333-8333-333333333333';
  await page.addInitScript((id) => localStorage.setItem('dock:host', id), host);
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: {
        local: { id: 'local', label: 'Entry Mac' },
        hosts: [
          { id: host, label: 'Lab Mac', accountLabel: 'lab', status: 'connected', error: null },
        ],
        setupError: null,
      },
    }),
  );
  await page.route(`**/api/hosts/${host}/proxy/apps`, (route) =>
    route.fulfill({ json: { apps: [], openHere: false, checkedAt } }),
  );
  const bodies = await serve(page, `/api/hosts/${host}/proxy`, accounts('missing', 'unavailable'), [
    accounts('missing', 'unavailable'),
  ]);
  await page.goto('/#/apps');
  const shortcut = page.locator('.apps-setup');
  await page.locator('.apps-setup > summary').click();
  await expect(shortcut.locator('.setup-guide-note')).toContainText('chat on Lab Mac');
  await expect(shortcut.locator('li').nth(0)).toContainText('Not installed.');
  await expect(shortcut.locator('li').nth(1)).toContainText('Nothing was changed.');
  expect(bodies).toEqual([{ force: false }]);
});
