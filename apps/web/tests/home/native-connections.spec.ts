import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  NativeConnectionAttachment,
  NativeConnectionSendReceipt,
  NativeConnectionsView,
} from '@dock/shared';

const now = new Date().toISOString();
function connections(): NativeConnectionsView {
  const sourceId = randomUUID();
  return {
    observedAt: now,
    sources: [
      {
        id: sourceId,
        label: 'Research laptop',
        kind: 'tmux',
        location: 'ssh',
        state: 'available',
        message: 'Existing native terminal. No local provider setup needed.',
      },
      {
        id: randomUUID(),
        label: 'Old native version',
        kind: 'herdr',
        location: 'local',
        state: 'unsupported',
        message: 'Safe generation identity unavailable; observation only.',
      },
      {
        id: randomUUID(),
        label: 'SSH unavailable',
        kind: 'tmux',
        location: 'ssh',
        state: 'unavailable',
        message: 'Noninteractive SSH authentication unavailable. Sign in in your own terminal.',
      },
    ],
    targets: [
      {
        id: randomUUID(),
        sourceId,
        label: 'Existing analysis session',
        kind: 'tmux',
        nativeStatus: 'unknown',
        canObserve: true,
        canControl: true,
        controlPolicy: 'shared',
        controller: 'unknown',
      },
    ],
    attachments: [],
  };
}
async function controlsReadable(page: Page, selector: string) {
  const values = await page.locator(selector).evaluateAll((buttons) =>
    buttons
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => ({
        font: parseFloat(getComputedStyle(element).fontSize),
        height: element.getBoundingClientRect().height,
      })),
  );
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value.font).toBeGreaterThanOrEqual(16);
    expect(value.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function terminal(page: Page, disconnected: () => void, connected: () => void) {
  const input: unknown[] = [];
  await page.routeWebSocket('**/api/native-connections/attachments/*/socket', (socket) => {
    connected();
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.send(JSON.stringify({ type: 'output', data: 'Native program prompt\r\n' }));
    socket.onMessage((value) => input.push(JSON.parse(value.toString())));
    socket.onClose(disconnected);
  });
  return input;
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('first-run native Connect works without local providers, defaults to Observe and preserves external lifetime on Back', async ({
  page,
}, info) => {
  const view = connections();
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...snapshot, projects: [], agents: [], tasks: [] } }),
  );
  await page.route('**/api/setup', (route) =>
    route.fulfill({ status: 503, json: { error: 'No local provider CLI or account configured.' } }),
  );
  await page.route('**/api/setup/check', (route) =>
    route.fulfill({ status: 503, json: { error: 'No local provider CLI or account configured.' } }),
  );
  let modelReads = 0;
  await page.route('**/api/models?*', (route) => {
    modelReads++;
    return route.fulfill({ status: 503, json: { error: 'No models on this computer.' } });
  });
  let fail = true;
  const writes: unknown[] = [];
  let attachment: NativeConnectionAttachment;
  await page.route('**/api/native-connections', (route) =>
    route.fulfill(
      fail ? { status: 503, json: { error: 'Session discovery unavailable.' } } : { json: view },
    ),
  );
  await page.route('**/api/native-connections/attach', (route) => {
    const input = route.request().postDataJSON();
    writes.push(input);
    attachment = {
      id: randomUUID(),
      targetId: input.targetId,
      mode: input.mode,
      status: 'connecting',
      message: 'Observing external native session.',
    };
    view.attachments.push(attachment);
    return route.fulfill({ json: attachment });
  });
  await page.route('**/api/native-connections/attachments/*', (route) =>
    route.fulfill({ json: attachment }),
  );
  const input = await terminal(
    page,
    () => {
      if (attachment) attachment.status = 'detached';
    },
    () => {
      attachment.status = 'connected';
    },
  );
  await page.goto('/#/welcome');
  await page.getByRole('button', { name: 'Connect native session', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Connect a native session' });
  await expect(picker).toContainText('Session discovery unavailable.');
  expect(writes).toHaveLength(0);
  fail = false;
  await picker.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(picker).toContainText('Safe generation identity unavailable');
  await expect(picker).toContainText('Noninteractive SSH authentication unavailable');
  await controlsReadable(page, '.native-connections-dialog button');
  await picker.getByRole('button', { name: 'Observe', exact: true }).click();
  const pane = page.locator('.native-connection-pane');
  await expect(pane).toContainText('Observing · input disabled');
  await expect(pane.locator('.native-connection-draft')).toHaveCount(0);
  await pane.locator('.xterm-helper-textarea').press('x');
  await expect(pane.getByRole('button', { name: /Send|saved prompts/ })).toHaveCount(0);
  expect(writes).toEqual([
    { key: (writes[0] as { key: string }).key, targetId: view.targets[0]!.id, mode: 'observe' },
  ]);
  expect(input.filter((value) => (value as { type: string }).type === 'input')).toEqual([]);
  await page.screenshot({ path: `../../data/native-ui/${info.project.name}-observe.png` });
  await pane.getByRole('link', { name: 'All chats', exact: true }).click();
  await expect(page).toHaveURL(/#\/chats$/);
  await expect.poll(() => attachment.status).toBe('detached');
  await page.reload();
  await expect(
    page.getByRole('link', { name: /Existing analysis session.*External terminal/ }),
  ).toBeVisible();
  expect(modelReads).toBe(0);
  expect(writes).toHaveLength(1); // Reads and reloads never attach, launch, take over or stop.
});

test('owner saved pane delivery survives lost reply, draft Back/reload and exact read-only recovery without resend', async ({
  page,
}, info) => {
  const view = connections();
  const target = view.targets[0]!;
  const attachment: NativeConnectionAttachment = {
    id: randomUUID(),
    targetId: target.id,
    mode: 'control',
    status: 'connecting',
    message: 'Owner control.',
    inputToken: randomUUID(),
  };
  view.attachments.push(attachment);
  const sends: unknown[] = [];
  const detaches: unknown[] = [];
  let saved!: NativeConnectionSendReceipt;
  let receiptReads = 0;
  let loseDetach = true;
  await page.route('**/api/native-connections', (route) => route.fulfill({ json: view }));
  await page.route(`**/api/native-connections/attachments/${attachment.id}`, (route) =>
    route.fulfill({ json: attachment }),
  );
  await page.route(`**/api/native-connections/attachments/${attachment.id}/send`, (route) => {
    const input = route.request().postDataJSON();
    sends.push(input);
    saved = {
      ...input,
      attachmentId: attachment.id,
      targetId: target.id,
      state: 'delivered',
      message: 'Submitted to the native pane; no agent acceptance acknowledgement.',
      createdAt: now,
    };
    return route.abort('failed');
  });
  await page.route('**/api/native-connections/attachments/*/receipts/*', (route) => {
    receiptReads++;
    return route.fulfill({ json: saved });
  });
  await page.route('**/api/native-connections/targets/*/prompts*', (route) => {
    const { text, inputToken: _token, ...metadata } = saved;
    return route.fulfill({
      json: {
        items: [{ ...metadata, textPreview: text, textLength: text.length }],
        nextCursor: null,
      },
    });
  });
  await page.route(`**/api/native-connections/attachments/${attachment.id}/detach`, (route) => {
    detaches.push(route.request().postDataJSON());
    attachment.status = 'detached';
    if (loseDetach) {
      loseDetach = false;
      return route.abort('failed');
    }
    return route.fulfill({ json: attachment });
  });
  await terminal(
    page,
    () => {
      attachment.status = 'detached';
    },
    () => {
      attachment.status = 'connected';
    },
  );
  await page.goto(`/#/chats/native/${attachment.id}`);
  const pane = page.locator('.native-connection-pane');
  await expect(pane).toContainText('Control connected');
  const draft = pane.getByRole('textbox', { name: 'Prompt to send and save' });
  await draft.fill('Original terminal prompt\nPreserve the exact delivery text.');
  await pane.getByRole('button', { name: 'Send and save prompt' }).click();
  await expect(pane).toContainText('Check the saved receipt');
  await expect(pane.getByLabel('Unresolved saved terminal prompt')).toHaveText(saved.text);
  expect(
    await pane
      .locator('label.native-connection-draft')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await draft.fill('A newer draft must survive the original receipt.');
  // Detach is an effect only while loaded/connected. Retained ended attachments
  // offer the exact saved check, rather than an unnecessary new detach.
  await pane.getByRole('button', { name: 'Detach', exact: true }).click();
  await expect(pane.getByRole('alert')).toContainText('Check the saved detach request');
  await pane.getByRole('link', { name: 'All chats' }).click();
  await page.getByRole('link', { name: /Existing analysis session.*External terminal/ }).click();
  await expect(draft).toHaveValue('A newer draft must survive the original receipt.');
  await page.reload();
  await expect(draft).toHaveValue('A newer draft must survive the original receipt.');
  await expect(pane.getByRole('button', { name: 'Check saved receipt' })).toBeVisible();
  await expect(pane.getByLabel('Unresolved saved terminal prompt')).toHaveText(saved.text);
  expect(sends).toHaveLength(1);
  expect(receiptReads).toBe(0);
  await pane.getByRole('button', { name: 'Check saved receipt' }).click();
  await expect(pane).toContainText('Delivered to terminal pane');
  await expect(draft).toHaveValue('A newer draft must survive the original receipt.');
  expect(sends).toHaveLength(1);
  expect(receiptReads).toBe(1);
  await pane.getByRole('button', { name: 'Your saved prompts' }).click();
  const history = page.getByRole('dialog', { name: 'Your saved prompts' });
  await expect(history).toContainText(
    'Raw terminal input and complete native chat history are not recorded',
  );
  await history.getByRole('button', { name: /View saved receipt/ }).click();
  const original = page.getByRole('dialog', { name: 'Saved terminal prompt' });
  await expect(original.locator('pre')).toHaveText(saved.text);
  await original.getByRole('button', { name: 'Close dialog' }).click();
  await controlsReadable(
    page,
    '.native-connection-pane button, .native-connection-pane a.secondary',
  );
  await page.screenshot({ path: `../../data/native-ui/${info.project.name}-saved-delivery.png` });
  await pane.getByRole('button', { name: 'Check saved detach', exact: true }).click();
  await expect(pane).toContainText('The native session continues where it started.');
  expect(detaches).toHaveLength(2);
  expect(detaches[0]).toEqual(detaches[1]);
  await expect(pane.getByRole('button', { name: 'Detach', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      (id) => localStorage.getItem(`dock:local:native-connection:detach:${id}`),
      attachment.id,
    ),
  ).toBeNull();
  expect(sends).toHaveLength(1);
});

test('New Connect refuses occupied control without takeover and recovers only an explicit original attachment after a lost reply', async ({
  page,
}) => {
  const view = connections();
  const target = view.targets[0]!;
  target.kind = 'herdr';
  target.controlPolicy = 'exclusive';
  target.controller = 'occupied';
  target.controllerLabel = 'Desktop owner';
  const observer: NativeConnectionAttachment = {
    id: randomUUID(),
    targetId: target.id,
    mode: 'observe',
    status: 'connected',
    message: 'Existing observer remains connected.',
  };
  view.attachments.push(observer);
  const requests: Record<string, unknown>[] = [];
  let attachment: NativeConnectionAttachment | undefined;
  let refused = false;
  await page.route('**/api/native-connections', (route) => route.fulfill({ json: view }));
  await page.route('**/api/native-connections/attach', (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    if (!refused) {
      refused = true;
      return route.fulfill({
        status: 409,
        json: {
          error: 'A native controller acquired the free slot. Existing observer was preserved.',
        },
      });
    }
    attachment ??= {
      id: randomUUID(),
      targetId: input.targetId,
      mode: input.mode,
      status: 'connecting',
      message: 'Reserved for explicit connection.',
      inputToken: randomUUID(),
    };
    if (requests.length === 2) {
      view.attachments.push(attachment);
      return route.abort('failed');
    }
    return route.fulfill({ json: attachment });
  });
  await page.route('**/api/native-connections/attachments/*', (route) =>
    route.fulfill({ json: attachment }),
  );
  await page.routeWebSocket('**/api/native-connections/attachments/*/socket', (socket) => {
    attachment!.status = 'unavailable';
    attachment!.inputToken = undefined;
    attachment!.message =
      'Safe native session generation could not be verified. Original session was left running.';
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.send(JSON.stringify({ type: 'error', message: 'Native attachment unavailable.' }));
    socket.close({ code: 1008, reason: 'Native attachment unavailable' });
  });
  await page.goto('/#/chats');
  const open = async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('button', { name: /Connect native session/ }).click();
  };
  await open();
  const picker = page.getByRole('dialog', { name: 'Connect a native session' });
  const control = picker.getByRole('button', { name: 'Request control', exact: true });
  await expect(control).toBeDisabled();
  await expect(picker).toContainText('Control is held by Desktop owner');
  expect(requests).toEqual([]);
  target.controller = 'unknown';
  await picker.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(control).toBeEnabled(); // Native free-acquire refuses occupancy atomically.
  await control.click();
  await expect(picker.getByText(/A native controller acquired the free slot/)).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Check original connection' })).toHaveCount(0);
  expect(observer.status).toBe('connected');
  await control.click();
  await expect(picker).toContainText('original connection request is retained');
  await page.reload();
  expect(requests).toHaveLength(2); // Reload never retries control or native input.
  await open();
  await picker.getByRole('button', { name: 'Check original connection' }).click();
  await expect(page.locator('.native-connection-pane')).toContainText(
    'Safe native session generation could not be verified',
  );
  await expect(page.getByRole('button', { name: 'Send and save prompt' })).toBeDisabled();
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[2]);
  for (const request of requests) expect(request).not.toHaveProperty('takeover');
  expect(observer.status).toBe('connected');
});

test('a browser save failure and definite first-send refusal keep the draft without an unresolved receipt, then owner retry uses a fresh connection', async ({
  page,
}) => {
  const view = connections();
  const first: NativeConnectionAttachment = {
    id: randomUUID(),
    targetId: view.targets[0]!.id,
    mode: 'control',
    status: 'connecting',
    message: 'Control reserved.',
    inputToken: randomUUID(),
  };
  let current = first;
  view.attachments.push(first);
  const sends: Record<string, unknown>[] = [];
  let handedOff = 0;
  let receiptReads = 0;
  let release!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = true;
  await page.route('**/api/native-connections', (route) => route.fulfill({ json: view }));
  await page.route('**/api/native-connections/attach', (route) => {
    const input = route.request().postDataJSON();
    current = {
      id: randomUUID(),
      targetId: input.targetId,
      mode: input.mode,
      status: 'connecting',
      message: 'Fresh explicit control attachment.',
      inputToken: randomUUID(),
    };
    view.attachments.push(current);
    return route.fulfill({ json: current });
  });
  await page.route('**/api/native-connections/attachments/*', async (route) => {
    if (waiting) {
      waiting = false;
      await firstRead;
    }
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: view.attachments.find((item) => item.id === id) });
  });
  await page.route('**/api/native-connections/attachments/*/receipts/*', (route) => {
    receiptReads++;
    return route.fulfill({
      status: 404,
      json: { error: 'No receipt exists for the refused input.' },
    });
  });
  await page.route('**/api/native-connections/attachments/*/send', (route) => {
    const input = route.request().postDataJSON();
    sends.push(input);
    if (sends.length === 1)
      return route.fulfill({
        status: 409,
        json: { error: 'The saved input token was refused before any native handoff or receipt.' },
      });
    handedOff++;
    return route.fulfill({
      json: {
        ...input,
        attachmentId: current.id,
        targetId: current.targetId,
        state: 'delivered',
        message: 'Submitted to the native pane only.',
        createdAt: now,
      },
    });
  });
  await terminal(
    page,
    () => {
      current.status = 'detached';
    },
    () => {
      current.status = 'connected';
    },
  );
  await page.goto(`/#/chats/native/${first.id}`);
  const pane = page.locator('.native-connection-pane');
  await expect(pane.getByRole('button', { name: 'Detach', exact: true })).toBeDisabled();
  release();
  await expect(pane).toContainText('Control connected');
  const draft = pane.getByRole('textbox', { name: 'Prompt to send and save' });
  const text = 'Retain this explicit owner prompt\nNo native handoff on refusal.';
  await draft.fill(text);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let blocked = true;
    Storage.prototype.setItem = function (key, value) {
      if (blocked && key.includes(':native-connection:send:'))
        throw new DOMException(
          'This browser could not save the prompt intent.',
          'QuotaExceededError',
        );
      return original.call(this, key, value);
    };
    Object.defineProperty(window, 'allowNativePromptSave', {
      value: () => {
        blocked = false;
      },
    });
  });
  await pane.getByRole('button', { name: 'Send and save prompt' }).click();
  await expect(pane.getByRole('status').filter({ hasText: 'Not sent' })).toContainText(
    'could not save the prompt intent',
  );
  await expect(pane.getByRole('button', { name: 'Check saved receipt' })).toHaveCount(0);
  await expect(draft).toHaveValue(text);
  expect(sends).toEqual([]);
  expect(handedOff).toBe(0);
  await page.evaluate(() =>
    (window as unknown as { allowNativePromptSave: () => void }).allowNativePromptSave(),
  );
  await pane.getByRole('button', { name: 'Send and save prompt' }).click();
  await expect(pane.getByRole('status').filter({ hasText: 'Not sent' })).toContainText(
    'before any native handoff or receipt',
  );
  await expect(pane.getByRole('button', { name: 'Check saved receipt' })).toHaveCount(0);
  await expect(draft).toHaveValue(text);
  expect(
    await page.evaluate(
      (id) => localStorage.getItem(`dock:local:native-connection:send:${id}`),
      first.id,
    ),
  ).toBeNull();
  expect(sends).toHaveLength(1);
  expect(handedOff).toBe(0);
  await page.reload();
  await expect(draft).toHaveValue(text);
  await expect(pane.getByRole('button', { name: 'Check saved receipt' })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Detach', exact: true })).toBeDisabled();
  expect(sends).toHaveLength(1);
  expect(receiptReads).toBe(0);
  // Reload closes the owned native client. A fresh explicit attachment, then
  // owner-operated typing, supplies new authority; the old input is never replayed.
  await pane.getByRole('button', { name: 'Connect a session' }).click();
  await page
    .getByRole('dialog', { name: 'Connect a native session' })
    .getByRole('button', { name: 'Request control', exact: true })
    .click();
  await expect(pane).toContainText('Control connected');
  await expect(draft).toHaveValue('');
  await draft.fill(text);
  await pane.getByRole('button', { name: 'Send and save prompt' }).click();
  await expect(pane).toContainText('Delivered to terminal pane');
  expect(sends).toHaveLength(2);
  expect(sends[1]!.key).not.toBe(sends[0]!.key);
  expect(sends[1]!.inputToken).not.toBe(sends[0]!.inputToken);
  expect(sends[1]!.text).toBe(text);
  expect(handedOff).toBe(1);
  expect(receiptReads).toBe(0);
});

test('an intermediary HTML 4xx retains the exact saved terminal prompt across reload and missing receipt inspection without replay', async ({
  page,
}) => {
  const view = connections();
  const attachment: NativeConnectionAttachment = {
    id: randomUUID(),
    targetId: view.targets[0]!.id,
    mode: 'control',
    status: 'connecting',
    message: 'Owner control.',
    inputToken: randomUUID(),
  };
  view.attachments.push(attachment);
  const sends: Record<string, unknown>[] = [];
  let saved!: NativeConnectionSendReceipt;
  let receiptReads = 0;
  await page.route('**/api/native-connections', (route) => route.fulfill({ json: view }));
  await page.route(`**/api/native-connections/attachments/${attachment.id}`, (route) =>
    route.fulfill({ json: attachment }),
  );
  await page.route(`**/api/native-connections/attachments/${attachment.id}/send`, (route) => {
    const input = route.request().postDataJSON();
    sends.push(input);
    saved = {
      ...input,
      attachmentId: attachment.id,
      targetId: attachment.targetId,
      state: 'delivered',
      message: 'Submitted to the native pane only.',
      createdAt: now,
    };
    // The server may have submitted the prompt before an intermediary replaced
    // the acknowledgement. This HTTP status cannot prove native refusal.
    return route.fulfill({
      status: 409,
      contentType: 'text/html',
      body: '<html><body>Intermediary connection interrupted</body></html>',
    });
  });
  await page.route('**/api/native-connections/attachments/*/receipts/*', (route) => {
    receiptReads++;
    if (receiptReads === 1)
      return route.fulfill({
        status: 404,
        json: { error: 'Original receipt temporarily unavailable.' },
      });
    return route.fulfill({ json: saved });
  });
  await terminal(
    page,
    () => {
      attachment.status = 'detached';
    },
    () => {
      attachment.status = 'connected';
    },
  );
  await page.goto(`/#/chats/native/${attachment.id}`);
  const pane = page.locator('.native-connection-pane');
  await expect(pane).toContainText('Control connected');
  const draft = pane.getByRole('textbox', { name: 'Prompt to send and save' });
  await draft.fill('Exact owner terminal input\nIntermediary reply is not a refusal.');
  await pane.getByRole('button', { name: 'Send and save prompt' }).click();
  await expect(pane.getByRole('alert')).toContainText('Check the saved receipt');
  await expect(pane.getByRole('status').filter({ hasText: 'Not sent' })).toHaveCount(0);
  await expect(pane.getByLabel('Unresolved saved terminal prompt')).toHaveText(saved.text);
  await expect(pane.getByRole('button', { name: 'Send and save prompt' })).toHaveCount(0);
  const storedInput = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`dock:local:native-connection:send:${id}`)!),
    attachment.id,
  );
  expect(storedInput).toEqual({ ...sends[0], attachmentId: attachment.id });
  await draft.fill('Newer owner draft remains separate.');
  await page.reload();
  await expect(pane.getByLabel('Unresolved saved terminal prompt')).toHaveText(saved.text);
  await expect(draft).toHaveValue('Newer owner draft remains separate.');
  expect(sends).toHaveLength(1);
  expect(receiptReads).toBe(0);
  await pane.getByRole('button', { name: 'Check saved receipt' }).click();
  await expect(pane.getByRole('alert')).toContainText('Nothing was resent');
  await expect(pane.getByLabel('Unresolved saved terminal prompt')).toHaveText(saved.text);
  expect(sends).toHaveLength(1);
  await pane.getByRole('button', { name: 'Check saved receipt' }).click();
  await expect(pane).toContainText('Delivered to terminal pane');
  await expect(draft).toHaveValue('Newer owner draft remains separate.');
  expect(sends).toHaveLength(1);
  expect(receiptReads).toBe(2);
  expect(
    await page.evaluate(
      (id) => localStorage.getItem(`dock:local:native-connection:send:${id}`),
      attachment.id,
    ),
  ).toBeNull();
});
