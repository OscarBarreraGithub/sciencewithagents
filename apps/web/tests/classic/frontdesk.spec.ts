import { test, expect, type Page } from './fixture';
import type { FrontdeskStatus, Snapshot } from '@dock/shared';

async function openSettings(page: Page) {
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Assistant settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Assistant settings', exact: true });
}
const initial = (identity?: Pick<FrontdeskStatus, 'agentId' | 'projectId'>): FrontdeskStatus => ({
  agentId: identity?.agentId ?? null,
  projectId: identity?.projectId ?? null,
  settings: {
    revision: 0,
    visibleProjectIds: [],
    preferences: '',
    priorities: '',
    commitments: '',
  },
  notice:
    'Only projects you select on this computer are shared. Removing a project cannot erase information already retained in the conversation.',
});

test('assistant settings share nothing by default and retry a lost save without a second change', async ({
  page,
}, info) => {
  let saved = initial((await (await page.request.get('/api/frontdesk')).json()) as FrontdeskStatus);
  const keys: string[] = [];
  const receipts = new Map<string, FrontdeskStatus>();
  let modelActions = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(messages|commands|tasks|integrate|start)$/.test(request.url())
    )
      modelActions++;
  });
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/frontdesk', (route) => route.fulfill({ json: saved }));
  await page.route('**/api/frontdesk/settings', (route) => {
    const input = route.request().postDataJSON();
    keys.push(input.key);
    const previous = receipts.get(input.key);
    if (previous) return route.fulfill({ json: previous });
    saved = {
      ...saved,
      settings: {
        revision: saved.settings.revision + 1,
        visibleProjectIds: input.visibleProjectIds,
        preferences: input.preferences,
        priorities: input.priorities,
        commitments: input.commitments,
      },
    };
    receipts.set(input.key, saved);
    return route.abort('failed');
  });
  const dialog = await openSettings(page);
  const project = snapshot.projects[0];
  await expect(dialog.getByRole('checkbox', { name: project.name, exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: project.name, exact: true }).check();
  await expect(dialog.getByRole('checkbox', { name: 'Your assistant', exact: true })).toHaveCount(
    0,
  );
  const projectLabel = dialog.locator('.checkbox-label').filter({ hasText: project.name });
  await expect(projectLabel).toHaveCSS('flex-direction', 'row');
  await dialog
    .getByLabel('How should your assistant work with you?')
    .fill('Keep updates short and explain unfamiliar terms.');
  await dialog.getByLabel('Current priorities').fill('Finish the garden journal.');
  await dialog.getByLabel('Commitments to remember').fill('Review before applying changes.');
  await dialog.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('Current priorities')).toHaveValue('Finish the garden journal.');
  await dialog.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(dialog).toContainText('Assistant settings saved');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(saved.settings.revision).toBe(1);
  expect(saved.settings.visibleProjectIds).toEqual([project.id]);
  expect(modelActions).toBe(0);
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-assistant-settings.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('assistant settings keep a stale-device draft and require a visible comparison before overwriting', async ({
  page,
}, info) => {
  let saved = initial((await (await page.request.get('/api/frontdesk')).json()) as FrontdeskStatus);
  const writes: { key: string; expectedRevision: number }[] = [];
  await page.route('**/api/frontdesk', (route) => route.fulfill({ json: saved }));
  await page.route('**/api/frontdesk/settings', (route) => {
    const input = route.request().postDataJSON();
    writes.push(input);
    if (input.expectedRevision !== saved.settings.revision)
      return route.fulfill({
        status: 409,
        json: {
          error:
            'These assistant settings changed on another device. Reload the latest settings before saving.',
        },
      });
    saved = {
      ...saved,
      settings: {
        revision: saved.settings.revision + 1,
        visibleProjectIds: input.visibleProjectIds,
        preferences: input.preferences,
        priorities: input.priorities,
        commitments: input.commitments,
      },
    };
    return route.fulfill({ json: saved });
  });
  const dialog = await openSettings(page);
  await dialog.getByLabel('How should your assistant work with you?').fill('My preserved edits');
  saved = {
    ...saved,
    settings: {
      ...saved.settings,
      revision: 1,
      preferences: 'Saved from another device',
      priorities: 'Other device priority',
    },
  };
  await dialog.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('another device');
  await expect(dialog.getByLabel('How should your assistant work with you?')).toHaveValue(
    'My preserved edits',
  );
  await dialog.getByRole('button', { name: 'Reload latest saved settings' }).click();
  const comparison = dialog.getByRole('region', { name: 'Saved settings comparison' });
  await expect(comparison).toContainText('Other device priority');
  await expect(
    dialog.getByRole('button', { name: 'Save assistant settings', exact: true }),
  ).toBeDisabled();
  await comparison.getByRole('button', { name: 'Keep my edits' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-assistant-comparison.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await comparison.getByRole('button', { name: 'Keep my edits' }).click();
  await dialog.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(dialog).toContainText('Assistant settings saved');
  expect(writes.map((input) => input.expectedRevision)).toEqual([0, 1]);
  expect(writes[0].key).not.toBe(writes[1].key);
  expect(saved.settings.preferences).toBe('My preserved edits');
  expect(saved.settings.revision).toBe(2);
});

test('assistant first-read failure has an in-app retry without losing any records', async ({
  page,
}) => {
  let unavailable = false;
  const saved = initial(
    (await (await page.request.get('/api/frontdesk')).json()) as FrontdeskStatus,
  );
  await page.route('**/api/frontdesk', (route) => {
    if (unavailable) {
      return route.fulfill({
        status: 500,
        json: { error: 'Storage was temporarily unavailable. Try again.' },
      });
    }
    return route.fulfill({ json: saved });
  });
  const initialStatus = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/frontdesk') && response.request().method() === 'GET',
  );
  await page.goto('/');
  await initialStatus;
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  unavailable = true;
  await page.getByRole('button', { name: 'Assistant settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant settings', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('temporarily unavailable');
  unavailable = false;
  await dialog.getByRole('button', { name: 'Try reading settings again' }).click();
  await expect(dialog.getByLabel('How should your assistant work with you?')).toHaveValue('');
  await expect(dialog).not.toContainText(/pnpm|\/path\//);
});

test('the real app creates or reopens an assistant, saves preferences, and keeps its demo conversation after reload', async ({
  page,
}, info) => {
  const before = (await (await page.request.get('/api/frontdesk')).json()) as FrontdeskStatus;
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  expect(snapshot.provider.version).toBe('demo');
  const target = snapshot.projects.find((project) => project.id !== before.projectId)!;
  await page.goto('/');
  if (page.viewportSize()!.width <= 720)
    await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Your assistant', exact: true }).click();
  if (before.agentId)
    await page.getByRole('button', { name: 'Personalize assistant', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant settings', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: target.name, exact: true }).check();
  await dialog
    .getByLabel('How should your assistant work with you?')
    .fill(`Concise updates for ${info.project.name}.`);
  await dialog.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect(dialog).toContainText('Assistant settings saved');
  const status = (await (await page.request.get('/api/frontdesk')).json()) as FrontdeskStatus;
  expect(status.agentId).toBeTruthy();
  if (before.agentId) expect(status.agentId).toBe(before.agentId);
  await dialog.getByRole('button', { name: 'Open your assistant', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: 'Message Your assistant', exact: true });
  await expect(composer).toBeVisible();
  const message = `Demo assistant handoff ${info.project.name} ${Date.now()}`;
  await composer.fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // An old demo reply and the new draft are not evidence that this send finished.
  await expect(page.locator('article').getByText(message, { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const detail = await (await page.request.get(`/api/agents/${status.agentId}`)).json();
      return detail.runs.filter(
        (run: { text: string; status: string }) =>
          run.text === message && run.status === 'completed',
      ).length;
    })
    .toBe(1);
  await expect(page.getByText('Your message is saved.', { exact: false }).last()).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Message Your assistant', exact: true }),
  ).toBeVisible();
  await expect(page.locator('article').getByText(message, { exact: true })).toBeVisible();
  const after = await (await page.request.get(`/api/agents/${status.agentId}`)).json();
  expect(after.runs.filter((run: { text: string }) => run.text === message)).toHaveLength(1);
  expect(after.agent.id).toBe(status.agentId);
  const finalSnapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  expect(finalSnapshot.projects.length).toBe(snapshot.projects.length + (before.agentId ? 0 : 1));
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-assistant-real-journey.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
