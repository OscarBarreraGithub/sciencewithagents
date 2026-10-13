import { expect, test, type Page } from '@playwright/test';

const routes = [
  'home',
  'chats',
  'apps',
  'work',
  'settings',
  'welcome',
  'models',
  'resources',
  'new',
  'computers',
  'phone',
  'recovery',
  'updates',
  'search',
  'advanced',
  'latex',
];

async function inspectSurfaces(page: Page) {
  return page.locator('.home-shell').evaluate((root) => {
    const light: string[] = [];
    const bounds = { width: innerWidth, height: innerHeight };
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      if (!(element instanceof HTMLElement)) continue;
      // Scientific documents and native image/canvas data retain their original appearance.
      if (element.closest('.pdf-reader, .document-reading, .image-preview, svg')) continue;
      const box = element.getBoundingClientRect();
      if (
        box.width < 160 ||
        box.height < 64 ||
        box.bottom <= 0 ||
        box.top >= bounds.height ||
        box.right <= 0 ||
        box.left >= bounds.width
      )
        continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const rgb = style.backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!rgb || rgb.length < 3 || (rgb[3] ?? 1) < 0.9) continue;
      if (rgb.slice(0, 3).every((channel) => channel > 180)) {
        light.push(`${element.tagName}.${String(element.className)}: ${style.backgroundColor}`);
      }
    }
    return {
      light,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  });
}

test('dark application surfaces keep the full set of destinations readable', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  for (const route of routes) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('main h1').first()).toBeVisible();
    const surfaces = await inspectSurfaces(page);
    expect.soft(surfaces.scheme, route).toContain('dark');
    expect.soft(surfaces.light, `${route}: unintended light application panels`).toEqual([]);
    expect.soft(surfaces.documentWidth, route).toBeLessThanOrEqual(surfaces.viewportWidth + 1);
    await page.screenshot({ path: info.outputPath(`dark-${route}.png`) });
  }
});

test('dark setup controls remain readable and reachable with enlarged text', async ({ page }) => {
  await page.goto('/#/welcome');
  await expect(page.getByRole('heading', { name: 'Welcome and setup' })).toBeVisible();
  const check = page.getByRole('button', { name: 'Check this computer', exact: true });
  await check.scrollIntoViewIfNeeded();
  const initial = await check.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      font: parseFloat(getComputedStyle(element).fontSize),
    };
  });
  expect(initial.width).toBeGreaterThanOrEqual(44);
  expect(initial.height).toBeGreaterThanOrEqual(44);
  expect(initial.font).toBeGreaterThanOrEqual(16);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await check.scrollIntoViewIfNeeded();
  await expect(check).toBeInViewport();
  const resized = await inspectSurfaces(page);
  expect(resized.documentWidth).toBeLessThanOrEqual(resized.viewportWidth + 1);
  expect(resized.light).toEqual([]);
});
