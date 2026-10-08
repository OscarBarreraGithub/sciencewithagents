import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mirrorPage, type MirrorState, type MirrorQueuedMessage } from '@dock/shared';

test('shared-chat tools keep one touch-sized row and remove the keyboard safe-area gap', async ({
  page,
}, info) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Compact composer',
    title: 'Working shared conversation',
    status: 'busy',
    message: '',
    canSteer: true,
    canQueue: true,
    steerToken: 'current-turn',
    stopToken: 'current-turn',
    paged: true,
    entries: [{ id: 'reply', role: 'assistant', text: 'The current reply remains readable.' }],
  };
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => {
    const { entries: _, ...window } = state;
    return route.fulfill({ json: [window] });
  });
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  const composer = page.locator('.mirror-composer');
  const tools = page.locator('.mirror-compose-tools');
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const stop = tools.getByRole('button', { name: 'Stop reply', exact: true });
  const notepad = tools.getByRole('button', { name: 'Open notepad', exact: true });
  await expect(stop).toBeVisible();
  const boxes = await tools.locator('button, select').evaluateAll((controls) =>
    controls
      .filter((control) => control.getClientRects().length)
      .map((control) => {
        const box = control.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
  );
  expect(boxes).toHaveLength(5);
  expect(
    Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y)),
  ).toBeLessThanOrEqual(1);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  if (page.viewportSize()!.width <= 459) {
    expect((await stop.boundingBox())!.width).toBe(44);
    expect((await notepad.boundingBox())!.width).toBe(44);
  }
  const toolsHeight = (await tools.boundingBox())!.height;
  await input.fill('Keep my draft.');
  const composerHeight = (await composer.boundingBox())!.height;
  await input.press('End');
  await input.press('!');
  await expect(input).toBeFocused();
  expect((await tools.boundingBox())!.height).toBe(toolsHeight);
  expect((await composer.boundingBox())!.height).toBe(composerHeight);
  // Routine draft persistence and provider refreshes keep the same writing geometry.
  state.status = 'idle';
  state.stopToken = undefined;
  await expect(stop).toHaveCount(0);
  expect((await tools.boundingBox())!.height).toBe(toolsHeight);
  expect((await composer.boundingBox())!.height).toBe(composerHeight);
  await expect(input).toBeFocused();
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: Math.min(420, innerHeight - 100) },
      offsetTop: { configurable: true, value: 12 },
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(composer).toHaveAttribute('data-keyboard', 'true');
  expect(await composer.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('6px');
  const bottomGap = await composer.evaluate((element) => {
    const bottom = element.getBoundingClientRect().bottom;
    const toolsBottom = element
      .querySelector('.mirror-compose-tools')!
      .getBoundingClientRect().bottom;
    return bottom - toolsBottom;
  });
  // The fixed one-line delivery receipt remains; no second safe area sits above the keyboard.
  expect(bottomGap).toBeLessThanOrEqual(32);
  await expect(input).toHaveValue('Keep my draft.!');
  await expect(input).toBeFocused();
  await page.screenshot({ path: info.outputPath('compact-shared-composer-keyboard.png') });
  await page.reload();
  await expect(input).toHaveValue('Keep my draft.!');
});

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
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [window] }),
  );
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
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [window] }),
  );
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
  // Closed, the queue is one summary row; the full list opens on demand.
  const summary = page.getByRole('button', { name: /Expand queue/ });
  await expect(summary).toContainText('12+ queued messages');
  await summary.click();
  const dialog = page.getByRole('dialog', { name: 'Queued messages', exact: true });
  const queue = dialog.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByRole('listitem')).toHaveCount(12);
  expect(await queue.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await queue.focus();
  await page.keyboard.press('End');
  await expect.poll(() => queue.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(queue.getByText('External queued message 12', { exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
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
  await expect(page.getByRole('button', { name: /Expand queue/ })).toContainText(
    '12+ queued messages',
  );
});

for (const queueReadError of ['unsupported', 'unavailable'] as const)
  for (const withAppRow of [false, true])
    test(`native queue ${queueReadError} is separate from ${withAppRow ? 'app-owned messages' : 'an empty app queue'}`, async ({
      page,
    }) => {
      const state: MirrorState = {
        windowId: randomUUID(),
        threadId: randomUUID(),
        provider: 'codex',
        source: withAppRow ? 'codex-daemon' : 'vscode',
        label: 'Queue recovery',
        title: 'Readable conversation',
        status: 'busy',
        message: '',
        canSteer: true,
        steerToken: 'current-turn',
        // Browser capability describes the app outbox, independently of native support.
        canQueue: true,
        queueReadError,
        entries: [{ id: 'reply', role: 'assistant', text: 'Saved reply remains readable.' }],
      };
      const { entries: _, queueReadError: _error, ...window } = state;
      await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
        route.fulfill({ json: [window] }),
      );
      await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
        route.fulfill({ json: mirrorPage(state) }),
      );
      let item: MirrorQueuedMessage = {
        id: randomUUID(),
        provider: 'codex',
        threadId: state.threadId!,
        text: 'App-owned follow-up remains editable.',
        status: 'queued',
        createdAt: new Date().toISOString(),
        queueRevision: 0,
        queueEdit: null,
        deliveryKey: null,
        message: 'Queued here.',
      };
      await page.route(/\/api\/vscode\/queued\?.*$/, (route) =>
        route.fulfill({ json: { items: withAppRow ? [item] : [] } }),
      );
      const actions: string[] = [];
      await page.route(`**/api/vscode/queued/${item.id}`, (route) => {
        if (route.request().method() === 'POST') {
          const input = route.request().postDataJSON();
          actions.push(input.action);
          item = {
            ...item,
            queueRevision: item.queueRevision + 1,
            queueEdit: { clientId: input.clientId, text: item.text, state: 'editing' },
          };
        }
        return route.fulfill({ json: item });
      });
      await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
      const label =
        queueReadError === 'unsupported' ? 'Native queue unsupported' : 'Native queue unreadable';
      const summary = page.getByRole('button', { name: /Expand queue/ });
      await expect(summary).toContainText(
        withAppRow ? `1 queued message · ${label.toLowerCase()}` : label,
      );
      await expect(page.getByText('Queue unavailable', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('native-queue-summary.png') });
      await summary.click();
      const details = page.getByRole('dialog', { name: 'Queued messages', exact: true });
      await expect(details.getByText(/Messages queued in this app still work/)).toBeVisible();
      await expect(
        details.getByText(
          queueReadError === 'unsupported'
            ? /does not expose its native queue/
            : /The native queue may still contain messages/,
        ),
      ).toBeVisible();
      if (withAppRow) {
        const row = details.getByRole('listitem').filter({ hasText: item.text });
        await expect(row.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
        await row.getByRole('button', { name: 'Edit', exact: true }).click();
        const edit = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
        await expect(edit.getByRole('textbox')).toHaveValue(item.text);
        await expect(
          edit.getByRole('button', { name: 'Save and queue', exact: true }),
        ).toBeEnabled();
        expect(actions).toEqual(['edit']);
        await edit.getByRole('button', { name: 'Minimize', exact: true }).click();
      }
      await details.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(page.getByText('Saved reply remains readable.', { exact: true })).toBeVisible();
      const field = page.getByRole('textbox', { name: 'Message Codex' });
      await expect(field).toBeEnabled();
      await field.fill('Retain this draft while reconnecting.');
      const timing = page.getByRole('combobox', { name: 'Send timing' });
      await expect(timing).toBeEnabled();
      await timing.selectOption('queue');
      await expect(
        page.getByRole('button', { name: 'Queue follow-up', exact: true }),
      ).toBeEnabled();
      await page.reload();
      await expect(field).toHaveValue('Retain this draft while reconnecting.');
      await expect(summary).toContainText(label.toLowerCase(), { ignoreCase: true });
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
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, async (route) => {
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
