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
async function at(page: Page, route: string) {
  await expect(page).toHaveURL(new RegExp(`#/${route.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}$`));
  // Hash changes precede React's destination render, especially after reload.
  // Wait for that surface before choosing a control whose phone layout changes.
  const agent = /^chat\/([^/]+)/.exec(route)?.[1];
  if (agent) {
    await expect(page.locator(`a.chat-row[href="#/chat/${agent}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('.main-chat.has-selection .chat-pane-inner')).toBeVisible();
  } else if (route === shared) {
    await expect(page.locator('.main-chat.has-selection .chat-editor')).toBeVisible();
  } else {
    const titles: Record<string, string> = {
      home: 'Home',
      settings: 'Settings',
      phone: 'Phone access',
      chats: 'Chats',
    };
    const title = titles[route];
    expect(title).toBeTruthy();
    await expect(page.locator('#home-content').getByRole('heading', { level: 1 })).toHaveText(
      title!,
    );
  }
}

/** The app's Back: the visible control, or the phone swipe where chats hide the header. */
async function back(page: Page) {
  const route = new URL(page.url()).hash.slice(2);
  await at(page, route);
  const link = page.locator('a.home-back');
  const phoneChat =
    (route.startsWith('chat/') || route === shared) &&
    (await page.evaluate(
      () => matchMedia('(max-width: 700px), (max-height: 500px) and (pointer: coarse)').matches,
    ));
  if (!phoneChat) {
    await expect(link).toBeVisible();
    return link.click();
  }
  await expect(link).toBeHidden();
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
}, info) => {
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
  await at(page, `chat/${b}`);
  await page.screenshot({ path: info.outputPath('reloaded-chat-before-back.png') });
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

test('Back waits for a reloaded chat destination before selecting its phone control', async ({
  page,
}) => {
  const [, b] = await chats(page);
  await page.goto('/#/settings');
  await at(page, 'settings');
  await go(page, `chat/${b}`);
  await at(page, `chat/${b}`);
  let entered!: () => void, release!: () => void;
  const fetched = new Promise<void>((resolve) => (entered = resolve));
  const ready = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    entered();
    await ready;
    await route.fulfill({ response });
  });
  try {
    await page.reload();
    await fetched;
    // The transient pre-chat header exists while its saved destination is loading.
    await expect(page.locator('a.home-back')).toBeVisible();
    await page.evaluate(() => {
      const state = window as unknown as { earlyBack: boolean };
      state.earlyBack = false;
      document.addEventListener(
        'click',
        (event) => {
          if (
            (event.target as Element).closest('a.home-back') &&
            !document.querySelector('.main-chat.has-selection')
          )
            state.earlyBack = true;
        },
        true,
      );
    });
    const returning = back(page);
    await expect(page.locator('a.home-back')).toBeVisible();
    release();
    await returning;
    expect(await page.evaluate(() => (window as unknown as { earlyBack: boolean }).earlyBack)).toBe(
      false,
    );
    await at(page, 'settings');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
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
