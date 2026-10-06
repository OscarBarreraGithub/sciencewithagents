import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const shared = `chats/vscode/${encodeURIComponent('demo-editor:thread one')}`;

/** Two listed managers, so the desktop test switches through the actual chat sidebar. */
async function chats(page: Page) {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const manager: string = snapshot.projects.find(
    (p: { internal?: boolean }) => !p.internal,
  ).managerId;
  const created = await page.request.post('/api/projects', {
    headers: { origin: new URL(test.info().project.use.baseURL as string).origin },
    data: { key: randomUUID(), name: `Navigation sibling ${randomUUID()}`, provider: 'codex' },
  });
  expect(created.ok()).toBe(true);
  const other = await created.json();
  expect(other.managerId).not.toBe(manager);
  return [manager, other.managerId as string] as const;
}

const go = (page: Page, route: string) =>
  page.evaluate((route) => (location.hash = `#/${route}`), route);
const at = (page: Page, route: string) =>
  expect(page).toHaveURL(new RegExp(`#/${route.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}$`));

/** The app's Back: the visible control, or the phone swipe where chats hide the header. */
async function back(page: Page) {
  const link = page.locator('a.home-back');
  if (await link.isVisible()) return link.click();
  await page.locator('#home-content').evaluate((node) => {
    const dispatch = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const points = [{ clientX: x, clientY: 300 }];
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : points },
        changedTouches: { value: points },
      });
      node.dispatchEvent(event);
    };
    dispatch('touchstart', 40);
    dispatch('touchmove', 150);
    dispatch('touchend', 150);
  });
}

/** Every route the app shows from now on, to prove Back never passes an old chat. */
async function record(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { seen: string[] }).seen = [];
    addEventListener('hashchange', (event) =>
      (window as unknown as { seen: string[] }).seen.push(new URL(event.newURL).hash),
    );
  });
  return () => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
}

test('switching conversations retires the earlier chat, even after a settings detour', async ({
  page,
}) => {
  const [a, b] = await chats(page);
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  // A sub-window opened from a chat still returns to that chat.
  await go(page, `chat/${a}`);
  await go(page, 'settings');
  await at(page, 'settings');
  await back(page);
  await at(page, `chat/${a}`);
  // Direct app → app switch, from the desktop sidebar where it is shown.
  const sidebar = page.locator(`a[href="#/chat/${b}"]:visible`).first();
  if (page.viewportSize()!.width > 900 && page.viewportSize()!.height > 500) {
    await expect(sidebar).toBeVisible();
    await sidebar.click();
  } else await go(page, `chat/${b}`);
  await at(page, `chat/${b}`);
  await back(page);
  await at(page, 'home');
  // chat A → settings → chat B: Back reaches settings, then Home, never chat A.
  await go(page, `chat/${a}`);
  await go(page, 'settings');
  await go(page, `chat/${b}`);
  await at(page, `chat/${b}`);
  await back(page);
  await at(page, 'settings');
  await back(page);
  await at(page, 'home');
  // app → shared → app and app → shared, through the plain Chats list.
  await go(page, 'chats');
  await go(page, `chat/${a}`);
  await go(page, shared);
  await go(page, `chat/${b}`);
  await at(page, `chat/${b}`);
  await page.reload();
  const seen = await record(page);
  await back(page);
  await at(page, 'chats');
  await go(page, `chat/${a}`);
  await go(page, shared);
  await at(page, shared);
  // Two quick Back taps consume two steps without revisiting chat A.
  await page.locator('a.home-back').evaluate((node) => {
    (node as HTMLElement).click();
    (node as HTMLElement).click();
  });
  await at(page, 'home');
  const routes = await seen();
  expect(routes.slice(routes.indexOf(`#/${shared}`) + 1)).toEqual(['#/chats', '#/home']);
});

test('an old saved trail with mixed conversations is normalized on reload', async ({ page }) => {
  const [a, b] = await chats(page);
  const old = ['home', `chat/${a}`, `chat/${a}/brief`, 'settings', shared, 'phone', `chat/${b}`];
  await page.addInitScript((old) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    sessionStorage.setItem('dock:local:navigation', JSON.stringify(old));
  }, old);
  await page.goto(`/#/chat/${b}`);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('dock:local:navigation')!)))
    .toEqual(['home', 'settings', 'phone', `chat/${b}`]);
  await back(page);
  await at(page, 'phone');
  await back(page);
  await at(page, 'settings');
  await back(page);
  await at(page, 'home');
});

test('Back closes an open Notes, Subagents or Configure panel and stays in the same chat', async ({
  page,
}) => {
  const [a] = await chats(page);
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await go(page, `chat/${a}`);
  for (const name of ['Notes', 'Subagents', 'Configure']) {
    const tool = page.locator('button.chat-tool', {
      has: page.locator('.chat-tool-label', { hasText: new RegExp(`^${name}$`) }),
    });
    await tool.click();
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await back(page);
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await at(page, `chat/${a}`);
  }
  // The brief notepad is a same-chat child; Back returns to its chat.
  await go(page, `chat/${a}/brief`);
  await at(page, `chat/${a}/brief`);
  await page.locator('a.home-back').evaluate((node) => (node as HTMLElement).click());
  await at(page, `chat/${a}`);
  // With no panel open, the next Back consumes the ordinary trail.
  await back(page);
  await at(page, 'settings');
});
