import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chatImageReference, mirrorPage, type MirrorState } from '@dock/shared';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const textFile = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
async function manager(page: Page, baseURL: string) {
  const created = await page.request.post('/api/projects', {
    headers: { origin: baseURL },
    data: { key: randomUUID(), name: 'Batch ' + randomUUID().slice(0, 8), provider: 'codex' },
  });
  expect(created.ok()).toBe(true);
  return (await created.json()).managerId as string;
}

test('a mixed batch keeps typing while uploading across managed Notepad and reload', async ({
  page,
  baseURL,
}, info) => {
  const id = await manager(page, baseURL!);
  const uploads: string[] = [],
    sends: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on('request', (request) => {
    if (request.url().endsWith(`/agents/${id}/messages`)) sends.push(request.url());
  });
  await page.route('**/api/chat-files', async (route) => {
    uploads.push(route.request().postDataJSON().name);
    if (uploads.length === 2) await held;
    await route.continue();
  });
  try {
    await page.goto(`/#/chat/${id}`);
    const composer = page.locator('.composer');
    const input = composer.getByRole('textbox');
    await input.fill('Before upload');
    const chooser = page.waitForEvent('filechooser');
    await composer.getByRole('button', { name: 'Attach files', exact: true }).click();
    const picked = await chooser;
    expect(picked.isMultiple()).toBe(true);
    await picked.setFiles([
      {
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\nBatch fixture\n%%EOF\n'),
      },
      textFile('notes.txt'),
      { name: 'plot.png', mimeType: 'image/png', buffer: png },
    ]);
    await expect.poll(() => uploads.length).toBe(2);
    // A late chooser event must explicitly reject a second selection, keeping this batch.
    await composer.getByLabel('Choose files').setInputFiles([textFile('late-selection.txt')]);
    await expect(composer.getByRole('alert')).toContainText(
      'Nothing from the new selection was uploaded',
    );
    await expect(composer.getByRole('link', { name: 'paper.pdf', exact: true })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await composer.getByRole('button', { name: 'Open notepad', exact: true }).click();
    const pad = page.getByRole('dialog');
    await pad.getByRole('textbox').fill('Typed during the batch');
    release();
    for (const name of ['paper.pdf', 'notes.txt', 'plot.png'])
      await expect(pad.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(pad.getByRole('textbox')).toHaveValue('Typed during the batch');
    await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(input).toHaveValue('Typed during the batch');
    await expect(composer.getByRole('button', { name: 'Send message' })).toBeEnabled();
    expect(uploads).toEqual(['paper.pdf', 'notes.txt', 'plot.png']);
    expect(sends).toEqual([]);
    await expect
      .poll(async () => {
        const draft = await page.evaluate(
          (id) => localStorage.getItem(`dock:local:workspace:draft:${id}`),
          id,
        );
        return (
          draft?.includes('Typed during the batch') && (draft.match(/swa-file:/g) ?? []).length
        );
      })
      .toBe(3);
    await page.reload();
    await expect(input).toHaveValue('Typed during the batch');
    await expect(composer.locator('.chat-file-card')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('batch-mixed-managed.png') });
  } finally {
    release();
  }
});

test('a selected-host partial batch retries only its unconfirmed file and remaining files from Notepad', async ({
  page,
  baseURL,
}, info) => {
  const host = randomUUID(),
    prefix = `/api/hosts/${host}/proxy`;
  await page.addInitScript((host) => localStorage.setItem('dock:host', host), host);
  const attempts: { key: string; name: string }[] = [],
    urls: string[] = [];
  await page.route(`**${prefix}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === prefix + '/events')
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname.includes('/chat-files')) urls.push(url.pathname);
    url.pathname = '/api' + url.pathname.slice(prefix.length);
    if (url.pathname === '/api/chat-files' && route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      attempts.push({ key: input.key, name: input.name });
      if (attempts.length === 2) {
        // The host saves the file; only its acknowledgement is lost.
        expect((await route.fetch({ url: url.href })).ok()).toBe(true);
        return route.abort('failed');
      }
    }
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  const id = await manager(page, baseURL!);
  await page.goto(`/#/chat/${id}`);
  const composer = page.locator('.composer');
  await composer.getByRole('textbox').fill('Before');
  await composer
    .getByLabel('Choose files')
    .setInputFiles([textFile('one.txt'), textFile('two.txt'), textFile('three.txt')]);
  await expect(composer.getByRole('button', { name: 'Retry upload' })).toBeVisible();
  await expect(composer.getByRole('alert')).toContainText('Remaining: two.txt, three.txt');
  await expect(composer.getByRole('link', { name: 'one.txt', exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(attempts.map((item) => item.name)).toEqual(['one.txt', 'two.txt']);
  await expect(
    composer.getByRole('button', { name: 'Retry upload', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath('batch-partial-failure.png') });
  await composer.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const pad = page.getByRole('dialog');
  await pad.getByRole('textbox').fill('Later typing stays');
  await pad.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(pad.locator('.chat-file-card')).toHaveCount(3);
  await expect(pad.getByRole('textbox')).toHaveValue('Later typing stays');
  expect(attempts.map((item) => item.name)).toEqual(['one.txt', 'two.txt', 'two.txt', 'three.txt']);
  expect(attempts[1]?.key).toBe(attempts[2]?.key);
  expect(new Set(attempts.map((item) => item.key)).size).toBe(3);
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    const href = await pad.getByRole('link', { name, exact: true }).getAttribute('href');
    expect(href).toContain(prefix + '/chat-files/');
    expect(await page.evaluate(async (href) => (await fetch(href!)).text(), href)).toBe(name);
  }
  expect(urls.every((url) => url.startsWith(prefix + '/chat-files'))).toBe(true);
});

test('batch limits include legacy images and reject overflow or invalid selections before uploading', async ({
  page,
  baseURL,
}) => {
  const id = await manager(page, baseURL!);
  const image = await page.request.post('/api/chat-images', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), png: png.toString('base64') },
  });
  expect(image.ok()).toBe(true);
  const imageId = (await image.json()).id as string;
  await page.addInitScript(
    ({ id, imageId }) => {
      localStorage.setItem(
        `dock:local:workspace:draft:${id}`,
        JSON.stringify({ text: `Draft\n\n![Screenshot](swa-image:${imageId})`, baseRevision: 0 }),
      );
    },
    { id, imageId },
  );
  const uploads: string[] = [];
  await page.route('**/api/chat-files', (route) => {
    uploads.push(route.request().postDataJSON().name);
    return route.continue();
  });
  await page.goto(`/#/chat/${id}`);
  const composer = page.locator('.composer'),
    choose = composer.getByLabel('Choose files');
  await expect(composer.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
  await choose.setInputFiles([textFile('existing.txt')]);
  await expect(composer.getByRole('link', { name: 'existing.txt', exact: true })).toBeVisible();
  await choose.setInputFiles([textFile('one.txt'), textFile('two.txt'), textFile('three.txt')]);
  await expect(composer.getByRole('alert')).toContainText('room for 2');
  expect(uploads).toEqual(['existing.txt']);
  for (const invalid of [
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) },
  ]) {
    await choose.setInputFiles([textFile('valid.txt'), invalid]);
    await expect(composer.getByRole('alert')).toContainText(`${invalid.name}:`);
    await expect(composer.getByRole('alert')).toContainText(
      'Nothing from this selection was uploaded',
    );
    expect(uploads).toEqual(['existing.txt']);
  }
  await choose.setInputFiles([textFile('one.txt'), textFile('two.txt')]);
  await expect(composer.locator('.chat-file-card')).toHaveCount(3);
  await expect(composer.getByText('4 of 4 files', { exact: false })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Attach files', exact: true })).toBeDisabled();
  await expect(composer.getByRole('textbox')).toHaveValue('Draft');
  const saved = await page.evaluate(
    (id) => localStorage.getItem(`dock:local:workspace:draft:${id}`),
    id,
  );
  expect(saved).toContain(chatImageReference(imageId));
});

test('a confirmed upload that cannot fit the draft retries attachment without another upload', async ({
  page,
  baseURL,
}) => {
  const id = await manager(page, baseURL!);
  const keys: string[] = [];
  await page.route('**/api/chat-files', (route) => {
    keys.push(route.request().postDataJSON().key);
    return route.continue();
  });
  await page.goto(`/#/chat/${id}`);
  const composer = page.locator('.composer'),
    area = composer.getByRole('textbox');
  await area.fill('x'.repeat(24000));
  await expect(composer.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
  await composer.getByLabel('Choose files').setInputFiles([textFile('fit.txt')]);
  await expect(composer.getByRole('alert')).toContainText('Shorten your message');
  expect(keys).toHaveLength(1);
  await area.fill('Shorter draft');
  await composer.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(composer.getByRole('link', { name: 'fit.txt', exact: true })).toBeVisible();
  await expect(area).toHaveValue('Shorter draft');
  expect(keys).toHaveLength(1);
});

test('shared chats retain a batch failure for explicit discard and accept a fresh mixed batch', async ({
  page,
}, info) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    provider: 'codex',
    label: 'Batch editor',
    title: 'Shared batch',
    status: 'idle',
    message: '',
    paged: true,
    entries: [],
  };
  const { entries: _, ...summary } = state;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [summary] }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  const uploads: string[] = [],
    sends: unknown[] = [];
  await page.route('**/api/chat-files', (route) => {
    uploads.push(route.request().postDataJSON().name);
    return route.continue();
  });
  await page.route(`**/api/vscode/windows/${state.windowId}/send`, (route) => {
    sends.push(route.request().postDataJSON());
    return route.fulfill({ json: { state: 'sent', message: 'Sent' } });
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent('codex:' + state.threadId)}`);
  const composer = page.locator('.mirror-composer'),
    area = composer.getByRole('textbox');
  await area.fill('Keep this draft');
  await composer
    .getByLabel('Choose files')
    .setInputFiles([
      textFile('done.txt'),
      { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') },
      textFile('waiting.txt'),
    ]);
  await expect(composer.getByRole('alert')).toContainText('Remaining: broken.png, waiting.txt');
  expect(uploads).toEqual(['done.txt']);
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await composer.getByRole('button', { name: 'Open notepad', exact: true }).click();
  const pad = page.getByRole('dialog');
  await pad.getByRole('button', { name: 'Discard remaining uploads' }).click();
  await expect(pad.getByRole('link', { name: 'done.txt', exact: true })).toBeVisible();
  await pad
    .getByLabel('Choose files')
    .setInputFiles([
      textFile('fresh.txt'),
      { name: 'fresh.png', mimeType: 'image/png', buffer: png },
    ]);
  await expect(pad.locator('.chat-file-card')).toHaveCount(3);
  await expect(pad.getByRole('textbox')).toHaveValue('Keep this draft');
  await pad.getByRole('button', { name: 'Minimize', exact: true }).click();
  expect(uploads).toEqual(['done.txt', 'fresh.txt', 'fresh.png']);
  expect(sends).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('batch-shared-discard.png') });
});
