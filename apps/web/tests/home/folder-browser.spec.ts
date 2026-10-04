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
