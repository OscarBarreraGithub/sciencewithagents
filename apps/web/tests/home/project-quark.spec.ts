import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { projectQuarkPolicySchema, schedulerStatusSchema } from '@dock/shared';

type Save = { key: string; enabled: boolean; expectedRevision: number };
type Fixture = { settings: unknown; projectId: string; managerId: string; runIds: string[] };
const owned = new WeakMap<Page, Fixture>();
test.beforeEach(async ({ page, baseURL }, info) => {
  const settings = schedulerStatusSchema.parse(
    await (await page.request.get('/api/scheduler')).json(),
  ).settings;
  owned.set(page, { settings, projectId: '', managerId: '', runIds: [] });
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers: { Origin: baseURL! },
        data: { key: randomUUID(), settings: { ...settings, paused: true } },
      })
    ).ok(),
  ).toBe(true);
  const response = await page.request.post('/api/projects', {
    headers: { Origin: baseURL! },
    data: {
      key: randomUUID(),
      name: `Project QUARK ${info.project.name} ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json();
  Object.assign(owned.get(page)!, { projectId: project.id, managerId: project.managerId });
});
test.afterEach(async ({ page, baseURL }) => {
  const fixture = owned.get(page)!;
  await page.unrouteAll({ behavior: 'wait' });
  for (const runId of fixture.runIds)
    expect(
      (
        await page.request.post('/api/pulsar/jobs', {
          headers: { Origin: baseURL! },
          data: { key: randomUUID(), runId, action: 'cancel' },
        })
      ).ok(),
    ).toBe(true);
  if (fixture.managerId)
    expect(
      (
        await page.request.post(`/api/agents/${fixture.managerId}/remove`, {
          headers: { Origin: baseURL! },
          data: { key: randomUUID() },
        })
      ).ok(),
    ).toBe(true);
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers: { Origin: baseURL! },
        data: { key: randomUUID(), settings: fixture.settings },
      })
    ).ok(),
  ).toBe(true);
});
function controls(page: Page) {
  const options = page
    .getByRole('group', { name: 'Conversation tools' })
    .getByRole('button', { name: 'Conversation options', exact: true });
  const menu = page.getByRole('menu', { name: 'Conversation options', exact: true });
  return {
    options,
    menu,
    toggle: menu.getByRole('menuitemcheckbox', { name: 'Follow QUARK', exact: true }),
    retry: menu.getByRole('menuitem', { name: 'Retry QUARK change', exact: true }),
  };
}

test('manager menu follows QUARK by default, retains a lost Off save across reload, and saves On again', async ({
  page,
  baseURL,
}, info) => {
  const fixture = owned.get(page)!;
  const path = `/api/projects/${fixture.projectId}/quark-scheduler`;
  const writes: Save[] = [];
  const message = await page.request.post(`/api/agents/${fixture.managerId}/messages`, {
    headers: { Origin: baseURL! },
    data: {
      key: randomUUID(),
      text: 'This owned reply stays queued during the manual host pause.',
    },
  });
  expect(message.ok()).toBe(true);
  fixture.runIds.push((await message.json()).id);
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (writes.length === 1)
      return route.fulfill({ status: 502, json: { error: 'Saved; acknowledgement lost.' } });
    await route.fulfill({ response });
  });
  await page.goto(`/#/chat/${fixture.managerId}`);
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Configuration', exact: true });
  await expect(panel.getByRole('switch', { name: /Ignore QUARK for my replies/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  const { options, menu, toggle, retry } = controls(page);
  await options.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toContainText('On');
  await expect(toggle).toContainText('Project + all workers');
  await expect(toggle).toHaveAccessibleDescription(/Stop, held jobs, native permissions/);
  await menu.getByRole('menuitem', { name: 'Archive conversation', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    menu.getByRole('menuitem', { name: 'Archive conversation', exact: true }),
  ).toBeFocused();
  await toggle.click();
  await expect(menu.getByRole('alert')).toContainText('Your change is retained');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); // no optimistic success
  await page.keyboard.press('Escape');
  await expect(options).toBeFocused();
  await options.click();
  await expect(menu.getByRole('status')).toHaveText('Off change unconfirmed.');
  await page.reload();
  await options.click();
  await expect(menu.getByRole('status')).toHaveText('Off change unconfirmed.');
  await retry.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toContainText('Off');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(projectQuarkPolicySchema.parse(await (await page.request.get(path)).json())).toMatchObject(
    {
      projectId: fixture.projectId,
      enabled: false,
      revision: 1,
    },
  );
  const detail = await (await page.request.get(`/api/agents/${fixture.managerId}`)).json();
  expect(detail.runs[0].status).toBe('queued');
  const bounds = (await toggle.boundingBox())!;
  const menuBounds = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('project-quark-off.png') });
  await page.keyboard.press('Escape');
  await options.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(writes[2]).toMatchObject({ enabled: true, expectedRevision: 1 });
  expect(writes[2].key).not.toBe(writes[0].key);
  await page.reload();
  await options.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(retry).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('project-quark-on.png') });
});

test('a revision conflict refreshes the switch and a failed reread retains the exact change without showing an older receipt', async ({
  page,
  baseURL,
}) => {
  const fixture = owned.get(page)!;
  const path = `/api/projects/${fixture.projectId}/quark-scheduler`;
  const writes: Save[] = [];
  let failRead = false;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === 'GET') {
      if (!failRead) return route.continue();
      failRead = false;
      return route.fulfill({
        status: 503,
        json: { error: 'Cannot confirm the current setting yet.' },
      });
    }
    writes.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (writes.length === 2) {
      expect(response.ok()).toBe(true);
      // Another device changes the setting after this request succeeds. Its receipt is now old.
      const newer = await page.request.post(path, {
        headers: { Origin: baseURL! },
        data: { key: randomUUID(), enabled: false, expectedRevision: 2 },
      });
      expect(newer.ok()).toBe(true);
      failRead = true;
    }
    await route.fulfill({ response });
  });
  await page.goto(`/#/chat/${fixture.managerId}`);
  const { options, menu, toggle, retry } = controls(page);
  await options.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const external = await page.request.post(path, {
    headers: { Origin: baseURL! },
    data: { key: randomUUID(), enabled: false, expectedRevision: 0 },
  });
  expect(external.ok()).toBe(true);
  await toggle.click();
  await expect(menu.getByRole('alert')).toContainText('changed elsewhere');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(retry).toHaveCount(0); // stale revision is not retried automatically
  await toggle.evaluate((element) => {
    const seen: string[] = [];
    (window as unknown as { quarkValues: string[] }).quarkValues = seen;
    new MutationObserver(() => seen.push(element.getAttribute('aria-checked')!)).observe(element, {
      attributes: true,
      attributeFilter: ['aria-checked'],
    });
  });
  await toggle.click();
  await expect(menu.getByRole('alert')).toContainText('Cannot confirm the current setting yet.');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(menu.getByRole('status')).toHaveText('On change unconfirmed.');
  await retry.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(writes[2]).toEqual(writes[1]);
  expect(
    await page.evaluate(() => (window as unknown as { quarkValues: string[] }).quarkValues),
  ).not.toContain('true');
  expect(projectQuarkPolicySchema.parse(await (await page.request.get(path)).json())).toMatchObject(
    {
      enabled: false,
      revision: 3,
    },
  );
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(writes[3]).toMatchObject({ enabled: true, expectedRevision: 3 });
});
