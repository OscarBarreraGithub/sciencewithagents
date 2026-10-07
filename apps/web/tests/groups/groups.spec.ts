import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const unexpected = new WeakMap<Page, string[]>();
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  const denied: string[] = [];
  unexpected.set(page, denied);
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin !== 'http://127.0.0.1:5197' ||
      request.method() !== 'GET' ||
      !(
        [
          '/',
          '/bootstrap.ts',
          '/Fixture.tsx',
          '/fixture.css',
          '/@vite/client',
          '/@react-refresh',
        ].includes(url.pathname) ||
        url.pathname.startsWith('/node_modules/.vite/deps/') ||
        ['apps/web/src', 'packages/shared/dist', 'node_modules', 'apps/web/node_modules'].some(
          (root) => decodeURIComponent(url.pathname).startsWith(`/@fs${resolve('../..', root)}/`),
        )
      )
    ) {
      denied.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(unexpected.get(page)).toEqual([]);
  expect(pageErrors.get(page)).toEqual([]);
});
async function controls(page: Page) {
  const control = page.locator('.fixture-controls');
  if (!(await control.evaluate((element) => (element as HTMLDetailsElement).open)))
    await control.locator('summary').click();
}
async function closeControls(page: Page) {
  const control = page.locator('.fixture-controls');
  if (await control.evaluate((element) => (element as HTMLDetailsElement).open))
    await control.locator('summary').click();
}
async function openGroup(page: Page) {
  await page.getByRole('button', { name: /River observations/ }).click();
  await expect(page.locator('.groups-event').first()).toBeVisible();
}
async function chat(page: Page) {
  const tab = page.getByRole('tab', { name: 'Your chat' });
  if (await tab.count()) await tab.click();
}
async function feed(page: Page) {
  const tab = page.getByRole('tab', { name: 'Shared feed' });
  if (await tab.count()) await tab.click();
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

test('first-run typed identity, create/join validation and truthful callbacks', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Your display name' });
  await expect(name).toHaveValue('');
  await expect(name).toBeFocused();
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.getByRole('alert')).toContainText('Type your display name');
  await name.fill('José · 李明');
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.getByRole('alert')).toContainText('Type a project name');
  await page.getByRole('textbox', { name: 'Project name' }).fill('Field notes');
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.getByRole('alert')).toContainText('setup is not connected');
  await expect(name).toHaveValue('José · 李明');
  await page.getByRole('button', { name: 'Back to groups' }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Join by invitation' }).click();
  await page.getByRole('button', { name: 'Request to join' }).click();
  await expect(page.getByRole('alert')).toContainText('Paste your invitation');
  await page
    .getByRole('textbox', { name: 'Invitation link' })
    .fill('https://example.invalid/synthetic-invite');
  await page.getByRole('button', { name: 'Request to join' }).click();
  await expect(page.getByRole('alert')).toContainText('joining is not connected');
  await noOverflow(page);
});

test('substantive feed, safe names, toggle filter, bounded pagination and exact source retry', async ({
  page,
}) => {
  await openGroup(page);
  await expect(page.locator('.groups-event')).toHaveCount(20);
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveCount(0);
  await expect(page.locator('.groups-event').first()).toContainText('same calibration');
  await expect(page.locator('.groups-event').nth(3)).toContainText('Noor⟦U+202E⟧⟦U+0007⟧');
  await expect(page.locator('.groups-feed-panel textarea')).toHaveCount(0);
  const decision = page.getByRole('button', { name: 'Decision', exact: true });
  await decision.click();
  await expect(decision).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.groups-event')).toHaveCount(3);
  await decision.click();
  await expect(decision).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.groups-event')).toHaveCount(20);
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await expect(page.getByRole('button', { name: 'Retry original' })).toBeVisible();
  await controls(page);
  await page.getByLabel('Fail original', { exact: true }).uncheck();
  await closeControls(page);
  await page.getByRole('button', { name: 'Retry original' }).click();
  const original = page.locator('pre[aria-label="Exact original"]');
  await expect(original).toBeVisible();
  const exact = `  Can we compare the river readings?\n\nKeep the original spacing.\tأمينة · 李明\nControl evidence: \u202e literal.\n${'Long source with evidence '.repeat(220)}\n${'x'.repeat(800)}\n  `;
  expect(await original.textContent()).toBe(exact);
  await page.getByText('Evidence and causal references', { exact: true }).click();
  await expect(page.getByText('Source message', { exact: false })).toContainText(
    'synthetic-message-0',
  );
  await noOverflow(page);
  await page.getByRole('button', { name: 'Close original' }).click();
  await page.getByRole('button', { name: 'Load more events' }).click();
  await expect(page.locator('.groups-event')).toHaveCount(32);
  await expect(page.getByRole('button', { name: 'Load more events' })).toHaveCount(0);
});

test('private/shared draft separation, keyboard focus, notepad and failed send retry', async ({
  page,
}) => {
  await openGroup(page);
  await chat(page);
  const shared = page.getByRole('textbox', {
    name: 'Message Synthetic group session',
    exact: true,
  });
  await shared.fill('Shared draft stays here');
  await expect(shared).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private aside', exact: true })).toBeFocused();
  const privateText = page.getByRole('textbox', {
    name: 'Message Synthetic private session',
    exact: true,
  });
  await expect(privateText).toHaveValue('');
  await expect(shared).toHaveCount(0);
  await privateText.fill('Only private draft');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Private aside', exact: true })).toBeFocused();
  await expect(shared).toHaveValue('Shared draft stays here');
  await expect(privateText).toHaveCount(0);
  await feed(page);
  await chat(page);
  await expect(shared).toHaveValue('Shared draft stays here');
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /Minimize/ }).click();
  await expect(shared).toHaveValue('Shared draft stays here');
  await controls(page);
  await page.getByLabel('Fail send', { exact: true }).check();
  await closeControls(page);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry previous message' })).toBeVisible();
  await expect(shared).toHaveValue('Shared draft stays here');
  await controls(page);
  await page.getByLabel('Fail send', { exact: true }).uncheck();
  await closeControls(page);
  await page.getByRole('button', { name: 'Retry previous message' }).click();
  await expect(shared).toHaveValue('');
  await expect(page.locator('.conversation')).toContainText('Shared draft stays here');
  await expect(shared).toBeFocused();
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await expect(privateText).toHaveValue('Only private draft');
  await expect(page.locator('.conversation')).not.toContainText('Shared draft stays here');
  await noOverflow(page);
});

test('private Notepad Escape dismisses only the nested dialog', async ({ page }, info) => {
  await openGroup(page);
  await chat(page);
  const shared = page.getByRole('textbox', {
    name: 'Message Synthetic group session',
    exact: true,
  });
  await shared.fill('Shared draft before private Notepad');
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  const privateText = page.getByRole('textbox', {
    name: 'Message Synthetic private session',
    exact: true,
  });
  await privateText.fill('Private draft before Notepad');
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('Private draft edited inside Notepad');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Private aside', exact: true })).toBeVisible();
  await expect(privateText).toHaveValue('Private draft edited inside Notepad');
  await expect(privateText).toBeFocused();
  await expect(shared).toHaveCount(0);
  const folder = resolve('../../data/groups-ui/correction2/screenshots');
  await mkdir(folder, { recursive: true });
  await page.screenshot({
    path: resolve(folder, `${info.project.name}-private-notepad-return.png`),
    fullPage: false,
  });
  await page.getByRole('button', { name: 'Back to group chat' }).click();
  await expect(shared).toHaveValue('Shared draft before private Notepad');
});

test('handled, composing and nested-dialog Escape events leave the private context intact', async ({
  page,
}) => {
  await openGroup(page);
  await chat(page);
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  const input = page.getByRole('textbox', {
    name: 'Message Synthetic private session',
    exact: true,
  });
  await input.fill('Private draft for event ownership');
  const heading = page.getByRole('heading', { name: 'Private aside', exact: true });
  // Actual bubbling DOM events enter the React handler; each guard is tested separately.
  expect(
    await input.evaluate((element) => {
      const handled = (event: Event) => event.preventDefault();
      element.addEventListener('keydown', handled, { once: true });
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect(heading).toBeVisible();
  expect(
    await input.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await expect(heading).toBeVisible();
  expect(
    await input.evaluate((element) => {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('role', 'dialog');
      element.before(wrapper);
      wrapper.append(element);
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      wrapper.replaceWith(element);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await expect(heading).toBeVisible();
  await expect(input).toHaveValue('Private draft for event ownership');
  await input.focus();
  await page.keyboard.press('Escape');
  await expect(heading).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Private aside', exact: true })).toBeFocused();
});

test('catch-up retains mounted shared/private chat, reading position, draft selection and return focus', async ({
  page,
}) => {
  await openGroup(page);
  await chat(page);
  for (const context of ['group', 'private'] as const) {
    if (context === 'private')
      await page.getByRole('button', { name: 'Private aside', exact: true }).click();
    const input = page.getByRole('textbox', {
      name: `Message Synthetic ${context} session`,
      exact: true,
    });
    for (let index = 0; index < 3; index++) {
      await input.fill(
        `Synthetic ${context} note ${index}. ${'A long reading about calibration and sampling. '.repeat(70)}`,
      );
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(input).toHaveValue('');
    }
    await input.fill(`Retained ${context} catch-up draft`);
    await input.evaluate((element) => {
      element.dataset.retainedInstance = 'same mounted composer';
      (element as HTMLTextAreaElement).setSelectionRange(3, 11);
    });
    const timeline = page.locator('.conversation');
    await timeline.hover();
    const bottom = await timeline.evaluate((element) => element.scrollTop);
    await page.mouse.wheel(0, -700);
    await expect
      .poll(() => timeline.evaluate((element) => element.scrollTop))
      .toBeLessThan(bottom - 100);
    const readingTop = await timeline.evaluate((element) => element.scrollTop);
    const opener = page.getByRole('button', { name: 'What mattered since last visit?' });
    for (const dismiss of ['Escape', 'Back to conversation']) {
      await opener.click();
      await expect(
        page.getByRole('heading', { name: 'Private catch-up', exact: true }),
      ).toBeFocused();
      const slot = page.locator('.groups-chat-slot');
      await expect(slot).toBeHidden();
      await expect(slot).toHaveAttribute('inert', '');
      await expect(slot.locator('textarea[data-retained-instance]')).toHaveCount(1);
      await expect(
        page.getByRole('textbox', { name: `Message Synthetic ${context} session`, exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText('Request privacy must be enforced by the host.', { exact: false }),
      ).toBeVisible();
      if (dismiss === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: dismiss, exact: true }).click();
      await expect(opener).toBeFocused();
      await expect(
        page.getByRole('heading', {
          name: context === 'private' ? 'Private aside' : 'Your group agent',
          exact: true,
        }),
      ).toBeVisible();
      await expect(input).toHaveValue(`Retained ${context} catch-up draft`);
      await expect(input).toHaveAttribute('data-retained-instance', 'same mounted composer');
      expect(
        await input.evaluate((element) => [
          (element as HTMLTextAreaElement).selectionStart,
          (element as HTMLTextAreaElement).selectionEnd,
        ]),
      ).toEqual([3, 11]);
      await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(readingTop);
    }
  }
  await page.getByRole('button', { name: 'Back to group chat' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Message Synthetic group session', exact: true }),
  ).toHaveValue('Retained group catch-up draft');
});

test('static HTTP boundary denies fabricated runtime data, encoding and traversal', async ({}, info) => {
  const canary = `SYNTHETIC-CANARY-${randomUUID()}`;
  const file = resolve(
    '../../data/groups-ui/correction1',
    `canary-${info.project.name}-${randomUUID()}.ts`,
  );
  await mkdir(resolve('../../data/groups-ui/correction1'), { recursive: true });
  await writeFile(file, `export default ${JSON.stringify(canary)};`);
  const read = (path: string, method = 'GET') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      // Node HTTP sends the raw path; browser/API URL normalization could hide traversal cases.
      const request = httpRequest(
        { hostname: '127.0.0.1', port: 5197, method, path },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (part: string) => {
            body += part;
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  try {
    const root = resolve('../..');
    const suffix = file.slice(root.length + 1);
    const attempts = [
      `/@fs${file}`,
      `/@fs${file}?raw`,
      `/@fs${file}?import`,
      `/@fs${file.replace('/data/', '/%64ata/')}`,
      `/@fs${file.replace('/data/', '/%2564ata/')}`,
      `/@fs${root}/apps/web/src/../../../${suffix}`,
      `/@fs${root}/apps/web/src/%2e%2e/%2e%2e/%2e%2e/${suffix}`,
      `/@fs${root}/apps/web/src/%2e%2e%2f%2e%2e%2f%2e%2e%2f${suffix}`,
      `/@fs${root}/apps/web/src/../../../data%2f${suffix.slice('data/'.length)}`,
      `/@fs${root}/apps/web/src/..%5c..%5c..%5c${suffix}`,
      `/node_modules/.vite/deps/../../../../../../../${suffix}`,
      `/@id/${file}`,
      `/../${suffix}`,
      '/api/groups',
    ];
    for (const path of attempts) {
      const result = await read(path);
      expect(result.status, path).toBe(403);
      expect(result.body, path).not.toContain(canary);
    }
    expect((await read('/bootstrap.ts')).status).toBe(200);
    expect((await read(`/@fs${root}/apps/web/src/groups/GroupsWorkspace.tsx`)).status).toBe(200);
    expect((await read('/bootstrap.ts', 'POST')).status).toBe(403);
  } finally {
    await rm(file);
  }
});

test('late source responses discarded on project and session switch; revocation removes evidence/chat', async ({
  page,
}) => {
  await controls(page);
  await page.getByLabel('Fail original', { exact: true }).uncheck();
  await page.getByLabel('Slow original', { exact: true }).check();
  await closeControls(page);
  await openGroup(page);
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await expect(page.getByText('Loading exact original…')).toBeVisible();
  await controls(page);
  await page.getByRole('button', { name: 'Switch project' }).click();
  await closeControls(page);
  await expect(page.getByRole('heading', { name: '星の研究 · رصد النجوم' })).toBeVisible();
  await page.waitForTimeout(1600);
  await expect(page.locator('pre[aria-label="Exact original"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close original' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await controls(page);
  await page.getByRole('button', { name: 'Replace sessions' }).click();
  await closeControls(page);
  await page.waitForTimeout(1600);
  await expect(page.locator('pre[aria-label="Exact original"]')).toHaveCount(0);
  await chat(page);
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Synthetic private session', exact: true })
    .fill('Private hidden after revocation');
  await controls(page);
  await page.getByLabel('Feed state').selectOption('revoked-response');
  await page.getByRole('button', { name: 'Replace sessions' }).click();
  await closeControls(page);
  await expect(page.getByRole('heading', { name: 'Group access revoked' })).toBeVisible();
  await expect(page.locator('.groups-event')).toHaveCount(0);
  await expect(page.locator('.conversation')).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to groups' }).click();
  await expect(page.getByRole('heading', { name: 'Groups', exact: true })).toBeFocused();
});

test('feed empty/offline/error retry, private catch-up retry, phone tabs preserve scroll', async ({
  page,
}) => {
  await controls(page);
  await page.getByLabel('Feed state').selectOption('empty');
  await closeControls(page);
  await expect(page.getByText('No groups yet.', { exact: false })).toBeVisible();
  await controls(page);
  await page.getByLabel('Feed state').selectOption('offline');
  await closeControls(page);
  await expect(page.getByRole('button', { name: 'Retry projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry projects' }).click();
  await openGroup(page);
  await controls(page);
  await page.getByLabel('Feed state').selectOption('empty');
  await page.getByRole('button', { name: 'Replace sessions' }).click();
  await closeControls(page);
  await expect(page.getByText('No shared events yet.')).toBeVisible();
  await controls(page);
  await page.getByLabel('Feed state').selectOption('offline');
  await page.getByRole('button', { name: 'Replace sessions' }).click();
  await closeControls(page);
  await expect(page.getByRole('button', { name: 'Retry feed' })).toBeVisible();
  await controls(page);
  await page.getByLabel('Feed state').selectOption('error');
  await closeControls(page);
  await page.getByRole('button', { name: 'Retry feed' }).click();
  await expect(page.getByText('Synthetic feed failure.', { exact: false })).toBeVisible();
  await controls(page);
  await page.getByLabel('Feed state').selectOption('ready');
  await closeControls(page);
  await page.getByRole('button', { name: 'Retry feed' }).click();
  await expect(page.locator('.groups-event')).toHaveCount(20);
  const scroller = page.getByLabel('Shared feed entries', { exact: true });
  await scroller.evaluate((element) => {
    element.scrollTop = 400;
  });
  const top = await scroller.evaluate((element) => element.scrollTop);
  await chat(page);
  await feed(page);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(top);
  const tab = page.getByRole('tab', { name: 'Shared feed' });
  if (await tab.count()) {
    await tab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Your chat' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Your chat' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } else await chat(page);
  await page.getByRole('button', { name: 'What mattered since last visit?' }).click();
  await expect(page.getByRole('heading', { name: 'Private catch-up', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Retry catch-up' })).toBeVisible();
  await controls(page);
  await page.getByLabel('Fail catch-up', { exact: true }).uncheck();
  await closeControls(page);
  await page.getByRole('button', { name: 'Retry catch-up' }).click();
  await expect(page.getByText('Synthetic example, limited', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(page.getByRole('button', { name: 'What mattered since last visit?' })).toBeFocused();
  await noOverflow(page);
});

test('enlarged text, long originals and responsive screenshots', async ({ page }, info) => {
  const folder = resolve('../../data/groups-ui/correction2/screenshots');
  await mkdir(folder, { recursive: true });
  await page.screenshot({
    path: resolve(folder, `${info.project.name}-landing.png`),
    fullPage: false,
  });
  await openGroup(page);
  await page.screenshot({
    path: resolve(folder, `${info.project.name}-feed.png`),
    fullPage: false,
  });
  await chat(page);
  await page
    .getByRole('textbox', { name: 'Message Synthetic group session', exact: true })
    .fill('A draft for the sampling plan.');
  await page.screenshot({
    path: resolve(folder, `${info.project.name}-chat.png`),
    fullPage: false,
  });
  await controls(page);
  await page.getByLabel('Large text', { exact: true }).check();
  await page.getByLabel('Fail original', { exact: true }).uncheck();
  await closeControls(page);
  await page.getByRole('button', { name: 'Send message', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await noOverflow(page);
  await feed(page);
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await expect(page.locator('pre[aria-label="Exact original"]')).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: resolve(folder, `${info.project.name}-large-source.png`),
    fullPage: false,
  });
  if (info.project.use.viewport!.height <= 500) {
    const scroller = page.getByLabel('Shared feed entries', { exact: true });
    expect(await scroller.evaluate((element) => element.clientHeight)).toBeGreaterThan(180);
    await scroller.hover();
    await page.mouse.wheel(0, 550);
    await expect
      .poll(() =>
        page
          .locator('.groups-feed-chrome')
          .evaluate((element) => element.getBoundingClientRect().bottom),
      )
      .toBeLessThan(await scroller.evaluate((element) => element.getBoundingClientRect().top));
    await page.screenshot({
      path: resolve(folder, `${info.project.name}-large-reading.png`),
      fullPage: false,
    });
    await scroller.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole('button', { name: 'Decision', exact: true })).toBeInViewport();
    await expect(page.getByRole('tab', { name: 'Your chat' })).toBeInViewport();
  }
  await chat(page);
  await page
    .getByRole('textbox', { name: 'Message Synthetic group session', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('textbox', { name: 'Message Synthetic group session', exact: true }),
  ).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  const timeline = page.locator('.conversation');
  expect(await timeline.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(120);
  await timeline.hover();
  await expect(timeline.locator('.message').first()).toBeInViewport();
  await page.screenshot({
    path: resolve(folder, `${info.project.name}-large-chat.png`),
    fullPage: false,
  });
});

test('pending page switches and invalid shared pages never expose other scopes', async ({
  page,
}) => {
  await controls(page);
  await page.getByLabel('Slow feed', { exact: true }).check();
  await closeControls(page);
  await page.getByRole('button', { name: /River observations/ }).click();
  await expect(page.getByText('Loading shared events…')).toBeVisible();
  await controls(page);
  await page.getByRole('button', { name: 'Switch project' }).click();
  await closeControls(page);
  await expect(page.locator('.groups-event').first()).toHaveAttribute(
    'data-event-id',
    '00000000-0000-4000-8000-000000000200',
  );
  await expect(page.locator('[data-event-id="00000000-0000-4000-8000-000000000100"]')).toHaveCount(
    0,
  );
  for (const scenario of ['private-page', 'wrong-group-page']) {
    await controls(page);
    await page.getByLabel('Slow feed', { exact: true }).uncheck();
    await page.getByLabel('Feed state').selectOption(scenario);
    await page.getByRole('button', { name: 'Replace sessions' }).click();
    await closeControls(page);
    await expect(page.getByText('The page did not belong to this shared group.')).toBeVisible();
    await expect(page.locator('.groups-event')).toHaveCount(0);
    await expect(page.locator('pre[aria-label="Exact original"]')).toHaveCount(0);
  }
});

test('source integrity failure retries; drafts persist across Back and browser reload', async ({
  page,
}) => {
  await controls(page);
  await page.getByLabel('Fail original', { exact: true }).uncheck();
  await page.getByLabel('Wrong original', { exact: true }).check();
  await closeControls(page);
  await openGroup(page);
  await page.getByRole('button', { name: 'Read exact original' }).first().click();
  await expect(
    page.getByText('The original evidence failed its integrity check.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('pre[aria-label="Exact original"]')).toHaveCount(0);
  await controls(page);
  await page.getByLabel('Wrong original', { exact: true }).uncheck();
  await closeControls(page);
  await page.getByRole('button', { name: 'Retry original' }).click();
  await expect(page.locator('pre[aria-label="Exact original"]')).toBeVisible();
  await chat(page);
  const shared = page.getByRole('textbox', {
    name: 'Message Synthetic group session',
    exact: true,
  });
  await shared.fill('Retained browser-only shared draft');
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Synthetic private session', exact: true })
    .fill('Retained browser-only private draft');
  await page.getByRole('button', { name: 'Back to groups' }).click();
  await openGroup(page);
  await chat(page);
  await expect(shared).toHaveValue('Retained browser-only shared draft');
  await page.reload();
  await openGroup(page);
  await chat(page);
  await expect(shared).toHaveValue('Retained browser-only shared draft');
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Message Synthetic private session', exact: true }),
  ).toHaveValue('Retained browser-only private draft');
});

test('conversation reading position survives panel and private/session navigation', async ({
  page,
}) => {
  await openGroup(page);
  await chat(page);
  const input = page.getByRole('textbox', { name: 'Message Synthetic group session', exact: true });
  for (let index = 0; index < 5; index++) {
    await input.fill(
      `Synthetic sampling note ${index + 1}.\n\n${'Keep the calibration readings with the original station and timestamp. '.repeat(16)}`,
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
  }
  await input.fill('Draft while reading earlier messages');
  const timeline = page.locator('.conversation');
  const bottom = await timeline.evaluate((element) => element.scrollTop);
  await timeline.hover();
  await page.mouse.wheel(0, -1000);
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollTop))
    .toBeLessThan(bottom - 100);
  const readingTop = await timeline.evaluate((element) => element.scrollTop);
  await feed(page);
  await chat(page);
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(readingTop);
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await page.getByRole('button', { name: 'Back to group chat' }).click();
  await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(readingTop);
  await expect(input).toHaveValue('Draft while reading earlier messages');
  await expect(input).toBeInViewport();
});

test('backend-dependent upload and normal chat links fail visibly without network', async ({
  page,
}) => {
  await openGroup(page);
  await chat(page);
  const input = page.getByRole('textbox', { name: 'Message Synthetic group session', exact: true });
  await input.fill('Draft retained through unavailable upload');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'synthetic.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic attachment only.'),
  });
  await expect(page.getByRole('alert')).toContainText(
    'Uploads are unavailable in the synthetic preview',
  );
  await expect(input).toHaveValue('Draft retained through unavailable upload');
  await page.getByRole('button', { name: 'Private aside', exact: true }).click();
  await page.getByRole('button', { name: 'Back to group chat' }).click();
  await expect(input).toHaveValue('Draft retained through unavailable upload');
  await input.fill('See https://example.invalid/synthetic-only for this synthetic note.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('link', { name: 'https://example.invalid/synthetic-only' }).click();
  await expect(
    page.getByText('Links are unavailable in the synthetic preview.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'River observations' })).toBeVisible();
});

test('150% chat retains a readable transcript and scroll-reachable controls in both contexts', async ({
  page,
}, info) => {
  await controls(page);
  await page.getByLabel('Large text', { exact: true }).check();
  await closeControls(page);
  await openGroup(page);
  await chat(page);
  const folder = resolve('../../data/groups-ui/correction2/screenshots');
  await mkdir(folder, { recursive: true });
  for (const context of ['group', 'private']) {
    if (context === 'private')
      await page.getByRole('button', { name: 'Private aside', exact: true }).click();
    const timeline = page.locator('.conversation');
    expect(await timeline.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(120);
    const input = page.getByRole('textbox', {
      name: `Message Synthetic ${context} session`,
      exact: true,
    });
    for (let index = 0; index < 3; index++) {
      await input.fill(
        `Reading ${context} ${index}. ${'Keep each calibration with its timestamp. '.repeat(25)}`,
      );
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(input).toHaveValue('');
    }
    const marker =
      context === 'private' ? 'Private reading is visible.' : 'Shared reading is visible.';
    await input.fill(marker);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
    // Reach the transcript by wheel, then read its final message through its own scroller.
    const panel = page.locator('.groups-chat-panel');
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 8, box!.y + 8);
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(0);
    const panelBottom = await panel.evaluate((element) => element.getBoundingClientRect().bottom);
    const transcriptBottom = await timeline.evaluate(
      (element) => element.getBoundingClientRect().bottom,
    );
    if (transcriptBottom > panelBottom)
      await page.mouse.wheel(0, transcriptBottom - panelBottom + 8);
    await expect
      .poll(() => timeline.evaluate((element) => element.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(panelBottom);
    await timeline.hover();
    await page.mouse.wheel(0, 10000);
    const last = timeline.getByText(marker, { exact: true });
    await expect(last).toBeInViewport();
    // toBeInViewport alone does not establish visibility through overflow-clipping ancestors.
    await expect
      .poll(() =>
        last.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const timeline = element.closest('.conversation')!.getBoundingClientRect();
          const panel = element.closest('.groups-chat-panel')!.getBoundingClientRect();
          return (
            rect.top >= Math.max(0, timeline.top, panel.top) &&
            rect.bottom <= Math.min(innerHeight, timeline.bottom, panel.bottom)
          );
        }),
      )
      .toBe(true);
    await noOverflow(page);
    await page.screenshot({
      path: resolve(folder, `${info.project.name}-large-${context}-reading.png`),
      fullPage: false,
    });
    // Normal keyboard traversal must reach the composer and scroll it into the visible panel.
    await page.getByRole('button', { name: 'What mattered since last visit?' }).click();
    await page.keyboard.press('Escape');
    for (
      let step = 0;
      step < 20 && !(await input.evaluate((element) => element === document.activeElement));
      step++
    )
      await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await expect(input).toBeInViewport();
    await input.fill(`Retained ${context} enlarged draft`);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    // Wheel to the panel's bottom to expose the entire composer, not just Send's edge.
    const visiblePanel = await panel.boundingBox();
    await page.mouse.move(
      visiblePanel!.x + 8,
      Math.min(visiblePanel!.y + visiblePanel!.height - 8, info.project.use.viewport!.height - 8),
    );
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() =>
        input.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const panel = element.closest('.groups-chat-panel')!.getBoundingClientRect();
          return (
            rect.top >= Math.max(0, panel.top) && rect.bottom <= Math.min(innerHeight, panel.bottom)
          );
        }),
      )
      .toBe(true);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeFocused();
    await noOverflow(page);
    await page.screenshot({
      path: resolve(folder, `${info.project.name}-large-${context}-composer.png`),
      fullPage: false,
    });
    const tab = page.getByRole('tab', { name: 'Your chat' });
    if (await tab.count()) {
      // Shift-Tab returns through the panel controls to the selected tab.
      for (
        let step = 0;
        step < 20 && !(await tab.evaluate((element) => element === document.activeElement));
        step++
      )
        await page.keyboard.press('Shift+Tab');
      await expect(tab).toBeFocused();
      await expect(tab).toBeInViewport();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByRole('tab', { name: 'Shared feed' })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tab).toBeFocused();
    }
    await expect(input).toHaveValue(`Retained ${context} enlarged draft`);
    await expect(
      page.getByRole('heading', {
        name: context === 'private' ? 'Private aside' : 'Your group agent',
        exact: true,
      }),
    ).toBeVisible();
  }
});
