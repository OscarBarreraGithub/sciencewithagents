import { expect, test, type Page } from '@playwright/test';

async function openGroups(page: Page) {
  await page.goto('/#/chats');
  const groups = page
    .getByRole('group', { name: 'Conversation type', exact: true })
    .getByRole('button', { name: 'Groups', exact: true });
  await groups.click();
  await expect(groups).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'New group', exact: true })).toBeVisible();
}

test('Groups detects external setup without leaving, recovers a failed refresh and preserves form entries', async ({
  page,
}) => {
  await page.clock.install();
  let configured = false;
  let unavailable = false;
  let reads = 0;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/groups'))
      writes.push(request.url());
  });
  await page.route('**/api/groups', (route) => {
    reads++;
    return unavailable
      ? route.fulfill({ status: 503, json: { error: 'Reconnecting to this computer.' } })
      : route.fulfill({
          json: {
            groups: [],
            service: {
              configured,
              message: configured ? 'Creator service configured.' : 'Setup needed.',
              setupCodeRequired: false,
            },
            native: {
              available: false,
              productionReady: false,
              authState: 'unavailable',
              message: 'No model started.',
            },
          },
        });
  });
  await openGroups(page);
  await expect(page.getByRole('dialog', { name: 'Group setup', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const form = page.locator('.groups-form-dialog');
  const create = form.getByRole('button', { name: 'Create group', exact: true });
  await expect(create).toBeDisabled();
  await form.getByLabel('Your display name', { exact: true }).fill('Amina');
  await form.getByLabel('Project name', { exact: true }).fill('Research group');
  await form.getByRole('button', { name: 'Set up hosting', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await expect(setup).toBeVisible();
  await expect(setup.getByLabel('Cloudflare Groups setup prompt')).toBeHidden();
  unavailable = true;
  const failedReads = reads;
  await page.clock.fastForward(5100);
  await expect.poll(() => reads).toBeGreaterThan(failedReads);
  // The setup dialog leaves the unfinished create form mounted underneath it.
  await expect(page.locator('.groups-main-chat > .chat-list [role="alert"]')).toContainText(
    'Reconnecting',
  );
  unavailable = false;
  configured = true;
  await page.clock.fastForward(5100);
  await expect(page.locator('.groups-main-chat > .chat-list [role="alert"]')).toHaveCount(0);
  await setup.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(create).toBeEnabled();
  await expect(form.getByLabel('Your display name', { exact: true })).toHaveValue('Amina');
  await expect(form.getByLabel('Project name', { exact: true })).toHaveValue('Research group');
  const readyReads = reads;
  await page.clock.fastForward(16000);
  expect(reads).toBe(readyReads);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBe(readyReads + 1);
  expect(writes).toEqual([]);
  await form.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New group', exact: true })).toBeVisible();
});

test('fresh Groups shows creator-owned Cloudflare prompts, human steps and copyable join/phone/GitHub setup', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt = text;
        },
      },
    });
  });
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: {
          configured: false,
          message: 'Use your own Cloudflare creator setup.',
          setupCodeRequired: false,
        },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'Enable local agents after joining.',
        },
      },
    }),
  );
  await openGroups(page);
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText('The creator hosts Groups in their own Cloudflare account.');
  await expect(setup.getByText('Recover an interrupted request', { exact: true })).toHaveCount(0);
  await expect(setup).toContainText('Group messages already sync through Cloudflare.');
  await setup.getByText('Your setup checklist', { exact: true }).click();
  await expect(setup).toContainText('sign in to your Cloudflare account and confirm Workers Free');
  await expect(setup.getByLabel('Cloudflare Groups setup prompt')).toBeHidden();
  await setup.getByRole('button', { name: 'Copy Cloudflare setup prompt', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt),
    )
    .toContain('MY OWN Cloudflare account');
  for (const [title, label, button, expected] of [
    [
      '2. Member: join the creator’s service',
      'Groups join setup prompt',
      'Copy join setup prompt',
      "creator's exact HTTPS service",
    ],
    [
      '3. Phone: your own Cloudflare Tunnel',
      'Groups Cloudflare phone setup prompt',
      'Copy phone setup prompt',
      'HTTP VPC Service',
    ],
    [
      '4. GitHub for shared code and files (optional)',
      'Groups GitHub setup prompt',
      'Copy GitHub setup prompt',
      'GitHub is optional for messaging',
    ],
  ]) {
    const choice = setup.locator('.group-setup-choice').filter({
      has: page.getByRole('heading', { name: title!, exact: true }),
    });
    await expect(choice.getByLabel(label!, { exact: true })).toBeHidden();
    await choice.getByRole('button', { name: button!, exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt),
      )
      .toContain(expected!);
  }
  await expect(setup.getByLabel('Beta setup code', { exact: true })).toHaveCount(0);
  expect(await setup.textContent()).not.toContain('Tailscale');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 2,
  );
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Group setup', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  const creator = setup.locator('.group-setup-choice').first();
  await expect(creator.getByLabel('Cloudflare Groups setup prompt')).toBeHidden();
  await creator.getByText('Read prompt', { exact: true }).click();
  await expect(creator.getByLabel('Cloudflare Groups setup prompt')).toBeVisible();
});

test('configured Groups keeps setup available in a dialog with collapsed prompt text', async ({
  page,
}) => {
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: {
          configured: true,
          message: 'Creator service configured.',
          setupCodeRequired: false,
        },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'Local setup.',
        },
      },
    }),
  );
  await openGroups(page);
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await expect(setup).toHaveCount(0);
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  await expect(setup.getByText('Creator service configured.', { exact: true })).toBeAttached();
  const creator = setup.locator('.group-setup-choice').first();
  await expect(creator.getByLabel('Cloudflare Groups setup prompt')).toBeHidden();
  await creator.getByText('Read prompt', { exact: true }).click();
  await expect(creator.getByLabel('Cloudflare Groups setup prompt')).toBeVisible();
  await setup.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'New group', exact: true })
      .getByRole('button', { name: 'Create group', exact: true }),
  ).toBeEnabled();
});

test('invalid invitation can be corrected while uncertain joins keep their retry identity', async ({
  page,
}) => {
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: { configured: true, message: 'Ready.', setupCodeRequired: false },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'No model.',
        },
      },
    }),
  );
  const keys: string[] = [];
  await page.route('**/api/groups/join', (route) => {
    keys.push(route.request().postDataJSON().key);
    return route.fulfill(
      keys.length === 1
        ? {
            status: 400,
            json: { code: 'INVALID_INVITATION', error: 'Use the correct service invitation.' },
          }
        : {
            status: 503,
            json: {
              code: 'GROUP_SERVICE_UNAVAILABLE',
              error: 'Service unavailable. Retry this request.',
            },
          },
    );
  });
  await openGroups(page);
  await page.getByRole('button', { name: 'Join group', exact: true }).click();
  const join = page.getByRole('dialog', { name: 'Join a group', exact: true });
  await join.getByLabel('Your display name', { exact: true }).fill('Li Ming');
  await join
    .getByLabel('Invitation link', { exact: true })
    .fill('https://groups.example.test/incorrect');
  const send = join.getByRole('button', { name: 'Join group', exact: true });
  await send.click();
  await expect(join.getByRole('alert')).toHaveText('Use the correct service invitation.');
  await join
    .getByLabel('Invitation link', { exact: true })
    .fill('https://groups.example.test/corrected');
  await send.click();
  await expect(join.getByRole('alert')).toHaveText('Service unavailable. Retry this request.');
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  await send.click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[1]).toBe(keys[2]);
  await expect(page.getByRole('heading', { name: 'Request sent', exact: true })).toHaveCount(0);
  // A lost acknowledgement makes recovery useful; opening help itself must not resend.
  const recovery: unknown[] = [];
  await page.route('**/api/groups/resume', (route) => {
    recovery.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'Still reconnecting. Request retained.' } });
  });
  await join.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await setup.getByText('Recover an interrupted request', { exact: true }).click();
  expect(recovery).toEqual([]);
  await setup.getByRole('button', { name: 'Recover pending setup', exact: true }).click();
  await expect(setup.getByRole('alert')).toHaveText('Still reconnecting. Request retained.');
  expect(recovery).toEqual([{ key: keys[1], kind: 'join' }]);
  await expect(
    setup.getByRole('button', { name: 'Recover pending setup', exact: true }),
  ).toBeVisible();
});
