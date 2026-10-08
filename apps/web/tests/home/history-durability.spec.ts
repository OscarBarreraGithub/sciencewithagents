import { expect, test } from '@playwright/test';

async function manager(page: import('@playwright/test').Page) {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  return (
    snapshot.agents.find((agent: { name: string }) => agent.name === 'History beta manager') ??
    snapshot.agents.find((agent: { role: string }) => agent.role === 'manager')
  );
}

test('long managed history pages stay bounded and keep the last reply outside collapsed tools', async ({
  page,
}) => {
  const agent = await manager(page);
  const entries = Array.from({ length: 1205 }, (_, index) => ({
    id: crypto.randomUUID(),
    agentId: agent.id,
    runId: null,
    kind: index % 200 === 100 ? 'user' : index > 1170 && index < 1204 ? 'tool' : 'assistant',
    title: 'Saved reply',
    text: index === 1204 ? 'Final assistant reply 🧪' : `Retained entry ${index}`,
    status: 'complete',
    createdAt: '2026-10-01T10:00:00.000Z',
  }));
  await page.route(`**/api/agents/${agent.id}*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== `/api/agents/${agent.id}`) return route.continue();
    const response = await route.fetch();
    const before = url.searchParams.get('before');
    const end = before ? entries.findIndex((entry) => entry.id === before) : entries.length;
    await route.fulfill({
      json: {
        ...(await response.json()),
        entries: entries.slice(Math.max(0, end - 200), end),
        hasMore: end > 200,
      },
    });
  });
  await page.goto(`/#/chat/${agent.id}`);
  await expect(page.getByText('Final assistant reply 🧪', { exact: true })).toBeVisible();
  expect(await page.locator('.tool-group pre').count()).toBe(0);
  const composer = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
  const text = 'Unicode 🧪 café 漢字\nSecond line\n' + 'x'.repeat(2048);
  await composer.fill(text);
  await page.getByRole('button', { name: 'Your prompts', exact: true }).click();
  const prompts = page.getByRole('dialog', { name: 'Your prompts', exact: true });
  await prompts.getByRole('button', { name: 'Older prompts', exact: true }).click();
  await prompts.getByRole('button', { name: /Retained entry 900/ }).click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await expect(page.locator('.message')).toHaveCount(200);
    await expect(composer).toBeInViewport();
    await expect(composer).toHaveValue(text);
  }
  await page.getByRole('button', { name: 'Back to latest', exact: true }).click();
  await expect(page.getByText('Final assistant reply 🧪', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(text);
});

test('typing during a delayed autosave retains the latest notepad version and another device draft', async ({
  page,
  browser,
  baseURL,
}) => {
  const agent = await manager(page);
  const other = await browser.newContext({ baseURL });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving = false;
  await page.route(`**/api/workspace/*/drafts/${agent.id}`, async (route) => {
    if (route.request().method() !== 'POST' || saving) return route.continue();
    const response = await route.fetch();
    saving = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    const phone = await other.newPage();
    await phone.goto(`/#/chat/${agent.id}`);
    const phoneDraft = phone.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
    await phoneDraft.fill('Independent device draft 漢字');
    await expect(phone.locator('.composer')).toHaveClass(/draft-steady/);
    await page.goto(`/#/chat/${agent.id}`);
    const composer = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
    await composer.fill('Older autosave 🧪');
    await expect.poll(() => saving).toBe(true);
    await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
    const notepad = page.getByRole('dialog', { name: 'Write at length', exact: true });
    const latest = 'Latest text 🧪 café 漢字\n' + 'a'.repeat(2048);
    await notepad
      .getByRole('textbox', { name: `Long message to ${agent.name}`, exact: true })
      .fill(latest);
    await notepad.getByRole('button', { name: 'Minimize', exact: true }).click();
    release();
    await expect(page.locator('.composer')).toHaveClass(/draft-steady/);
    await page.reload();
    await expect(composer).toHaveValue(latest);
    await phone.reload();
    await expect(phoneDraft).toHaveValue('Independent device draft 漢字');
  } finally {
    release();
    await other.close();
  }
});

test('a delayed old receipt cannot discard a newer uncertain send or its latest draft', async ({
  page,
  baseURL,
}) => {
  const agent = await manager(page);
  const first = `First accepted message 🧪 ${crypto.randomUUID()}`;
  const second = `Second accepted message ${crypto.randomUUID()}\n漢字 ` + 'z'.repeat(1024);
  const third = 'Keep the newest unsent text 🧪\nAfter a lost response.';
  const accepted = { key: crypto.randomUUID(), text: first };
  expect(
    (
      await page.request.post(`/api/agents/${agent.id}/messages`, {
        data: accepted,
        headers: { Origin: baseURL! },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#/chat/${agent.id}`);
  const composer = page.getByRole('textbox', { name: `Message ${agent.name}`, exact: true });
  await expect(composer).toBeEnabled();
  await expect(page.locator('.composer')).toHaveClass(/draft-steady/);
  const storageKey = `dock:local:workspace:send:${agent.id}:pending`;
  await page.evaluate(
    ({ storageKey, accepted }) =>
      localStorage.setItem(storageKey, JSON.stringify({ ...accepted, steer: false })),
    { storageKey, accepted },
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldRead = false;
  await page.route(`**/api/agents/${agent.id}/receipts/${accepted.key}`, async (route) => {
    const response = await route.fetch();
    oldRead = true;
    await gate;
    await route.fulfill({ response });
  });
  const sends: { key: string; text: string }[] = [];
  await page.route(`**/api/agents/${agent.id}/messages`, async (route) => {
    const body = route.request().postDataJSON();
    sends.push(body);
    const response = await route.fetch();
    // The original key is idempotent: retrying it returns the existing receipt.
    if (body.key === accepted.key) return route.fulfill({ response });
    await route.fulfill({ status: 502, json: { error: 'Accepted; response lost' } });
  });
  try {
    await page.reload();
    await expect.poll(() => oldRead).toBe(true);
    await expect(composer).toBeEnabled();
    await composer.fill(second);
    // The unconfirmed earlier message is retried under its own key before new text is sent.
    await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(composer).toHaveValue(second);
    expect(sends.map(({ key, text }) => ({ key, text }))).toEqual([accepted]);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('response lost');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ text: second });
    expect(sends[1].key).not.toBe(accepted.key);
    await composer.fill(third);
    const oldResponse = page.waitForResponse(`**/api/agents/${agent.id}/receipts/${accepted.key}`);
    release();
    await oldResponse;
    await page.waitForTimeout(150);
    await expect
      .poll(async () =>
        page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.key, storageKey),
      )
      .toBe(sends[1].key);
    await page.reload();
    await expect(composer).toHaveValue(third);
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), storageKey))
      .toBeNull();
    expect(sends).toHaveLength(2);
    const detail = await (await page.request.get(`/api/agents/${agent.id}`)).json();
    expect(detail.runs.filter((run: { text: string }) => run.text === first)).toHaveLength(1);
    expect(detail.runs.filter((run: { text: string }) => run.text === second)).toHaveLength(1);
  } finally {
    release();
  }
});
