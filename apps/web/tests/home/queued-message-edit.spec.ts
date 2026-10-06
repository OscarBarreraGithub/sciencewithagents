import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chatFileIds, chatFileReference, schedulerSettingsSchema } from '@dock/shared';

const owned = new WeakMap<Page, { settings: unknown; agents: string[] }>();
test.beforeEach(async ({ page }) => {
  const baseline = await (await page.request.get('/api/scheduler')).json();
  owned.set(page, { settings: schedulerSettingsSchema.parse(baseline.settings), agents: [] });
});
test.afterEach(async ({ page, baseURL }) => {
  // Fixture routes read the API themselves. Drain those callbacks while the
  // request context is alive, before cleanup emits another queue update.
  await page.unrouteAll({ behavior: 'wait' });
  const fixture = owned.get(page);
  if (!fixture) return;
  const headers = { Origin: baseURL! };
  // Cancel only this test's queued turns before releasing the scheduler.
  for (const agentId of fixture.agents) {
    const detail = await (await page.request.get(`/api/agents/${agentId}`)).json();
    for (const run of detail.runs as { id: string; status: string }[]) {
      if (run.status !== 'queued') continue;
      expect(
        (
          await page.request.post('/api/pulsar/jobs', {
            headers,
            data: { key: randomUUID(), runId: run.id, action: 'cancel' },
          })
        ).ok(),
      ).toBe(true);
    }
  }
  expect(
    (
      await page.request.post('/api/scheduler/settings', {
        headers,
        data: { key: randomUUID(), settings: fixture.settings },
      })
    ).ok(),
  ).toBe(true);
  owned.delete(page);
});

/** The closed queue is one summary row; its items open in the full-height dialog. */
async function openQueue(page: Page) {
  await page.getByRole('button', { name: /Expand queue/ }).click();
  await expect(page.getByRole('dialog', { name: 'Queued messages', exact: true })).toBeVisible();
}

async function fixture(page: Page, origin: string) {
  const headers = { Origin: origin };
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
        name: `Queued edits ${randomUUID().slice(0, 8)}`,
        provider: 'codex',
      },
    })
  ).json();
  owned.get(page)!.agents.push(project.managerId);
  const firstKey = randomUUID();
  const first = await (
    await page.request.post(`/api/agents/${project.managerId}/messages`, {
      headers,
      data: { key: firstKey, text: 'First queued scientific question' },
    })
  ).json();
  await page.request.post(`/api/agents/${project.managerId}/messages`, {
    headers,
    data: { key: randomUUID(), text: 'Second queued question stays separate' },
  });
  const read = async () =>
    (await (await page.request.get(`/api/agents/${project.managerId}`)).json()).runs.find(
      (run: { id: string }) => run.id === first.id,
    );
  return {
    agentId: project.managerId as string,
    runId: first.id as string,
    firstKey,
    read,
    headers,
  };
}

test('queued notepad holds one item, keeps the composer, survives keyboard dismissal/reload, and explicitly requeues', async ({
  page,
  baseURL,
}, info) => {
  const saved = await fixture(page, baseURL!);
  await page.goto(`/#/chat/${saved.agentId}`);
  const composer = page.locator('.composer textarea');
  await composer.fill('Separate unsent composer draft');
  const summary = page.getByRole('button', { name: /Expand queue/ });
  await expect(summary).toContainText('2 queued messages');
  const list = page.getByRole('list', { name: 'Queued messages' });
  await expect(list).toHaveCount(0);
  await openQueue(page);
  const menu = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.height).toBeGreaterThan(page.viewportSize()!.height * 0.8);
  await mkdir('../../data/queued-message-ui', { recursive: true });
  await page.screenshot({
    path: `../../data/queued-message-ui/${info.project.name}-expanded-queue.png`,
  });
  await menu
    .getByRole('listitem')
    .filter({ hasText: 'First queued scientific question' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
  await expect(pad).toBeVisible();
  await expect.poll(async () => (await saved.read()).queueEdit?.state).toBe('editing');
  const area = pad.getByRole('textbox');
  await area.fill('Updated scientific question');
  await area.press('End');
  await area.press('Enter');
  await area.press('X');
  const edited = 'Updated scientific question\nX';
  await expect(area).toHaveValue(edited);
  await expect.poll(async () => (await saved.read()).queueEdit?.text).toBe(edited);
  for (const button of ['Save and queue', 'Minimize'])
    await expect(pad.getByRole('button', { name: button, exact: true })).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await mkdir('../../data/queued-message-ui', { recursive: true });
  await page.screenshot({
    path: `../../data/queued-message-ui/${info.project.name}-held-notepad.png`,
  });
  await page.keyboard.press('Escape');
  if (await pad.isVisible()) await page.keyboard.press('Escape');
  await expect(pad).toHaveCount(0);
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(composer).toHaveValue('Separate unsent composer draft');
  // Closing the queue keeps the item held; the summary says so.
  await expect(summary).toContainText('1 held');
  expect((await saved.read()).queueEdit?.state).toBe('editing');
  await page.reload();
  await expect(composer).toHaveValue('Separate unsent composer draft');
  await openQueue(page);
  await expect(list).toContainText('Held for editing');
  await list
    .getByRole('listitem')
    .filter({ hasText: 'Updated scientific question' })
    .getByRole('button', { name: 'Resume edit' })
    .click();
  await expect(area).toHaveValue(edited);
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  await expect(pad).toHaveCount(0);
  await expect.poll(async () => (await saved.read()).queueEdit).toBeNull();
  expect((await saved.read()).text).toBe(edited);
  const receipt = await (
    await page.request.get(`/api/agents/${saved.agentId}/receipts/${saved.firstKey}`)
  ).json();
  expect(receipt.submitted.text).toBe('First queued scientific question');
  await expect(list.getByRole('listitem')).toHaveCount(2);
});

test('editing queued wording retains its file attachment without exposing internal markers', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  const bytes = Buffer.from('Saved calibration data\n1,2,3\n');
  const upload = await page.request.post('/api/chat-files', {
    headers: saved.headers,
    data: { key: randomUUID(), name: 'calibration.csv', data: bytes.toString('base64') },
  });
  expect(upload.ok()).toBe(true);
  const file = await upload.json();
  const response = await page.request.post(`/api/agents/${saved.agentId}/messages`, {
    headers: saved.headers,
    data: { key: randomUUID(), text: `Read this calibration\n\n${chatFileReference(file.id)}` },
  });
  expect(response.ok()).toBe(true);
  const submitted = await response.json();
  await page.goto(`/#/chat/${saved.agentId}`);
  await openQueue(page);
  const menu = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  const row = menu.getByRole('listitem').filter({ hasText: 'Read this calibration' });
  await expect(row).not.toContainText('swa-file:');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
  await expect(pad.getByRole('textbox')).toHaveValue('Read this calibration');
  await pad.getByRole('textbox').fill('Compare the calibration uncertainty');
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  const detail = await (await page.request.get(`/api/agents/${saved.agentId}`)).json();
  const run = detail.runs.find((value: { id: string }) => value.id === submitted.id);
  expect(run.text).toContain('Compare the calibration uncertainty');
  expect(chatFileIds(run.text)).toEqual([file.id]);
  expect(await (await page.request.get(`/api/chat-files/${file.id}`)).body()).toEqual(bytes);
});

test('reload reconciles an unknown Save and queue acknowledgement without a new request or duplicate chat evidence', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  let queueAttempts = 0;
  await page.route(`**/api/agents/${saved.agentId}/queued/${saved.runId}`, async (route) => {
    if (route.request().postDataJSON().action !== 'queue') return route.continue();
    queueAttempts++;
    await route.fetch();
    return route.fulfill({
      status: 503,
      json: { error: 'Queued edit saved; acknowledgement lost.' },
    });
  });
  await page.goto(`/#/chat/${saved.agentId}`);
  await openQueue(page);
  await page
    .getByRole('list', { name: 'Queued messages' })
    .getByRole('listitem')
    .filter({ hasText: 'First queued scientific question' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await pad.getByRole('textbox').fill('Changed queued content for the same run');
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  await expect(
    pad.getByText('Queued edit saved; acknowledgement lost.', { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(
      'A queued action needs inspection after a lost acknowledgement. It was not repeated.',
    ),
  ).toBeVisible();
  expect(queueAttempts).toBe(1);
  await page.getByRole('button', { name: 'Inspect queued action', exact: true }).click();
  await expect(page.locator('.queue-action-recovery')).toHaveCount(0);
  expect(queueAttempts).toBe(1);
  expect((await saved.read()).text).toBe('Changed queued content for the same run');
  expect((await saved.read()).queueEdit).toBeNull();
  await expect(page.getByText('Original queued message', { exact: true })).toHaveCount(0);
});

test('reload retains uncertain queued steering for inspection without enabling another send', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  let steering = 0;
  const state = async () => {
    const held = await saved.read();
    return steering
      ? {
          ...held,
          queueEdit: { ...held.queueEdit, state: 'steering' },
          queueRevision: held.queueRevision + 1,
        }
      : held;
  };
  // Native acknowledgement/receipt are simulated, matching the durable backend uncertainty test.
  await page.route(new RegExp(`/api/agents/${saved.agentId}(?:\\?.*)?$`), async (route) => {
    const body = await (await route.fetch()).json();
    body.agent.status = 'running';
    if (steering)
      body.runs = body.runs
        .map((run: { id: string }) => (run.id === saved.runId ? undefined : run))
        .filter(Boolean)
        .concat(await state());
    return route.fulfill({ json: body });
  });
  await page.route(`**/api/agents/${saved.agentId}/queued/${saved.runId}`, async (route) => {
    if (route.request().postDataJSON().action !== 'steer') return route.continue();
    steering++;
    return route.fulfill({
      status: 503,
      json: { error: 'Native steering acknowledgement was lost.' },
    });
  });
  await page.route(
    `**/api/agents/${saved.agentId}/queued/${saved.runId}/receipts/*`,
    async (route) => route.fulfill({ json: { status: 'uncertain', run: await state() } }),
  );
  await page.goto(`/#/chat/${saved.agentId}`);
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await list
    .getByRole('listitem')
    .filter({ hasText: 'First queued scientific question' })
    .getByRole('button', { name: 'Steer now…', exact: true })
    .click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await pad.getByRole('button', { name: 'Steer now', exact: true }).click();
  await expect(
    pad.getByText('Native steering acknowledgement was lost.', { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Inspect queued action', exact: true }).click();
  await expect(
    page.getByText(
      'Steering is uncertain. The message stays held; inspect the reply before removing it.',
    ),
  ).toBeVisible();
  // The inspected outcome stays with the notice when it follows the opened queue.
  await openQueue(page);
  await expect(
    page.getByText(
      'Steering is uncertain. The message stays held; inspect the reply before removing it.',
    ),
  ).toBeVisible();
  await list.getByRole('button', { name: 'Resume edit', exact: true }).click();
  await expect(pad.getByRole('textbox')).toHaveAttribute('readonly', '');
  await expect(pad.getByRole('button', { name: 'Save and queue', exact: true })).toBeDisabled();
  await expect(pad.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0);
  expect(steering).toBe(1);
});

test('queued edits retain later typing on lost acknowledgements and require explicit takeover after another device', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  const attempts: { key: string; text: string; action: string }[] = [];
  let lost = false;
  await page.route(`**/api/agents/${saved.agentId}/queued/${saved.runId}`, async (route) => {
    const input = route.request().postDataJSON();
    if (input.action === 'save') {
      attempts.push(input);
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        return route.fulfill({
          status: 503,
          json: { error: 'Saved edit acknowledgement was lost.' },
        });
      }
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.goto(`/#/chat/${saved.agentId}`);
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await list
    .getByRole('listitem')
    .filter({ hasText: 'First queued scientific question' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
  const area = pad.getByRole('textbox');
  await area.fill('Saved before lost acknowledgement');
  await expect(
    pad.getByText('Saved edit acknowledgement was lost.', { exact: true }).first(),
  ).toBeVisible();
  await area.fill('Later typing must survive the old acknowledgement');
  await pad.getByRole('button', { name: 'Retry saved action' }).click();
  await expect
    .poll(async () => (await saved.read()).queueEdit?.text)
    .toBe('Later typing must survive the old acknowledgement');
  await expect(area).toHaveValue('Later typing must survive the old acknowledgement');
  expect(attempts[0].key).toBe(attempts[1].key);
  const other = await (
    await page.request.post('/api/workspace/clients', {
      headers: saved.headers,
      data: { key: randomUUID(), label: 'Competing browser fixture' },
    })
  ).json();
  const taken = await page.request.post(`/api/agents/${saved.agentId}/queued/${saved.runId}`, {
    headers: saved.headers,
    data: {
      key: randomUUID(),
      clientId: other.client.id,
      revision: (await saved.read()).queueRevision,
      action: 'takeover',
    },
  });
  expect(taken.ok()).toBe(true);
  await area.fill('Local version stays recoverable after takeover');
  await expect(pad.getByText(/changed on another tab or device/).first()).toBeVisible();
  expect((await saved.read()).queueEdit.text).toBe(
    'Later typing must survive the old acknowledgement',
  );
  await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(list.getByRole('button', { name: 'Take over edit' })).toBeVisible();
  await list.getByRole('button', { name: 'Take over edit' }).click();
  await expect(area).toHaveValue('Later typing must survive the old acknowledgement');
  await pad.getByRole('button', { name: 'Versions', exact: true }).click();
  await expect(
    pad
      .getByRole('button')
      .filter({ hasText: 'Local version stays recoverable after takeover' })
      .first(),
  ).toBeVisible();
  await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
  expect((await saved.read()).queueEdit.state).toBe('editing');
});

test('queued editing follows the pinned selected host and shows queue-only controls for Claude', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  const host = randomUUID();
  const writes: string[] = [];
  await page.addInitScript((id) => localStorage.setItem('dock:host', id), host);
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: {
        local: { id: 'local', label: 'Entry fixture' },
        setupError: null,
        hosts: [
          {
            id: host,
            label: 'Selected fixture',
            accountLabel: 'owner fixture',
            status: 'connected',
            error: null,
          },
        ],
      },
    }),
  );
  // The transport targets another API prefix; only provider/display status is simulated.
  // The private demo's actual queue mutation/receipt/draft backend remains in use.
  await page.route(`**/api/hosts/${host}/proxy/**`, async (route) => {
    const url = route.request().url().replace(`/api/hosts/${host}/proxy`, '/api');
    if (new URL(url).pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': selected host fixture\n\n',
      });
    if (route.request().method() === 'POST' && url.includes('/queued/'))
      writes.push(route.request().url());
    const response = await route.fetch({ url });
    const pathname = new URL(url).pathname;
    if (pathname === `/api/agents/${saved.agentId}` || pathname === '/api/snapshot') {
      const body = await response.json();
      const agent =
        body.agent ?? body.agents.find((agent: { id: string }) => agent.id === saved.agentId);
      agent.provider = 'claude';
      agent.status = 'running';
      return route.fulfill({ json: body });
    }
    return route.fulfill({ response });
  });
  await page.goto(`/#/chat/${saved.agentId}`);
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('button', { name: /Steer now/ })).toHaveCount(0);
  await list
    .getByRole('listitem')
    .filter({ hasText: 'First queued scientific question' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await expect(pad.getByRole('button', { name: 'Steer now', exact: true })).toHaveCount(0);
  await pad.getByRole('textbox').fill('A follow-up on the selected computer');
  await pad.getByRole('button', { name: 'Save and queue', exact: true }).click();
  await expect(pad).toHaveCount(0);
  expect((await saved.read()).text).toBe('A follow-up on the selected computer');
  expect(writes.length).toBeGreaterThanOrEqual(2);
  expect(
    writes.every((url) => url.includes(`/api/hosts/${host}/proxy/agents/${saved.agentId}/queued/`)),
  ).toBe(true);
});

test('queued Steer now holds the selected item before a separate explicit Codex action', async ({
  page,
  baseURL,
}) => {
  const saved = await fixture(page, baseURL!);
  await page.route(new RegExp(`/api/agents/${saved.agentId}(?:\\?.*)?$`), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.agent.status = 'running';
    return route.fulfill({ json: body });
  });
  const steering: { text: string; wasHeld: boolean }[] = [];
  // Native turn/steer is simulated; hold and autosave use the real owned demo database.
  await page.route(`**/api/agents/${saved.agentId}/queued/${saved.runId}`, async (route) => {
    const input = route.request().postDataJSON();
    if (input.action !== 'steer') return route.continue();
    const held = await saved.read();
    steering.push({ text: input.text, wasHeld: held.queueEdit?.state === 'editing' });
    return route.fulfill({
      json: {
        ...held,
        status: 'cancelled',
        queueEdit: null,
        queueRevision: held.queueRevision + 1,
      },
    });
  });
  await page.goto(`/#/chat/${saved.agentId}`);
  const list = page.getByRole('list', { name: 'Queued messages' });
  await openQueue(page);
  await list
    .getByRole('listitem')
    .filter({ hasText: 'First queued scientific question' })
    .getByRole('button', { name: 'Steer now…', exact: true })
    .click();
  const pad = page.getByRole('dialog', { name: 'Edit queued message' });
  await expect(pad).toBeVisible();
  expect(steering).toHaveLength(0);
  await pad.getByRole('textbox').fill('Guide only this running reply');
  await expect
    .poll(async () => (await saved.read()).queueEdit?.text)
    .toBe('Guide only this running reply');
  await pad.getByRole('button', { name: 'Steer now', exact: true }).click();
  await expect(pad).toHaveCount(0);
  expect(steering).toEqual([{ text: 'Guide only this running reply', wasHeld: true }]);
  await expect(list.getByRole('listitem')).toHaveCount(1);
});
