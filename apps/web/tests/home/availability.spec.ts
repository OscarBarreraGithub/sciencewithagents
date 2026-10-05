import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function project(page: Page, origin: string) {
  const result = await page.request.post('/api/projects', {
    headers: { Origin: origin },
    data: {
      key: randomUUID(),
      name: `Availability ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(result.ok()).toBe(true);
  return (await result.json()).managerId as string;
}

test('a send lost before admission and an edited draft recover through the real draft contract', async ({
  page,
  baseURL,
}) => {
  const id = await project(page, baseURL!);
  await page.goto(`/#/chat/${id}`);
  const composer = page.locator('.composer');
  const input = composer.getByRole('textbox');
  await input.fill('First prompt, never delivered.');
  await page.route(`**/api/agents/${id}/messages`, (route) => route.abort('failed'), { times: 1 });
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  const retry = composer.getByRole('button', { name: 'Retry previous message', exact: true });
  await expect(retry).toBeEnabled();
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes(`/drafts/${id}`) && response.request().method() === 'POST',
  );
  await input.fill('New draft written after the lost connection.');
  expect((await saved).ok()).toBe(true);
  const refusal = page.waitForResponse((response) =>
    response.url().endsWith(`/agents/${id}/messages`),
  );
  await retry.click();
  expect(await (await refusal).json()).toMatchObject({ code: 'DRAFT_CHANGED' });
  await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('New draft written after the lost connection.');
  await composer.getByText('Previous unsent message', { exact: true }).click();
  await expect(composer.getByText('First prompt, never delivered.', { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/agents/${id}`)).json()).runs).toEqual([]);
  await page.reload();
  await expect(input).toHaveValue('New draft written after the lost connection.');
  await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});

test('the first successful draft read retains offline typing after an initial read failure', async ({
  page,
  baseURL,
}) => {
  const id = await project(page, baseURL!);
  await page.addInitScript(
    ({ id }) =>
      localStorage.setItem(
        `dock:local:workspace:draft:${id}`,
        JSON.stringify({ text: 'Typed offline and still mine.', baseRevision: 0 }),
      ),
    { id },
  );
  let reads = 0;
  await page.route(`**/api/workspace/*/drafts/${id}`, (route) => {
    if (route.request().method() === 'GET' && ++reads === 1)
      return route.fulfill({ status: 503, json: { error: 'Initial draft read unavailable' } });
    return route.continue();
  });
  await page.goto(`/#/chat/${id}`);
  const input = page.locator('.composer').getByRole('textbox');
  await expect(input).toHaveValue('Typed offline and still mine.');
  await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(
    page.locator('.composer').getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue('Typed offline and still mine.');
  expect(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`dock:local:workspace:draft:${id}`)!).text,
      id,
    ),
  ).toBe('Typed offline and still mine.');
});

test('provider and queue failures leave navigation and drafts usable; cold reconnect exposes the local draft', async ({
  page,
  baseURL,
}, info) => {
  const id = await project(page, baseURL!);
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    state.provider = { ready: false, version: '', message: 'Provider offline' };
    state.schedulingError =
      'QUARK could not check the queue. New starts wait while it retries automatically. Saved chats and drafts remain available.';
    await route.fulfill({ json: state });
  });
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  await expect(page.getByText(/QUARK could not check the queue/)).toBeVisible();
  await page.goto(`/#/chat/${id}`);
  const input = page.locator('.composer').getByRole('textbox');
  await input.fill('Keep this prompt through reconnect.');
  await page.screenshot({ path: info.outputPath('provider-unavailable.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({ status: 503, json: { error: 'Computer reconnecting' } }),
  );
  await page.reload();
  const retained = page.getByRole('region', { name: 'Retained browser draft' });
  await expect(retained).toContainText('Keep this prompt through reconnect.');
  await expect(retained.getByRole('button', { name: 'Copy draft' })).toBeVisible();
  await page.unroute('**/api/phone/status');
  await page.reload();
  await expect(input).toHaveValue('Keep this prompt through reconnect.');
});
