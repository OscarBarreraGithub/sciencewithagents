import { test, expect, type Page } from './fixture';
import { randomUUID } from 'node:crypto';

async function openChats(page: Page) {
  await expect(page.locator('.topbar')).toBeVisible();
  const menu = page.getByRole('button', { name: /Open chats|Open projects/ });
  if (await menu.isVisible()) await menu.click();
}
async function chooseChat(page: Page, name: string) {
  await openChats(page);
  await page
    .locator('.sidebar')
    .getByRole('navigation', { name: 'VS Code chats' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
}

test('native editor queued messages expand into a readable list without app edit or steering controls', async ({
  page,
}, info) => {
  const state = {
    windowId: randomUUID(),
    label: 'Readonly native queue',
    threadId: 'native-owned-queue',
    title: 'Native queue fixture',
    status: 'busy',
    message: 'Same conversation as VS Code.',
    entries: [],
    queuedMessages: Array.from({ length: 12 }, (_, i) => ({
      id: `native-${i}`,
      text: `Native queued message ${i + 1}`,
    })),
  };
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [{ ...state, entries: undefined }] }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.goto('/');
  await chooseChat(page, 'Native queue fixture');
  await page.getByRole('button', { name: 'Expand queue', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  await expect(menu.getByRole('listitem')).toHaveCount(12);
  await expect(menu.getByRole('button', { name: /Edit|Steer/ })).toHaveCount(0);
  expect((await menu.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height * 0.8);
  await page.screenshot({
    path: `../../data/queued-message-ui/${info.project.name}-native-expanded-queue.png`,
  });
  await menu.getByRole('button', { name: 'Close dialog' }).click();
  await expect(menu).toHaveCount(0);
});

test('mirror syncs submitted desktop messages, preserves local drafts and keeps retry identity', async ({
  page,
}, testInfo) => {
  const windowId = randomUUID();
  const state = {
    windowId,
    label: 'My computer',
    threadId: 'shared-thread',
    title: 'Existing Codex conversation',
    status: 'idle',
    message: 'Same conversation as VS Code. Drafts stay separate.',
    entries: [
      { id: 'old', role: 'user', text: 'Earlier desktop message' },
      { id: 'reply', role: 'assistant', text: 'An old retained answer' },
    ],
  };
  let submitted = false;
  const keys: string[] = [];
  const receiptKeys: string[] = [];
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [{ ...state, entries: undefined }] }),
  );
  await page.route(`**/api/vscode/windows/${windowId}`, (route) => route.fulfill({ json: state }));
  await page.route(`**/api/vscode/windows/${windowId}/send`, async (route) => {
    const input = route.request().postDataJSON();
    keys.push(input.key);
    if (!submitted) {
      state.entries.push({ id: 'phone', role: 'user', text: input.text });
      submitted = true;
    }
    return route.abort('failed');
  });
  await page.route('**/api/vscode/deliveries/*', (route) => {
    receiptKeys.push(route.request().url().split('/').at(-1)!);
    expect(route.request().method()).toBe('GET');
    return route.fulfill({
      json: { state: 'sent', message: 'Sent to the existing Codex conversation.' },
    });
  });
  await page.goto('/?mirror=1');
  const dialog = page.getByRole('region', { name: 'Codex chat', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(dialog.getByRole('log')).toContainText('Earlier desktop message');
  await page.getByLabel('Message Codex').fill('Unfinished phone draft');
  state.entries.push({ id: 'desktop-new', role: 'user', text: 'Human typed at the desktop' });
  await expect(dialog.getByRole('log')).toContainText('Human typed at the desktop');
  await expect(page.getByLabel('Message Codex')).toHaveValue('Unfinished phone draft');
  if (testInfo.project.use.isMobile)
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  else await page.getByLabel('Message Codex').press('Enter');
  await expect(dialog.getByRole('button', { name: 'Check delivery' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Message Codex')).toHaveValue('Unfinished phone draft');
  await dialog.getByRole('button', { name: 'Check delivery' }).click();
  await expect(page.getByLabel('Message Codex')).toHaveValue('');
  expect(keys).toHaveLength(1);
  expect(receiptKeys).toEqual(keys);
  expect(state.entries.filter((e) => e.id === 'phone')).toHaveLength(1);
  state.status = 'busy';
  await expect(dialog.getByText('Codex is working…')).toBeVisible();
  await page.getByLabel('Message Codex').fill('Wait for later');
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.screenshot({ path: `../../data/screenshots/mirror-${testInfo.project.name}.png` });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a connected bridge recovers from a temporarily offline provider without re-sharing', async ({
  page,
}) => {
  const state = {
    windowId: randomUUID(),
    label: 'Computer',
    threadId: 'temporary-offline',
    title: 'Recover this chat',
    status: 'offline',
    message: 'The native provider is reconnecting.',
    entries: [],
  };
  let reads = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [state] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) => {
    reads++;
    if (reads > 1) state.status = 'idle';
    return route.fulfill({ json: state });
  });
  await page.goto('/?mirror=1');
  await expect(page.locator('.mirror-header')).toContainText('Connected');
  expect(reads).toBeGreaterThan(1);
  await page.getByLabel('Message Codex').fill('A draft after recovery');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
});

test('checking an unknown delivery never resends a request that missed the gateway', async ({
  page,
}) => {
  const state = {
    windowId: randomUUID(),
    label: 'Computer',
    threadId: 'missed-send',
    title: 'Check without resending',
    status: 'idle',
    message: '',
    entries: [],
  };
  let sends = 0,
    checks = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [state] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, (route) => {
    sends++;
    return route.abort('failed');
  });
  await page.route('**/api/vscode/deliveries/*', (route) => {
    checks++;
    return route.fulfill({
      json: {
        state: 'uncertain',
        message: 'No receipt is available. Inspect VS Code. Nothing was resent.',
      },
    });
  });
  await page.goto('/?mirror=1');
  await expect(page.locator('.mirror-header')).toContainText('Connected');
  await page.getByLabel('Message Codex').fill('Do not send this twice');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(
    page
      .locator('.mirror-delivery-status summary')
      .filter({ hasText: 'No receipt is available. Inspect VS Code. Nothing was resent.' }),
  ).toBeVisible();
  expect(sends).toBe(1);
  expect(checks).toBe(1);
  await expect(page.getByLabel('Message Codex')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Message Codex')).toHaveValue('Do not send this twice');
  await page.unrouteAll({ behavior: 'wait' });
});

test('long history scrolls independently and incoming messages do not move a reader away from older text', async ({
  page,
}, testInfo) => {
  const state = {
    windowId: randomUUID(),
    label: 'Computer',
    threadId: 'long-history',
    title: 'An ongoing conversation',
    status: 'idle',
    message: '',
    entries: Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? 'assistant' : 'user',
      text: `Message ${index}: this saved conversation remains readable on both screens.\n\nA second paragraph with some **important details**.`,
    })),
  };
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [state] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: state }),
  );
  await page.goto('/?mirror=1');
  const log = page.getByRole('log');
  await expect(log.getByText('Message 79:', { exact: false })).toBeInViewport();
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByRole('button', { name: 'Latest messages' })).toBeVisible();
  state.entries.push({ id: '80', role: 'assistant', text: 'Newest reply stays at the bottom.' });
  await expect(log).toContainText('Newest reply stays at the bottom.');
  expect(await log.evaluate((el) => el.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'Latest messages' }).click();
  await expect(log.getByText('Newest reply stays at the bottom.')).toBeInViewport();
  await expect(page.getByLabel('Message Codex')).toBeInViewport();
  await page.screenshot({
    path: `../../data/screenshots/mirror-history-${testInfo.project.name}.png`,
  });
  // Simulate a mobile keyboard reducing only the visual viewport, not innerHeight.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 330 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(async () => {
      const box = await page.getByLabel('Message Codex').boundingBox();
      return box!.y + box!.height;
    })
    .toBeLessThanOrEqual(330);
  await page.unrouteAll({ behavior: 'wait' });
});

test('empty mirror provides setup guidance without exposing a shell or package-manager commands', async ({
  page,
}) => {
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [] }));
  await page.goto('/?mirror=1');
  const dialog = page.getByRole('region', { name: 'VS Code conversations' });
  await expect(dialog).toContainText('Share a Conversation');
  await expect(dialog).not.toContainText('pnpm');
  await expect(page.getByLabel('Message Codex')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a late receipt cannot clear the draft of a newly shared conversation', async ({ page }) => {
  const windowId = randomUUID();
  const state = {
    windowId,
    label: 'Computer',
    threadId: 'first',
    title: 'First conversation',
    status: 'idle',
    message: '',
    entries: [],
  };
  let complete!: () => void;
  const release = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let started = false;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => route.fulfill({ json: [state] }));
  await page.route(`**/api/vscode/windows/${windowId}`, (route) => route.fulfill({ json: state }));
  await page.route(`**/api/vscode/windows/${windowId}/send`, async (route) => {
    started = true;
    await release;
    await route.fulfill({ json: { state: 'sent', message: 'Sent' } });
  });
  try {
    await page.goto('/?mirror=1');
    const input = page.getByLabel('Message Codex');
    await expect(input).toBeVisible();
    await page.evaluate(() =>
      sessionStorage.setItem(
        'dock:mirror:local:second',
        JSON.stringify({ text: 'Keep my other draft', pending: null }),
      ),
    );
    await input.fill('First thread message');
    await input.press('Enter');
    await expect.poll(() => started).toBe(true);
    state.threadId = 'second';
    state.title = 'Second conversation';
    await expect(page.getByRole('region', { name: 'Codex chat', exact: true })).toContainText(
      'First conversation',
    );
    await expect(input).toHaveValue('First thread message');
    await chooseChat(page, 'Second conversation');
    await expect(input).toHaveValue('Keep my other draft');
    complete();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('Keep my other draft');
  } finally {
    complete();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('chat navigation separates providers and drafts, preserves selection, and returns to project chat', async ({
  page,
}, testInfo) => {
  const codex = {
    windowId: randomUUID(),
    label: 'Writing project',
    threadId: 'same-id',
    title: 'Plan the next chapter',
    status: 'idle',
    message: '',
    entries: [
      {
        id: '1',
        role: 'assistant',
        text: 'Here is our chapter outline.\n\n- Start with the observation\n- Explain the experiment\n- End with what we learned',
      },
    ],
  };
  const claude = {
    ...codex,
    windowId: randomUUID(),
    provider: 'claude',
    title: 'Review the experiment',
    entries: [
      {
        id: '1',
        role: 'assistant',
        text: 'The experiment is ready for review. What would you like to look at first?',
      },
    ],
  };
  let sent: Record<string, string> | undefined;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [codex, claude] }),
  );
  for (const state of [codex, claude])
    await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
      route.fulfill({ json: state }),
    );
  await page.route(`**/api/vscode/windows/${claude.windowId}/send`, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ json: { state: 'sent', message: 'Sent to Claude Code.' } });
  });
  await page.goto('/?mirror=1');
  await chooseChat(page, 'Plan the next chapter');
  await page.getByLabel('Message Codex').fill('Keep my Codex draft');
  await chooseChat(page, 'Review the experiment');
  await expect(page.getByLabel('Message Claude Code')).toHaveValue('');
  await page.getByLabel('Message Claude Code').fill('Check the conclusion');
  await page.reload();
  await expect(page.getByLabel('Message Claude Code')).toHaveValue('Check the conclusion');
  await expect(page.getByRole('log')).toContainText('ready for review');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => sent?.provider).toBe('claude');
  expect(sent?.threadId).toBe('same-id');
  await chooseChat(page, 'Plan the next chapter');
  await expect(page.getByLabel('Message Codex')).toHaveValue('Keep my Codex draft');
  await page.screenshot({
    path: `../../data/screenshots/mirror-chat-${testInfo.project.name}.png`,
  });
  const input = await page.getByLabel('Message Codex').boundingBox();
  expect(input!.y + input!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await openChats(page);
  await page
    .getByRole('navigation', { name: 'Projects', exact: true })
    .getByRole('button')
    .first()
    .click();
  await expect(page.locator('.mirror-conversation')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.mirror-conversation')).toHaveCount(0);
  await chooseChat(page, 'Plan the next chapter');
  await expect(page.getByLabel('Message Codex')).toHaveValue('Keep my Codex draft');
  await page.unrouteAll({ behavior: 'wait' });
});

test('offline chats stay visible and reconnect to the same thread with a new window ID without sending', async ({
  page,
}) => {
  let state = {
    windowId: randomUUID(),
    label: 'My computer',
    threadId: 'reconnect',
    title: 'A continuing chat',
    status: 'idle',
    message: '',
    entries: [{ id: '1', role: 'assistant', text: 'Saved answer' }],
  };
  let online = true,
    posts = 0;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: online ? [state] : [] }),
  );
  await page.route(/\/api\/vscode\/windows\/[^/]+$/, (route) => route.fulfill({ json: state }));
  await page.route('**/api/vscode/windows/*/send', (route) => {
    posts++;
    return route.abort();
  });
  await page.goto('/?mirror=1');
  await expect(page.getByRole('log')).toContainText('Saved answer');
  await page.getByLabel('Message Codex').fill('Send only when I choose');
  online = false;
  await expect(page.locator('.mirror-header')).toContainText('Offline');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('log')).toContainText('Saved answer');
  await page.reload();
  await expect(page.getByLabel('Message Codex')).toHaveValue('Send only when I choose');
  state = { ...state, windowId: randomUUID() };
  online = true;
  await expect(page.locator('.mirror-header')).toContainText('Connected');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect(posts).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
});
