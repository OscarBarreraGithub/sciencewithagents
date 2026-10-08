import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { arxivImportSchema, type ArxivImport } from '@dock/shared';
import { ZodError } from 'zod';
import { Conflict, Invalid, Missing, Store } from './store.js';
import { Documents, registerDocumentRoutes } from './documents.js';
import {
  ArxivImports,
  arxivLimits,
  registerArxivImportRoutes,
  type Fetcher,
} from './arxiv-import.js';
import { readerExecutable } from './document-reading.js';
import { proxyPath } from './hosts.js';
import { tar } from './arxiv-tar.fixture.js';

const pdf = Buffer.from('%PDF-1.4\narXiv original\n%%EOF');
const main = String.raw`\documentclass{article}
\begin{document}
\section{Gravitational waves}
Energy flux $\dot E = -\frac{32}{5} G \mu^2 r^4 \omega^6$. \input{sections/method}
\end{document}
`;
const atom = (id: string, version: number, title = 'A Study of Waves') =>
  `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/${id}v${version}</id>
  <title>${title}</title><summary>We study waves.</summary>
  <author><name>Ada Lovelace</name></author></entry></feed>`;

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
/** Like real fetch, a pending request ends when its signal aborts. */
const hang: Route = (_, init) =>
  new Promise((_resolve, reject) =>
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
  );
let root: string, data: string, store: Store, documents: Documents, imports: ArxivImports;
let app: FastifyInstance, calls: string[], routes: Map<string, Route>;
const saved = { ...arxivLimits };
const fetcher: Fetcher = async (url, init) => {
  calls.push(url);
  expect(init.redirect).toBe('manual');
  expect(new Headers(init.headers).get('user-agent')).toMatch(/sciencewithagents/);
  const parsed = new URL(url);
  const route = routes.get(
    parsed.pathname + (parsed.pathname === '/api/query' ? parsed.search : ''),
  );
  if (!route) return new Response('missing', { status: 404 });
  return route(parsed, init);
};
function paper(id: string, version: number, source: Buffer | null, title?: string) {
  const query = (versioned: boolean) =>
    `/api/query?id_list=${id}${versioned ? `v${version}` : ''}&max_results=1`;
  routes.set(query(false), () => new Response(atom(id, version, title)));
  routes.set(query(true), () => new Response(atom(id, version, title)));
  routes.set(`/pdf/${id}v${version}`, () => new Response(pdf));
  if (source) routes.set(`/src/${id}v${version}`, () => new Response(source));
}
async function post(link: string, key = randomUUID()) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/documents/arxiv',
    payload: { key, link },
  });
  return {
    status: response.statusCode,
    body: response.json() as ArxivImport & { error: string },
  };
}
async function settled(id: string) {
  let result!: ArxivImport;
  await expect
    .poll(
      async () => {
        result = arxivImportSchema.parse((await app.inject(`/api/documents/arxiv/${id}`)).json());
        return result.state;
      },
      { timeout: 10000 },
    )
    .toMatch(/^(ready|failed)$/);
  return result;
}
async function imported(link: string) {
  const started = await post(link);
  expect(started.status).toBe(200);
  return settled(started.body.id);
}

function server() {
  const fastify = Fastify();
  // Mirrors the app's error mapping (server.ts) for status assertions.
  fastify.setErrorHandler((error, _request, reply) =>
    reply
      .status(
        error instanceof ZodError || error instanceof Invalid
          ? 400
          : error instanceof Missing
            ? 404
            : error instanceof Conflict
              ? 409
              : 500,
      )
      .send({ error: error.message }),
  );
  registerDocumentRoutes(fastify, documents);
  registerArxivImportRoutes(fastify, imports);
  return fastify;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'swa-arxiv-'));
  data = join(root, 'data');
  await mkdir(join(root, 'home'));
  store = new Store(join(data, 'dock.sqlite'));
  documents = new Documents(store, data, join(root, 'home'));
  imports = new ArxivImports(store, documents, data, fetcher);
  calls = [];
  routes = new Map();
  app = server();
});
afterEach(async () => {
  Object.assign(arxivLimits, saved);
  await app.close();
  await imports.close();
  await documents.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});

it('imports from an abs link, serves arXiv’s PDF without compiling and reuses the cache for pdf and bare-ID links', async () => {
  paper(
    '2401.12345',
    2,
    gzipSync(
      tar([
        { name: 'main.tex', data: main },
        { name: 'sections/method.tex', data: 'We use the quadrupole formula.' },
        { name: 'figs/plot.png', data: 'png' },
      ]),
    ),
  );
  const result = await imported('https://arxiv.org/abs/2401.12345');
  expect(result).toMatchObject({ state: 'ready', arxivId: '2401.12345', version: 2 });
  const doc = result.document!;
  expect(doc).toMatchObject({
    name: 'A Study of Waves',
    folder: 'arXiv 2401.12345v2',
    kind: 'tex',
    state: 'ready',
    hasPdf: true,
    arxiv: {
      id: '2401.12345',
      version: 2,
      authors: ['Ada Lovelace'],
      abstract: 'We study waves.',
      hasSource: true,
      notes: [],
      absUrl: 'https://arxiv.org/abs/2401.12345v2',
    },
  });
  expect(JSON.stringify(result)).not.toContain(root);
  expect(calls.map((url) => new URL(url).pathname)).toEqual([
    '/api/query',
    '/pdf/2401.12345v2',
    '/src/2401.12345v2',
  ]);
  // Appears in Recent documents; opening needs no compiler and keeps arXiv's PDF.
  expect((await app.inject('/api/documents')).json().documents[0].id).toBe(doc.id);
  const opened = await app.inject({
    method: 'POST',
    url: `/api/documents/${doc.id}/open`,
    payload: { key: randomUUID() },
  });
  expect(opened.json()).toMatchObject({ state: 'ready', hasPdf: true });
  const served = await app.inject(`/api/documents/${doc.id}/pdf`);
  expect(served.rawPayload).toEqual(pdf);
  expect(served.headers['content-disposition']).toContain(
    encodeURIComponent('A Study of Waves.pdf'),
  );
  // Rebuild re-copies arXiv's PDF instead of compiling locally.
  await app.inject({
    method: 'POST',
    url: `/api/documents/${doc.id}/build`,
    payload: { key: randomUUID() },
  });
  await expect.poll(() => documents.get(doc.id).state).toBe('ready');
  expect((await documents.pdf(doc.id)).data).toEqual(pdf);
  expect(existsSync(join(data, 'arxiv', '2401.12345v2', 'source', 'sections', 'method.tex'))).toBe(
    true,
  );
  expect((await readdir(join(data, 'arxiv'))).filter((name) => name.startsWith('.'))).toEqual([]);

  // Versioned pdf and bare-ID links are served from the cache with no network at all.
  calls = [];
  for (const link of [
    'https://arxiv.org/pdf/2401.12345v2.pdf',
    '2401.12345v2',
    'arXiv:2401.12345v2',
  ])
    expect((await imported(link)).document?.id).toBe(doc.id);
  expect(calls).toEqual([]);
  // A link without a version asks arXiv only for the latest version number.
  expect((await imported('arxiv.org/pdf/2401.12345')).document?.id).toBe(doc.id);
  expect(calls.map((url) => new URL(url).pathname)).toEqual(['/api/query']);
  // Offline, a link without a version reopens the newest cached copy.
  routes.clear();
  const offline = imports;
  imports = new ArxivImports(store, documents, data, async () => {
    throw new TypeError('fetch failed');
  });
  await offline.close();
  await app.close();
  app = server();
  expect((await imported('https://arxiv.org/abs/2401.12345')).document?.id).toBe(doc.id);
  const missing = await imported('https://arxiv.org/abs/2402.00001');
  expect(missing).toMatchObject({ state: 'failed', document: null });
  expect(missing.message).toMatch(/Could not reach arXiv/);
});

it.skipIf(!readerExecutable('pandoc'))(
  'builds Reading for an import with the existing pipeline',
  async () => {
    paper(
      '2401.12345',
      1,
      gzipSync(
        tar([
          { name: 'main.tex', data: main },
          { name: 'sections/method.tex', data: 'Quadrupole formula.' },
        ]),
      ),
    );
    const doc = (await imported('2401.12345')).document!;
    const reading = await app.inject(`/api/documents/${doc.id}/reading`);
    expect(reading.json()).toMatchObject({ available: true });
    expect(reading.json().html).toContain('Gravitational waves');
    expect(reading.json().html).toContain('Quadrupole formula.');
  },
);

it('respects idempotency keys and rejects non-arXiv links with a short sentence', async () => {
  paper('hep-th/9901001', 3, gzipSync(tar([{ name: 'paper.tex', data: main }])));
  const key = randomUUID();
  const first = await post('https://arxiv.org/abs/hep-th/9901001', key);
  const again = await post('hep-th/9901001', key);
  expect(again.body.id).toBe(first.body.id);
  expect((await post('hep-th/9901002', key)).status).toBe(409);
  const done = await settled(first.body.id);
  expect(done.document).toMatchObject({ kind: 'tex', folder: 'arXiv hep-th/9901001v3' });
  expect(existsSync(join(data, 'arxiv', 'hep-th_9901001v3', 'source', 'paper.tex'))).toBe(true);
  expect(calls.filter((url) => url.includes('/src/'))).toHaveLength(1);
  const invalid = await post('https://example.com/abs/2401.12345');
  expect(invalid).toMatchObject({ status: 400 });
  expect(invalid.body.error).toMatch(/^Only arxiv\.org links can be imported\./);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/documents/arxiv',
        payload: { key, link: 'x', path: '/etc' },
      })
    ).statusCode,
  ).toBe(400);
  expect(proxyPath('POST', '/documents/arxiv')).toBe('/api/documents/arxiv');
  expect(proxyPath('GET', `/documents/arxiv/${first.body.id}`)).toBe(
    `/api/documents/arxiv/${first.body.id}`,
  );
  expect(proxyPath('GET', '/documents/arxiv/not-an-id')).toBeNull();
});

it('never caches a transient PDF failure; the next import fetches arXiv’s PDF', async () => {
  paper('2401.00010', 1, gzipSync(tar([{ name: 'main.tex', data: main }])));
  for (const failure of [
    () => new Response('busy', { status: 503 }),
    () => new Response('<html>PDF is being generated</html>'),
  ]) {
    routes.set('/pdf/2401.00010v1', failure);
    expect(await imported('2401.00010v1')).toMatchObject({
      state: 'failed',
      message: 'arXiv could not send the PDF right now. Try again later.',
    });
    expect(existsSync(join(data, 'arxiv', '2401.00010v1'))).toBe(false);
  }
  routes.set('/pdf/2401.00010v1', () => new Response(pdf));
  const doc = (await imported('2401.00010v1')).document!;
  expect(doc).toMatchObject({ kind: 'tex', state: 'ready', hasPdf: true });
  expect((await app.inject(`/api/documents/${doc.id}/pdf`)).rawPayload).toEqual(pdf);
});

it('replaces an incomplete cache entry and sweeps partial downloads at startup', async () => {
  paper('2401.00011', 1, gzipSync(tar([{ name: 'main.tex', data: main }])));
  const dir = join(data, 'arxiv', '2401.00011v1');
  await mkdir(join(dir, 'source'), { recursive: true });
  await writeFile(join(dir, 'meta.json'), '{"truncated');
  await mkdir(join(data, 'arxiv', '.partial-stale', 'source'), { recursive: true });
  const restarted = new ArxivImports(store, documents, data, fetcher);
  await imports.close();
  imports = restarted;
  await app.close();
  app = server();
  expect(await readdir(join(data, 'arxiv'))).toEqual(['2401.00011v1']);
  expect((await imported('2401.00011v1')).document).toMatchObject({ kind: 'tex', hasPdf: true });
  expect(existsSync(join(dir, 'source', 'main.tex'))).toBe(true);
  expect(calls.filter((url) => url.includes('/src/'))).toHaveLength(1);
});

it('says when arXiv has a source the app cannot read yet', async () => {
  paper('2401.00012', 1, gzipSync('%!PS-Adobe-3.0\n'));
  paper('2401.00013', 1, Buffer.from('<html>unexpected</html>'));
  for (const id of ['2401.00012', '2401.00013']) {
    const result = await imported(id);
    expect(result.message).toBe(
      'This arXiv source is in a format the app can’t read yet. Reading is unavailable; Original PDF shows arXiv’s PDF.',
    );
    expect(result.document).toMatchObject({
      kind: 'pdf',
      hasPdf: true,
      arxiv: { hasSource: true },
    });
  }
});

it('imports PDF-only papers and single gzipped TeX sources', async () => {
  // arXiv serves a PDF-only submission's PDF as its "source"; a 404 source is treated the same.
  paper('2310.00001', 1, pdf);
  paper('2310.00002', 1, null);
  for (const id of ['2310.00001', '2310.00002']) {
    const result = await imported(id);
    expect(result.document).toMatchObject({
      kind: 'pdf',
      state: 'ready',
      hasPdf: true,
      arxiv: { hasSource: false },
    });
    expect(result.message).toBe(
      'This paper has no LaTeX source on arXiv. Reading is unavailable; Original PDF shows arXiv’s PDF.',
    );
    expect(result.document!.arxiv!.notes).toEqual([result.message]);
    expect(
      (await app.inject(`/api/documents/${result.document!.id}/reading`)).json(),
    ).toMatchObject({ available: false });
    expect((await app.inject(`/api/documents/${result.document!.id}/pdf`)).rawPayload).toEqual(pdf);
  }
  const gz = gzipSync(main);
  const named = Buffer.concat([gz.subarray(0, 10), Buffer.from('waves.tex\0'), gz.subarray(10)]);
  named[3] = named[3]! | 8;
  paper('2310.00003', 1, named);
  paper('2310.00004', 1, gzipSync(main));
  expect((await imported('2310.00003')).document).toMatchObject({ kind: 'tex', hasPdf: true });
  expect(existsSync(join(data, 'arxiv', '2310.00003v1', 'source', 'waves.tex'))).toBe(true);
  expect((await imported('2310.00004')).document).toMatchObject({ kind: 'tex' });
  expect(existsSync(join(data, 'arxiv', '2310.00004v1', 'source', 'main.tex'))).toBe(true);
});

it('keeps network on arXiv hosts with caps and timeouts and refuses unsafe archives', async () => {
  paper('2401.00001', 1, gzipSync(tar([{ name: 'main.tex', data: main }])));
  routes.set(
    '/pdf/2401.00001v1',
    () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/paper.pdf' } }),
  );
  let result = await imported('2401.00001v1');
  expect(result).toMatchObject({
    state: 'failed',
    message: 'arXiv redirected to a site other than arxiv.org.',
  });
  expect(calls.some((url) => url.includes('evil.example'))).toBe(false);
  // Redirects within arXiv are followed, including relative locations.
  routes.set(
    '/pdf/2401.00001v1',
    () => new Response(null, { status: 301, headers: { location: '/pdf/moved' } }),
  );
  routes.set('/pdf/moved', () => new Response(pdf));
  expect((await imported('2401.00001v1')).document).toMatchObject({ hasPdf: true });

  paper('2401.00002', 1, gzipSync(tar([{ name: 'main.tex', data: main }])));
  arxivLimits.sourceBytes = 64;
  routes.set(
    '/src/2401.00002v1',
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(100));
            c.close();
          },
        }),
      ),
  );
  result = await imported('2401.00002v1');
  expect(result).toMatchObject({
    state: 'failed',
    message: 'This arXiv file is larger than the 0 MB import limit.',
  });
  Object.assign(arxivLimits, saved);
  routes.set(
    '/src/2401.00002v1',
    () => new Response('x', { headers: { 'content-length': String(61 * 1024 ** 2) } }),
  );
  expect((await imported('2401.00002v1')).message).toBe(
    'This arXiv file is larger than the 60 MB import limit.',
  );

  // A stalled API falls back to the abs page; both stalled ends with a timeout message.
  Object.assign(arxivLimits, { apiMs: 50, metadataMs: 50 });
  routes.set('/api/query?id_list=2401.00003&max_results=1', hang);
  routes.set('/abs/2401.00003', hang);
  expect((await imported('2401.00003')).message).toBe(
    'arXiv did not respond in time. Try again later.',
  );
  Object.assign(arxivLimits, saved);

  paper(
    '2401.00004',
    1,
    gzipSync(
      tar([
        { name: 'main.tex', data: main },
        { name: '../../escape.tex', data: 'x' },
      ]),
    ),
  );
  result = await imported('2401.00004v1');
  expect(result).toMatchObject({
    state: 'failed',
    message: 'This arXiv source tries to write outside its folder.',
  });
  expect(existsSync(join(data, 'escape.tex'))).toBe(false);
  expect(existsSync(join(data, 'arxiv', '2401.00004v1'))).toBe(false);
  expect(
    (await readdir(join(data, 'arxiv'))).filter((name) => name.startsWith('.partial')),
  ).toEqual([]);
});

it('retries a rate-limited catalogue once, then reads the abs page', async () => {
  arxivLimits.retryMs = 1;
  paper('1706.03762', 7, gzipSync(tar([{ name: 'ms.tex', data: main }])));
  routes.set(
    '/api/query?id_list=1706.03762&max_results=1',
    () => new Response('', { status: 429 }),
  );
  routes.set(
    '/abs/1706.03762',
    () =>
      new Response(`<html><head><meta name="citation_title" content="Attention Is All You Need" />
      <meta name="citation_author" content="Vaswani, Ashish" /><meta name="citation_author" content="Shazeer, Noam" />
      <meta name="citation_arxiv_id" content="1706.03762" /><meta name="citation_abstract" content="The dominant &amp; sequence models." />
      </head><body>[v1] ... [v6] ... [v7]</body></html>`),
  );
  const result = await imported('https://arxiv.org/abs/1706.03762');
  expect(result.document).toMatchObject({
    name: 'Attention Is All You Need',
    arxiv: {
      version: 7,
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      abstract: 'The dominant & sequence models.',
    },
  });
  expect(calls.map((url) => new URL(url).pathname)).toEqual([
    '/api/query',
    '/api/query',
    '/abs/1706.03762',
    '/pdf/1706.03762v7',
    '/src/1706.03762v7',
  ]);
  routes.set(
    '/api/query?id_list=2401.99999&max_results=1',
    () => new Response('', { status: 503 }),
  );
  expect((await imported('2401.99999')).message).toBe('arXiv has no paper with the ID 2401.99999.');
});

it('marks interrupted imports as failed after a restart', async () => {
  routes.set('/api/query?id_list=2401.00005&max_results=1', hang);
  const started = await post('2401.00005');
  await expect.poll(() => imports.get(started.body.id).state).toBe('fetching');
  // A new process sees the unfinished row; the stopped one aborts its own request.
  const restarted = new ArxivImports(store, documents, data, fetcher);
  expect(restarted.get(started.body.id)).toMatchObject({
    state: 'failed',
    message: 'The computer stopped during this import. Import the link again to retry.',
  });
  await imports.close();
  imports = restarted;
  expect(calls).toHaveLength(1);
});
