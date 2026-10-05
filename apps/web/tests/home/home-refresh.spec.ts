import { expect, test, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function pull(target: Locator, dx = 0, dy = 120, end = true) {
  await target.evaluate(
    (element, args) => {
      const box = element.getBoundingClientRect();
      const x = box.x + 40,
        y = box.y + 20;
      const send = (type: string, tx: number, ty: number) => {
        // WebKit does not expose a constructible Touch in this test context.
        const touch = { identifier: 1, target: element, clientX: tx, clientY: ty };
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: type === 'touchend' ? [] : [touch] },
          changedTouches: { value: [touch] },
        });
        element.dispatchEvent(event);
      };
      send('touchstart', x, y);
      send('touchmove', x + args.dx, y + args.dy);
      if (args.end) send('touchend', x + args.dx, y + args.dy);
    },
    { dx, dy, end },
  );
}

test('Home pull refresh waits for readings, preserves drafts and offers updates explicitly', async ({
  page,
}, info) => {
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await draft.fill('Retain this unsent note while refreshing.');
  await page.locator('.home-content').evaluate((e) => e.scrollTo(0, 0));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route('**/api/snapshot', async (route) => {
    reads++;
    await gate;
    await route.continue();
  });
  const tile = page.locator('.overview-destinations a').first();
  const wheel = page.locator('.home-pull-wheel');
  try {
    await pull(tile, 0, 50);
    await expect(wheel).toHaveCount(0);
    expect(reads).toBe(0);
    await pull(tile, 0, 120, false);
    await expect(wheel).toContainText('Release to refresh');
    await page.screenshot({ path: info.outputPath('pull-to-refresh.png') });
    await tile.evaluate((e) => e.dispatchEvent(new Event('touchend', { bubbles: true })));
    await expect(wheel).toContainText('Refreshing');
    await expect.poll(() => reads).toBe(1);
    // A second gesture while busy must neither duplicate the read nor dismiss the wheel.
    await pull(tile);
    await expect(wheel).toContainText('Refreshing');
    expect(reads).toBe(1);
  } finally {
    release();
  }
  await expect(wheel).toContainText('Updated');
  await expect(draft).toHaveValue('Retain this unsent note while refreshing.');
  await expect(page).toHaveURL(/#\/home$/);
  await page.unroute('**/api/snapshot');

  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ status: 503, json: { error: 'Temporarily offline' } }),
  );
  await pull(tile);
  await expect(wheel).toContainText('Couldn’t refresh');
  await expect(page.locator('.overview')).toBeVisible();
  await page.unroute('**/api/snapshot');
  await page.route('**/', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        /src="\/assets\/index-[^"]+\.js"/,
        'src="/assets/new-release.js"',
      ),
    });
  });
  await pull(tile);
  await expect(wheel).toContainText('Updated');
  await expect(page.getByRole('button', { name: 'Reload app', exact: true })).toBeVisible();
  await expect(draft).toHaveValue('Retain this unsent note while refreshing.');
});

test('pull refresh leaves scrolling panels, editing, sideways gestures and other pages alone', async ({
  page,
}) => {
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  const wheel = page.locator('.home-pull-wheel');
  const tile = page.locator('.overview-destinations a').first();
  await pull(page.locator('.overview-section-body').first());
  await expect(wheel).toHaveCount(0);
  await pull(page.getByRole('textbox', { name: 'New to-do', exact: true }));
  await expect(wheel).toHaveCount(0);
  await pull(tile, 120, 10);
  await expect(wheel).toHaveCount(0);
  await page.locator('.home-content').evaluate((e) => {
    const spacer = document.createElement('div');
    spacer.style.height = '1800px';
    e.append(spacer);
    e.scrollTop = 100;
  });
  await pull(tile);
  await expect(wheel).toHaveCount(0);
  await page.goto('/#/chats');
  await expect(page.locator('.home-pull-refresh')).toHaveCount(0);
});

test('orb drifts quietly, varies on tap without an outline and pauses when hidden or reduced', async ({
  page,
  browserName,
}, info) => {
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      // Count on the button: each new shape draws on a fresh canvas.
      const orb = this.canvas.closest<HTMLElement>('.home-orb');
      if (orb) orb.dataset.draws = String(Number(orb.dataset.draws ?? 0) + 1);
      return clear.apply(this, args);
    };
  });
  await page.goto('/#/home');
  const button = page.getByRole('button', { name: 'Change orb shape', exact: true });
  await expect(page.locator('.home-header .home-orb')).toHaveCount(0);
  const orbBox = (await button.boundingBox())!;
  const destinations = (await page.locator('.overview-destinations').boundingBox())!;
  expect(orbBox.y + orbBox.height).toBeLessThanOrEqual(destinations.y);
  if (page.viewportSize()!.width <= 700) {
    const readings = (await page.locator('.home-mobile-readings').boundingBox())!;
    expect(orbBox.x).toBeGreaterThanOrEqual(readings.x + readings.width);
    expect(orbBox.height).toBe(80);
  }
  const draws = async () => Number((await button.getAttribute('data-draws')) ?? 0);
  // Idle motion continues without a tap, at a low frame rate.
  await expect.poll(draws).toBeGreaterThan(1);
  let start = await draws();
  await page.waitForTimeout(1000);
  const idle = (await draws()) - start;
  expect(idle).toBeGreaterThanOrEqual(5);
  expect(idle).toBeLessThanOrEqual(16);
  const before = await button.locator('canvas').evaluate((e: HTMLCanvasElement) => e.toDataURL());
  await page.waitForTimeout(400);
  expect(await button.locator('canvas').evaluate((e: HTMLCanvasElement) => e.toDataURL())).not.toBe(
    before,
  );

  let form = await button.getAttribute('data-form');
  const forms = new Set([form]);
  await button.click();
  expect(
    await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        outline: style.outlineStyle,
        shadow: style.boxShadow,
      };
    }),
  ).toEqual({ background: 'rgba(0, 0, 0, 0)', outline: 'none', shadow: 'none' });
  // A tap livens the motion briefly instead of freezing it.
  start = await draws();
  await page.waitForTimeout(500);
  expect((await draws()) - start).toBeGreaterThan(idle / 2 + 2);
  for (let tap = 0; tap < 12; tap += 1) {
    const next = await button.getAttribute('data-form');
    expect(next).not.toBe(form);
    form = next;
    forms.add(form);
    await button.click();
  }
  expect(forms.size).toBeGreaterThanOrEqual(4);
  for (const square of ['shaping', 'solving']) expect(forms.has(square)).toBe(false);

  const visibility = (hidden: boolean) =>
    page.evaluate((hidden) => {
      if (hidden) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
      } else {
        delete (document as { hidden?: boolean }).hidden;
        delete (document as { visibilityState?: string }).visibilityState;
      }
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await visibility(true);
  await page.waitForTimeout(100);
  const hidden = await draws();
  await page.waitForTimeout(600);
  expect(await draws()).toBe(hidden);
  await visibility(false);
  await expect.poll(draws).toBeGreaterThan(hidden);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  const reduced = await draws();
  await page.waitForTimeout(500);
  expect(await draws()).toBe(reduced);
  await button.click();
  await page.waitForTimeout(300);
  expect(await draws()).toBe(reduced + 1);

  // Keyboard focus still shows the accessible outline. WebKit's default Tab skips buttons.
  if (browserName !== 'webkit') {
    await button.evaluate((element) => element.blur());
    for (
      let press = 0;
      press < 20 && !(await button.evaluate((e) => e === document.activeElement));
      press += 1
    )
      await page.keyboard.press('Tab');
    expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    );
  }
  const controls = page.locator('.home-header-actions');
  const box = (await controls.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('idle-orb.png') });
});

test('phone installation metadata serves the original drawn alien without signing in', async ({
  page,
  request,
}) => {
  await page.goto('/#/home');
  const icon = page.locator('link[rel="apple-touch-icon"]');
  await expect(icon).toHaveAttribute('sizes', '180x180');
  const response = await request.get((await icon.getAttribute('href'))!);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(await response.body()).toEqual(await readFile('public/dock-180.png'));
  const manifest = await request.get(
    (await page.locator('link[rel="manifest"]').getAttribute('href'))!,
  );
  const data = await manifest.json();
  expect(data.id).toBe('/');
  for (const size of [192, 512]) {
    const image = await request.get(
      data.icons.find((i: { sizes: string }) => i.sizes === `${size}x${size}`).src,
    );
    expect(await image.body()).toEqual(await readFile(`public/dock-${size}.png`));
  }
});

test('native phone touch drags refresh without opening the tile', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'phone', 'Chromium touch-dispatch check at phone size.');
  await page.goto('/#/home');
  const tile = page.locator('.overview-destinations a').first();
  await expect(tile).toBeVisible();
  const box = (await tile.boundingBox())!;
  const x = box.x + 70,
    y = box.y + 25;
  const input = await context.newCDPSession(page);
  try {
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const dy of [10, 25, 50, 85, 120])
      await input.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + dy }],
      });
    await expect(page.locator('.home-pull-wheel')).toContainText('Release to refresh');
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.home-pull-wheel')).toContainText('Updated');
    await expect(page).toHaveURL(/#\/home$/);
  } finally {
    await input.detach();
  }
});

test('an unreachable reading stops the wheel and a later pull can retry', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'phone', 'One deterministic network-timeout check.');
  await page.clock.install();
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/api/resources', async (route) => {
    requested = true;
    await gate;
    // The app's timeout can already have cancelled the intercepted request.
    await route.abort().catch((error: unknown) => {
      if (!String(error).includes('Route is already handled')) throw error;
    });
  });
  const tile = page.locator('.overview-destinations a').first();
  try {
    await pull(tile);
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('.home-pull-wheel')).toContainText('Refreshing');
    await page.clock.fastForward(15_100);
    await expect(page.locator('.home-pull-wheel')).toContainText('Couldn’t refresh');
  } finally {
    release();
  }
  await page.unroute('**/api/resources');
  await pull(tile);
  await expect(page.locator('.home-pull-wheel')).toContainText('Updated');
});
