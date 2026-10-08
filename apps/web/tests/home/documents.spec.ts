import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { SavedDocument } from '@dock/shared';
import { readingEqualityLayout } from '../../src/readingMathLayout';

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
  const tile = page
    .locator('.apps-grid')
    .getByRole('link', { name: 'LaTeX / PDF reader', exact: true });
  await expect(tile).toBeVisible();
  await page.reload();
  await tile.click();
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
  // Phone toolbars change only the height: the fitted scale and reading position stay put.
  const scroller = reader.locator('.pdf-scroll');
  const top = await scroller.evaluate((element) => (element.scrollTop = 200) && element.scrollTop);
  const fitted = await reader.locator('.pdf-zoom').textContent();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, height: viewport.height - 75 });
  await page.waitForTimeout(150);
  await expect(reader.locator('.pdf-zoom')).toHaveText(fitted!);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  await page.setViewportSize(viewport);
  const beforePinch = await reader.locator('.pdf-zoom').textContent();
  // Pinch handling never cancels touches, so the browser can always scroll without waiting.
  const prevented = await reader.locator('.pdf-scroll').evaluate((element) => {
    const touch = (x: number) => ({ clientX: x, clientY: 250 });
    let cancelled = false;
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
      cancelled ||= event.defaultPrevented;
    }
    return cancelled;
  });
  expect(prevented).toBe(false);
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

test('LaTeX browser navigates locations and breadcrumbs, tolerates server skew and explains bad replies', async ({
  page,
}, info) => {
  const ids = Object.fromEntries(
    [
      'root',
      'users',
      'home',
      'desktop',
      'documents',
      'downloads',
      'developer',
      'volumes',
      'papers',
    ].map((name) => [name, randomUUID()]),
  );
  const names: Record<string, string> = {
    root: 'This computer',
    users: 'Users',
    home: 'emmy',
    documents: 'Documents',
    papers: 'Thermal papers',
  };
  const chain: Record<string, string[]> = {
    home: ['root', 'users', 'home'],
    documents: ['root', 'users', 'home', 'documents'],
    papers: ['root', 'users', 'home', 'documents', 'papers'],
    root: ['root'],
  };
  const locations = [
    ['Home', 'home'],
    ['Desktop', 'desktop'],
    ['Documents', 'documents'],
    ['Downloads', 'downloads'],
    ['Developer', 'developer'],
    ['This computer', 'root', 'computer'],
    ['Drives', 'volumes'],
  ].map(([name, key, kind]) => ({ id: ids[key]!, name, kind: kind ?? key }));
  const recent: SavedDocument = {
    id: randomUUID(),
    name: 'Notes.pdf',
    folder: 'Documents',
    kind: 'pdf',
    state: 'ready',
    hasPdf: true,
    builtAt: null,
    openedAt: new Date().toISOString(),
    error: null,
    href: '#/latex/x',
  };
  const requested: (string | null)[] = [];
  let malformed = false;
  await page.route('**/api/documents**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/documents'))
      return route.fulfill({ json: { compiler: 'latexmk', documents: [recent] } });
    const folderId = url.searchParams.get('folderId');
    requested.push(folderId);
    if (malformed) return route.fulfill({ json: { current: 'unexpected' } });
    const key = Object.keys(ids).find((name) => ids[name] === folderId) ?? 'home';
    const trail = (chain[key] ?? ['home']).map((part) => ({ id: ids[part]!, name: names[part]! }));
    // The exact shape the pre-fix server sends (it spreads FolderBrowser output), plus a future key.
    return route.fulfill({
      json: {
        current: { id: ids[key], name: names[key], canSelect: key !== 'home' },
        parentId: trail.at(-2)?.id ?? null,
        folders: key === 'documents' ? [{ id: ids.papers, name: 'Thermal papers' }] : [],
        nextOffset: null,
        search: null,
        breadcrumbs: trail,
        locations,
        files: [],
        nextFileOffset: null,
        addedByNewerServer: { anything: true },
      },
    });
  });
  await page.goto('/#/apps');
  await page
    .locator('.apps-grid')
    .getByRole('link', { name: 'LaTeX / PDF reader', exact: true })
    .click();
  await page.getByRole('button', { name: 'Browse this computer' }).click();
  const browser = page.getByRole('region', { name: 'Files on this computer' });
  const places = browser.getByRole('navigation', { name: 'Locations' });
  const path = browser.getByRole('navigation', { name: 'Folder path' });
  await expect(places.getByRole('button')).toHaveText([
    'Home',
    'Desktop',
    'Documents',
    'Downloads',
    'Developer',
    'This computer',
    'Drives',
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(places.getByRole('button', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await places.getByRole('button', { name: 'Documents' }).click();
  await expect(browser.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await browser.getByRole('button', { name: 'Thermal papers' }).click();
  await expect(path.getByRole('button')).toHaveText([
    'This computer',
    'Users',
    'emmy',
    'Documents',
    'Thermal papers',
  ]);
  await expect(path.getByRole('button', { name: 'Thermal papers' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  // Narrow screens keep the current folder in view; ancestors scroll.
  expect(
    await path.evaluate(
      (element) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  for (const button of await places.getByRole('button').all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await browser.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: `../../data/latex-browser-20261007/${info.project.name}-browser.png`,
  });
  await path.getByRole('button', { name: 'emmy' }).click();
  await expect(browser.getByRole('heading', { name: 'emmy' })).toBeVisible();
  expect(requested).toEqual([null, ids.documents, ids.papers, ids.home]);
  malformed = true;
  await browser.getByRole('button', { name: 'Refresh folder' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'This folder could not be read. Reload and try again.',
  );
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
  // A parent re-render (here a rebuild and reading refresh) keeps the reading DOM, including
  // the equation's sideways position and overflow cue.
  const equation = await reader.locator('.math.display').elementHandle();
  const sideways = await equation!.evaluate((element) => element.scrollLeft);
  await reader.getByRole('button', { name: 'Rebuild', exact: true }).click();
  await expect(reader.getByRole('button', { name: 'Rebuild', exact: true })).toBeEnabled();
  expect(await equation!.evaluate((element) => element.isConnected && element.scrollLeft)).toBe(
    sideways,
  );
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

test('source reading opens with the paper title block and marks passages only in the PDF', async ({
  page,
}, info) => {
  const data = await fixture(page);
  // Server output for a revtex paper (title, two authors with affiliations, email, abstract)
  // with one passage Pandoc rejected. Unknown keys mimic a newer server.
  const html = `<header class="reading-front-matter">
<h1 class="reading-title">Thermal transport in a long-titled layered material with <span class="math inline">\\(\\kappa_{xy}\\)</span></h1>
<div class="reading-authors"><p>Ann Alpha<sup>1</sup>, Ben Beta<sup>2</sup></p></div>
<div class="reading-affiliations"><p><sup>1</sup>Department of Physics, First Institute of Technology, Town 12345</p>
<p><sup>2</sup>Second Laboratory for Very Long Affiliation Names, City</p></div>
<div class="reading-contact"><p>Email: ann.alpha@first-institute.example.org</p></div>
<section class="reading-abstract"><h2 class="reading-abstract-heading">Abstract</h2>
<p>We measure the thermal Hall conductivity <span class="math inline">\\(\\kappa_{xy}\\)</span> and find a small effect.</p></section>
</header>
<h1 id="introduction">Introduction</h1><p>${'Body text that wraps on a phone. '.repeat(8)}</p>
<div class="reading-omitted"><p>Part of this section is only in the Original PDF.</p></div>`;
  await page.route('**/api/documents/*/reading', (route) =>
    route.fulfill({
      json: {
        available: true,
        html,
        warnings: [
          'Some passages could not be converted. Each is marked where it is only in the Original PDF.',
        ],
        labels: {},
        health: {
          conversion: 'partial',
          dropped: [{ part: 'body', reason: 'r', excerpt: 'e' }],
          later: 1,
        },
        figures: [],
      },
    }),
  );
  await page.goto(`/#/latex/${data.doc.id}`);
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  const title = reader.getByRole('heading', { level: 1, name: /Thermal transport/ });
  await expect(title).toBeVisible();
  await expect(reader.locator('.document-reading > :first-child')).toHaveClass(
    'reading-front-matter',
  );
  await expect(reader.getByRole('heading', { name: 'Abstract' })).toBeVisible();
  await expect(reader.locator('.reading-title .katex')).toHaveCount(1);
  await expect(reader.getByText('Part of this section is only in the Original PDF.')).toBeVisible();
  await expect(reader.getByText('Conversion notes')).toBeVisible();
  const area = reader.getByLabel('Reading pages');
  const titleSize = await title.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize),
  );
  const bodySize = await reader
    .locator('.document-reading > p')
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(titleSize).toBeGreaterThan(bodySize);
  await page.screenshot({
    path: `../../data/s2a-corpus/screens/front-matter-${info.project.name}.png`,
  });
  for (let i = 0; i < 5; i++) await reader.getByRole('button', { name: 'Larger text' }).click();
  expect(await area.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `../../data/s2a-corpus/screens/front-matter-large-${info.project.name}.png`,
  });
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

test('Reading equality candidates retain substrings and decline uncertain TeX boundaries', () => {
  const tex = String.raw`\mathrm{Attention}(Q, K, V) = \mathrm{softmax}(\frac{QK^T}{\sqrt{d_k}})V`;
  expect(readingEqualityLayout(tex)).toBe(
    String.raw`\begin{gathered}\mathrm{Attention}(Q, K, V) \\= \mathrm{softmax}(\frac{QK^T}{\sqrt{d_k}})V\end{gathered}`,
  );
  expect(readingEqualityLayout(String.raw`\mathbf{a}=b`)).toBe(
    String.raw`\begin{gathered}\mathbf{a}\\=b\end{gathered}`,
  );
  // Unscoped declarations can reset at a gathered row, changing the RHS appearance.
  for (const declaration of [
    'bf',
    'rm',
    'it',
    'sf',
    'tt',
    'cal',
    'mit',
    'tiny',
    'sixptsize',
    'scriptsize',
    'footnotesize',
    'small',
    'normalsize',
    'large',
    'Large',
    'LARGE',
    'huge',
    'Huge',
  ]) {
    expect(readingEqualityLayout(`\\${declaration} a=b`)).toBeNull();
    expect(readingEqualityLayout(`a=\\${declaration} b`)).toBeNull();
  }
  for (const uncertain of [
    'a <= b',
    'a < = b',
    'a >= b',
    'a != b',
    'a == b',
    'a=b=c',
    'a=(b',
    'a(b=c)',
    String.raw`\text{a=b}`,
    String.raw`a=\text{b}`,
    String.raw`\verb|a=b|`,
    String.raw`a\=b`,
    String.raw`a\not=b`,
    String.raw`\textstyle a=b`,
    String.raw`\color{red}a=b`,
    String.raw`\{a=b\}`,
    String.raw`a\\ b=c`,
    String.raw`\left(a=b\right)`,
    String.raw`\langle a=b\rangle`,
    String.raw`\begin{bmatrix}a=b\end{bmatrix}`,
    String.raw`a&=b`,
  ])
    expect(readingEqualityLayout(uncertain)).toBeNull();
});

test('cached attention equality fits the Reading column without changing its scientific tokens', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const data = await fixture(page);
  // Exact equation from cached1706.03762/model_architecture.tex; label supplied by this fixture.
  const tex = String.raw`\mathrm{Attention}(Q, K, V) = \mathrm{softmax}(\frac{QK^T}{\sqrt{d_k}})V`;
  const wide = String.raw`z=\frac{${'a+'.repeat(70)}b}{c}`;
  const html = `<p>Scaled dot-product attention, equation <a href="#eq:attention" data-reference-type="ref">7</a>.</p><span class="math display">\\[\\begin{equation}\\label{eq:attention}${tex}\\end{equation}\\]</span><span class="math display">\\[${wide}\\]</span>`;
  await page.route('**/api/documents/*/reading', (route) =>
    route.fulfill({
      json: { available: true, html, labels: { 'eq:attention': '7' }, warnings: [] },
    }),
  );
  await page.goto(`/#/latex/${data.doc.id}`);
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  const equation = reader.getByRole('region', { name: 'Equation 7', exact: true });
  await expect(equation).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const wrapped = equation.locator('.reading-equation-wrapped');
  const original = equation.locator('.reading-equation-original');
  const formula = equation.locator('.reading-equation-content > span').first();
  const inspect = async () => {
    await expect
      .poll(() => equation.evaluate((element) => element.scrollWidth <= element.clientWidth + 3))
      .toBe(true);
    expect(await original.locator('annotation').textContent()).toBe(tex);
    expect(await wrapped.locator('annotation').textContent()).toBe(readingEqualityLayout(tex));
    await expect(formula.getByRole('math')).toHaveCount(1);
    await expect(equation.locator('.reading-equation-number')).toContainText('(7)');
    await expect(reader.locator('#eq\\:attention')).toHaveCount(1);
    expect(
      await reader
        .getByLabel('Reading pages')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  };
  await inspect();
  const dimensions = await equation.evaluate((element) => ({
    available: element.clientWidth,
    rendered: element.scrollWidth,
    natural: element.querySelector('.reading-equation-original .katex')!.getBoundingClientRect()
      .width,
    wrapped: !element.querySelector<HTMLElement>('.reading-equation-wrapped')!.hidden,
  }));
  await info.attach('attention-width', {
    body: JSON.stringify(dimensions),
    contentType: 'application/json',
  });
  expect(dimensions.wrapped).toBe(dimensions.natural > dimensions.available + 3);
  for (let i = 0; i < 2; i++) await reader.getByRole('button', { name: 'Larger text' }).click();
  await inspect();
  if (['phone', 'small-phone'].includes(info.project.name)) await expect(wrapped).toBeVisible();
  const fallback = reader.getByRole('region', { name: 'Equation', exact: true });
  expect(await fallback.evaluate((element) => element.scrollWidth > element.clientWidth + 3)).toBe(
    true,
  );
  await expect(fallback.locator('..').getByText('More equation →', { exact: true })).toBeVisible();
  await fallback.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(fallback.locator('..').getByText('← More equation', { exact: true })).toBeVisible();
  for (let i = 0; i < 2; i++) await reader.getByRole('button', { name: 'Smaller text' }).click();
  await inspect();
  await expect(reader.locator('.katex-error')).toHaveCount(0);
  await expect.poll(() => errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('attention-reflow.png') });
});

test('simple cached atmosphere table keeps full header associations in narrow Reading cards', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const data = await fixture(page);
  // Exact header and first two rows from cached2610.07861, atmosphere-grid comparison.
  const html = String.raw`<table>
<thead>
<tr>
<th style="text-align: left;">Model</th>
<th style="text-align: left;"><span class="math inline">\({T_{\rm eff}}\)</span> [K]</th>
<th style="text-align: left;"><span class="math inline">\({\log g}\)</span></th>
<th style="text-align: left;"><span class="math inline">\({[\mathrm{M/H}]}\)</span></th>
<th style="text-align: left;">Other parameters</th>
<th style="text-align: left;">Physical scale / interpretation</th>
<th style="text-align: left;"><span class="math inline">\(\overline{\chi^2}_{\rm spec}\)</span></th>
<th style="text-align: left;"><span class="math inline">\(\overline{\chi^2}_{{\rm phot},w}\)</span></th>
<th style="text-align: left;">Cosine</th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align: left;">Sonora Elf Owl</td>
<td style="text-align: left;">700</td>
<td style="text-align: left;">5.50</td>
<td style="text-align: left;"><span class="math inline">\(-0.50\)</span></td>
<td style="text-align: left;">C/O<span class="math inline">\(=1.00\)</span>, <span class="math inline">\(\log K_{zz}=2.0\)</span></td>
<td style="text-align: left;">Best balanced score; cloud-free disequilibrium-chemistry solution.</td>
<td style="text-align: left;">1.11</td>
<td style="text-align: left;">0.18</td>
<td style="text-align: left;">0.959</td>
</tr>
<tr>
<td style="text-align: left;">LOWZ grid</td>
<td style="text-align: left;">700</td>
<td style="text-align: left;">5.00</td>
<td style="text-align: left;"><span class="math inline">\(-1.00\)</span></td>
<td style="text-align: left;">C/O<span class="math inline">\(=0.55\)</span>, <span class="math inline">\(\log K_{zz}=-1.0\)</span></td>
<td style="text-align: left;">Low-metallicity grid solution; used as the basis for the MCMC posterior below.</td>
<td style="text-align: left;">1.25</td>
<td style="text-align: left;">0.15</td>
<td style="text-align: left;">0.953</td>
</tr></tbody></table>`;
  const fitting =
    '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>';
  await page.route('**/api/documents/*/reading', (route) =>
    route.fulfill({ json: { available: true, html: html + fitting, labels: {}, warnings: [] } }),
  );
  await page.goto(`/#/latex/${data.doc.id}`);
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  const table = reader.locator('table').first();
  await expect(table).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await table
    .locator('..')
    .evaluate((element) => ({ available: element.clientWidth, rendered: element.scrollWidth }));
  await info.attach('table-width', {
    body: JSON.stringify(dimensions),
    contentType: 'application/json',
  });
  expect(dimensions.rendered).toBeLessThanOrEqual(dimensions.available + 3);
  const inspect = async () => {
    await expect(table).toHaveClass(
      dimensions.available < 600 ? /reading-card-active/ : /^(?!.*reading-card-active)/,
    );
    const fittingTable = reader.locator('table').nth(1);
    await expect(fittingTable).toHaveClass(/reading-card-table/);
    await expect(fittingTable).not.toHaveClass(/reading-card-active/);
    await expect(fittingTable.getByRole('columnheader').first()).toBeVisible();
    await expect(fittingTable.locator('.reading-card-label').first()).toBeHidden();
    await expect(table.getByRole('columnheader')).toHaveCount(9);
    await expect(table.getByRole('cell')).toHaveCount(18);
    if (dimensions.available < 600) {
      expect(
        await table
          .locator('tbody td')
          .first()
          .evaluate((cell) => {
            const label = cell.querySelector('.reading-card-label')!.getBoundingClientRect();
            const value = cell.querySelector('.reading-card-value')!.getBoundingClientRect();
            const style = getComputedStyle(cell);
            const available =
              cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return (
              value.top >= label.bottom - 1 &&
              Math.abs(value.left - label.left) < 1 &&
              label.width >= available - 1 &&
              value.width >= available - 1
            );
          }),
      ).toBe(true);
    }
    // Every visual label is the complete original rendered header, including math/units.
    expect(
      await table.evaluate((element, source) => {
        const original = new DOMParser()
          .parseFromString(source, 'text/html')
          .querySelector('table')!;
        const headers = [...element.querySelectorAll('thead th')];
        const cells = [...element.querySelectorAll('tbody td')];
        const originalCells = [...original.querySelectorAll('tbody td')];
        return cells.every((cell, index) => {
          const header = headers[index % headers.length]!;
          const value = cell.querySelector('.reading-card-value')!;
          const label = cell.querySelector('.reading-card-label')!;
          const expected = originalCells[index]!.cloneNode(true) as Element;
          const actual = value.cloneNode(true) as Element;
          const sourceTex = [...expected.querySelectorAll('.math')].map((math) =>
            math.textContent!.replace(/^\\[([]|\\[)\]]$/g, ''),
          );
          const actualTex = [...actual.querySelectorAll('annotation')].map(
            (math) => math.textContent,
          );
          expected.querySelectorAll('.math').forEach((math) => math.remove());
          actual.querySelectorAll('.math').forEach((math) => math.remove());
          return (
            cell.getAttribute('headers') === header.id &&
            header.getAttribute('scope') === 'col' &&
            label.innerHTML === header.innerHTML &&
            label.getAttribute('aria-hidden') === 'true' &&
            expected.textContent === actual.textContent &&
            JSON.stringify(sourceTex) === JSON.stringify(actualTex)
          );
        });
      }, html),
    ).toBe(true);
    expect(
      await table
        .locator('..')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 3),
    ).toBe(true);
  };
  await inspect();
  await page.screenshot({ path: info.outputPath('atmosphere-cards-default.png') });
  for (let at = 0; at < 2; at++) await reader.getByRole('button', { name: 'Larger text' }).click();
  await inspect();
  if (dimensions.available < 600) {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(table).not.toHaveClass(/reading-card-active/);
    await expect(table.getByRole('columnheader').first()).toBeVisible();
    await page.setViewportSize(viewport);
    await inspect();
  }
  await expect(reader.locator('.katex-error')).toHaveCount(0);
  await expect.poll(() => errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('atmosphere-cards.png') });
});

test('ambiguous Reading tables retain their original structure and horizontal fallback', async ({
  page,
}) => {
  const data = await fixture(page);
  const long = '7'.repeat(180);
  const candidates = [
    `<thead><tr><th colspan="2">Merged quantity</th><th>Unit</th></tr></thead><tbody><tr><td>${long}</td><td>2</td><td>K</td></tr></tbody>`,
    '<thead><tr><th>A</th><th>B</th><th>C</th></tr><tr><th>D</th><th>E</th><th>F</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody>',
    '<tbody><tr><td>A</td><td>B</td><td>C</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></tbody>',
    '<thead><tr><th>A</th><th></th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody>',
    '<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td rowspan="2">1</td><td>2</td><td>3</td></tr><tr><td>4</td><td>5</td></tr></tbody>',
    '<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>',
    '<tbody><tr><td><table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table></td></tr></tbody>',
  ];
  const html = candidates.map((body) => `<table>${body}</table>`).join('');
  await page.route('**/api/documents/*/reading', (route) =>
    route.fulfill({ json: { available: true, html, labels: {}, warnings: [] } }),
  );
  await page.goto(`/#/latex/${data.doc.id}`);
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  await expect(reader.locator('table')).toHaveCount(candidates.length + 1);
  await expect(reader.locator('.reading-card-table')).toHaveCount(0);
  await expect(reader.locator('.reading-card-label')).toHaveCount(0);
  const fallback = reader.getByRole('region', { name: 'Table', exact: true }).first();
  await expect(fallback.locator('..').getByText('More table →', { exact: true })).toBeVisible();
  await fallback.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(fallback.locator('..').getByText('← More table', { exact: true })).toBeVisible();
});
