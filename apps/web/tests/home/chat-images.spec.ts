import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chatImageIds, mirrorPage, type MirrorState } from '@dock/shared';

async function screenshot(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(512, 320);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = Math.random() * 255;
      pixels.data[i + 1] = Math.random() * 255;
      pixels.data[i + 2] = Math.random() * 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    context.fillStyle = 'white';
    context.fillRect(20, 80, 470, 140);
    context.fillStyle = '#20242f';
    context.font = '24px sans-serif';
    context.fillText('Phone screenshot test', 40, 155);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const buffer = Buffer.from(base64, 'base64');
  expect(buffer.length).toBeGreaterThan(128 * 1024);
  return { name: 'phone-screenshot.png', mimeType: 'image/png', buffer };
}
async function pick(page: Page) {
  const file = await screenshot(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
  await (await chooser).setFiles(file);
}
async function visiblePreview(page: Page) {
  const image = page.getByRole('img', { name: 'Attached screenshot 1' });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(512);
  const previews = page.getByLabel('Attached screenshots');
  expect(await previews.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await previews.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  return image;
}

test('a manager accepts a screenshot-only message and restores attached drafts after reload', async ({
  page,
  baseURL,
}, info) => {
  const created = await page.request.post('/api/projects', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), name: 'Screenshot ' + randomUUID().slice(0, 8), provider: 'codex' },
  });
  expect(created.ok()).toBe(true);
  const { managerId } = await created.json();
  await page.goto(`/#/chat/${managerId}`);
  const composer = page.locator('.composer');
  const input = composer.getByRole('textbox');
  await expect(page.getByRole('button', { name: 'Attach screenshot' })).toBeEnabled();
  await pick(page);
  await visiblePreview(page);
  await expect(input).toHaveValue('');
  await input.fill('Look here \n');
  const typed = await input.inputValue();
  // WebKit's editable control preserves the space before a newline as NBSP.
  expect(typed.replace(/\u00a0/g, ' ')).toBe('Look here \n');
  await page.reload();
  await visiblePreview(page);
  await expect(input).toHaveValue(typed);
  await input.fill('');
  const send = composer.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  await expect(send).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('manager-screenshot.png') });
  const delivered = page.waitForResponse((response) =>
    response.url().endsWith(`/agents/${managerId}/messages`),
  );
  await send.click();
  const response = await delivered;
  expect(response.ok()).toBe(true);
  expect(chatImageIds(response.request().postDataJSON().text)).toHaveLength(1);
  await expect(page.getByRole('img', { name: 'Attached screenshot 1' })).toHaveCount(0);
  await expect(page.locator('.conversation .chat-uploaded-image img')).toBeVisible();
});

test('a shared phone chat retries the same upload, preserves typing, and sends to the existing turn', async ({
  page,
}, info) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Existing editor',
    title: 'Screenshot conversation',
    status: 'busy',
    message: '',
    canSteer: true,
    steerToken: 'existing-turn',
    paged: true,
    entries: [{ id: 'reply', role: 'assistant', text: 'Share the screenshot here.' }],
  };
  const { entries: _, ...summary } = state;
  await page.route('**/api/vscode/windows', (route) => route.fulfill({ json: [summary] }));
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  const sends: Record<string, unknown>[] = [];
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, (route) => {
    sends.push(route.request().postDataJSON());
    return route.fulfill({ json: { state: 'sent', message: 'Sent' } });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent('codex:' + state.threadId)}`);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill('This is the problem. ');
  const attempts: string[] = [];
  await page.route('**/api/chat-images', (route) => {
    attempts.push(route.request().postDataJSON().key);
    return attempts.length === 1 ? route.abort('failed') : route.continue();
  });
  await pick(page);
  await expect(page.getByRole('button', { name: 'Retry upload' })).toBeVisible();
  await expect(input).toHaveValue('This is the problem. ');
  await page.getByRole('button', { name: 'Retry upload' }).click();
  await visiblePreview(page);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  await page.reload();
  await visiblePreview(page);
  await expect(input).toHaveValue('This is the problem. ');
  for (const zoom of [1, 1.5, 2]) {
    await page
      .locator('.mirror-compose-tools')
      .evaluate((el, zoom) => (el.style.zoom = String(zoom)), zoom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  }
  await page.locator('.mirror-compose-tools').evaluate((el) => (el.style.zoom = ''));
  await page.screenshot({ path: info.outputPath('shared-screenshot.png') });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ threadId: state.threadId, expectedTurnId: 'existing-turn' });
  expect(chatImageIds(String(sends[0].text))).toHaveLength(1);
  await expect(page.getByRole('img', { name: 'Attached screenshot 1' })).toHaveCount(0);
});
