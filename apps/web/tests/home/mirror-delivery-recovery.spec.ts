import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mirrorPage, mirrorWindowSchema, type MirrorSend, type MirrorState } from '@dock/shared';

async function fixture(page: Page) {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Disposable editor',
    title: 'Delivery recovery fixture',
    status: 'idle',
    message: '',
    entries: [{ id: 'saved-reply', role: 'assistant', text: 'The saved reply stays readable.' }],
    nativeRequests: [],
    nativeRequestCount: 0,
    nativeRequestsUnavailable: false,
  };
  let sendMode: 'lost' | 'sent' | 'refused' | 'failed' | 'interrupted' = 'lost';
  let receiptState: 'missing' | 'recorded' | undefined = 'missing';
  let checkStatus = 200;
  let holdSend = false;
  let releaseSend: (() => void) | undefined;
  const sends: MirrorSend[] = [];
  const checks: string[] = [];
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [mirrorWindowSchema.parse(state)] }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}/questions`, (route) =>
    route.fulfill({
      json: {
        windowId: state.windowId,
        provider: state.provider,
        threadId: state.threadId,
        status: state.status,
        message: '',
        nativeRequests: [],
        nativeRequestCount: 0,
      },
    }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, async (route) => {
    sends.push(route.request().postDataJSON() as MirrorSend);
    if (holdSend)
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    if (sendMode === 'lost') return route.abort();
    if (sendMode === 'refused')
      return route.fulfill({
        status: 409,
        json: { error: 'The original turn has ended.', code: 'STALE_TURN' },
      });
    if (sendMode === 'failed')
      return route.fulfill({ status: 503, json: { error: 'Fixture service interrupted.' } });
    if (sendMode === 'interrupted')
      return route.fulfill({
        status: 403,
        contentType: 'text/html',
        body: 'Fixture proxy interruption.',
      });
    return route.fulfill({ json: { state: 'sent', message: 'Original message accepted.' } });
  });
  await page.route('**/api/vscode/deliveries/*', (route) => {
    checks.push(route.request().url());
    return checkStatus !== 200
      ? route.fulfill({ status: checkStatus, json: { error: 'Fixture receipt read unavailable.' } })
      : route.fulfill({
          json: {
            state: 'uncertain',
            receiptState,
            message:
              receiptState === 'missing'
                ? 'This computer has no recorded receipt for the original message.'
                : 'The original request is recorded, but native acceptance is not confirmed.',
          },
        });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  await expect(page.locator('.mirror-header')).toContainText('Connected');
  return {
    state,
    sends,
    checks,
    sendMode: (mode: typeof sendMode) => {
      sendMode = mode;
    },
    receiptState: (value: typeof receiptState) => {
      receiptState = value;
    },
    checkStatus: (value: number) => {
      checkStatus = value;
    },
    holdSend: () => {
      holdSend = true;
    },
    releaseSend: () => {
      holdSend = false;
      releaseSend?.();
    },
    draftKey: `dock:mirror:local:${state.threadId}`,
  };
}
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Codex', exact: true });
const delivery = (page: Page) =>
  page.getByRole('dialog', { name: 'Message delivery', exact: true });
async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `../../data/screenshots/editor-delivery/${test.info().project.name}-${name}.png`,
  });
}

test('missing receipt enables only explicit exact original retry after reload while edited draft stays separate', async ({
  page,
}) => {
  const data = await fixture(page);
  const original = 'Original fixture question 🧪 café 漢字\nKeep its Unicode bytes.';
  const edited = 'A different later draft; do not send this on retry.';
  await composer(page).fill(original);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  expect(data.sends).toHaveLength(1);
  await composer(page).fill(edited);
  await page.reload();
  await expect(composer(page)).toHaveValue(edited);
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toBeEnabled();
  expect(data.sends).toHaveLength(1);
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  await expect(delivery(page)).toContainText('no recorded receipt');
  await delivery(page).getByText('Original message', { exact: true }).click();
  await expect(delivery(page).locator('pre')).toHaveText(original);
  await expect(delivery(page)).toContainText('A retry never sends the edited draft');
  data.sendMode('sent');
  await screenshot(page, 'missing');
  await delivery(page).getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect(delivery(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toHaveCount(0);
  expect(data.sends).toHaveLength(2);
  expect(data.sends[1]).toEqual(data.sends[0]);
  expect(data.sends[1]!.text).toBe(original);
  expect(data.checks).toHaveLength(1);
  expect(data.checks[0]).toContain(data.sends[0]!.key);
  await expect(composer(page)).toHaveValue(edited);
  await page.reload();
  await expect(composer(page)).toHaveValue(edited);
  expect(data.sends).toHaveLength(2);
});

test('recorded uncertain or older receipt offers read-only inspection without retry and explicit browser-only clearance', async ({
  page,
}) => {
  const data = await fixture(page);
  data.receiptState('recorded');
  await composer(page).fill('The original retained fixture message.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review delivery', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review delivery', exact: true }).click();
  await expect(delivery(page)).toContainText('recorded the original request');
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toHaveCount(0);
  await expect(
    delivery(page).getByRole('button', { name: 'Clear browser reminder', exact: true }),
  ).toBeDisabled();
  data.checkStatus(403);
  await delivery(page).getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(delivery(page)).toContainText('Delivery not confirmed');
  await expect(delivery(page)).toBeVisible();
  // A read refusal does not establish anything about the earlier POST.
  expect(data.sends).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeVisible();
  data.checkStatus(200);
  data.receiptState(undefined);
  await delivery(page).getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(delivery(page)).toContainText('older or unavailable connection');
  await expect(page.getByRole('button', { name: 'Retry message', exact: true })).toHaveCount(0);
  await screenshot(page, 'recorded');
  await delivery(page)
    .getByRole('checkbox', { name: 'I inspected the original conversation.', exact: true })
    .check();
  await delivery(page).getByRole('button', { name: 'Clear browser reminder', exact: true }).click();
  await expect(delivery(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toHaveCount(0);
  await expect(composer(page)).toHaveValue('The original retained fixture message.');
  expect(data.sends).toHaveLength(1);
  const saved = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)!),
    data.draftKey,
  );
  expect(saved.pending).toBeNull();
});

test('definite POST refusal preserves draft and releases pending while service failure remains uncertain', async ({
  page,
}) => {
  const data = await fixture(page);
  data.sendMode('refused');
  data.holdSend();
  await composer(page).fill('The original refused message 🧪.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => data.sends.length).toBe(1);
  const draft = 'Keep this edited draft after refusal 🧪.';
  await composer(page).fill(draft);
  data.releaseSend();
  await expect(page.locator('.mirror-delivery-status')).toContainText(
    'The original turn has ended.',
  );
  await expect(composer(page)).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.reload();
  await expect(composer(page)).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  data.sendMode('failed');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await expect(composer(page)).toHaveValue(draft);
  expect(data.sends).toHaveLength(2);
  expect(data.sends[1]!.key).not.toBe(data.sends[0]!.key);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  expect(data.sends).toHaveLength(2);
  await screenshot(page, 'failure');
});

test('interrupted non-JSON 4xx keeps original receipt and draft across reload', async ({
  page,
}) => {
  const data = await fixture(page);
  data.sendMode('interrupted');
  const draft = 'Preserve the interrupted fixture intent.';
  await composer(page).fill(draft);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await expect(composer(page)).toHaveValue(draft);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  await expect(composer(page)).toHaveValue(draft);
  expect(data.sends).toHaveLength(1);
  expect(data.checks).toEqual([]);
});
