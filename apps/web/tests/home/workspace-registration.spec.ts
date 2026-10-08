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
}, info) => {
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
  let recovering = false;
  let unavailableReplies = 0;
  let recoveredReplies = 0;
  await page.route('**/api/workspace/clients', async (route) => {
    const canRecover = recovering;
    const input = route.request().postDataJSON();
    expect(input).toEqual(saved);
    inputs.push(input);
    const response = await route.fetch();
    const value = await response.json();
    expect(response.ok()).toBe(true);
    registeredClient ||= value.client.id;
    expect(value.client.id).toBe(registeredClient);
    // A later mounted hook may retry a failed bootstrap before reload. Keep
    // every receipt unavailable until the fixture explicitly permits recovery.
    if (!canRecover) {
      await route.fulfill({
        status: 503,
        json: { error: 'Owned fixture lost registration receipt' },
      });
      unavailableReplies++;
      return;
    }
    await route.fulfill({ response });
    recoveredReplies++;
  });
  await page.goto(`/#/chat/${id}`);
  // The main pane offers the saved retry in plain words; the raw reply stays in Open conversations.
  await expect(
    page
      .locator('.workspace-reconnect-notice')
      .getByRole('button', { name: 'Retry connection', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message-queue')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => unavailableReplies).toBeGreaterThanOrEqual(2);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('dock:local:workspace:registration')!),
    ),
  ).toEqual(saved);
  expect(await page.evaluate(() => localStorage.getItem('dock:local:workspace:client'))).toBeNull();
  await expect(page.locator('.composer textarea')).toHaveValue('Retained local draft');
  const composer = page.locator('.composer');
  const draftState = composer.locator('.draft-handoff [data-draft]').first();
  const send = composer.getByRole('button', { name: 'Send message', exact: true });
  const notice = page.locator('.workspace-reconnect-notice');
  const retry = notice.getByRole('button', { name: 'Retry connection', exact: true });
  await expect(draftState).toHaveAttribute('data-draft', 'connecting');
  await expect(send).toBeDisabled();
  await expect(retry).toBeEnabled();
  await expect(retry).toBeInViewport();
  expect(await notice.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('registration-gated-retry.png'), scale: 'css' });
  const failedAttempts = inputs.length;
  recovering = true;
  await retry.click();
  await expect.poll(() => recoveredReplies).toBeGreaterThan(0);
  expect(inputs.length).toBeGreaterThan(failedAttempts);
  expect(inputs).toEqual(Array.from({ length: inputs.length }, () => saved));
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('dock:local:workspace:client')))
    .toBe(registeredClient);
  await expect(page.locator('.composer textarea')).toHaveValue('Retained local draft');
  await expect(draftState).toHaveAttribute('data-draft', 'saved');
  await expect(send).toBeEnabled();
  await expect(notice).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem('dock:local:workspace:registration')),
  ).toBeNull();
  const recoveredAttempts = inputs.length;
  await page.reload();
  const reloadedList = await openQueue(page);
  await expect(
    reloadedList.getByRole('button', { name: 'Edit', exact: true }).first(),
  ).toBeEnabled();
  await expect(page.locator('.composer textarea')).toHaveValue('Retained local draft');
  await expect(draftState).toHaveAttribute('data-draft', 'saved');
  await expect(send).toBeEnabled();
  expect(inputs).toHaveLength(recoveredAttempts);
  await reloadedList.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({ path: info.outputPath('registration-recovered.png'), scale: 'css' });
});

test('an interrupted first open offers the same saved retry beside a short reconnect notice', async ({
  page,
  baseURL,
}, info) => {
  const headers = { Origin: baseURL! };
  const project = await (
    await page.request.post('/api/projects', {
      headers,
      data: { key: randomUUID(), name: `Reconnect ${randomUUID().slice(0, 8)}`, provider: 'codex' },
    })
  ).json();
  const id = project.managerId as string;
  // Owner history is a fixture-only read; nothing is sent to the agent.
  const detail = await (await page.request.get(`/api/agents/${id}`)).json();
  const owner = {
    id: randomUUID(),
    agentId: id,
    runId: null,
    kind: 'user',
    title: 'You',
    text: 'Owner message kept through reload',
    status: 'complete',
    createdAt: new Date().toISOString(),
  };
  await page.route(new RegExp(`/api/agents/${id}(?:\\?.*)?$`), (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { ...detail, entries: [owner] } })
      : route.continue(),
  );
  const sends: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/messages|\/resume|\/start/.test(request.url()))
      sends.push(request.url());
  });
  const opens: Record<string, unknown>[] = [];
  const accepted: { status: string; state: { client: { revision: number } } }[] = [];
  let mode: 'interrupt' | 'fail' | 'pass' = 'interrupt';
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/workspace\/[0-9a-f-]{36}$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    opens.push(route.request().postDataJSON());
    if (mode === 'fail')
      return route.fulfill({ status: 503, json: { error: 'Owned fixture: reply unavailable' } });
    if (mode === 'pass') return route.continue();
    // The real demo backend accepts the open; its reply never reaches the page.
    const response = await route.fetch();
    accepted.push(await response.json());
    await held;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto(`/#/chat/${id}`);
    const composer = page.locator('.composer');
    const input = composer.getByRole('textbox', { name: /^Message / });
    const draftState = composer.locator('.draft-handoff [data-draft]').first();
    await expect(draftState).toHaveAttribute('data-draft', 'saved');
    await input.fill('Unsent draft kept through reload');
    await expect(draftState).toHaveAttribute('data-draft', 'saved');
    await expect.poll(() => accepted.length).toBe(1);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ revision: 0, action: { kind: 'open', agentId: id } });
    expect(accepted[0]).toMatchObject({ status: 'applied', state: { client: { revision: 1 } } });
    const pending = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('dock:local:workspace:pending') ?? 'null'),
      );
    expect(await pending()).toEqual(opens[0]);
    // Rapid reload while the accepted open's reply is still outstanding.
    await page.reload();
    release();
    const notice = page.locator('.flow-chat-notice.workspace-reconnect-notice');
    const retry = notice.getByRole('button', { name: 'Retry connection', exact: true });
    await expect(notice).toContainText('Connection interrupted.');
    await expect(notice).not.toContainText('Retry the previous workspace change');
    await expect(retry).toBeEnabled();
    await expect(retry).toBeInViewport();
    await expect(
      page.locator('.message.user').filter({ hasText: 'Owner message kept through reload' }),
    ).toBeVisible();
    await expect(input).toHaveValue('Unsent draft kept through reload');
    expect(await pending()).toEqual(opens[0]);
    expect(opens).toHaveLength(1);
    // The whole notice and its button are visible: no clipping, overlap or sideways overflow.
    expect(await notice.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
    const noticeBox = (await notice.boundingBox())!;
    const retryBox = (await retry.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(retryBox.height).toBeGreaterThanOrEqual(43);
    expect(retryBox.y).toBeGreaterThanOrEqual(noticeBox.y);
    expect(retryBox.y + retryBox.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height + 1);
    expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(noticeBox.x + noticeBox.width + 1);
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('reconnect-notice.png'), scale: 'css' });
    // A failed retry resends the exact saved input and keeps the direct action.
    mode = 'fail';
    await retry.click();
    await expect.poll(() => opens.length).toBe(2);
    expect(opens[1]).toEqual(opens[0]);
    // The notice and its action stay in place through the attempt and after its failure.
    await expect(retry).toHaveText('Retry connection');
    await expect(retry).toBeEnabled();
    await expect(notice).toBeVisible();
    expect(await pending()).toEqual(opens[0]);
    await page.screenshot({
      path: info.outputPath('reconnect-after-failed-retry.png'),
      scale: 'css',
    });
    mode = 'pass';
    await retry.click();
    await expect.poll(pending).toBeNull();
    await expect(page.locator('.workspace-reconnect-notice')).toHaveCount(0);
    expect(opens).toHaveLength(3);
    expect(opens[2]).toEqual(opens[0]);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('Unsent draft kept through reload');
    await expect(draftState).toHaveAttribute('data-draft', 'saved');
    const client = await page.evaluate(() => localStorage.getItem('dock:local:workspace:client'));
    const saved = await (await page.request.get(`/api/workspace/${client}`)).json();
    expect(saved.client.revision).toBe(1);
    expect(saved.client.openAgentIds.filter((agent: string) => agent === id)).toHaveLength(1);
    expect(saved.client.selectedAgentId).toBe(id);
    expect(sends).toEqual([]);
    expect((await (await page.request.get(`/api/agents/${id}`)).json()).runs).toEqual([]);
    await page.screenshot({ path: info.outputPath('reconnect-recovered.png'), scale: 'css' });
  } finally {
    release();
  }
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
