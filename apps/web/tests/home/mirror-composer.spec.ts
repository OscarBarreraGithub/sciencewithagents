import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mirrorPage, type MirrorState } from '@dock/shared';

test('shared-chat drafts wrap and resize without a horizontal or premature scrollbar', async ({
  page,
}) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Composer check',
    title: 'Shared conversation',
    status: 'busy',
    message: '',
    canSteer: true,
    steerToken: 'current-turn',
    stopToken: 'current-turn',
    paged: true,
    entries: [{ id: 'reply', role: 'assistant', text: 'Working on your project.' }],
  };
  const { entries: _, ...window } = state;
  await page.route('**/api/vscode/windows', (route) => route.fulfill({ json: [window] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await expect(input).toBeVisible();
  const geometry = () =>
    input.evaluate((field) => {
      const style = getComputedStyle(field);
      return {
        horizontal: field.scrollWidth - field.clientWidth,
        vertical: field.scrollHeight - field.clientHeight,
        horizontalBar:
          field.offsetHeight -
          field.clientHeight -
          parseFloat(style.borderTopWidth) -
          parseFloat(style.borderBottomWidth),
        height: field.getBoundingClientRect().height,
        capped: Math.abs(field.offsetHeight - parseFloat(style.maxHeight)) <= 1,
      };
    });
  await expect.poll(async () => (await geometry()).horizontal).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await geometry()).vertical).toBeLessThanOrEqual(1);
  const emptyHeight = (await geometry()).height;
  await input.fill('Please check the results.');
  await expect.poll(async () => (await geometry()).vertical).toBeLessThanOrEqual(1);
  await input.fill('First line\nSecond line');
  await expect.poll(async () => (await geometry()).height).toBeGreaterThan(emptyHeight);
  await expect.poll(async () => (await geometry()).vertical).toBeLessThanOrEqual(1);
  await input.fill('A'.repeat(500));
  await expect.poll(async () => (await geometry()).horizontal).toBeLessThanOrEqual(1);
  await expect.poll(async () => (await geometry()).capped).toBe(true);
  await expect.poll(async () => (await geometry()).vertical).toBeGreaterThan(0);
  await input.fill('');
  // Scale the composer without changing the shell's synthetic viewport height.
  // WebKit's scrollWidth mixes scaled inner-editor units with CSS units here;
  // inspect the actual scrollbar gutter, not that misleading width difference.
  for (const zoom of [0.8, 1.25, 2, 1]) {
    await page
      .locator('.mirror-input-row')
      .evaluate((row, value) => (row.style.zoom = String(value)), zoom);
    await expect.poll(async () => (await geometry()).horizontalBar).toBeLessThanOrEqual(1);
    await expect(input).toBeInViewport();
  }
  await page.setViewportSize({ width: 1000, height: 900 });
  const draft = 'Please review the figures and explain the results before making further changes.';
  await input.fill(draft);
  const wideHeight = (await geometry()).height;
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(async () => (await geometry()).height).toBeGreaterThan(wideHeight);
  await expect.poll(async () => (await geometry()).vertical).toBeLessThanOrEqual(1);
  await expect(input).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('wrapped-draft.png') });
  await input.fill('');
  await expect.poll(async () => (await geometry()).height).toBeLessThanOrEqual(emptyHeight + 1);
});

test('native queue is scrollable and sends the selected follow-up without steering', async ({
  page,
}) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Native queue',
    title: 'Queued conversation',
    status: 'busy',
    message: '',
    canSteer: true,
    steerToken: 'current-turn',
    canQueue: true,
    entries: [],
    queuedMessages: Array.from({ length: 12 }, (_, i) => ({
      id: `external-${i}`,
      text: `External queued message ${i + 1}`,
    })),
    queueHasMore: true,
  };
  const { entries: _, queuedMessages: _queue, queueHasMore: _more, ...window } = state;
  await page.route('**/api/vscode/windows', (route) => route.fulfill({ json: [window] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  const sent: Record<string, unknown>[] = [];
  let finish!: () => void;
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, async (route) => {
    sent.push(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return route.fulfill({
      json: { state: 'uncertain', message: 'Native delivery not confirmed.' },
    });
  });
  const checked: string[] = [];
  await page.route('**/api/vscode/deliveries/*', (route) => {
    checked.push(route.request().url());
    return route.fulfill({ json: { state: 'sent', message: 'Accepted into the native queue.' } });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue).toBeVisible();
  await expect(queue.getByRole('listitem')).toHaveCount(12);
  expect(await queue.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await queue.focus();
  await page.keyboard.press('End');
  await expect.poll(() => queue.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(queue.getByText('External queued message 12', { exact: true })).toBeInViewport();
  const field = page.getByRole('textbox', { name: 'Message Codex' });
  const beforeStatusChange = (await field.boundingBox())!.y;
  state.status = 'idle';
  await expect(page.getByRole('combobox', { name: 'Send timing' })).toBeDisabled();
  expect(Math.abs((await field.boundingBox())!.y - beforeStatusChange)).toBeLessThanOrEqual(1);
  await expect(
    page.getByText('Your message updates the current task.', { exact: false }),
  ).toHaveCount(0);
  state.status = 'busy';
  await expect(page.getByRole('combobox', { name: 'Send timing' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Send timing' }).selectOption('queue');
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Run this afterward.');
  await page.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  const writing = page.getByRole('textbox', { name: 'Message Codex' });
  await expect(writing).toBeEnabled();
  await writing.fill('My next unsent draft.');
  finish();
  await expect(page.getByRole('button', { name: 'Check delivery', exact: true })).toBeEnabled();
  expect(sent[0]).toMatchObject({ mode: 'queue', text: 'Run this afterward.' });
  expect(sent[0].expectedTurnId).toBeUndefined();
  await expect(writing).toHaveValue('My next unsent draft.');
  await page.reload();
  await expect(writing).toHaveValue('My next unsent draft.');
  await page.getByRole('button', { name: 'Check delivery', exact: true }).click();
  await expect(writing).toHaveValue('My next unsent draft.');
  expect(checked).toHaveLength(1);
  expect(checked[0]).toContain(String(sent[0].key));
  expect(sent).toHaveLength(1);
  await expect(page.getByRole('list', { name: 'Queued messages' })).toBeVisible();
});

test('unreadable queue is explicit while the chat and draft remain usable', async ({ page }) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Queue recovery',
    title: 'Readable conversation',
    status: 'busy',
    message: '',
    canSteer: true,
    steerToken: 'current-turn',
    canQueue: false,
    queueReadError: 'unavailable',
    entries: [{ id: 'reply', role: 'assistant', text: 'Saved reply remains readable.' }],
  };
  const { entries: _, queueReadError: _error, ...window } = state;
  await page.route('**/api/vscode/windows', (route) => route.fulfill({ json: [window] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  await expect(page.getByText('Queue unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText(/The queue may still contain messages/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(page.getByText('Saved reply remains readable.', { exact: true })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Message Codex' });
  await expect(field).toBeEnabled();
  await field.fill('Retain this draft while reconnecting.');
  await page.reload();
  await expect(field).toHaveValue('Retain this draft while reconnecting.');
  await expect(page.getByText('Queue unavailable', { exact: true })).toBeVisible();
});

test('shared-chat status follows the newest reading through failed, slow and lost refreshes', async ({
  page,
}) => {
  const busy: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Status check',
    title: 'Long shared conversation',
    status: 'busy',
    message: 'Same conversation as VS Code. Drafts stay separate.',
    canSteer: true,
    steerToken: 'turn-1',
    stopToken: 'turn-1',
    paged: true,
    entries: [{ id: 'reply', role: 'assistant', text: 'Still answering normally.' }],
  };
  const idle: MirrorState = {
    ...busy,
    status: 'idle',
    steerToken: undefined,
    stopToken: undefined,
  };
  const summary = ({ entries: _, ...window }: MirrorState) => window;
  const failed = { ...summary(idle), status: 'offline', message: 'VS Code is not responding.' };
  let phase: 'busy' | 'failed' | 'recovered' | 'gone' = 'busy';
  let slowListAt = 0;
  let slowListLanded = false;
  let recoveredAt = 0;
  const held: import('@playwright/test').Route[] = [];
  await page.route('**/api/vscode/windows', async (route) => {
    if (phase === 'gone') return route.fulfill({ json: [] });
    if (phase === 'busy') return route.fulfill({ json: [summary(busy)] });
    if (phase === 'failed') return route.fulfill({ json: [failed] });
    if (recoveredAt) return route.fulfill({ json: [summary(idle)] });
    // A list that began before the recovering read lands late with the older failure.
    slowListAt ||= Date.now();
    await new Promise((resolve) => setTimeout(resolve, 4000));
    slowListLanded = true;
    return route.fulfill({ json: [failed] });
  });
  await page.route(`**/api/vscode/windows/${busy.windowId}`, (route) => {
    // The native read behind the failed refresh is still outstanding on the editor.
    if (phase === 'failed') return void held.push(route);
    if (phase === 'recovered') {
      // Serve only a chat read that clearly started after the slow list did.
      if (!recoveredAt && (!slowListAt || Date.now() - slowListAt < 200)) return route.abort();
      recoveredAt ||= Date.now();
      return route.fulfill({ json: mirrorPage(idle) });
    }
    return route.fulfill({ json: mirrorPage(busy) });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${busy.threadId}`)}`);
  await expect(page.getByText('Still answering normally.', { exact: true })).toBeVisible();
  const draft = page.getByLabel('Message Codex');
  await draft.fill('How is it going?');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const stop = page.getByRole('button', { name: 'Stop reply', exact: true });
  await expect(send).toBeEnabled();
  await expect(stop).toBeVisible();

  // A failed native refresh is newer than the retained busy reading: no stale steer or stop.
  phase = 'failed';
  await expect(page.getByText('VS Code is not responding.', { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(stop).toHaveCount(0);
  await expect(draft).toHaveValue('How is it going?');

  // A chat read that starts after the failure wins, even over a slower list carrying it.
  phase = 'recovered';
  for (const route of held.splice(0)) await route.abort();
  await expect.poll(() => recoveredAt, { timeout: 8000 }).toBeGreaterThan(0);
  expect(slowListLanded).toBe(false);
  await expect(send).toBeEnabled({ timeout: 2000 });
  await expect(page.getByText('VS Code is not responding.', { exact: true })).toHaveCount(0);
  await expect.poll(() => slowListLanded, { timeout: 6000 }).toBe(true);
  await page.waitForTimeout(300);
  await expect(send).toBeEnabled();
  await expect(page.getByText('VS Code is not responding.', { exact: true })).toHaveCount(0);

  // A genuine disconnect removes the window from discovery; the draft stays.
  phase = 'gone';
  await expect(page.getByText(/^Offline\. Open VS Code/)).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(draft).toHaveValue('How is it going?');
});
