import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { SavedDocument } from '@dock/shared';

// A tiny standards-compliant PDF with two real, selectable-text pages; no binary fixture is shipped.
function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['Thermal report - first page', 'Measurements - second page'].map((text) => {
      const stream = `BT /F1 24 Tf 50 700 Td (${text}) Tj 0 -50 Td /F1 14 Tf (Selectable text at every zoom.) Tj ET`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
async function fixture(page: Page) {
  const id = randomUUID(),
    folder = randomUUID();
  // Match the paired-phone content security policy, including the PDF worker/font boundaries.
  await page.route(/\/($|\?)/, async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      },
    });
  });
  let doc: SavedDocument = {
    id,
    name: 'Thermal report with a longer descriptive title.tex',
    folder: 'Thermal project',
    kind: 'tex',
    state: 'ready',
    hasPdf: true,
    builtAt: new Date().toISOString(),
    openedAt: new Date().toISOString(),
    error: null,
    href: `#/latex/${id}`,
  };
  let fail = false;
  await page.route('**/api/documents**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/pdf'))
      return route.fulfill({ contentType: 'application/pdf', body: pdfFixture() });
    if (url.pathname.endsWith('/browse'))
      return route.fulfill({
        json: {
          current: { id: folder, name: 'Thermal project', canSelect: true },
          parentId: null,
          folders: [],
          files: [doc],
          nextOffset: null,
          nextFileOffset: null,
        },
      });
    if (url.pathname.endsWith('/documents'))
      return route.fulfill({ json: { compiler: 'latexmk', documents: [doc] } });
    if (url.pathname.endsWith('/build'))
      doc = {
        ...doc,
        state: fail ? 'failed' : 'ready',
        error: fail ? 'Undefined control sequence in chapter.tex at line 2.' : null,
        builtAt: fail ? doc.builtAt : new Date().toISOString(),
      };
    return route.fulfill({ json: doc });
  });
  return {
    doc,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}
async function rendered(page: Page) {
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.textLayer').first()).toContainText('Thermal report');
  await expect(reader.getByRole('alert')).toHaveCount(0);
  expect(await reader.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  return reader;
}

test('LaTeX app browses, zooms, navigates pages, survives build errors and reopens recent PDFs', async ({
  page,
}, info) => {
  const data = await fixture(page);
  await page.goto('/#/apps');
  await page.getByRole('link', { name: 'LaTeX', exact: true }).click();
  await page.getByRole('button', { name: 'Browse this computer' }).click();
  const files = page.getByRole('region', { name: 'Files on this computer' });
  await files.getByRole('button', { name: /Thermal report/ }).click();
  const reader = await rendered(page);
  for (const value of ['1', '2', '3', 'page-width', 'page-fit']) {
    await reader.getByLabel('Page fit').selectOption(value);
    await expect(reader.locator('.page canvas').first()).toBeVisible();
    expect(await reader.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
  }
  await reader.getByLabel('Page fit').selectOption('page-width');
  await reader.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await reader.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await reader.getByLabel('Page number').fill('2');
  await reader.getByLabel('Page number').press('Enter');
  await expect(reader.locator('.page').nth(1).locator('.textLayer')).toContainText('Measurements');
  await reader.getByLabel('Page number').fill('1');
  await reader.getByLabel('Page number').press('Enter');
  const beforePinch = await reader.locator('.pdf-zoom').textContent();
  await reader.locator('.pdf-scroll').evaluate((element) => {
    const touch = (x: number) => ({ clientX: x, clientY: 250 });
    for (const [type, touches] of [
      ['touchstart', [touch(100), touch(180)]],
      ['touchmove', [touch(60), touch(220)]],
      ['touchend', []],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: [touch(220)] },
      });
      element.dispatchEvent(event);
    }
  });
  await expect(reader.locator('.pdf-zoom')).not.toHaveText(beforePinch!);
  await reader.getByLabel('Page fit').selectOption('page-width');
  await page.screenshot({
    path: `../../data/latex-reader-20261004/${info.project.name}-reader.png`,
  });
  for (const zoom of [1.25, 1.5, 2]) {
    await reader.evaluate((element, value) => {
      (element as HTMLElement).style.zoom = String(value);
    }, zoom);
    expect(await reader.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await expect(reader.getByRole('button', { name: 'Back to where I was' })).toBeVisible();
  }
  await reader.evaluate((element) => {
    (element as HTMLElement).style.zoom = '';
  });
  data.fail();
  await reader.getByRole('button', { name: 'Rebuild', exact: true }).click();
  await expect(reader.getByRole('alert')).toContainText('previous PDF');
  await expect(reader.locator('.page canvas').first()).toBeVisible();
  data.recover();
  await reader.getByRole('button', { name: 'Try again' }).click();
  await expect(reader.getByRole('alert')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'LaTeX', exact: true })).toBeVisible();
  await page
    .getByRole('region', { name: 'Recent documents' })
    .getByRole('button', { name: /Thermal report/ })
    .click();
  await rendered(page);
  await page.goBack();
  await expect(reader).toHaveCount(0);
});

test('manager PDF links retain the mounted chat, its draft and exact scroll position on Back and swipe', async ({
  page,
}, info) => {
  const data = await fixture(page);
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const created = await page.request.post('/api/projects', {
    headers: { origin },
    data: { key: randomUUID(), name: `PDF reading ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  await page.route(`**/api/agents/${project.managerId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.entries = Array.from({ length: 24 }, (_, index) => ({
      id: randomUUID(),
      agentId: project.managerId,
      runId: null,
      kind: 'assistant',
      title: 'Report',
      status: 'completed',
      createdAt: new Date().toISOString(),
      text: `Reading paragraph ${index}. ${'Keep this chat position while reading the document. '.repeat(4)}\n\n[Read the thermal report](${data.doc.href})`,
    }));
    await route.fulfill({ json: detail });
  });
  await page.goto(`/#/chat/${project.managerId}`);
  const conversation = page.locator('.conversation');
  await expect(conversation).toBeVisible();
  await page.locator('.composer textarea').fill('Keep my unfinished question.');
  await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  const link = conversation.getByRole('link', { name: 'Read the thermal report' }).nth(12);
  await link.scrollIntoViewIfNeeded();
  const before = await conversation.evaluate((element) => element.scrollTop);
  await link.click();
  const reader = await rendered(page);
  expect(new URL(page.url()).hash).toBe(`#/chat/${project.managerId}`);
  await page.screenshot({
    path: `../../data/latex-reader-20261004/${info.project.name}-from-chat.png`,
  });
  await reader.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(reader).toHaveCount(0);
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my unfinished question.');
  await link.click();
  await rendered(page);
  // Synthetic touch events exercise the reader gesture handler; this is emulation, not an iPhone claim.
  await reader.locator('.pdf-scroll').evaluate((element) => {
    const touch = (x: number) => ({ identifier: 1, target: element, clientX: x, clientY: 200 });
    const start = new Event('touchstart', { bubbles: true });
    Object.defineProperties(start, { touches: { value: [touch(40)] } });
    element.dispatchEvent(start);
    const end = new Event('touchend', { bubbles: true });
    Object.defineProperties(end, {
      touches: { value: [] },
      changedTouches: { value: [touch(200)] },
    });
    element.dispatchEvent(end);
  });
  await expect(reader).toHaveCount(0);
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
});

test('a direct document link opens on first load and one Back closes it', async ({ page }) => {
  const data = await fixture(page);
  await page.goto(`/${data.doc.href}`);
  const reader = await rendered(page);
  await page.reload();
  await rendered(page);
  await reader.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'LaTeX', exact: true })).toBeVisible();
});
