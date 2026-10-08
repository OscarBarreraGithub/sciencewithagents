import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  arxivImportRequestSchema,
  arxivImportSchema,
  arxivPaperSchema,
  type ArxivImport,
  type ArxivPaper,
} from '@dock/shared';
import {
  ArxivLinkError,
  type ArxivRef,
  type SourceFile,
  detectMainFile,
  extractTar,
  gunzipLimited,
  gzipName,
  parseArxivLink,
  safeArxivId,
  sniffFormat,
  UnsafeArchiveError,
} from './arxiv-source.js';
import type { Documents } from './documents.js';
import { Conflict, Invalid, Missing, Store, now } from './store.js';

/**
 * Server-side arXiv import. The client sends only a link; this host chooses every URL,
 * talks only to arXiv over HTTPS, caps sizes and time, and caches each id+version under
 * data/arxiv so a repeat import needs no network.
 */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Job = Omit<ArxivImport, 'document'> & { documentId: string | null };
const cacheMetaSchema = z.object({
  paper: arxivPaperSchema,
  main: z.string().nullable(),
  pdf: z.boolean(),
});
type CacheMeta = z.infer<typeof cacheMetaSchema>;

const userAgent = 'sciencewithagents/0.1 (LaTeX reader arXiv import; single-user desktop app)';
const allowedHosts = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);
export const arxivLimits = {
  sourceBytes: 60 * 1024 ** 2,
  // Matches the document reader's PDF limit.
  pdfBytes: 50 * 1024 ** 2,
  metadataBytes: 2 * 1024 ** 2,
  // The Atom API can stall when busy; the abs page is the fallback.
  apiMs: 10_000,
  metadataMs: 20_000,
  // arXiv asks API clients to wait about three seconds between requests.
  retryMs: 3_000,
  fileMs: 120_000,
  texReadBytes: 8 * 1024 ** 2,
};
const noSourceNote =
  'This paper has no LaTeX source on arXiv. Reading is unavailable; Original PDF shows arXiv’s PDF.';
const unreadableNote =
  'This arXiv source is in a format the app can’t read yet. Reading is unavailable; Original PDF shows arXiv’s PDF.';
const noMainNote =
  'No main LaTeX file was found in the arXiv source, so Reading is unavailable. Original PDF shows arXiv’s PDF.';

class ImportFailure extends Error {}
/** arXiv could not be reached or did not answer; a cached copy may stand in. */
class Unreachable extends ImportFailure {}

async function download(
  fetcher: Fetcher,
  url: string,
  options: { maxBytes: number; timeoutMs: number; signal: AbortSignal },
) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname))
        throw new ImportFailure('arXiv redirected to a site other than arxiv.org.');
      const response = await fetcher(target.href, {
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': userAgent },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) throw new ImportFailure('arXiv sent an incomplete redirect.');
        url = new URL(location, target).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, data: Buffer.alloc(0) };
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      const tooLarge = `This arXiv file is larger than the ${Math.round(options.maxBytes / 1024 ** 2)} MB import limit.`;
      if (declared > options.maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new ImportFailure(tooLarge);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      if (response.body)
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          total += chunk.length;
          if (total > options.maxBytes) throw new ImportFailure(tooLarge);
          chunks.push(Buffer.from(chunk));
        }
      return { status: response.status, data: Buffer.concat(chunks) };
    }
    throw new ImportFailure('arXiv redirected too many times.');
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    if (options.signal.aborted)
      throw new ImportFailure('The import stopped because the app is restarting.');
    if ((error as { name?: string }).name === 'TimeoutError')
      throw new Unreachable('arXiv did not respond in time. Try again later.');
    throw new Unreachable('Could not reach arXiv. Check this computer’s internet connection.');
  }
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
      name[0] === '#'
        ? String.fromCodePoint(
            parseInt(name.slice(name[1] === 'x' ? 2 : 1), name[1] === 'x' ? 16 : 10),
          )
        : (entities[name] ?? whole),
    )
    .replace(/\s+/g, ' ')
    .trim();

/** Reads title, authors, abstract and the resolved version from the arXiv Atom API response. */
export function parseArxivAtom(
  xml: string,
  ref: ArxivRef,
): Omit<ArxivPaper, 'hasSource' | 'notes'> {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  const tag = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(entry ?? '')?.[1];
  const id = xmlText(tag('id') ?? '');
  const version = /\/abs\/(.+)v(\d+)$/.exec(id);
  if (!entry || !version || /api\/errors/.test(id))
    throw new Missing(
      ref.version
        ? `arXiv has no version ${ref.version} of ${ref.id}.`
        : `arXiv has no paper with the ID ${ref.id}.`,
    );
  return {
    id: ref.id,
    version: Number(version[2]),
    title: xmlText(tag('title') ?? '') || ref.id,
    authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => xmlText(m[1]!)),
    abstract: xmlText(tag('summary') ?? ''),
    absUrl: `https://arxiv.org/abs/${ref.id}v${version[2]}`,
  };
}

/** Fallback when the API is rate limited: the abs page's citation tags and submission history. */
export function parseArxivAbsPage(
  html: string,
  ref: ArxivRef,
): Omit<ArxivPaper, 'hasSource' | 'notes'> {
  const meta = (name: string) =>
    [...html.matchAll(new RegExp(`<meta name="citation_${name}" content="([^"]*)"`, 'g'))].map(
      (match) => xmlText(match[1]!),
    );
  const latest = Math.max(0, ...[...html.matchAll(/\[v(\d+)\]/g)].map((m) => Number(m[1])));
  const version = ref.version ?? latest;
  if (!meta('arxiv_id').length || !version)
    throw new ImportFailure('arXiv’s catalogue is unavailable right now. Try again in a minute.');
  return {
    id: ref.id,
    version,
    title: meta('title')[0] || ref.id,
    // Citation tags list "Last, First"; the API and the reader show "First Last".
    authors: meta('author').map((name) => name.replace(/^([^,]+),\s*([^,]+)$/, '$2 $1')),
    abstract: meta('abstract')[0] ?? '',
    absUrl: `https://arxiv.org/abs/${ref.id}v${version}`,
  };
}

export class ArxivImports {
  private directory: string;
  private active: Promise<void> | null = null;
  private stopping = new AbortController();
  constructor(
    private store: Store,
    private documents: Documents,
    dataDir: string,
    private fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {
    this.directory = resolve(dataDir, 'arxiv');
    // Partial downloads from a stopped process are never reused.
    for (const name of existsSync(this.directory) ? readdirSync(this.directory) : [])
      if (name.startsWith('.partial-'))
        rmSync(join(this.directory, name), { recursive: true, force: true });
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS arxiv_imports (id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    );
    for (const row of store.db.prepare('SELECT body FROM arxiv_imports').all()) {
      const job = JSON.parse(String(row.body)) as Job;
      if (['queued', 'fetching'].includes(job.state))
        this.save({
          ...job,
          state: 'failed',
          message: 'The computer stopped during this import. Import the link again to retry.',
        });
    }
  }
  private read(id: string): Job {
    const row = this.store.db
      .prepare('SELECT body FROM arxiv_imports WHERE id=?')
      .get(z.string().uuid().parse(id));
    if (!row) throw new Missing('This arXiv import is not on this computer.');
    return JSON.parse(String(row.body)) as Job;
  }
  private public(job: Job): ArxivImport {
    const { documentId, ...value } = job;
    return arxivImportSchema.parse({
      ...value,
      document: documentId ? this.documents.get(documentId) : null,
    });
  }
  private save(job: Job) {
    job = { ...job, updatedAt: now() };
    this.store.db
      .prepare(
        'INSERT INTO arxiv_imports VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(job.id, JSON.stringify(job));
    this.store.event(`document.arxiv.${job.state}`, null, null, this.public(job));
    return job;
  }
  get(id: string) {
    return this.public(this.read(id));
  }
  /** Records the import durably under the idempotency key; fetching continues in the background. */
  start(raw: unknown) {
    const input = arxivImportRequestSchema.parse(raw);
    let ref: ArxivRef;
    try {
      ref = parseArxivLink(input.link);
    } catch (error) {
      if (error instanceof ArxivLinkError) throw new Invalid(error.message);
      throw error;
    }
    if (this.stopping.signal.aborted)
      throw new Conflict('The reader is restarting. Try again in a moment.');
    const { id } = this.store.operation(`arxiv:${input.key}`, ref, () => {
      const at = now();
      const job = this.save({
        id: randomUUID(),
        arxivId: ref.id,
        version: ref.version,
        state: 'queued',
        message: 'Waiting to fetch from arXiv.',
        documentId: null,
        createdAt: at,
        updatedAt: at,
      });
      return { id: job.id };
    });
    queueMicrotask(() => this.pump());
    return this.get(id);
  }
  private pump() {
    if (this.active || this.stopping.signal.aborted) return;
    const row = this.store.db
      .prepare(
        "SELECT body FROM arxiv_imports WHERE json_extract(body,'$.state')='queued' ORDER BY json_extract(body,'$.createdAt') LIMIT 1",
      )
      .get();
    if (!row) return;
    // One import at a time keeps requests to arXiv polite.
    this.active = this.run(JSON.parse(String(row.body)) as Job).finally(() => {
      this.active = null;
      this.pump();
    });
  }
  private async run(job: Job) {
    job = this.save({ ...job, state: 'fetching', message: 'Fetching from arXiv.' });
    try {
      const ref = { id: job.arxivId, version: job.version };
      const cached = await this.fetchOrCache(ref);
      const document = await this.register(cached.dir, cached.meta);
      this.save({
        ...job,
        version: cached.meta.paper.version,
        state: 'ready',
        message: cached.meta.paper.notes[0] ?? 'Ready to read.',
        documentId: document.id,
      });
    } catch (error) {
      const known =
        error instanceof ImportFailure ||
        error instanceof UnsafeArchiveError ||
        error instanceof Missing ||
        error instanceof Conflict;
      this.save({
        ...job,
        state: 'failed',
        message: known
          ? (error as Error).message
          : 'The arXiv import failed on this computer. Try again.',
      });
    }
  }
  private cachePath(id: string, version: number) {
    return join(this.directory, `${safeArxivId(id)}v${version}`);
  }
  /** A complete cache entry, or null. An incomplete entry is removed so the next fetch replaces it. */
  private async readCache(id: string, version: number) {
    const dir = this.cachePath(id, version);
    if (!existsSync(dir)) return null;
    try {
      const meta = cacheMetaSchema.parse(
        JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')),
      );
      const files = [
        ...(meta.pdf ? [join(dir, 'paper.pdf')] : []),
        ...(meta.main ? [join(dir, 'source', ...meta.main.split('/'))] : []),
      ];
      if (meta.paper.version === version && files.every((file) => existsSync(file)))
        return { dir, meta };
    } catch {
      /* Missing or damaged meta.json. */
    }
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  private async latestCached(id: string) {
    const prefix = `${safeArxivId(id)}v`;
    const versions = (await readdir(this.directory).catch(() => [] as string[]))
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .map((name) => Number(name.slice(prefix.length)))
      .sort((a, b) => b - a);
    for (const version of versions) {
      const cached = await this.readCache(id, version);
      if (cached) return cached;
    }
    return null;
  }
  private async fetchOrCache(ref: ArxivRef) {
    if (ref.version) {
      const cached = await this.readCache(ref.id, ref.version);
      if (cached) return cached;
    }
    let paper: Omit<ArxivPaper, 'hasSource' | 'notes'>;
    try {
      paper = await this.metadata(ref);
    } catch (error) {
      // Offline, a link without a version reopens the newest copy already on this computer.
      const cached =
        !ref.version && error instanceof Unreachable ? await this.latestCached(ref.id) : null;
      if (cached) return cached;
      throw error;
    }
    return (await this.readCache(ref.id, paper.version)) ?? (await this.downloadPaper(paper));
  }
  private async metadata(ref: ArxivRef) {
    const name = `${ref.id}${ref.version ? `v${ref.version}` : ''}`;
    const options = {
      maxBytes: arxivLimits.metadataBytes,
      timeoutMs: arxivLimits.metadataMs,
      signal: this.stopping.signal,
    };
    const api = `https://export.arxiv.org/api/query?id_list=${name}&max_results=1`;
    const apiOptions = { ...options, timeoutMs: arxivLimits.apiMs };
    try {
      let response = await download(this.fetcher, api, apiOptions);
      if ([429, 503].includes(response.status)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.stopping.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, arxivLimits.retryMs);
          this.stopping.signal.addEventListener('abort', done, { once: true });
        });
        response = await download(this.fetcher, api, apiOptions);
      }
      if (response.status === 200) return parseArxivAtom(response.data.toString('utf8'), ref);
    } catch (error) {
      if (!(error instanceof ImportFailure) || this.stopping.signal.aborted) throw error;
    }
    // The API is often rate limited or stalled; the paper's abs page carries the same essentials.
    const page = await download(this.fetcher, `https://arxiv.org/abs/${name}`, options);
    if (page.status === 404)
      throw new Missing(
        ref.version
          ? `arXiv has no version ${ref.version} of ${ref.id}.`
          : `arXiv has no paper with the ID ${ref.id}.`,
      );
    if (page.status !== 200)
      throw new ImportFailure('arXiv’s catalogue is unavailable right now. Try again in a minute.');
    return parseArxivAbsPage(page.data.toString('utf8'), ref);
  }
  private async downloadPaper(paper: Omit<ArxivPaper, 'hasSource' | 'notes'>) {
    const name = `${paper.id}v${paper.version}`;
    const limits = { timeoutMs: arxivLimits.fileMs, signal: this.stopping.signal };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const partial = join(this.directory, `.partial-${randomUUID()}`);
    await mkdir(partial, { mode: 0o700 });
    try {
      const pdf = await download(this.fetcher, `https://arxiv.org/pdf/${name}`, {
        ...limits,
        maxBytes: arxivLimits.pdfBytes,
      });
      // Only 403/404 mean arXiv has no PDF; anything else may be transient and is never cached.
      let pdfData: Buffer | null =
        pdf.status === 200 && sniffFormat(pdf.data) === 'pdf' ? pdf.data : null;
      const pdfMissing = !pdfData && [403, 404].includes(pdf.status);
      const source = await download(this.fetcher, `https://arxiv.org/src/${name}`, {
        ...limits,
        maxBytes: arxivLimits.sourceBytes,
      });
      if (source.status !== 200 && ![403, 404].includes(source.status))
        throw new ImportFailure(
          `arXiv could not send the source (HTTP ${source.status}). Try again later.`,
        );
      const notes: string[] = [];
      let hasSource = false,
        unreadable = false,
        main: string | null = null;
      if (source.status === 200) {
        let payload: Buffer = source.data;
        let format = sniffFormat(payload);
        let original: string | null = null;
        if (format === 'gzip') {
          original = gzipName(payload);
          payload = await gunzipLimited(payload, 250 * 1024 ** 2);
          format = sniffFormat(payload);
        }
        const tree = join(partial, 'source');
        if (format === 'tar') {
          const extracted = await extractTar(payload, tree).catch((error: unknown) => {
            if (error instanceof UnsafeArchiveError) throw error;
            throw new UnsafeArchiveError('This arXiv source archive could not be unpacked safely.');
          });
          hasSource = extracted.files.length > 0;
          unreadable = !hasSource;
          if (extracted.skipped)
            notes.push(`Skipped ${extracted.skipped} linked or special files in the arXiv source.`);
          main = hasSource ? detectMainFile(await this.sourceFiles(tree, extracted.files)) : null;
        } else if (format === 'tex') {
          const file = original && /^[\w.-]+\.tex$/i.test(original) ? original : 'main.tex';
          await mkdir(tree, { mode: 0o700 });
          await writeFile(join(tree, file), payload, { mode: 0o600 });
          hasSource = true;
          main = file;
        } else if (format === 'pdf') {
          // PDF-only submissions serve the PDF as their "source".
          pdfData ??= payload;
        } else {
          unreadable = true;
        }
      }
      if (!pdfData && !pdfMissing)
        throw new ImportFailure('arXiv could not send the PDF right now. Try again later.');
      if (unreadable) notes.unshift(unreadableNote);
      else if (!hasSource) notes.unshift(noSourceNote);
      else if (!main) notes.unshift(noMainNote);
      if (!pdfData && !main)
        throw new ImportFailure(
          'arXiv did not provide a readable PDF or LaTeX source for this paper.',
        );
      if (pdfData) await writeFile(join(partial, 'paper.pdf'), pdfData, { mode: 0o600 });
      const meta: CacheMeta = {
        paper: { ...paper, hasSource: hasSource || unreadable, notes },
        main,
        pdf: !!pdfData,
      };
      await writeFile(join(partial, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
      const dir = this.cachePath(paper.id, paper.version);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await rename(partial, dir);
        } catch {
          // A complete copy saved first is kept; an incomplete one is removed and replaced once.
        }
        const cached = await this.readCache(paper.id, paper.version);
        if (cached) return cached;
      }
      throw new ImportFailure('The arXiv copy could not be saved on this computer.');
    } finally {
      // Already renamed on success; otherwise this partial copy is discarded.
      await rm(partial, { recursive: true, force: true }).catch(() => {});
    }
  }
  private async sourceFiles(tree: string, files: { path: string; size: number }[]) {
    const result: SourceFile[] = [];
    for (const file of files) {
      const readable =
        file.size <= arxivLimits.texReadBytes &&
        (/\.(?:tex|ltx|latex)$/i.test(file.path) || /^00README\.(?:json|XXX)$/i.test(file.path));
      result.push(
        readable
          ? { ...file, text: await readFile(join(tree, ...file.path.split('/')), 'utf8') }
          : file,
      );
    }
    return result;
  }
  private register(dir: string, meta: CacheMeta) {
    const pdf = meta.pdf ? join(dir, 'paper.pdf') : null;
    const source = join(dir, 'source');
    return this.documents.registerImported({
      root: meta.main ? source : dir,
      path: meta.main ? join(source, ...meta.main.split('/')) : pdf!,
      pdf: pdf && existsSync(pdf) ? pdf : null,
      name: meta.paper.title,
      folder: `arXiv ${meta.paper.id}v${meta.paper.version}`,
      arxiv: meta.paper,
    });
  }
  async close() {
    this.stopping.abort();
    await this.active;
  }
}

export function registerArxivImportRoutes(app: FastifyInstance, imports: ArxivImports) {
  app.post('/api/documents/arxiv', (request) => imports.start(request.body));
  app.get('/api/documents/arxiv/:id', (request) =>
    imports.get(z.object({ id: z.string().uuid() }).parse(request.params).id),
  );
}
