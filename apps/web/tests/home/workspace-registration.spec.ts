import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const owned = new WeakMap<Page, { settings: unknown; agentId: string }>();
test.afterEach(async ({ page, baseURL }) => {
  await page.unrouteAll({ behavior: 'wait' });
  const fixture = owned.get(page);
  if (!fixture) return;
  const headers = { Origin: baseURL! };
  const detail = await (await page.request.get(`/api/agents/${fixture.agentId}`)).json();
  for (const run of detail.runs as { id: string; status: string }[])
    if (run.status === 'queued')
      expect(
        (
          await page.request.post('/api/pulsar/jobs', {
            headers,
            data: { key: randomUUID(), runId: run.id, action: 'cancel' },
          })
        ).ok(),
      ).toBe(true);
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers,
        data: { key: randomUUID(), settings: fixture.settings },
      })
    ).ok(),
  ).toBe(true);
});

async function queue(page: Page, origin: string) {
  const headers = { Origin: origin };
  const baseline = await (await page.request.get('/api/scheduler')).json();
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers,
        data: { key: randomUUID(), settings: { paused: true, maxConcurrent: 4 } },
      })
    ).ok(),
  ).toBe(true);
  const project = await (
    await page.request.post('/api/projects', {
      headers,
      data: {
        key: randomUUID(),
        name: `Registration ${randomUUID().slice(0, 8)}`,
        provider: 'codex',
      },
    })
  ).json();
  owned.set(page, { settings: baseline.settings, agentId: project.managerId });
  for (const text of ['Real saved first queue item', 'Real saved second queue item'])
    expect(
      (
        await page.request.post(`/api/agents/${project.managerId}/messages`, {
          headers,
          data: { key: randomUUID(), text },
        })
      ).ok(),
    ).toBe(true);
  const detail = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  expect(detail.runs.every((run: { queueEditable: boolean }) => run.queueEditable)).toBe(true);
  return project.managerId as string;
}

async function openQueue(page: Page) {
  await expect(page.locator('.message-queue')).toBeVisible();
  // The compact composer owns the newer summary; classic fixtures retain Expand queue.
  const summary = page.locator('.message-queue-summary');
  if (await summary.count()) await summary.click();
  else await page.getByRole('button', { name: 'Expand queue', exact: true }).click();
  return page.getByRole('dialog', { name: 'Queued messages', exact: true });
}

test('two cold browsers share registration within each document and can edit the same saved queue', async ({
  page,
  browser,
  baseURL,
}) => {
  const id = await queue(page, baseURL!);
  const second = await browser.newContext({ baseURL, viewport: page.viewportSize()! });
  const clients: string[] = [];
  try {
    for (const view of [page, await second.newPage()]) {
      const inputs: { key: string; label: string }[] = [];
      await view.route('**/api/workspace/clients', async (route) => {
        inputs.push(route.request().postDataJSON());
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ response });
      });
      await view.goto(`/#/chat/${id}`);
      const list = await openQueue(view);
      await expect(list.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(2);
      await expect(list.getByRole('button', { name: 'Edit', exact: true }).first()).toBeEnabled();
      expect(inputs).toHaveLength(1);
      await expect(view.getByRole('alert').filter({ hasText: 'This retry key' })).toHaveCount(0);
      clients.push(await view.evaluate(() => localStorage.getItem('dock:local:workspace:client')!));
      await list.getByRole('button', { name: 'Edit', exact: true }).first().click();
      const editor = view.getByRole('dialog', { name: 'Edit queued message', exact: true });
      await expect(editor).toBeVisible();
      await editor.getByRole('button', { name: 'Save and queue', exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    expect(clients[0]).not.toBe(clients[1]);
  } finally {
    await second.close();
  }
});

test('a lost registration response reloads with the exact saved body and keeps a local draft', async ({
  page,
  baseURL,
}) => {
  const id = await queue(page, baseURL!);
  const saved = { key: randomUUID(), label: 'Label saved before the interrupted connection' };
  await page.addInitScript(
    ({ saved, id }) => {
      if (!sessionStorage.getItem('registration-fixture-seeded')) {
        localStorage.setItem('dock:local:workspace:registration', JSON.stringify(saved));
        localStorage.setItem(
          `dock:local:workspace:draft:${id}`,
          JSON.stringify({ text: 'Retained local draft', baseRevision: 0 }),
        );
        sessionStorage.setItem('registration-fixture-seeded', 'yes');
      }
    },
    { saved, id },
  );
  const inputs: (typeof saved)[] = [];
  let registeredClient = '';
  await page.route('**/api/workspace/clients', async (route) => {
    inputs.push(route.request().postDataJSON());
    const response = await route.fetch();
    const value = await response.json();
    expect(response.ok()).toBe(true);
    registeredClient = value.client.id;
    if (inputs.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Owned fixture lost registration receipt' },
      });
    await route.fulfill({ response });
  });
  await page.goto(`/#/chat/${id}`);
  await expect(page.getByRole('alert').first()).toContainText('lost registration receipt');
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('dock:local:workspace:registration')!),
    ),
  ).toEqual(saved);
  await expect(page.locator('.composer textarea')).toHaveValue('Retained local draft');
  await page.reload();
  const list = await openQueue(page);
  await expect(list.getByRole('button', { name: 'Edit', exact: true }).first()).toBeEnabled();
  expect(inputs).toEqual([saved, saved]);
  expect(await page.evaluate(() => localStorage.getItem('dock:local:workspace:client'))).toBe(
    registeredClient,
  );
  await expect(page.locator('.composer textarea')).toHaveValue('Retained local draft');
  expect(
    await page.evaluate(() => localStorage.getItem('dock:local:workspace:registration')),
  ).toBeNull();
});

test('legacy pending UUID retains its key and an existing renamed identity is reused', async ({
  page,
  baseURL,
}) => {
  const id = await queue(page, baseURL!);
  const legacyKey = randomUUID();
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('legacy-registration-seeded')) {
      localStorage.setItem('dock:local:workspace:registration', key);
      sessionStorage.setItem('legacy-registration-seeded', 'yes');
    }
  }, legacyKey);
  const inputs: { key: string; label: string }[] = [];
  await page.route('**/api/workspace/clients', async (route) => {
    inputs.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto(`/#/chat/${id}`);
  const list = await openQueue(page);
  await expect(list.getByRole('button', { name: 'Edit', exact: true }).first()).toBeEnabled();
  expect(inputs).toHaveLength(1);
  expect(inputs[0].key).toBe(legacyKey);
  const clientId = await page.evaluate(() => localStorage.getItem('dock:local:workspace:client')!);
  const state = await (await page.request.get(`/api/workspace/${clientId}`)).json();
  expect(
    (
      await page.request.post(`/api/workspace/${clientId}`, {
        headers: { Origin: baseURL! },
        data: {
          key: randomUUID(),
          hostId: state.hostId,
          revision: state.client.revision,
          action: { kind: 'rename', label: 'Owner chosen workspace label' },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.evaluate(
    (key) => localStorage.setItem('dock:local:workspace:registration', key),
    randomUUID(),
  );
  await page.reload();
  const reopened = await openQueue(page);
  await expect(reopened.getByRole('button', { name: 'Edit', exact: true }).first()).toBeEnabled();
  expect(inputs).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('dock:local:workspace:client'))).toBe(
    clientId,
  );
  expect((await (await page.request.get(`/api/workspace/${clientId}`)).json()).client.label).toBe(
    'Owner chosen workspace label',
  );
});
