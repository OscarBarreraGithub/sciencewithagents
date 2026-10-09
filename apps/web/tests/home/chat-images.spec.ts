import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chatFileIds, mirrorPage, type MirrorState } from '@dock/shared';

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
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await chooser).setFiles(file);
}
async function visiblePreview(page: Page) {
  const image = page.getByRole('img', { name: 'Attached image phone-screenshot.png' });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(512);
  const previews = page.getByLabel('Attached files');
  expect(await previews.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await previews.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  return image;
}

test('general PDF/text attachments survive Notepad and reload, expose downloads and reach the manager message', async ({
  page,
  baseURL,
}, info) => {
  const created = await page.request.post('/api/projects', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), name: 'Files ' + randomUUID().slice(0, 8), provider: 'codex' },
  });
  expect(created.ok()).toBe(true);
  const { managerId } = await created.json();
  await page.goto(`/#/chat/${managerId}`);
  const composer = page.locator('.composer');
  const input = composer.getByRole('textbox');
  await input.fill('Read these files. ');
  // WebKit can insert a non-breaking trailing space through native editing.
  // Preserve the exact browser value across composer/notepad transitions.
  const originalText = await input.inputValue();
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const pad = page.getByRole('dialog');
  const pick = async (name: string, mimeType: string, buffer: Buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await pad.getByRole('button', { name: 'Attach files', exact: true }).click();
    await (await chooser).setFiles({ name, mimeType, buffer });
    await expect(pad.getByRole('link', { name, exact: true })).toBeVisible();
  };
  await pick(
    'paper.pdf',
    'application/pdf',
    Buffer.from('%PDF-1.4\nPrivate PDF fixture only.\n%%EOF\n'),
  );
  await pick('research.tex', 'text/plain', Buffer.from('\\section{Research fixture}\nHello α.\n'));
  await expect(pad.getByText('PDF ·', { exact: false })).toBeVisible();
  await expect(pad.getByText('Text ·', { exact: false })).toBeVisible();
  const area = pad.getByRole('textbox');
  await expect(area).toHaveValue(originalText);
  await area.fill('Read the full files. ');
  const revisedText = await area.inputValue();
  const downloaded = await page.request.get(
    (await pad
      .getByRole('link', { name: 'research.tex', exact: true })
      .getAttribute('href')) as string,
  );
  expect(downloaded.ok()).toBe(true);
  expect((await downloaded.body()).toString()).toContain('Research fixture');
  await expect(pad.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('files-notepad.png') });
  await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(composer.getByRole('link', { name: 'paper.pdf', exact: true })).toBeVisible();
  await page.reload();
  await expect(composer.getByRole('link', { name: 'research.tex', exact: true })).toBeVisible();
  await expect(input).toHaveValue(revisedText);
  const delivered = page.waitForResponse((response) =>
    response.url().endsWith(`/agents/${managerId}/messages`),
  );
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await delivered;
  expect(response.ok()).toBe(true);
  expect(chatFileIds(response.request().postDataJSON().text)).toHaveLength(2);
  await expect(composer.getByRole('link', { name: 'research.tex', exact: true })).toHaveCount(0);
  await expect(
    page.locator('.conversation').getByRole('link', { name: 'research.tex', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('selected-computer file upload retries from Notepad with the same key and keeps later typing', async ({
  page,
  baseURL,
}) => {
  const host = randomUUID();
  const prefix = `/api/hosts/${host}/proxy`;
  await page.addInitScript((host) => localStorage.setItem('dock:host', host), host);
  const urls: string[] = [],
    keys: string[] = [];
  await page.route(`**${prefix}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === prefix + '/events')
      return route.fulfill({ contentType: 'text/event-stream', body: ': private fixture\n\n' });
    if (url.pathname.includes('/chat-files')) urls.push(url.pathname);
    if (url.pathname === prefix + '/chat-files' && route.request().method() === 'POST') {
      keys.push(route.request().postDataJSON().key);
      if (keys.length === 1) return route.abort('failed');
    }
    url.pathname = '/api' + url.pathname.slice(prefix.length);
    return route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  const created = await page.request.post('/api/projects', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), name: 'Selected file fixture', provider: 'codex' },
  });
  const { managerId } = await created.json();
  await page.goto(`/#/chat/${managerId}`);
  const input = page.locator('.composer').getByRole('textbox');
  await input.fill('Original typing. ');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'selected.tex',
    mimeType: 'text/plain',
    buffer: Buffer.from('\\section{Selected computer fixture}\n'),
  });
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const pad = page.getByRole('dialog');
  await pad.getByRole('textbox').fill('Later typing is kept. ');
  await pad.getByRole('button', { name: 'Retry upload', exact: true }).click();
  const link = pad.getByRole('link', { name: 'selected.tex', exact: true });
  await expect(link).toBeVisible();
  await expect(pad.getByRole('textbox')).toHaveValue('Later typing is kept. ');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const href = await link.getAttribute('href');
  expect(href).toContain(prefix + '/chat-files/');
  const content = await page.evaluate(async (href) => (await fetch(href!)).text(), href);
  expect(content).toContain('Selected computer fixture');
  expect(urls.length).toBeGreaterThan(3);
  expect(urls.every((url) => url.startsWith(prefix + '/chat-files'))).toBe(true);
});

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
  await expect(page.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  await pick(page);
  await visiblePreview(page);
  await expect(
    composer.getByText('1 file attached · up to 4, 8 MB each', { exact: true }),
  ).toBeVisible();
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
  expect(chatFileIds(response.request().postDataJSON().text)).toHaveLength(1);
  // The delivered chat card uses the same image alt text as the draft preview.
  // Check the acknowledged conversation first, so a successful render cannot look
  // like an uncleared composer attachment.
  const deliveredImage = page
    .locator('.conversation .chat-file-card')
    .getByRole('img', { name: 'Attached image phone-screenshot.png', exact: true });
  await expect(deliveredImage).toBeVisible();
  await expect(
    composer.getByRole('img', { name: 'Attached image phone-screenshot.png' }),
  ).toHaveCount(0);
  await expect(input).toHaveValue('');
  await page.reload();
  await expect(deliveredImage).toBeVisible();
  await expect(
    composer.getByRole('img', { name: 'Attached image phone-screenshot.png' }),
  ).toHaveCount(0);
  await expect(input).toHaveValue('');
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
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [summary] }),
  );
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
  await page.route('**/api/chat-files', (route) => {
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
  expect(chatFileIds(String(sends[0].text))).toHaveLength(1);
  await expect(
    page
      .locator('.mirror-composer')
      .getByRole('img', { name: 'Attached image phone-screenshot.png' }),
  ).toHaveCount(0);
});

test('a remote shared chat preserves saved screenshots for removal and sends text without uploading', async ({
  page,
}, info) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Remote editor',
    title: 'Remote screenshot limit',
    status: 'idle',
    message: '',
    paged: true,
    entries: [{ id: 'reply', role: 'assistant', text: 'Remote chat is available.' }],
  };
  let remote = false;
  const current = () => ({ ...state, ...(remote ? { canAttachImages: false } : {}) });
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) => {
    const { entries: _, ...summary } = current();
    return route.fulfill({ json: [summary] });
  });
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(current()) }),
  );
  const sends: Record<string, unknown>[] = [];
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, (route) => {
    sends.push(route.request().postDataJSON());
    return route.fulfill({ json: { state: 'sent', message: 'Sent' } });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent('codex:' + state.threadId)}`);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  await input.fill('Saved draft');
  await pick(page);
  await visiblePreview(page);
  remote = true;
  await page.reload();
  await visiblePreview(page);
  await expect(input).toHaveValue('Saved draft');
  await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Remote attachments are unavailable.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove phone-screenshot.png' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('remote-screenshot-limit.png') });
  await page.getByRole('button', { name: 'Remove phone-screenshot.png' }).click();
  await expect(
    page
      .locator('.mirror-composer')
      .getByRole('img', { name: 'Attached image phone-screenshot.png' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ text: 'Saved draft', threadId: state.threadId });
  expect(chatFileIds(String(sends[0].text))).toEqual([]);
});
