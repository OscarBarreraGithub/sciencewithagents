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
    if (url.pathname.endsWith('/format')) return route.fulfill({ json: null });
    if (url.pathname.endsWith('/reading'))
      return route.fulfill({ json: { available: false, html: '', warnings: [] } });
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
  await page.getByRole('button', { name: 'Help and setup', exact: true }).click();
  await page.getByRole('link', { name: 'LaTeX / PDF reader', exact: true }).click();
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
  // Saved entries keep their identities across reads; a poll must not replace every link.
  const entries = Array.from({ length: 24 }, (_, index) => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    kind: 'assistant',
    title: 'Report',
    status: 'completed',
    createdAt: new Date().toISOString(),
    text: `Reading paragraph ${index}. ${'Keep this chat position while reading the document. '.repeat(4)}\n\n[Read the thermal report](/saved/project/thermal.pdf)`,
  }));
  let detailReads = 0;
  let resolvedLocalLink = false;
  await page.route('**/api/documents/from-message', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ agentId: project.managerId, index: 0 });
    expect(Object.keys(route.request().postDataJSON()).sort()).toEqual([
      'agentId',
      'entryId',
      'index',
    ]);
    resolvedLocalLink = true;
    return route.fulfill({ json: data.doc });
  });
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.entries = entries;
    await route.fulfill({ json: detail });
    detailReads++;
  });
  await page.clock.install();
  await page.goto(`/#/chat/${project.managerId}`);
  const conversation = page.locator('.conversation');
  await expect(conversation).toBeVisible();
  const mountedChat = await conversation.elementHandle();
  expect(mountedChat).not.toBeNull();
  // Capture each opening before DocumentHost saves it. WebKit can scroll a link into
  // view during click/focus, so a later opening need not share the first one's baseline.
  await conversation.evaluate((element) => {
    window.addEventListener(
      'dock:document',
      () => element.setAttribute('data-test-document-opening-top', String(element.scrollTop)),
      { capture: true },
    );
  });
  await page.locator('.composer textarea').fill('Keep my unfinished question.');
  await page.evaluate(() => document.fonts.ready);
  await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  const link = conversation.getByRole('link', { name: 'Read the thermal report' }).nth(12);
  const mountedLink = await link.elementHandle();
  expect(mountedLink).not.toBeNull();
  await link.scrollIntoViewIfNeeded();
  const before = await conversation.evaluate((element) => element.scrollTop);
  await link.click();
  const reader = await rendered(page);
  expect(Number(await conversation.getAttribute('data-test-document-opening-top'))).toBeCloseTo(
    before,
    0,
  );
  expect(resolvedLocalLink).toBe(true);
  expect(new URL(page.url()).hash).toBe(`#/chat/${project.managerId}`);
  await page.screenshot({
    path: `../../data/latex-reader-20261004/${info.project.name}-from-chat.png`,
  });
  const readsBefore = detailReads;
  await page.clock.fastForward(5100);
  await expect.poll(() => detailReads).toBeGreaterThan(readsBefore);
  expect(await mountedLink!.evaluate((element) => element.isConnected)).toBe(true);
  await reader.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(reader).toHaveCount(0);
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBeCloseTo(before, 0);
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my unfinished question.');
  await link.click();
  await rendered(page);
  const reopened = Number(await conversation.getAttribute('data-test-document-opening-top'));
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
    .toBeCloseTo(reopened, 0);
  await expect(page.locator('.composer textarea')).toHaveValue('Keep my unfinished question.');
  expect(new URL(page.url()).hash).toBe(`#/chat/${project.managerId}`);
  expect(
    await mountedChat!.evaluate(
      (element) => element.isConnected && element === document.querySelector('.conversation'),
    ),
  ).toBe(true);
  expect(await mountedLink!.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({ path: info.outputPath('restored-chat.png') });
  await info.attach('document-return-positions', {
    body: JSON.stringify({
      firstOpening: before,
      secondOpening: reopened,
      finalReturn: await conversation.evaluate((element) => element.scrollTop),
    }),
    contentType: 'application/json',
  });
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

test('source reading wraps at large text sizes, isolates equations, keeps its place and opens the original PDF', async ({
  page,
}, info) => {
  const data = await fixture(page);
  const html = `<h1>Thermal report</h1><p>Comfortable reading with a formula <span class="math inline">\\(E=mc^2\\)</span> in ordinary text.</p>
    <p>${'This text should wrap to the phone width without moving sideways. '.repeat(6)}</p>
    <span class="math display">\\[${'a+b+c+d+'.repeat(25)}z\\]</span>
    <table><tr><th>Name</th><th>Meaning</th></tr><tr><td>Temperature</td><td>${'A longer description that wraps. '.repeat(5)}</td></tr></table>
    ${Array.from({ length: 40 }, (_, i) => `<h2 id="section-${i}">Section ${i}</h2><p>${'More readable text. '.repeat(12)}</p>`).join('')}
    <img src="https://invalid.example/private"><script>window.injected=true</script><a href="javascript:alert(1)">Unsafe link</a>`;
  await page.route('**/api/documents/*/reading', (route) =>
    route.fulfill({ json: { available: true, html, warnings: [] } }),
  );
  await page.goto(`/#/latex/${data.doc.id}`);
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  await expect(reader.locator('.document-reading h1')).toHaveText('Thermal report');
  await expect(reader.locator('.katex-error')).toHaveCount(0);
  await expect(reader.locator('.document-reading img')).toHaveCount(0);
  await expect(reader.locator('a[href^="javascript:"]')).toHaveCount(0);
  for (let i = 0; i < 5; i++) await reader.getByRole('button', { name: 'Larger text' }).click();
  const area = reader.getByLabel('Reading pages');
  expect(await area.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  expect(
    await reader
      .locator('.math.display')
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  expect(
    await reader
      .locator('.document-reading p')
      .first()
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await expect(reader.getByText('More equation →', { exact: true })).toBeVisible();
  await reader.locator('.math.display').evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(reader.getByText('← More equation', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `../../data/reader-resource-20261004/reflow-${info.project.name}.png`,
  });
  await area.evaluate((element) => {
    element.scrollTop = 1500;
  });
  await reader.getByRole('button', { name: 'Original PDF', exact: true }).click();
  await rendered(page);
  await reader.getByRole('button', { name: 'Reading', exact: true }).click();
  await expect.poll(() => area.evaluate((element) => element.scrollTop)).toBeGreaterThan(1400);
  await reader.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(reader).toHaveCount(0);
});

test('phone formatting is an explicit selectable request and leaves original reading available', async ({
  page,
}, info) => {
  const data = await fixture(page);
  let requested: Record<string, unknown> | null = null;
  const formattedId = randomUUID(),
    agentId = randomUUID();
  const status = {
    id: formattedId,
    documentId: data.doc.id,
    agentId,
    model: 'claude-sonnet-5-5',
    state: 'ready',
    message: 'AI-formatted copy; original retained.',
  };
  await page.route('**/api/documents/*/reading', (route) =>
    route.fulfill({
      json: {
        available: true,
        html: '<h1>Original report</h1><p>Original prose.</p>',
        warnings: [],
        labels: {},
      },
    }),
  );
  await page.route('**/api/documents/*/formatted/*', (route) =>
    route.fulfill({
      json: {
        available: true,
        html: '<h1>Readable copy</h1><p>Original prose.</p>',
        warnings: [],
        labels: {},
      },
    }),
  );
  await page.route('**/api/documents/*/format', (route) => {
    if (route.request().method() === 'POST') requested = route.request().postDataJSON();
    return route.fulfill({ json: requested ? status : null });
  });
  await page.route('**/api/models?provider=claude', (route) =>
    route.fulfill({
      json: [
        {
          id: 'claude-sonnet-5-5',
          label: 'Sonnet 5.5',
          efforts: ['medium', 'high'],
          isDefault: true,
        },
        { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'], isDefault: false },
      ],
    }),
  );
  await page.goto(`/#/latex/${data.doc.id}`);
  await expect(page.getByRole('heading', { name: 'Original report' })).toBeVisible();
  expect(requested).toBeNull();
  await page.getByText('Format for phone', { exact: true }).click();
  const controls = page.locator('.document-format');
  await expect(controls.getByLabel('Model', { exact: true })).toHaveValue('claude-sonnet-5-5');
  await controls.getByLabel('Model', { exact: true }).selectOption('claude-opus-5-5');
  await expect(controls.getByLabel('Thinking')).toHaveValue('high');
  await controls.getByRole('button', { name: 'Create reading copy' }).click();
  expect(requested).toMatchObject({ model: 'claude-opus-5-5', provider: 'claude', effort: 'high' });
  await controls.getByRole('button', { name: 'Read formatted copy' }).click();
  await expect(page.getByRole('heading', { name: 'Readable copy' })).toBeVisible();
  await controls.getByRole('button', { name: 'Read original' }).click();
  await expect(page.getByRole('heading', { name: 'Original report' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('phone-formatting.png') });
});
