import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroupHostOpen } from '@dock/shared/dist/group-host.js';
import type { GroupPhoneHostView } from '@dock/shared/dist/group-phone-host.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let child: ChildProcess | undefined;
let connection: { origin: string; cookie: string; port: number };
test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      join(root, 'apps/server/node_modules/tsx/dist/cli.mjs'),
      join(root, 'apps/server/src/group-host-browser.fixture.ts'),
      '--phone-control',
    ],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' },
  );
  child.stderr?.resume();
  connection = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Owned phone harness startup timeout')), 30000);
    child!.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Owned phone harness exited'));
    });
    child!.stdout!.on('data', (chunk) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const value = JSON.parse(line) as typeof connection;
          if (value.origin && value.cookie) {
            clearTimeout(timer);
            resolve(value);
            return;
          }
        } catch {}
      }
    });
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const end = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await end;
  }
  expect(child?.exitCode).toBe(0);
});

test('hosted phone reads without a companion and retains exact human retries without scroll jitter', async ({
  page,
  playwright,
}, info) => {
  const owner = await playwright.request.newContext({
    baseURL: `http://127.0.0.1:${connection.port}`,
    extraHTTPHeaders: {
      Host: new URL(connection.origin).host,
      Origin: connection.origin,
      Cookie: connection.cookie,
    },
  });
  try {
    const created = await owner.post('/api/groups/create', {
      data: { key: randomUUID(), projectName: 'Phone acceptance', displayName: 'Amina' },
    });
    expect(created.status()).toBe(200);
    const open = (await created.json()) as GroupHostOpen;
    const original = 'A shared result with its full original. '.repeat(50);
    const sent = await owner.post('/api/groups/send', {
      data: { handle: open.shared.handle, key: randomUUID(), text: original },
    });
    expect(sent.status()).toBe(200);
    async function pair(allowPost: boolean) {
      const result = await owner.post('/api/groups/phone', {
        data: {
          action: 'pair',
          handle: open.shared.handle,
          key: randomUUID(),
          label: 'Browser phone',
          allowPost,
        },
      });
      expect(result.status()).toBe(200);
      return (await result.json()) as GroupPhoneHostView;
    }
    const [name, ...value] = connection.cookie.split('=');
    await page.context().addCookies([
      {
        name,
        value: value.join('='),
        url: connection.origin,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    await page.goto(`${connection.origin}/#/chats/groups`);
    const openManage = async () => {
      const manage = page.getByRole('button', { name: 'Manage', exact: true });
      const entry = page.getByRole('button', { name: /Phone acceptance/ });
      await expect(manage.or(entry).first()).toBeVisible();
      if (!(await manage.isVisible())) await entry.click();
      await manage.click();
    };
    await openManage();
    const panel = page.getByRole('region', { name: 'Phone access' });
    await expect(panel.getByLabel('Allow this phone to send human messages')).not.toBeChecked();
    await panel.getByRole('heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('phone-manage-setup.png') });
    const linkRequests: unknown[] = [];
    let lostLink = false;
    await page.route('**/api/groups/phone', async (route) => {
      const input = route.request().postDataJSON() as { action: string };
      if (input.action === 'pair') {
        linkRequests.push(input);
        if (!lostLink) {
          lostLink = true;
          await route.fetch();
          await route.abort('failed');
          return;
        }
      }
      await route.continue();
    });
    await panel.getByRole('button', { name: 'Connect a phone', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Check saved phone request' })).toBeVisible();
    await page.reload();
    await openManage();
    await expect(panel.getByRole('button', { name: 'Check saved phone request' })).toBeVisible();
    await panel.getByRole('button', { name: 'Check saved phone request' }).click();
    await expect(panel.getByRole('button', { name: 'Copy phone link' })).toBeVisible();
    expect(linkRequests).toHaveLength(2);
    expect(linkRequests[0]).toEqual(linkRequests[1]);
    await panel.getByRole('button', { name: 'Copy phone link' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('phone-manage-link.png') });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '150%';
    });
    for (const name of ['Connect a phone', 'Refresh connections', 'Copy phone link']) {
      const button = panel.getByRole('button', { name, exact: true });
      await button.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await expect(button).toBeInViewport({ ratio: 1 });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(
        await button.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(24);
    }
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('phone-manage-large-text.png') });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    await page.context().clearCookies();
    const reading = await pair(false);
    await page.clock.install();
    await page.goto(reading.link!);
    await expect(page.getByRole('heading', { name: 'Phone acceptance' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Read full message' }).click();
    await expect(page.locator('#feed article p').first()).toHaveText(original.trim());
    const expanded = page.locator('#feed article').first();
    await expanded.evaluate((element) => {
      element.setAttribute('data-retained', 'yes');
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    const scroll = await page.evaluate(() => window.scrollY);
    await page.clock.fastForward(60001);
    await expect(expanded).toHaveAttribute('data-retained', 'yes');
    await expect(expanded.locator('p')).toHaveText(original.trim());
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('phone-read-only.png'), fullPage: true });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '150%';
      window.scrollTo(
        0,
        document.querySelector('#feed')!.getBoundingClientRect().top + window.scrollY,
      );
    });
    expect(
      await expanded
        .locator('p')
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(24);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    if ((page.viewportSize()?.height ?? 0) <= 500)
      expect(
        await page.locator('header').evaluate((element) => element.getBoundingClientRect().bottom),
      ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('phone-feed-large-text.png') });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
      window.scrollTo(0, 0);
    });
    const cookie = (await page.context().cookies()).find((value) =>
      value.name.startsWith('swa_test_group_'),
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    const writing = await pair(true);
    const claims: unknown[] = [];
    let limited = false;
    await page.route('**/v1/phone/*', async (route) => {
      const input = route.request().postDataJSON() as { kind: string };
      if (input.kind === 'claim') {
        claims.push(input);
        if (!limited) {
          limited = true;
          await route.fulfill({ status: 429, json: { ok: false, error: 'limit' } });
          return;
        }
      }
      await route.continue();
    });
    await page.goto(writing.link!);
    await expect(page.getByRole('status')).toContainText('current limit');
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Check phone connection' }).click();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual(claims[1]);
    await page.unroute('**/v1/phone/*');
    await page.evaluate(() => {
      localStorage.setItem('swa:phone-post:' + location.pathname.split('/')[2], '{not-json');
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Phone acceptance' })).toBeVisible();
    await expect(page.locator('#saved-request-note')).toContainText('could not be read');
    await expect(page.getByLabel('Message to the group')).toBeDisabled();
    await page.getByRole('button', { name: 'Refresh messages' }).click();
    await expect(page.locator('#saved-request-note')).toContainText('could not be read');
    await page.getByRole('button', { name: 'Stop retrying saved message' }).click();
    await expect(page.getByLabel('Message to the group')).toBeEnabled();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldPosts: { kind: string; key: string; text: string }[] = [];
    await page.route('**/v1/phone/*', async (route) => {
      const input = route.request().postDataJSON() as { kind: string; key: string; text: string };
      if (input.kind === 'post') {
        heldPosts.push(input);
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await page.getByLabel('Message to the group').fill('First held phone message.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop retrying saved message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeDisabled();
    await expect(page.getByLabel('Message to the group')).toBeDisabled();
    // Exercise the guards even when a browser extension dispatches handlers on disabled controls.
    await page.evaluate(() => {
      const remove = document.getElementById('remove') as HTMLButtonElement;
      remove.onclick?.call(remove, new MouseEvent('click'));
      const draft = document.getElementById('draft') as HTMLTextAreaElement;
      draft.value = 'Second unsent draft must survive the first receipt.';
      draft.dispatchEvent(new Event('input'));
      const form = document.getElementById('compose') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    expect(heldPosts).toHaveLength(1);
    release!();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeHidden();
    await expect(page.getByLabel('Message to the group')).toHaveValue(
      'Second unsent draft must survive the first receipt.',
    );
    expect(
      await page.evaluate(() =>
        localStorage.getItem('swa:phone-draft:' + location.pathname.split('/')[2]),
      ),
    ).toBe('Second unsent draft must survive the first receipt.');
    await page.unroute('**/v1/phone/*');
    let lost = false;
    const posts: { key: string; text: string }[] = [];
    await page.route('**/v1/phone/*', async (route) => {
      const input = route.request().postDataJSON() as { kind: string; key: string; text: string };
      if (input.kind === 'post') {
        posts.push({ key: input.key, text: input.text });
        if (!lost) {
          lost = true;
          await route.fetch();
          await route.abort('failed');
          return;
        }
      }
      await route.continue();
    });
    await page.getByLabel('Message to the group').fill('A phone message with a saved receipt.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry saved message' }).click();
    await expect(page.getByRole('button', { name: 'Retry saved message' })).toBeHidden();
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    await expect(
      page.locator('#feed article p').filter({ hasText: 'A phone message with a saved receipt.' }),
    ).toHaveCount(1);
    const devices = await owner.post('/api/groups/phone', {
      data: { action: 'status', handle: open.shared.handle },
    });
    const active = ((await devices.json()) as GroupPhoneHostView).devices.find(
      (d) => d.allowPost && d.state === 'active',
    )!;
    expect(
      (
        await owner.post('/api/groups/phone', {
          data: {
            action: 'revoke',
            handle: open.shared.handle,
            key: randomUUID(),
            deviceId: active.id,
          },
        })
      ).status(),
    ).toBe(200);
    await page.getByRole('button', { name: 'Refresh messages' }).click();
    await expect(page.getByRole('status')).toContainText('Pair again');
    await expect(page.locator('#feed article')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeHidden();
    await owner.dispose();
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Owned companion close timeout')), 15000);
      const listener = (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n')) {
          try {
            const value = JSON.parse(line) as { id?: string; companionsClosed?: boolean };
            if (value.id === id && value.companionsClosed) {
              clearTimeout(timer);
              child!.stdout!.off('data', listener);
              resolve();
            }
          } catch {}
        }
      };
      child!.stdout!.on('data', listener);
      child!.stdin!.write(JSON.stringify({ id, kind: 'close-companions' }) + '\n');
    });
    await page.context().clearCookies();
    await page.context().addCookies([cookie!]);
    const hosted = new URL(reading.link!);
    hosted.hash = '';
    await page.goto(hosted.toString());
    await expect(page.getByRole('heading', { name: 'Phone acceptance' })).toBeVisible();
    await expect(page.locator('#feed article')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeHidden();
  } finally {
    await owner.dispose();
  }
});
