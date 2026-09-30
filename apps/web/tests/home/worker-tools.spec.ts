import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('worker tool choices survive a lost save response and reload without repeating the change', async ({
  page,
}, info) => {
  const created = await page.request.post('/api/projects', {
    headers: { origin: 'http://127.0.0.1:4339' },
    data: { key: randomUUID(), name: `Tools ${info.project.name} ${randomUUID().slice(0, 5)}` },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  const path = `/api/projects/${project.id}/worker-tools`;
  const writes: { key: string; revision: number }[] = [];
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (writes.length === 1)
      return route.fulfill({
        status: 502,
        json: { error: 'Save response interrupted. Check the same request.' },
      });
    return route.fulfill({ response });
  });
  await page.goto(`/#/project/${project.id}`);
  await page.getByText('Tools for new workers', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Worker capabilities' })).toHaveValue('native');
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Worker capabilities' }).selectOption('restricted');
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveValue(
    'disabled',
  );
  await page.getByRole('combobox', { name: 'Web research', exact: true }).selectOption('live');
  await page.getByLabel('Generate images', { exact: true }).check();
  await page.getByLabel('Installed Codex plugins and connected apps', { exact: true }).check();
  await page.getByRole('button', { name: 'Show available tools', exact: true }).click();
  await page.getByLabel('demo_docs', { exact: true }).check();
  await page.getByRole('button', { name: 'Save worker settings', exact: true }).click();
  await expect(page.locator('.project-tools [role=alert]')).toContainText(
    'Save response interrupted',
  );
  await page.reload();
  await page.getByText('Tools for new workers', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveValue(
    'live',
  );
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check save request', exact: true }).click();
  await expect(page.locator('.project-tools [role=status]')).toContainText('Saved.');
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect((await (await page.request.get(path)).json()).revision).toBe(1);
  await expect(page.getByLabel('demo_docs', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Generate images', { exact: true })).toBeChecked();
  const save = page.getByRole('button', { name: 'Save worker settings', exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const smallTargets = await page
    .locator('.project-tools')
    .evaluate((panel) =>
      [...panel.querySelectorAll('button, select, summary, .project-tools-check')]
        .filter((node) => node.getBoundingClientRect().height < 44)
        .map((node) => node.textContent),
    );
  expect(smallTargets).toEqual([]);
  await page.screenshot({ path: `../../data/screenshots/worker-tools/${info.project.name}.png` });
  await page.getByRole('combobox', { name: 'Worker capabilities' }).selectOption('native');
  await save.click();
  await expect(page.locator('.project-tools [role=status]')).toContainText(
    'New workers use native settings',
  );
  await page.reload();
  await page.getByText('Tools for new workers', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Worker capabilities' })).toHaveValue('native');
  await expect(page.getByRole('button', { name: 'Show available tools' })).toHaveCount(0);
  const restored = await (await page.request.get(path)).json();
  expect(restored).toMatchObject({
    revision: 2,
    toolPolicy: 'native',
    codex: { webSearch: 'live', mcpServers: ['demo_docs'] },
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.project-tools').screenshot({
    path: `../../data/screenshots/worker-tools/${info.project.name}-native.png`,
  });
  await page.unrouteAll({ behavior: 'wait' });
});

test('stale tabs reload explicit saved settings and unavailable catalogs retain selections', async ({
  page,
}) => {
  const project = await (
    await page.request.post('/api/projects', {
      headers: { origin: 'http://127.0.0.1:4339' },
      data: { key: randomUUID(), name: `Tools conflict ${randomUUID().slice(0, 5)}` },
    })
  ).json();
  const path = `/api/projects/${project.id}/worker-tools`;
  await page.goto(`/#/project/${project.id}`);
  await page.getByText('Tools for new workers', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Worker capabilities' })).toHaveValue('native');
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Worker capabilities' }).selectOption('restricted');
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveValue(
    'disabled',
  );
  await page.getByRole('combobox', { name: 'Web research', exact: true }).selectOption('indexed');
  expect(
    (
      await page.request.post(path, {
        headers: { origin: 'http://127.0.0.1:4339' },
        data: {
          key: randomUUID(),
          revision: 0,
          codex: { imageGeneration: true, mcpServers: ['demo_docs'] },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Save worker settings', exact: true }).click();
  await expect(page.locator('.project-tools [role=alert]')).toContainText('changed in another tab');
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveValue(
    'indexed',
  );
  await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Web research', exact: true })).toHaveValue(
    'disabled',
  );
  await expect(page.getByLabel('Generate images', { exact: true })).toBeChecked();
  await page.route(`**${path}/catalog`, (route) =>
    route.fulfill({ status: 503, json: { error: 'Fixture catalog unavailable' } }),
  );
  await page.getByRole('button', { name: 'Show available tools', exact: true }).click();
  await expect(page.locator('.project-tools [role=alert]')).toContainText(
    'Saved selections are retained',
  );
  await expect(page.getByLabel('demo_docs', { exact: true })).toBeChecked();
  await page.getByLabel('demo_docs', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save worker settings', exact: true }).click();
  await expect(page.locator('.project-tools [role=status]')).toContainText('Saved.');
  expect((await (await page.request.get(path)).json()).codex.mcpServers).toEqual([]);
});
