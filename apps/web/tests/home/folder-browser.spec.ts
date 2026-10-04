import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('browse on this device, recover a failed listing, cancel safely and select before Spawn', async ({
  page,
}, info) => {
  const home = randomUUID(),
    project = randomUUID();
  const name = 'Existing project with a long descriptive name';
  let failed = false;
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true, folderBrowser: true } }),
  );
  await page.route('**/api/project-folders?*', (route) => {
    const id = new URL(route.request().url()).searchParams.get('folderId');
    if (id === project && !failed) {
      failed = true;
      return route.fulfill({
        status: 409,
        json: { error: 'The folder could not be read. Try again.' },
      });
    }
    return route.fulfill({
      json: {
        current: {
          id: id ?? home,
          name: id === project ? name : 'Home folder',
          canSelect: id === project,
        },
        parentId: id === project ? home : null,
        folders: id === project ? [] : [{ id: project, name }],
        nextOffset: null,
      },
    });
  });
  const selections: Record<string, unknown>[] = [];
  await page.route('**/api/projects/connect-folder', (route) => {
    const input = route.request().postDataJSON();
    selections.push(input);
    return route.fulfill({
      json: { project: null, selection: { key: input.key, name, needsTracking: false } },
    });
  });
  await page.goto('/#/new');
  await page.getByRole('radio', { name: /Existing folder/ }).check();
  const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
  await expect(browser).toBeVisible();
  await expect(browser.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
  await browser.getByRole('button', { name }).click();
  await expect(browser.getByRole('alert')).toContainText('could not be read');
  await browser.getByRole('button', { name: 'Try again' }).click();
  await expect(browser.getByRole('button', { name: 'Use this folder' })).toBeEnabled();
  await page.screenshot({
    path: `../../data/interaction-audit-20261003/${info.project.name}-folder.png`,
  });
  expect(await browser.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await browser.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(selections).toHaveLength(0);
  await page.getByRole('button', { name: 'Choose a folder', exact: true }).click();
  await browser.getByRole('button', { name }).click();
  await browser.getByRole('button', { name: 'Use this folder' }).click();
  await expect(browser).toHaveCount(0);
  await expect(page.getByText(`Selected folder: ${name}`, { exact: true })).toBeVisible();
  expect(selections).toHaveLength(1);
  expect(selections[0]).toMatchObject({ folderId: project, selectOnly: true });
  expect(selections[0]).not.toHaveProperty('path');
  await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByText(`Selected folder: ${name}`, { exact: true })).toBeVisible();
});

test('explore locations, jump through breadcrumbs and search descendants without losing navigation', async ({
  page,
}, info) => {
  const ids = Object.fromEntries(
    ['home', 'documents', 'developer', 'science', 'measurements', 'hidden'].map((key) => [
      key,
      randomUUID(),
    ]),
  );
  const names: Record<string, string> = {
    home: 'Home',
    documents: 'Documents',
    developer: 'Developer',
    science: 'Science',
    measurements: 'Measurements',
    hidden: '.archive',
  };
  const children: Record<string, string[]> = {
    home: ['documents', 'developer'],
    documents: ['science'],
    developer: [],
    science: ['measurements'],
    measurements: [],
    hidden: [],
  };
  const ancestors: Record<string, string[]> = {
    home: ['home'],
    documents: ['home', 'documents'],
    developer: ['home', 'developer'],
    science: ['home', 'documents', 'science'],
    measurements: ['home', 'documents', 'science', 'measurements'],
    hidden: ['home', 'hidden'],
  };
  const link = (key: string) => ({ id: ids[key], name: names[key] });
  const requests: URLSearchParams[] = [];
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /projects|agents/.test(request.url()))
      writes.push(request.url());
  });
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true, folderBrowser: true } }),
  );
  await page.route('**/api/project-folders?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    const key = Object.keys(ids).find((key) => ids[key] === query.get('folderId')) ?? 'home';
    const term = query.get('query');
    if (term === 'slow') await new Promise((resolve) => setTimeout(resolve, 400));
    const results = term
      ? term.toLowerCase().includes('measure') && query.get('scope') !== 'children'
        ? [{ ...link('measurements'), location: 'Documents / Science' }]
        : []
      : [
          ...(children[key] ?? []).map(link),
          ...(key === 'home' && query.get('hidden') === 'true' ? [link('hidden')] : []),
        ];
    await route
      .fulfill({
        json: {
          current: { ...link(key), canSelect: key !== 'home' },
          parentId: ids[ancestors[key]!.at(-2)!] ?? null,
          breadcrumbs: ancestors[key]!.map(link),
          locations: ['home', 'documents', 'developer'].map((key) => ({ ...link(key), kind: key })),
          folders: results,
          nextOffset: null,
          search: term ? { query: term, partial: term === 'slow' } : null,
        },
      })
      .catch(() => {});
  });
  await page.goto('/#/new');
  await page.getByRole('radio', { name: /Existing folder/ }).check();
  const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
  const places = browser.getByRole('navigation', { name: 'Locations', exact: true });
  const path = browser.getByRole('navigation', { name: 'Folder path', exact: true });
  const list = browser.locator('.folder-browser-list');
  await places.getByRole('button', { name: 'Documents', exact: true }).click();
  await list.getByRole('button', { name: 'Science', exact: true }).click();
  await expect(path.getByRole('button', { name: 'Science', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await browser.getByRole('button', { name: 'Previous folder', exact: true }).click();
  await expect(path.getByRole('button', { name: 'Documents', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await browser.getByRole('button', { name: 'Next folder', exact: true }).click();
  await expect(path.getByRole('button', { name: 'Science', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await path.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(browser.getByRole('button', { name: 'Use this folder' })).toBeDisabled();
  const search = browser.getByRole('searchbox', { name: 'Search folders', exact: true });
  await search.fill('Measurements');
  await browser.getByRole('button', { name: 'Search folders', exact: true }).click();
  await expect(list.getByRole('button', { name: /Measurements/ })).toContainText(
    'Documents / Science',
  );
  expect(requests.at(-1)?.get('query')).toBe('Measurements');
  await browser.getByRole('combobox', { name: 'Search scope' }).selectOption('children');
  await expect(list.getByText('No matching folders found here.')).toBeVisible();
  await browser.getByRole('combobox', { name: 'Search scope' }).selectOption('descendants');
  await list.getByRole('button', { name: /Measurements/ }).click();
  await expect(path.getByRole('button', { name: 'Measurements', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(search).toHaveValue('');
  await expect(browser.getByRole('button', { name: 'Use this folder' })).toBeEnabled();
  await places.getByRole('button', { name: 'Home', exact: true }).click();
  await browser.getByRole('checkbox', { name: 'Hidden folders' }).check();
  await expect(list.getByRole('button', { name: '.archive', exact: true })).toBeVisible();
  await search.fill('slow');
  await browser.getByRole('button', { name: 'Search folders', exact: true }).click();
  await places.getByRole('button', { name: 'Developer', exact: true }).click();
  await expect(path.getByRole('button', { name: 'Developer', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await page.waitForTimeout(500); // Finish the old response; it must not replace the chosen location.
  await expect(path.getByRole('button', { name: 'Developer', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await places.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(path.getByRole('button', { name: 'Documents', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(list.getByRole('button', { name: 'Science', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('folder-explorer.png') });
  for (const size of [16, 20, 24]) {
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`;
    }, size);
    expect(
      await browser.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await expect(browser.getByRole('button', { name: 'Use this folder' })).toBeInViewport();
    await expect(browser.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
    const geometry = await list.boundingBox();
    expect(geometry!.height).toBeGreaterThan(44);
  }
  if (info.project.name === 'phone' || info.project.name === 'small-phone') {
    // Model an on-screen keyboard without pretending this is a physical-device test.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '16px';
      Object.defineProperty(window.visualViewport, 'height', { value: 480, configurable: true });
      Object.defineProperty(window.visualViewport, 'offsetTop', { value: 20, configurable: true });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => Math.round((await browser.boundingBox())!.height)).toBe(480);
    const button = await browser.getByRole('button', { name: 'Use this folder' }).boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(500);
    expect((await list.boundingBox())!.height).toBeGreaterThan(44);
  }
  expect(writes).toEqual([]);
  await browser.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(browser).toHaveCount(0);
});
