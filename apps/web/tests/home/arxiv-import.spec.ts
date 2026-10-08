import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Service workers can bypass Playwright's network stubs, including on WebKit.
test.use({ serviceWorkers: 'block' });

async function fixture(
  page: Page,
  options: { pdfOnly?: boolean; lostReply?: boolean; unavailable?: boolean; hold?: boolean } = {},
) {
  const id = randomUUID(),
    importId = randomUUID();
  const paper = {
    id: '2401.12345',
    version: 2,
    title: 'An imported paper',
    authors: ['Fixture Author'],
    abstract: 'A fixture abstract.',
    absUrl: 'https://arxiv.org/abs/2401.12345v2',
    hasSource: !options.pdfOnly,
    notes: options.pdfOnly
      ? [
          'This paper has no LaTeX source on arXiv. Reading is unavailable; Original PDF shows arXiv’s PDF.',
        ]
      : [],
    futureMetadata: true,
  };
  const doc = {
    id,
    name: paper.title,
    folder: 'arXiv',
    kind: options.pdfOnly ? 'pdf' : 'tex',
    state: 'ready',
    hasPdf: true,
    builtAt: null,
    openedAt: null,
    error: null,
    href: `#/latex/${id}`,
    arxiv: paper,
    futureMetadata: true,
  };
  const requests: { key: string; link: string }[] = [];
  const paths: string[] = [];
  let reads = 0,
    ready = false,
    fail = false;
  const job = (state: string) => ({
    id: importId,
    arxivId: paper.id,
    version: 2,
    state,
    message:
      state === 'failed'
        ? 'arXiv is busy. Try again later.'
        : state === 'ready'
          ? 'Ready to read.'
          : 'Fetching from arXiv.',
    document: state === 'ready' ? doc : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    futureMetadata: true,
  });
  await page.route(/\/api\/(?:hosts\/[0-9a-f-]{36}\/proxy\/)?documents/, async (route) => {
    const requested = new URL(route.request().url()).pathname;
    paths.push(requested);
    const path = requested.replace(/^\/api\/hosts\/[0-9a-f-]{36}\/proxy/, '/api');
    if (path === '/api/documents/arxiv') {
      requests.push(route.request().postDataJSON());
      if (options.unavailable) return route.fulfill({ status: 404, json: { error: 'Not found' } });
      if (options.lostReply && requests.length === 1) return route.abort('failed');
      return route.fulfill({ json: job('queued') });
    }
    if (path === `/api/documents/arxiv/${importId}`) {
      reads++;
      if (fail) return route.fulfill({ json: job('failed') });
      if (!options.hold && reads > 1) ready = true;
      return route.fulfill({ json: job(ready ? 'ready' : 'fetching') });
    }
    if (path === '/api/documents')
      return route.fulfill({
        json: { compiler: null, documents: ready ? [doc] : [], futureMetadata: true },
      });
    if (path.endsWith('/reading'))
      return route.fulfill({
        json: {
          available: !options.pdfOnly,
          html: '<h1>An imported paper</h1><p>A fixture abstract.</p>',
          warnings: [],
        },
      });
    if (path.endsWith('/format')) return route.fulfill({ json: null });
    if (path.endsWith('/pdf')) {
      // A tiny selectable-text PDF; no remote requests or binary fixture.
      const stream = 'BT /F1 20 Tf 50 700 Td (Imported original PDF) Tj ET';
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
      let pdf = '%PDF-1.4\n';
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return route.fulfill({ contentType: 'application/pdf', body: Buffer.from(pdf) });
    }
    return route.fulfill({ json: doc });
  });
  return {
    id,
    requests,
    paths,
    reads: () => reads,
    finish: () => {
      ready = true;
    },
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
      ready = true;
    },
  };
}

async function open(page: Page) {
  await page.goto('/#/latex');
  await page
    .getByRole('textbox', { name: 'arXiv link or ID' })
    .fill('https://arxiv.org/pdf/2401.12345v2');
  await page.getByRole('button', { name: 'Open paper', exact: true }).click();
}

test('paste a link from an empty library, show progress, open Reading and retain Original PDF and recent paper', async ({
  page,
}, info) => {
  const data = await fixture(page);
  await page.goto('/#/latex');
  const form = page.getByRole('form', { name: 'Open an arXiv paper' });
  await expect(form).toBeVisible();
  const button = form.getByRole('button', { name: 'Open paper', exact: true });
  await expect(button).toBeDisabled();
  expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: `../../data/arxiv-ui/${info.project.name}-empty.png` });
  await page
    .getByRole('textbox', { name: 'arXiv link or ID' })
    .fill('https://arxiv.org/pdf/2401.12345v2');
  await button.click();
  await expect.poll(() => data.requests.length).toBe(1);
  await expect(form.getByRole('status')).toContainText('Fetching from arXiv.');
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  await expect(reader.getByRole('heading', { name: 'An imported paper' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Reading', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await reader.getByRole('button', { name: 'Original PDF', exact: true }).click();
  await expect(reader.locator('.textLayer')).toContainText('Imported original PDF');
  await reader.getByRole('button', { name: 'Back to where I was' }).click();
  await expect(page.getByRole('region', { name: 'Recent documents' })).toContainText(
    'arXiv 2401.12345v2',
  );
  await page.reload();
  await expect(page.getByRole('region', { name: 'Recent documents' })).toContainText(
    'An imported paper',
  );
  expect(data.requests).toHaveLength(1);
});

test('a lost import acknowledgement survives reload and retries the same key', async ({ page }) => {
  const data = await fixture(page, { lostReply: true });
  await open(page);
  await expect(page.getByRole('alert')).toContainText('import may still be running');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'arXiv link or ID' })).toHaveValue(
    'https://arxiv.org/pdf/2401.12345v2',
  );
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'PDF reader' })).toBeVisible();
  expect(data.requests).toHaveLength(2);
  expect(data.requests[1]).toEqual(data.requests[0]);
});

test('reload follows the saved import with reads only and a failed import can retry with a new key', async ({
  page,
}) => {
  const data = await fixture(page, { hold: true });
  await open(page);
  await expect(page.getByRole('status')).toContainText('Fetching from arXiv.');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Fetching from arXiv.');
  expect(data.requests).toHaveLength(1);
  data.fail();
  await expect(page.getByRole('alert')).toContainText('arXiv is busy.');
  data.recover();
  await page.getByRole('button', { name: 'Retry import', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'PDF reader' })).toBeVisible();
  expect(data.requests).toHaveLength(2);
  expect(data.requests[1]!.key).not.toBe(data.requests[0]!.key);
});

test('PDF-only import opens the original and explains missing source even without browser storage', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'sessionStorage', {
      get: () => {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    }),
  );
  await fixture(page, { pdfOnly: true });
  await open(page);
  const reader = page.getByRole('dialog', { name: 'PDF reader' });
  await expect(reader.locator('.textLayer')).toContainText('Imported original PDF');
  await expect(reader).toContainText('This paper has no LaTeX source on arXiv.');
  await expect(reader.getByRole('button', { name: 'Reading', exact: true })).toHaveCount(0);
});

test('an older server reports unavailable import once without starting progress polling', async ({
  page,
}) => {
  const data = await fixture(page, { unavailable: true });
  await open(page);
  await expect(page.getByRole('alert')).toContainText(
    'arXiv import is unavailable on this computer.',
  );
  await page.waitForTimeout(1400);
  expect(data.requests).toHaveLength(1);
  expect(data.reads()).toBe(0);
});

test('import, progress and reader requests stay pinned to the selected computer', async ({
  page,
}) => {
  const host = randomUUID();
  await page.addInitScript((id) => localStorage.setItem('dock:host', id), host);
  await page.route('**/api/hosts', (route) =>
    route.fulfill({
      json: {
        local: { id: 'local', label: 'Entry fixture' },
        setupError: null,
        hosts: [
          {
            id: host,
            label: 'Selected fixture',
            accountLabel: 'owner fixture',
            status: 'connected',
            error: null,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/hosts/${host}/proxy/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/documents')) return route.fallback();
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 400, json: { error: 'No fixture mutation here.' } });
    url.pathname = url.pathname.replace(`/api/hosts/${host}/proxy`, '/api');
    return route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  const data = await fixture(page);
  await open(page);
  await expect(
    page
      .getByRole('dialog', { name: 'PDF reader' })
      .getByRole('heading', { name: 'An imported paper' }),
  ).toBeVisible();
  expect(data.paths.some((path) => path.endsWith('/arxiv'))).toBe(true);
  expect(data.paths.every((path) => path.startsWith(`/api/hosts/${host}/proxy/documents`))).toBe(
    true,
  );
});
