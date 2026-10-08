import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chatFileReference, chatImageReference } from '@dock/shared';

// Network fixtures must remain authoritative in WebKit as well as Chromium.
test.use({ serviceWorkers: 'block' });

test('chat screenshots close with Back, Close and Escape without losing scroll or draft', async ({
  page,
  baseURL,
}, info) => {
  const response = await page.request.post('/api/projects', {
    headers: { origin: baseURL! },
    data: {
      key: randomUUID(),
      name: `Image viewer ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(response.ok()).toBe(true);
  const { managerId } = await response.json();
  const legacyId = randomUUID(),
    fileId = randomUUID(),
    generatedId = randomUUID(),
    pdfId = randomUUID();
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#f4f6fa';
      context.fillRect(0, 0, 720, 1280);
      context.fillStyle = '#526bd4';
      context.fillRect(0, 0, 720, 160);
      context.fillStyle = 'white';
      context.font = '36px sans-serif';
      context.fillText('Chat screenshot', 40, 100);
      context.fillStyle = '#293246';
      context.font = '28px sans-serif';
      context.fillText('Close returns to the same chat.', 40, 240);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }),
    'base64',
  );
  for (const path of [
    `/chat-images/${legacyId}`,
    `/chat-files/${fileId}/preview`,
    `/agents/${managerId}/images/${generatedId}`,
  ])
    await page.route(`**/api${path}`, (route) =>
      route.fulfill({ contentType: 'image/png', body: png }),
    );
  for (const [id, name, mimeType] of [
    [fileId, 'phone-screenshot.png', 'image/png'],
    [pdfId, 'paper.pdf', 'application/pdf'],
  ])
    await page.route(`**/api/chat-files/${id}/info`, (route) =>
      route.fulfill({
        json: {
          id,
          name,
          mimeType,
          size: png.length,
          ...(id === fileId ? { image: { width: 720, height: 1280 } } : {}),
        },
      }),
    );
  const entries = Array.from({ length: 25 }, (_, index) => ({
    id: randomUUID(),
    agentId: managerId,
    runId: null,
    kind: 'assistant',
    title: 'Assistant',
    status: 'complete',
    createdAt: new Date().toISOString(),
    text:
      index === 8
        ? chatImageReference(legacyId)
        : index === 12
          ? chatFileReference(fileId)
          : index === 16
            ? 'Generated screenshot'
            : index === 20
              ? chatFileReference(pdfId)
              : `Saved paragraph ${index}. ${'Keep this chat position and unfinished draft. '.repeat(4)}`,
    ...(index === 16
      ? {
          image: {
            id: generatedId,
            mimeType: 'image/png',
            byteLength: png.length,
            width: 720,
            height: 1280,
          },
        }
      : {}),
  }));
  let reads = 0;
  let sends = 0;
  await page.route(new RegExp(`/api/agents/${managerId}(?:\\?.*)?$`), async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    reads++;
    return route.fulfill({ json: { ...detail, entries, runs: [], hasMore: false } });
  });
  await page.route(`**/api/agents/${managerId}/messages`, (route) => {
    sends++;
    return route.fulfill({ status: 500, json: { error: 'Unexpected model request' } });
  });
  await page.clock.install();
  await page.goto(`/#/chat/${managerId}`);
  const conversation = page.locator('.conversation');
  await conversation.evaluate((element) => {
    element.addEventListener(
      'click',
      (event) => {
        if (event.target instanceof Element && event.target.closest('.image-preview-trigger'))
          element.setAttribute('data-test-image-opening-top', String(element.scrollTop));
      },
      { capture: true },
    );
  });
  const mountedChat = await conversation.elementHandle();
  const draft = page.locator('.composer textarea');
  await draft.fill('Keep this unfinished question.');
  const url = page.url();
  const sources = [
    { label: 'Open image Screenshot', dismissal: 'back' },
    { label: 'Open image phone-screenshot.png', dismissal: 'close' },
    { label: 'Open generated image', dismissal: 'escape' },
  ];
  for (const source of sources) {
    const trigger = conversation.getByRole('button', { name: source.label, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    if (source.dismissal === 'escape') await trigger.press('Enter');
    else await trigger.click();
    // Touch browsers can scroll a large thumbnail into view before its click.
    const before = Number(await conversation.getAttribute('data-test-image-opening-top'));
    const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    const closeBox = (await viewer.getByRole('button', { name: 'Close', exact: true }).boundingBox())!;
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    await expect
      .poll(() => viewer.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(720);
    expect(page.url()).toBe(url);
    expect(page.context().pages()).toHaveLength(1);
    const readsBefore = reads;
    await page.clock.fastForward(5100);
    await expect.poll(() => reads).toBeGreaterThan(readsBefore);
    if (source.dismissal === 'close')
      await page.screenshot({ path: info.outputPath('image-viewer-close.png') });
    if (source.dismissal === 'back') await page.goBack();
    else if (source.dismissal === 'escape') await page.keyboard.press('Escape');
    else await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect.poll(() => conversation.evaluate((node) => node.scrollTop)).toBeCloseTo(before, 0);
    await expect(draft).toHaveValue('Keep this unfinished question.');
    await expect(trigger).toBeFocused();
    expect(page.url()).toBe(url);
    expect(await mountedChat!.evaluate((node) => node.isConnected)).toBe(true);
  }
  const pdf = conversation.getByRole('link', { name: 'paper.pdf', exact: true });
  await expect(pdf).toHaveAttribute('href', `/api/chat-files/${pdfId}`);
  await expect(pdf).toHaveAttribute('download', 'paper.pdf');
  expect(sends).toBe(0);
});
