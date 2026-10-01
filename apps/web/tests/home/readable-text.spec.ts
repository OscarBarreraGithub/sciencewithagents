import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectModelFormLayout, expectSliderLayout } from './control-layout';

const screens = [
  'home',
  'models',
  'new',
  'resources',
  'work',
  'chats',
  'apps',
  'settings',
  'welcome',
];

async function fits(page: Page) {
  const size = await page.evaluate(() => {
    const panel = document.querySelector('.home-content')!;
    const header = document.querySelector('.home-header')!;
    const box = panel.getBoundingClientRect();
    return {
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      headerContent: header.scrollWidth,
      headerWidth: header.clientWidth,
      panel: panel.clientWidth,
      content: panel.scrollWidth,
      visibleHeight: box.height,
      route: location.hash,
      spilling: Array.from(panel.querySelectorAll<HTMLElement>('*'))
        .filter(
          (e) =>
            e.clientWidth > 0 &&
            e.scrollWidth > e.clientWidth + 2 &&
            getComputedStyle(e).overflowX === 'visible',
        )
        .slice(0, 12)
        .map((e) => ({
          class: e.className,
          tag: e.tagName,
          width: e.clientWidth,
          scroll: e.scrollWidth,
        })),
      overflow: Array.from(panel.querySelectorAll('*'))
        .filter((e) => e.getBoundingClientRect().right > box.right + 1)
        .slice(0, 8)
        .map((e) => ({
          element: e.tagName,
          class: e.className,
          text: e.textContent?.slice(0, 45),
        })),
    };
  });
  expect(size.document, JSON.stringify(size)).toBeLessThanOrEqual(size.viewport + 1);
  expect(size.headerContent, JSON.stringify(size)).toBeLessThanOrEqual(size.headerWidth + 1);
  expect.soft(size.content, JSON.stringify(size)).toBeLessThanOrEqual(size.panel + 1);
  expect(size.visibleHeight).toBeGreaterThan(80);
}

async function inspect(page: Page, route: string) {
  await expect(page.locator('main h1').first()).toBeVisible();
  if (route === 'models') {
    await expect(page.getByRole('group', { name: 'Providers in your defaults' })).toBeVisible();
    await expectModelFormLayout(page);
    const advanced = page.locator('.model-advanced');
    if ((await advanced.getAttribute('open')) === null)
      await advanced.locator(':scope > summary').click();
    await expectModelFormLayout(page);
    await page
      .getByRole('group', { name: 'Manager default', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('combobox', { name: 'Manager provider', exact: true }),
    ).toBeInViewport();
    const restore = page.getByRole('button', { name: 'Restore recommended defaults', exact: true });
    await restore.scrollIntoViewIfNeeded();
    await expect(restore).toBeInViewport();
  }
  if (route === 'new') {
    const name = page.getByRole('textbox', { name: 'Project name', exact: true });
    await name.fill('Readable project setup');
    const spawn = page.getByRole('button', { name: 'Spawn', exact: true });
    await spawn.scrollIntoViewIfNeeded();
    await expect(spawn).toBeInViewport();
    await expect(name).toHaveValue('Readable project setup');
  }
  await fits(page);
  if (route !== 'home') {
    const back = page.getByRole('link', { name: 'Back', exact: true });
    await expect(back).toBeInViewport();
    const box = (await back.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    // Browser zoom can round a 44px CSS target down by a fraction of a pixel.
    expect(box.width).toBeGreaterThanOrEqual(43.9);
    expect(box.height).toBeGreaterThanOrEqual(43.9);
  }
  await expectSliderLayout(page);
}

test('larger text reflows with doubled reading size on desktop and phones', async ({
  page,
}, info) => {
  for (const route of screens) {
    await page.goto(`/#/${route}`);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '100%';
    });
    await inspect(page, route);
    if (route === 'home' || route === 'models') {
      await page.locator('.home-content').evaluate((e) => e.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`${route}-reading-size.png`) });
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await inspect(page, route);
    if (route === 'models') {
      await page.locator('.home-content').evaluate((e) => e.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath('models-double-text.png') });
    }
    // Keep viewport evidence of the actual form, not just its page heading.
    if (route === 'models') {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '100%';
      });
      for (const [name, selector] of [
        ['providers', '.model-enabled'],
        ['manager', '.model-manager-grid'],
        ['levels', '.model-tier'],
        ['assistants', '.model-routing'],
      ]) {
        await page.locator(selector!).first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`models-${name}.png`) });
      }
    }
  }
});

test('readable screens reflow at real browser zoom from 80 to 400 percent', async ({}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Real browser zoom is checked once; phone text resizing runs above.',
  );
  test.setTimeout(120_000);
  const root = resolve('../../data/zoom');
  await mkdir(root, { recursive: true });
  const owned = await mkdtemp(join(root, 'readable-text-'));
  const extension = join(owned, 'extension');
  await mkdir(extension);
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Local readable text check',
      version: '1.0',
      permissions: ['tabs'],
      host_permissions: ['http://127.0.0.1:4339/*'],
      background: { service_worker: 'background.js' },
    }),
  );
  await writeFile(
    join(extension, 'background.js'),
    'chrome.runtime.onInstalled.addListener(() => {});',
  );
  const context = await chromium.launchPersistentContext(join(owned, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4339');
    for (const factor of [0.8, 1, 1.25, 1.5, 2, 4]) {
      await worker.evaluate(async (factor) => {
        const c = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                query(query: object): Promise<{ id: number; url?: string }[]>;
                setZoom(id: number, factor: number): Promise<void>;
              };
            };
          }
        ).chrome;
        const tab = (await c.tabs.query({})).find((t) =>
          t.url?.startsWith('http://127.0.0.1:4339'),
        )!;
        await c.tabs.setZoom(tab.id, factor);
      }, factor);
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(factor, 1);
      for (const route of screens) {
        await page.goto(`http://127.0.0.1:4339/#/${route}`);
        await inspect(page, route);
        if (route === 'home' || route === 'models') {
          await page.locator('.home-content').evaluate((e) => e.scrollTo(0, 0));
          await page.screenshot({ path: info.outputPath(`${route}-${factor}x.png`) });
        }
      }
    }
  } finally {
    await context.close();
    await rm(owned, { recursive: true, force: true });
  }
});
