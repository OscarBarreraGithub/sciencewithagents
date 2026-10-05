import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

type ViewportOverride = { height?: number; offsetTop?: number; scale?: number };

declare global {
  interface Window {
    __testViewport(next: ViewportOverride, event?: 'resize' | 'scroll'): void;
  }
}

// Synthetic Safari geometry: override only the visual viewport's height, pan offset and pinch
// scale on the native object; the window and layout viewport keep their size. An omitted event
// models Safari finishing a keyboard or zoom transition without reporting it. This exercises
// the app's geometry and event handling, not iOS's own keyboard animation or focus panning.
async function viewportFixture(page: Page) {
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    const prototype = Object.getPrototypeOf(viewport);
    const override: Record<string, number | undefined> = {};
    for (const name of ['height', 'offsetTop', 'scale']) {
      const native = Object.getOwnPropertyDescriptor(prototype, name)!.get!.bind(viewport);
      Object.defineProperty(viewport, name, {
        configurable: true,
        get: () => override[name] ?? native(),
      });
    }
    window.__testViewport = (next, event) => {
      Object.assign(override, next);
      if (event) viewport.dispatchEvent(new Event(event));
    };
  });
}

async function setViewport(page: Page, next: ViewportOverride, event?: 'resize' | 'scroll') {
  await page.evaluate(
    async ({ next, event }) => {
      window.__testViewport(next, event);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    { next, event },
  );
}

const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  }, selector);

async function expectCovers(page: Page, selector: string, height: number, top = 0) {
  // Bounded: recovery must not wait for another user gesture or a reopen.
  await expect
    .poll(() => box(page, selector), { timeout: 1500 })
    .toEqual({ top: Math.round(top), height: Math.round(height) });
}

async function openManagerChat(page: Page, origin: string) {
  const response = await page.request.post('/api/projects', {
    headers: { origin },
    data: { key: randomUUID(), name: `Viewport ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { managerId } = await response.json();
  // Arrive from the chat list so Back/swipe-back is a real history step inside the app.
  await page.goto('/#/chats');
  await expect(page.locator('.home-shell')).toBeVisible();
  await page.evaluate((id) => (location.hash = `#/chat/${id}`), managerId);
  const input = page.locator('.composer textarea');
  await expect(input).toBeVisible();
  const full = await page.evaluate(() => innerHeight);
  return { input, full, keyboard: Math.round(full * (full < 500 ? 0.72 : 0.55)) };
}

test.describe('phone keyboard', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name === 'desktop', 'Keyboard geometry targets phone layouts.');
  });

  test('ticket editing keeps its action bar above the keyboard and recovers without reopening', async ({
    page,
    baseURL,
  }) => {
    await viewportFixture(page);
    const title = `Keyboard ticket ${randomUUID().slice(0, 8)}`;
    const response = await page.request.post('/api/work-items', {
      headers: { origin: new URL(baseURL!).origin },
      data: { key: randomUUID(), title },
    });
    expect(response.ok()).toBe(true);
    await page.goto('/#/home');
    const board = page.locator('.owner-work-board');
    await board.getByRole('checkbox', { name: `Select “${title}”`, exact: true }).check();
    await board.getByRole('button', { name: 'Package 1 to-do', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'QUARK background ticket', exact: true });
    const editor = dialog.getByRole('textbox', { name: 'Additional brief', exact: true });
    const full = await page.evaluate(() => innerHeight);
    const keyboard = Math.round(full * (full < 500 ? 0.72 : 0.55));
    await editor.fill('Preserve the draft while the keyboard opens and closes.');
    await setViewport(page, { height: keyboard, offsetTop: 35, scale: 1 }, 'resize');
    await expectCovers(page, '.owner-ticket-dialog', keyboard - 24, 47);
    const action = await dialog
      .getByRole('button', { name: 'Queue with QUARK', exact: true })
      .boundingBox();
    expect(action!.y).toBeGreaterThanOrEqual(35);
    expect(action!.y + action!.height).toBeLessThanOrEqual(35 + keyboard);
    await editor.blur();
    await setViewport(page, { height: full / 1.1, offsetTop: 0, scale: 1.1 }, 'resize');
    await expectCovers(page, '.owner-ticket-dialog', Math.min(900, full - 24), 12);
    await expect(editor).toHaveValue('Preserve the draft while the keyboard opens and closes.');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expectCovers(page, '.home-shell', full);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test('a keyboard dismissed while pinch-zoomed returns the full screen, also after going back', async ({
    page,
    baseURL,
  }) => {
    await viewportFixture(page);
    const { input, full, keyboard } = await openManagerChat(page, new URL(baseURL!).origin);
    const draft = 'Keep this draft through zoom and keyboard changes.';
    await input.fill(draft);
    await input.focus();
    // A scale that differs from 1 only by rounding is not a zoom.
    await setViewport(page, { height: keyboard, offsetTop: 0, scale: 1.0000001 }, 'resize');
    await expectCovers(page, '.home-shell', keyboard);

    // Pinch in with the keyboard open (or Safari zooming a focused field), then dismiss the
    // keyboard. Safari keeps the zoom, so every later event arrives with scale above 1.
    await setViewport(page, { height: keyboard / 1.06, offsetTop: 140, scale: 1.06 }, 'resize');
    await input.blur();
    await setViewport(page, { height: full / 1.06, offsetTop: 24 }, 'resize');
    await expectCovers(page, '.home-shell', full);
    await expect(input).toHaveValue(draft);

    // Swipe back while still zoomed: the previous screen also gets the whole layout.
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/#\/chats$/);
    await expectCovers(page, '.home-shell', full);
    await setViewport(page, { height: full, offsetTop: 0, scale: 1 }, 'resize');
    await expectCovers(page, '.home-shell', full);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      full + 1,
    );
  });

  test('the shell recovers when Safari reorders or omits the final keyboard viewport event', async ({
    page,
    baseURL,
  }) => {
    await viewportFixture(page);
    const { input, full, keyboard } = await openManagerChat(page, new URL(baseURL!).origin);
    await input.focus();
    await setViewport(page, { height: keyboard, offsetTop: 0, scale: 1 }, 'resize');
    await setViewport(page, { offsetTop: 60 }, 'scroll');
    await expectCovers(page, '.home-shell', keyboard, 60);

    // The pan resets before the height, blur precedes the keyboard animation, and the closing
    // resize never arrives.
    await setViewport(page, { offsetTop: 0 }, 'scroll');
    await input.blur();
    await page.waitForTimeout(120);
    await setViewport(page, { height: full });
    await expectCovers(page, '.home-shell', full);

    // Leaving the chat removes the focused composer; the keyboard closes without an event.
    await input.focus();
    await setViewport(page, { height: keyboard }, 'resize');
    await expectCovers(page, '.home-shell', keyboard);
    await setViewport(page, { height: full });
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/#\/chats$/);
    await expectCovers(page, '.home-shell', full);

    // Returning to the app or rotating re-reads the geometry Safari reports afterwards.
    for (const event of ['pageshow', 'orientationchange', 'visibilitychange'] as const) {
      await setViewport(page, { height: keyboard }, 'resize');
      await expectCovers(page, '.home-shell', keyboard);
      await setViewport(page, { height: full });
      await page.evaluate(
        (event) =>
          (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)),
        event,
      );
      await expectCovers(page, '.home-shell', full);
    }
  });

  test('the notepad follows the keyboard, recovers after zoomed dismissal and minimizes into chat', async ({
    page,
    baseURL,
  }) => {
    await viewportFixture(page);
    const { input, full, keyboard } = await openManagerChat(page, new URL(baseURL!).origin);
    await page.locator('.composer').getByRole('button', { name: 'Open notepad' }).click();
    const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
    const editor = notepad.getByRole('textbox').first();
    await expect(editor).toBeFocused();
    await editor.fill('Notepad draft survives viewport changes.');
    await setViewport(page, { height: keyboard, offsetTop: 0, scale: 1 }, 'resize');
    await setViewport(page, { offsetTop: 40 }, 'scroll');
    await expectCovers(page, 'dialog.notepad', keyboard, 40);
    // A full-height rubber-band offset does not move the notepad and open a blank band.
    await setViewport(page, { height: full, offsetTop: -60 }, 'scroll');
    await expectCovers(page, 'dialog.notepad', full);
    await setViewport(page, { height: keyboard, offsetTop: 40 }, 'resize');
    await setViewport(page, { height: keyboard / 1.1, scale: 1.1 }, 'resize');
    await setViewport(page, { height: full / 1.1, offsetTop: 0 }, 'resize');
    await expectCovers(page, 'dialog.notepad', full);
    await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(notepad).toBeHidden();
    await expect(input).toHaveValue('Notepad draft survives viewport changes.');
    await expect(input).toBeFocused();
    await expectCovers(page, '.home-shell', full);
  });

  test('real Chromium pinch zoom keeps the full layout while a keyboard is open', async ({
    page,
    baseURL,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Page scale emulation uses the Chromium protocol.');
    await viewportFixture(page);
    const { input, full, keyboard } = await openManagerChat(page, new URL(baseURL!).origin);
    const cdp = await page.context().newCDPSession(page);
    await input.focus();
    await setViewport(page, { height: keyboard, offsetTop: 0 }, 'resize');
    await expectCovers(page, '.home-shell', keyboard);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
    await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(1.5);
    await expectCovers(page, '.home-shell', full);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await expectCovers(page, '.home-shell', keyboard);
    await input.blur();
    await setViewport(page, { height: full }, 'resize');
    await expectCovers(page, '.home-shell', full);
  });
});

test('desktop browser and pinch zoom keep the shell at the full window', async ({
  page,
  browserName,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Window zoom levels target the desktop layout.');
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  // Browser zoom shrinks the window in CSS pixels without a visual viewport scale.
  for (const zoom of [1.25, 2]) {
    const size = { width: Math.round(1440 / zoom), height: Math.round(1000 / zoom) };
    await page.setViewportSize(size);
    await expectCovers(page, '.home-shell', size.height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      size.height + 1,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectCovers(page, '.home-shell', 1000);
  if (browserName !== 'chromium') return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(2);
  await expectCovers(page, '.home-shell', 1000);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await expectCovers(page, '.home-shell', 1000);
});
