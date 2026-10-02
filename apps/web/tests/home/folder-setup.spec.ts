import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('pick an existing folder first, keep model choices editable, and Spawn once at the bottom', async ({
  page,
}, info) => {
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true } }),
  );
  await page.route('**/api/models?provider=claude', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-fable-5-5', label: 'Fable fixture', isDefault: true, efforts: ['xhigh'] },
      ],
    }),
  );
  const selections: { key: string; selectOnly?: boolean; provider?: string }[] = [];
  const connections: typeof selections = [];
  let created: { id: string; managerId: string } | undefined;
  await page.route('**/api/projects/connect-folder', async (route) => {
    const input = route.request().postDataJSON();
    if (input.selectOnly) {
      selections.push(input);
      return route.fulfill({
        json: {
          project: null,
          selection: { key: input.key, name: 'Existing research folder', needsTracking: false },
        },
      });
    }
    connections.push(input);
    if (!created) {
      const response = await page.request.post('/api/projects', {
        headers: { origin: new URL(page.url()).origin },
        data: {
          key: randomUUID(),
          name: `Folder ${info.project.name} ${randomUUID().slice(0, 8)}`,
          provider: input.provider,
        },
      });
      expect(response.ok()).toBe(true);
      created = await response.json();
      return route.abort('failed'); // Saved on the host; only the response was lost.
    }
    return route.fulfill({ json: { project: created } });
  });
  await page.goto('/#/new');
  await page.getByRole('radio', { name: /Existing folder/ }).check();
  await expect(
    page.getByText('Selected folder: Existing research folder', { exact: true }),
  ).toBeVisible();
  expect(selections).toHaveLength(1);
  expect(selections[0]).not.toHaveProperty('provider');
  expect(connections).toHaveLength(0);
  const provider = page
    .getByRole('group', { name: 'Manager', exact: true })
    .getByRole('combobox', { name: 'Provider', exact: true });
  await expect(provider).toBeEnabled();
  await provider.selectOption('claude');
  await page.reload();
  await expect(
    page.getByText('Selected folder: Existing research folder', { exact: true }),
  ).toBeVisible();
  await expect(provider).toHaveValue('claude');
  expect(selections).toHaveLength(1);
  await page.screenshot({
    path: `../../data/screenshots/folder-setup/${info.project.name}-selection.png`,
  });
  const spawn = page.getByRole('button', { name: 'Spawn', exact: true });
  await expect(spawn).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: /^Set token budget/ })).toBeAttached();
  await expect(page.getByText('Set max usage', { exact: true })).toHaveCount(0);
  expect(
    await spawn.evaluate((button) => {
      const budget = document.querySelector('.quark-controls')!;
      return !!(budget.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  await spawn.scrollIntoViewIfNeeded();
  await expect(spawn).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/folder-setup/${info.project.name}-spawn.png`,
  });
  await spawn.click();
  await expect(page.getByRole('alert')).toContainText('connection was interrupted');
  await page.reload();
  await page.getByRole('button', { name: 'Retry Spawn', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Describe your project', exact: true }),
  ).toBeVisible();
  expect(connections).toEqual([
    { key: selections[0]!.key, provider: 'claude' },
    { key: selections[0]!.key, provider: 'claude' },
  ]);
  const detail = await (await page.request.get(`/api/agents/${created!.managerId}`)).json();
  expect(detail.agent.provider).toBe('claude');
  expect(detail.runs).toEqual([]);
});

test('folder cancellation and picker failure stay beside the choice and can be retried', async ({
  page,
}) => {
  await page.route('**/api/project-options', (route) =>
    route.fulfill({ json: { canChooseFolder: true } }),
  );
  const requests: { key: string; selectOnly: boolean }[] = [];
  await page.route('**/api/projects/connect-folder', (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    if (requests.length === 1) return route.fulfill({ json: { project: null } });
    if (requests.length === 2)
      return route.fulfill({
        status: 503,
        json: { error: 'The folder chooser could not open. Try again.' },
      });
    return route.fulfill({
      json: { project: null, selection: { key: input.key, name: 'My notes', needsTracking: true } },
    });
  });
  await page.goto('/#/new');
  await page.getByRole('radio', { name: /Existing folder/ }).check();
  const choose = page.getByRole('button', { name: 'Choose a folder', exact: true });
  await expect(choose).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeDisabled();
  await choose.click();
  const project = page.getByRole('group', { name: 'Project', exact: true });
  await expect(project.getByRole('alert')).toContainText('folder chooser could not open');
  await choose.click();
  await expect(project).toContainText('Selected folder: My notes');
  await expect(project.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeEnabled();
  expect(requests).toEqual(Array(3).fill({ key: requests[0]!.key, selectOnly: true }));
  await page.getByRole('radio', { name: /New folder/ }).check();
  await expect(page.getByLabel('Project name', { exact: true })).toBeVisible();
});
