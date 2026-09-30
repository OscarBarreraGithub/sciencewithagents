import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { BackupSetup } from '@dock/shared';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('a project previews private backup, retains an uncertain attempt and reconnects the exact destination', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = snapshot.projects[0];
  const state: BackupSetup = {
    canSignIn: true,
    destination: null,
    preview: null,
    status: {
      projectId: project.id,
      configured: false,
      state: 'not_configured',
      commit: null,
      checkedAt: null,
      message: 'Private GitHub source backup is not configured.',
    },
  };
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...snapshot, backups: [state.status] } }),
  );
  const base = `**/api/projects/${project.id}/backup`;
  await page.route(`${base}/setup`, (route) => route.fulfill({ json: state }));
  const writes: { path: string; input: unknown }[] = [];
  let attempts = 0;
  await page.route(`${base}/preview`, (route) => {
    writes.push({ path: 'preview', input: route.request().postDataJSON() });
    state.preview = {
      id: randomUUID(),
      repository: 'fixture/my-research-40f5122a',
      branch: 'main',
      choice: 'create',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      attempted: false,
    };
    return route.fulfill({ json: state });
  });
  await page.route(`${base}/connect`, (route) => {
    writes.push({ path: 'connect', input: route.request().postDataJSON() });
    if (attempts++ === 0) {
      state.preview!.attempted = true;
      return route.abort('failed');
    }
    state.destination = { repository: state.preview!.repository, branch: 'main' };
    state.preview = null;
    state.status = {
      ...state.status,
      configured: true,
      state: 'waiting',
      message: 'Connected. Reviewed source checkpoints will be backed up to private GitHub.',
    };
    return route.fulfill({ json: state });
  });
  await page.route(`${base}/retry`, (route) => {
    writes.push({ path: 'retry', input: route.request().postDataJSON() });
    state.status = {
      ...state.status,
      state: 'saved',
      message: 'Verified source checkpoint backed up to private GitHub.',
    };
    return route.fulfill({ json: { queued: true } });
  });
  await page.goto(`/#/project/${project.id}`);
  const card = page.getByRole('region', { name: 'Private source backup', exact: true });
  await card.getByRole('button', { name: 'Set up source backup', exact: true }).click();
  expect(writes).toEqual([]);
  await card.getByRole('button', { name: 'Preview private backup', exact: true }).click();
  await expect(
    card.getByText('github.com/fixture/my-research-40f5122a', { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Confirm private backup', exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([{ path: 'preview', input: { choice: 'create' } }]);
  await mkdir('../../data/screenshots/source-backup', { recursive: true });
  await card
    .getByRole('heading', { name: 'Create a private source backup' })
    .scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/source-backup/${info.project.name}-preview.png`,
  });
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Confirm private backup', exact: true }).click();
  await expect(card.getByRole('alert')).toBeVisible();
  const original = state.preview!.id;
  await page.reload();
  await card.getByRole('button', { name: 'Set up source backup', exact: true }).click();
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Continue this connection', exact: true }).click();
  await expect(card.getByText('Connected destination', { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: /fixture\/my-research/ })).toHaveAttribute(
    'href',
    'https://github.com/fixture/my-research-40f5122a',
  );
  expect(writes.filter((w) => w.path === 'connect')).toEqual(
    Array(2).fill({
      path: 'connect',
      input: { key: original, previewId: original, confirm: true },
    }),
  );
  await card.getByRole('button', { name: 'Retry source backup', exact: true }).click();
  await expect(
    card.getByText('Verified source checkpoint backed up to private GitHub.', { exact: true }),
  ).toBeVisible();
  await card.getByText('Connected destination', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/source-backup/${info.project.name}-connected.png`,
  });
});

test('existing private repository setup keeps its draft after failure and native sign-in opens only on request', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const project = snapshot.projects[0];
  const state: BackupSetup = {
    canSignIn: true,
    destination: null,
    preview: null,
    status: {
      projectId: project.id,
      configured: false,
      state: 'not_configured',
      commit: null,
      checkedAt: null,
      message: 'Source backup is not configured.',
    },
  };
  const base = `**/api/projects/${project.id}/backup`;
  let signs = 0,
    checks = 0;
  await page.route(`${base}/setup`, (route) => route.fulfill({ json: state }));
  await page.route(`${base}/sign-in`, (route) => {
    signs++;
    return route.fulfill({ json: { opened: true } });
  });
  await page.route(`${base}/preview`, (route) => {
    if (!checks++)
      return route.fulfill({
        status: 409,
        json: { error: 'Choose a private, writable GitHub repository.' },
      });
    expect(route.request().postDataJSON()).toEqual({
      choice: 'existing',
      repository: 'fixture/existing-project',
    });
    state.preview = {
      id: randomUUID(),
      repository: 'fixture/existing-project',
      branch: 'retained-main',
      choice: 'existing',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      attempted: false,
    };
    return route.fulfill({ json: state });
  });
  await page.goto(`/#/project/${project.id}`);
  const card = page.getByRole('region', { name: 'Private source backup', exact: true });
  await card.getByRole('button', { name: 'Set up source backup', exact: true }).click();
  await card.getByText('Need to connect GitHub?', { exact: true }).click();
  expect(signs).toBe(0);
  await card.getByRole('button', { name: 'Open GitHub sign-in', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('Check Terminal');
  expect(signs).toBe(1);
  await card.getByRole('radio', { name: /Connect an existing private repository/ }).check();
  await card.getByLabel('GitHub owner/repository').fill('fixture/existing-project');
  await card.getByRole('button', { name: 'Preview private backup', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('private, writable');
  await expect(card.getByLabel('GitHub owner/repository')).toHaveValue('fixture/existing-project');
  await card.getByRole('button', { name: 'Preview private backup', exact: true }).click();
  await expect(card.getByText('retained-main', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Choose again', exact: true }).click();
  await expect(card.getByLabel('GitHub owner/repository')).toHaveValue('fixture/existing-project');
  expect(signs).toBe(1);
});
