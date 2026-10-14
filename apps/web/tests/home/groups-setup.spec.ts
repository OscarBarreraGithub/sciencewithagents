import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

async function installCreationClipboard(page: Page) {
  await page.addInitScript(() => {
    const state = { texts: [] as string[], fail: false };
    (window as Window & { creationClipboard?: typeof state }).creationClipboard = state;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (state.fail) throw new Error('Clipboard permission denied');
          state.texts.push(text);
        },
      },
    });
  });
}

async function checkCreationGuide(page: Page, form: Locator) {
  await form.getByRole('radio', { name: 'Chat only — no GitHub', exact: true }).check();
  const requests: string[] = [];
  const record = (request: Request) => {
    if (request.method() === 'POST') requests.push(request.url());
  };
  page.on('request', record);
  const guide = form.getByRole('region', { name: 'Set up with your agent', exact: true });
  const prompt = guide.getByLabel('Group creation setup prompt');
  await expect(guide).toBeVisible();
  await expect(prompt).toBeHidden();
  const read = guide.getByText('Read prompt', { exact: true });
  await read.click();
  await expect(prompt).toBeVisible();
  await read.click();
  const copy = guide.getByRole('button', { name: 'Copy group setup prompt', exact: true });
  await expect(copy).toHaveAttribute('type', 'button');
  for (const target of [copy, read]) {
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(
      await target.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(16);
  }
  await copy.click();
  const clipboard = () =>
    page.evaluate(
      () =>
        (window as Window & { creationClipboard?: { texts: string[] } }).creationClipboard!.texts,
    );
  await expect.poll(clipboard).toHaveLength(1);
  const [copied] = await clipboard();
  expect(copied).toContain('docs/GROUP_HOSTING.md');
  expect(copied).toContain('ONE intended PRIVATE repository');
  expect(copied).toContain('\"displayName\":\"Amina\"');
  expect(copied).toContain('\"projectName\":\"Research group\"');
  expect(copied).toContain('Do not ask for the names or another folder selection again.');
  await expect(prompt).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('new-group-guide.png') });
  await page.evaluate(() => {
    (window as Window & { creationClipboard?: { fail: boolean } }).creationClipboard!.fail = true;
  });
  await guide.getByRole('button', { name: 'Copied', exact: true }).click();
  await expect(guide.getByRole('status')).toContainText('copy it by hand');
  await expect(prompt).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(copied);
  await expect.poll(clipboard).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 2,
  );
  await read.click();
  page.off('request', record);
  expect(requests).toEqual([]);
  await expect(form.getByLabel('Your display name', { exact: true })).toHaveValue('Amina');
  await expect(form.getByLabel('Project name', { exact: true })).toHaveValue('Research group');
}

async function openGroups(page: Page) {
  await page.goto('/#/chats');
  const groups = page
    .getByRole('group', { name: 'Conversation type', exact: true })
    .getByRole('button', { name: 'Groups', exact: true });
  await groups.click();
  await expect(page).toHaveURL(/#\/chats\/groups$/);
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New group', exact: true })).toBeVisible();
}

test('Groups detects external setup without leaving, recovers a failed refresh and preserves form entries', async ({
  page,
}) => {
  await installCreationClipboard(page);
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
  await checkCreationGuide(page, form);
  await expect(create).toBeDisabled();
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

test('fresh Groups separates creator, joining and shared-file setup with optional phone access', async ({
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
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/groups'))
      writes.push(request.url());
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
  const setupButton = page.getByRole('button', { name: 'Group setup', exact: true });
  await expect(setupButton).toHaveAccessibleName('Group setup');
  await expect(setupButton.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  const setupBox = (await setupButton.boundingBox())!;
  expect(setupBox.height).toBeGreaterThanOrEqual(44);
  expect(setupBox.width).toBeGreaterThanOrEqual(44);
  expect(
    await setupButton.evaluate((button) => parseFloat(getComputedStyle(button).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await setupButton.click();
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await expect(setup).toBeVisible();
  const choices = setup.getByRole('group', { name: 'Setup purpose', exact: true });
  await expect(choices.getByRole('button')).toHaveText([
    'Create a group',
    'Join a group',
    'Shared files',
  ]);
  for (const button of await choices.getByRole('button').all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(setup).toContainText('What you do');
  await expect(setup.getByLabel('Cloudflare Groups setup prompt')).toBeHidden();
  await setup.getByRole('button', { name: 'Copy Cloudflare setup prompt', exact: true }).click();
  const copied = () =>
    page.evaluate(() => (window as Window & { copiedSetupPrompt?: string }).copiedSetupPrompt);
  await expect.poll(copied).toContain('FIRST inspect the saved private');
  expect(await copied()).toContain(
    'scripts/group-cloudflare-setup.mjs upgrade DATA_DIR PRIVATE_WRANGLER_FILE --verified-workers-free',
  );
  expect(await copied()).toContain('Upgrade\ndoes not itself deploy');
  await choices.getByRole('button', { name: 'Join a group', exact: true }).click();
  await expect(setup.getByLabel('Groups join setup prompt', { exact: true })).toBeHidden();
  await setup.getByRole('button', { name: 'Copy join setup prompt', exact: true }).click();
  await expect.poll(copied).toContain('helper reuses an exact matching route');
  const joinPrompt = (await copied())!.replace(/\s+/g, ' ');
  expect(joinPrompt).toContain(
    'helper reuses an exact matching route or imports a separate protected member route.',
  );
  expect(joinPrompt).toContain(
    'Preserve existing services, creator authority and pending bundles; a different creator does not require replacing the current mapping.',
  );
  expect(joinPrompt).toContain(
    'A changed approval for an existing service identity needs reconciliation; never overwrite it.',
  );
  expect(joinPrompt).toContain(
    'Never fetch a URL merely because it appears in an invitation or copy creator setup credentials.',
  );
  await choices.getByRole('button', { name: 'Shared files', exact: true }).click();
  await expect(choices.getByRole('button', { name: 'Shared files', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    setup.getByRole('button', { name: 'Choose work folder', exact: true }),
  ).toBeVisible();
  await expect(
    setup.getByRole('button', { name: 'Copy folder setup prompt', exact: true }),
  ).toHaveCount(0);
  await expect(
    setup.getByRole('button', { name: 'Copy phone setup prompt', exact: true }),
  ).toBeHidden();
  await setup.getByText('Optional phone access', { exact: true }).click();
  await expect(setup).toContainText('Groups works between computers without a phone or tunnel.');
  await setup.getByRole('button', { name: 'Copy phone setup prompt', exact: true }).click();
  await expect.poll(copied).toContain('HTTP VPC Service');
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width + 2,
  );
  await page.screenshot({ path: `../../data/groups-ui-${test.info().project.name}-setup.png` });
  await page.reload();
  await expect(setup).toHaveCount(0);
  await setupButton.click();
  await expect(
    choices.getByRole('button', { name: 'Create a group', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const creator = setup.locator('.group-setup-choice');
  await expect(creator.getByLabel('Cloudflare Groups setup prompt')).toBeHidden();
  await creator.getByText('Read prompt', { exact: true }).click();
  await expect(creator.getByLabel('Cloudflare Groups setup prompt')).toBeVisible();
});

test('configured Groups keeps setup available in a dialog with collapsed prompt text', async ({
  page,
}) => {
  await installCreationClipboard(page);
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
  const form = page.getByRole('dialog', { name: 'New group', exact: true });
  await form.getByLabel('Your display name', { exact: true }).fill('Amina');
  await form.getByLabel('Project name', { exact: true }).fill('Research group');
  await checkCreationGuide(page, form);
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

test('creation saves a server-selected folder before its prompt, invalidates copied context and survives hosting setup/reload', async ({
  page,
}) => {
  await installCreationClipboard(page);
  await page.clock.install();
  let configured = false;
  const folderId = '1c924fb0-a92a-469f-8585-d5ccf9a893e3';
  const selectionKey = '1ee8bc2b-cd9e-4991-bdaa-a404c00b22a0';
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: {
          configured,
          message: configured ? 'Ready.' : 'Setup needed.',
          setupCodeRequired: false,
        },
        native: {
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message: 'No model.',
        },
      },
    }),
  );
  await page.route('**/api/project-folders?*', (route) =>
    route.fulfill({
      json: {
        current: { id: folderId, name: 'Intended research', canSelect: true },
        parentId: null,
        folders: [],
        nextOffset: null,
        breadcrumbs: [{ id: folderId, name: 'Intended research' }],
        locations: [{ id: folderId, name: 'Home', kind: 'home' }],
      },
    }),
  );
  const picks: unknown[] = [];
  await page.route('**/api/projects/connect-folder', (route) => {
    picks.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        project: null,
        selection: {
          key: selectionKey,
          name: 'Intended research',
          needsTracking: false,
          workspacePath: '/private/local/Intended research',
        },
      },
    });
  });
  await openGroups(page);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New group', exact: true });
  await form.getByLabel('Your display name', { exact: true }).fill('Amina');
  await form.getByLabel('Project name', { exact: true }).fill('Research group');
  await expect(form.getByRole('button', { name: 'Copy group setup prompt' })).toHaveCount(0);
  await form.getByRole('radio', { name: 'Use my intended work folder', exact: true }).check();
  await form.getByRole('button', { name: 'Choose work folder', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
  const search = browser.getByRole('searchbox', { name: 'Search folders', exact: true });
  await expect(search).toBeVisible();
  const colors = await search.evaluate((element) => ({
    color: getComputedStyle(element).color,
    background: getComputedStyle(element.closest('.folder-browser-content')!).backgroundColor,
    placeholder: getComputedStyle(element, '::placeholder').color,
  }));
  expect(colors.color).not.toBe(colors.background);
  expect(colors.placeholder).not.toBe(colors.background);
  await search.focus();
  await page.screenshot({ path: test.info().outputPath('creation-folder-dark-search.png') });
  await browser.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(browser).toHaveCount(0);
  await expect(form).toContainText('Setup pending');
  await checkCreationGuideForFolder();
  await form.getByLabel('Project name', { exact: true }).fill('Renamed research');
  await expect(
    form.getByRole('button', { name: 'Copy group setup prompt', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(form.getByLabel('Your display name', { exact: true })).toHaveValue('Amina');
  await expect(form.getByLabel('Project name', { exact: true })).toHaveValue('Renamed research');
  await expect(form).toContainText('/private/local/Intended research');
  await form.getByRole('button', { name: 'Set up hosting', exact: true }).click();
  configured = true;
  await page.clock.fastForward(5100);
  await page
    .getByRole('dialog', { name: 'Group setup', exact: true })
    .getByRole('button', { name: 'Close dialog' })
    .click();
  await expect(form.getByRole('button', { name: 'Create group', exact: true })).toBeEnabled();
  expect(picks).toEqual([{ key: expect.any(String), folderId, selectOnly: true }]);
  async function checkCreationGuideForFolder() {
    const writes: string[] = [];
    const record = (request: Request) => {
      if (request.method() === 'POST') writes.push(request.url());
    };
    page.on('request', record);
    await form.getByRole('button', { name: 'Copy group setup prompt', exact: true }).click();
    const texts = await page.evaluate(
      () =>
        (window as Window & { creationClipboard?: { texts: string[] } }).creationClipboard!.texts,
    );
    expect(texts[0]).toContain('"displayName":"Amina"');
    expect(texts[0]).toContain('"projectName":"Research group"');
    expect(texts[0]).toContain('"folder":"/private/local/Intended research"');
    expect(texts[0]).toContain(selectionKey);
    expect(texts[0]).toContain('Do not ask for the names or another folder selection again.');
    expect(texts[0]).toContain('Copying this prompt did not change your working directory.');
    expect(writes).toEqual([]);
    page.off('request', record);
  }
});

for (const configured of [false, true])
  test(`joining retains private context for trusted registration (configured=${configured})`, async ({
    page,
  }) => {
    await installCreationClipboard(page);
    await page.route('**/api/groups', (route) =>
      route.fulfill({
        json: {
          groups: [],
          service: { configured, message: 'Service status', setupCodeRequired: false },
          native: { available: false, message: 'No model' },
        },
      }),
    );
    const writes: Record<string, unknown>[] = [];
    let registered = false;
    await page.route('**/api/groups/join', (route) => {
      writes.push(route.request().postDataJSON());
      return route.fulfill(
        registered
          ? {
              status: 503,
              json: {
                code: 'GROUP_SERVICE_UNAVAILABLE',
                error: 'Registered service is offline. Retry the same join.',
              },
            }
          : {
              status: 409,
              json: {
                code: 'GROUP_SERVICE_REGISTRATION_REQUIRED',
                error: 'Register the invitation service with your setup agent.',
              },
            },
      );
    });
    await openGroups(page);
    await page.getByRole('button', { name: 'Join group', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Join a group', exact: true });
    const invitation = 'https://creator.example.test/join#/groups?invite=private-quoted-data';
    await form.getByLabel('Your display name', { exact: true }).fill('Amina');
    await form.getByLabel('Invitation link', { exact: true }).fill(invitation);
    await form.getByRole('button', { name: 'Join group', exact: true }).click();
    const handoff = form.getByRole('region', {
      name: 'Finish joining with your agent',
      exact: true,
    });
    await expect(handoff).toBeVisible();
    await handoff.getByRole('button', { name: 'Copy join handoff prompt', exact: true }).click();
    const texts = await page.evaluate(
      () =>
        (window as Window & { creationClipboard?: { texts: string[] } }).creationClipboard!.texts,
    );
    expect(texts[0]).toContain(JSON.stringify({ displayName: 'Amina', invitation }));
    expect(texts[0]).toContain('join <existing-app-data> <private-invitation-file>');
    expect(writes).toHaveLength(1);
    expect(await page.evaluate(() => Object.values(sessionStorage).join('\n'))).not.toContain(
      invitation,
    );
    await page.evaluate(() => {
      (window as Window & { creationClipboard?: { fail: boolean } }).creationClipboard!.fail = true;
    });
    await handoff.getByRole('button', { name: 'Copied', exact: true }).click();
    await expect(handoff.getByLabel('Private join setup prompt')).toBeVisible();
    await expect(handoff.getByRole('status')).toContainText('copy it by hand');
    registered = true;
    await form.getByRole('button', { name: 'Join group', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Registered service is offline');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ displayName: 'Amina', invitation });
    await form.getByRole('button', { name: 'Join group', exact: true }).click();
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[2]).toEqual(writes[1]);
    await expect(form.getByLabel('Your display name', { exact: true })).toHaveValue('Amina');
    await expect(form.getByLabel('Invitation link', { exact: true })).toHaveValue(invitation);
  });

test('a late folder reply cannot replace intent after closing and reopening creation', async ({
  page,
}) => {
  const folderId = '4272dd13-a78e-4e48-a62d-64d93c1fc6fb';
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: { configured: true, message: 'Ready' },
        native: { available: false, message: 'No model' },
      },
    }),
  );
  await page.route('**/api/project-folders?*', (route) =>
    route.fulfill({
      json: {
        current: { id: folderId, name: 'Work', canSelect: true },
        parentId: null,
        folders: [],
        nextOffset: null,
      },
    }),
  );
  const picks: Record<string, unknown>[] = [];
  let release!: () => void;
  await page.route('**/api/projects/connect-folder', async (route) => {
    const input = route.request().postDataJSON();
    picks.push(input);
    if (picks.length === 1)
      await new Promise<void>((done) => {
        release = done;
      });
    await route.fulfill({
      json: {
        project: null,
        selection: {
          key: input.key,
          name: 'Work',
          needsTracking: false,
          workspacePath: '/private/fixture/work',
        },
      },
    });
  });
  await openGroups(page);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New group', exact: true });
  await form.getByLabel('Your display name').fill('Amina');
  await form.getByLabel('Project name').fill('Preserved intent');
  await form.getByRole('radio', { name: 'Use my intended work folder', exact: true }).check();
  await form.getByRole('button', { name: 'Choose work folder', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose a project folder' })
    .getByRole('button', { name: 'Use this folder', exact: true })
    .click();
  await expect.poll(() => picks.length).toBe(1);
  await form.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  release();
  await expect(
    form.getByRole('button', { name: 'Retry folder selection', exact: true }),
  ).toBeVisible();
  await expect(
    form.getByRole('button', { name: 'Copy group setup prompt', exact: true }),
  ).toHaveCount(0);
  await form.getByRole('button', { name: 'Retry folder selection', exact: true }).click();
  await expect(form).toContainText('/private/fixture/work');
  expect(picks).toHaveLength(2);
  expect(picks[0]).toEqual(picks[1]);
});

test('Join keeps an optional GitHub username through registration handoff and uncertain retry', async ({
  page,
}) => {
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: { configured: true, message: 'Ready' },
        native: { available: false, message: 'No model' },
      },
    }),
  );
  const joins: Record<string, unknown>[] = [];
  await page.route('**/api/groups/join', (route) => {
    joins.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      json: { code: 'GROUP_SERVICE_UNAVAILABLE', error: 'Uncertain join retained.' },
    });
  });
  await openGroups(page);
  await page.getByRole('button', { name: 'Join group', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Join a group', exact: true });
  await form.getByLabel('Your display name', { exact: true }).fill('Member');
  await form
    .getByLabel('Invitation link', { exact: true })
    .fill('https://creator.example/#private');
  await form.getByLabel('GitHub username (optional)', { exact: true }).fill('member-gh');
  await form.getByRole('button', { name: 'Join group', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Uncertain join');
  await form.getByRole('button', { name: 'Join group', exact: true }).click();
  await expect.poll(() => joins.length).toBe(2);
  expect(joins[0]).toEqual(joins[1]);
  expect(joins[0]).not.toHaveProperty('githubUsername');
  await expect(form.getByLabel('GitHub username (optional)', { exact: true })).toHaveValue(
    'member-gh',
  );
});

test('lost Join acknowledgement Resume retains its supplied GitHub profile independently', async ({
  page,
}) => {
  const handle = 'bf62fa91-40ae-446c-8c9e-b5d12aa33970';
  const group = {
    id: '8152e92f-1c7b-41f0-974f-2a8b787d0ca3',
    handle,
    name: 'Recovered membership',
    members: 2,
    sync: 'Ready',
    state: 'active',
  };
  await page.route('**/api/groups', (route) =>
    route.fulfill({
      json: {
        groups: [],
        service: { configured: true, message: 'Ready' },
        native: { available: false, message: 'No model' },
      },
    }),
  );
  const joins: Record<string, unknown>[] = [],
    resumes: Record<string, unknown>[] = [];
  await page.route('**/api/groups/join', (route) => {
    joins.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      json: { code: 'GROUP_SERVICE_UNAVAILABLE', error: 'Lost acknowledgement.' },
    });
  });
  await page.route('**/api/groups/resume', (route) => {
    resumes.push(route.request().postDataJSON());
    return route.fulfill({ json: { group, confirmation: null } });
  });
  await page.route('**/api/groups/open', (route) =>
    route.fulfill({ status: 503, json: { error: 'Optional profile context is reconnecting.' } }),
  );
  await openGroups(page);
  await page.getByRole('button', { name: 'Join group', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Join a group', exact: true });
  await form.getByLabel('Your display name', { exact: true }).fill('Given name');
  await form
    .getByLabel('Invitation link', { exact: true })
    .fill('https://creator.example/#private');
  await form.getByLabel('GitHub username (optional)', { exact: true }).fill('Given-GitHub');
  await form.getByRole('button', { name: 'Join group', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Lost acknowledgement');
  await form.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Group setup', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Group setup', exact: true });
  await setup.getByText('Recover an interrupted request', { exact: true }).click();
  await setup.getByRole('button', { name: 'Recover pending setup', exact: true }).click();
  const saved = () =>
    page.evaluate(
      (handle) =>
        JSON.parse(
          sessionStorage.getItem(`swa:groups:local:github-join-profile:${handle}`) ?? 'null',
        ),
      handle,
    );
  await expect.poll(saved).toMatchObject({ username: 'Given-GitHub', key: expect.any(String) });
  expect(joins).toHaveLength(1);
  expect(resumes).toEqual([{ key: joins[0].key, kind: 'join' }]);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('swa:groups:local:join')))
    .toBeNull();
});
