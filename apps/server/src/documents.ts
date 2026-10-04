import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, existsSync, accessSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  documentSchema,
  documentActionSchema,
  documentBrowseQuerySchema,
  savedDocumentLinkSchema,
  savedDocumentLinks,
  type DocumentReading,
  type SavedDocument,
} from '@dock/shared';
import { FolderBrowser } from './folder-browser.js';
import { Conflict, Missing, Store, now } from './store.js';
import { buildReading } from './document-reading.js';

const maxBytes = 50 * 1024 ** 2;
const inside = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
type Record = SavedDocument & { path: string; root: string; revision: string | null };
export function latexCompiler() {
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), 'Library/TinyTeX/bin/universal-darwin'),
    '/Library/TeX/texbin',
  ];
  for (const name of ['latexmk', 'tectonic'])
    for (const directory of dirs.filter(Boolean)) {
      const path = join(directory, name);
      try {
        accessSync(path, constants.X_OK);
        return { name, path };
      } catch {
        /* Next install. */
      }
    }
  return null;
}

/** Authenticated local document library. Paths are issued by the host, not submitted by web clients. */
export class Documents {
  readonly browser: FolderBrowser;
  private directory: string;
  private active: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private stopped = false;
  private readings = new Map<string, Promise<DocumentReading>>();
  private readingQueue: Promise<unknown> = Promise.resolve();
  private stopCompiler() {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* The owned compiler already finished. */
    }
  }
  constructor(
    private store: Store,
    dataDir: string,
    home = homedir(),
  ) {
    this.directory = resolve(dataDir, 'documents');
    this.browser = new FolderBrowser(dataDir, home);
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, body TEXT NOT NULL)',
    );
    for (const row of store.db.prepare('SELECT body FROM documents').all()) {
      const doc = JSON.parse(String(row.body)) as Record;
      if (['queued', 'building'].includes(doc.state))
        this.save({
          ...doc,
          state: 'failed',
          error:
            'The computer stopped during this build. Your source and previous PDF are safe. Choose Rebuild to try again.',
        });
    }
  }
  private read(id: string): Record {
    const row = this.store.db
      .prepare('SELECT body FROM documents WHERE id=?')
      .get(z.string().uuid().parse(id));
    if (!row) throw new Missing('This document is not in this computer’s library.');
    return JSON.parse(String(row.body)) as Record;
  }
  private public(doc: Record): SavedDocument {
    const { path: _path, root: _root, revision: _revision, ...value } = doc;
    return documentSchema.parse(value);
  }
  private save(doc: Record, transactional = true) {
    const write = () => {
      this.store.db
        .prepare(
          'INSERT INTO documents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(doc.id, doc.path, JSON.stringify(doc));
      this.store.event(`document.${doc.state}`, null, null, this.public(doc));
    };
    if (transactional) this.store.transaction(write);
    else write();
    return this.public(doc);
  }
  get(id: string) {
    return this.public(this.read(id));
  }
  list() {
    return {
      compiler: latexCompiler()?.name ?? null,
      documents: this.store.db
        .prepare(
          "SELECT body FROM documents WHERE json_extract(body,'$.openedAt') IS NOT NULL ORDER BY json_extract(body,'$.openedAt') DESC LIMIT 24",
        )
        .all()
        .map((row) => this.public(JSON.parse(String(row.body)))),
    };
  }
  async register(root: string, path: string) {
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(path);
    const info = await stat(canonical);
    const extension = extname(canonical).toLowerCase();
    if (
      !inside(canonicalRoot, canonical) ||
      !info.isFile() ||
      !['.tex', '.pdf'].includes(extension)
    )
      throw new Conflict('Choose a .tex or .pdf file within this folder.');
    if (info.size > maxBytes)
      throw new Conflict('This file is larger than the 50 MB reader limit.');
    const existing = this.store.db
      .prepare('SELECT body FROM documents WHERE path=?')
      .get(canonical);
    if (existing) return this.public(JSON.parse(String(existing.body)));
    const id = randomUUID();
    return this.save({
      id,
      path: canonical,
      root: canonicalRoot,
      name: basename(canonical),
      folder: basename(dirname(canonical)),
      kind: extension === '.tex' ? 'tex' : 'pdf',
      state: 'source',
      hasPdf: false,
      builtAt: null,
      openedAt: null,
      error: null,
      revision: null,
      href: `#/latex/${id}`,
    });
  }
  async registerRelative(root: string, path: string) {
    if (isAbsolute(path) || path.includes('\0') || !inside(resolve(root), resolve(root, path)))
      throw new Conflict('Use a project-relative .tex or .pdf path.');
    return this.register(root, resolve(root, path));
  }
  private agentRoots(agentId: string) {
    const agent = this.store.agent(agentId);
    return [
      ...new Set([
        agent.cwd,
        this.store.project(agent.projectId).root,
        // Project-scoped managers used this host-owned workspace before their cwd migration.
        ...(agent.role === 'manager' && !agent.surface
          ? [resolve(this.directory, '..', 'managers', agent.id)]
          : []),
      ]),
    ];
  }
  async registerAgentRelative(agentId: string, path: string) {
    const agent = this.store.agent(agentId);
    const roots =
      agent.role === 'manager' && !agent.surface ? this.agentRoots(agentId) : [agent.cwd];
    let failure: unknown;
    for (const root of roots) {
      try {
        return await this.registerRelative(root, path);
      } catch (error) {
        failure ??= error;
      }
    }
    throw failure;
  }
  async fromSavedLink(raw: unknown) {
    const input = savedDocumentLinkSchema.parse(raw);
    const agent = this.store.agent(input.agentId);
    const entry = this.store.savedEntry(agent.id, input.entryId);
    const href =
      entry && ['assistant', 'user'].includes(entry.kind)
        ? savedDocumentLinks(entry.text)[input.index]
        : undefined;
    if (!href) throw new Missing('This saved message does not contain that document link.');
    let path: string;
    try {
      path = decodeURIComponent(href.startsWith('file://') ? new URL(href).pathname : href);
    } catch {
      throw new Conflict('This saved file link is invalid.');
    }
    // A message is evidence of the link, not authority to read outside its workspaces.
    for (const root of this.agentRoots(agent.id)) {
      try {
        return await this.register(root, path);
      } catch {
        /* check the other allowed workspace */
      }
    }
    throw new Conflict(
      'The linked document is unavailable or outside this conversation’s project and workspace. Find it through Apps → LaTeX instead.',
    );
  }
  reading(id: string): Promise<DocumentReading> {
    const doc = this.read(id);
    if (this.stopped) throw new Conflict('The reader is restarting. Try again in a moment.');
    const existing = this.readings.get(id);
    if (existing) return existing;
    const work = this.readingQueue.then(async () => {
      let source = doc.path;
      if (doc.kind === 'pdf') source = source.replace(/\.pdf$/i, '.tex');
      const canonical = await realpath(source).catch(() => null);
      if (!canonical || !inside(doc.root, canonical))
        return { available: false, html: '', warnings: [], labels: {} };
      return buildReading(canonical, doc.root, join(this.directory, `${id}-assets`));
    });
    this.readingQueue = work.catch(() => {});
    this.readings.set(id, work);
    void work.finally(() => this.readings.delete(id)).catch(() => {});
    return work;
  }
  async readingAsset(id: string, asset: string) {
    this.read(id);
    if (!/^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(asset))
      throw new Missing('No such figure.');
    return readFile(join(this.directory, `${id}-assets`, asset));
  }
  async browse(folderId?: string, offset = 0) {
    const folders = await this.browser.browse(folderId, offset);
    const path = await this.browser.resolve(folders.current.id);
    const files = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(tex|pdf)$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const documents: SavedDocument[] = [];
    for (const entry of files.slice(offset, offset + 100)) {
      try {
        documents.push(await this.register(path, join(path, entry.name)));
      } catch {
        /* Unreadable/oversized entries cannot be opened. */
      }
    }
    return {
      ...folders,
      folders: folders.folders.filter((folder) => !folder.name.startsWith('.')),
      files: documents,
      nextFileOffset: offset + 100 < files.length ? offset + 100 : null,
    };
  }
  private async source(doc: Record) {
    const path = await realpath(doc.path);
    if (path !== doc.path || !inside(doc.root, path))
      throw new Conflict('This source moved. Browse to it again.');
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxBytes)
      throw new Conflict('The source must be a regular file smaller than 50 MB.');
    return { path, revision: `${info.size}:${info.mtimeMs}` };
  }
  async open(id: string, key: string, rebuild = false) {
    if (this.store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(`document:${key}`))
      return this.store.operation(`document:${key}`, { id, rebuild }, () => this.get(id));
    let doc = this.read(id);
    if (this.stopped) throw new Conflict('The reader is restarting. Try again in a moment.');
    const source = await this.source(doc).catch(() => null);
    if (!source && !doc.hasPdf)
      throw new Conflict('The source file is unavailable on this computer. Browse to it again.');
    if (rebuild && !source)
      throw new Conflict('The source file is unavailable. The previous PDF is still readable.');
    // A .tex file may include edited figures or chapters: explicit Rebuild always refreshes all inputs.
    return this.store.operation(`document:${key}`, { id, rebuild }, () => {
      doc = this.read(id);
      if (['queued', 'building'].includes(doc.state)) return this.get(id);
      const build = source && (rebuild || !doc.hasPdf || source.revision !== doc.revision);
      const result = this.save(
        { ...doc, openedAt: now(), ...(build ? { state: 'queued' as const, error: null } : {}) },
        false,
      );
      if (build) queueMicrotask(() => this.pump());
      return result;
    });
  }
  private pump() {
    if (this.active || this.stopped) return;
    const row = this.store.db
      .prepare(
        "SELECT body FROM documents WHERE json_extract(body,'$.state')='queued' ORDER BY json_extract(body,'$.openedAt') LIMIT 1",
      )
      .get();
    if (!row) return;
    this.active = this.build(JSON.parse(String(row.body))).finally(() => {
      this.active = null;
      this.pump();
    });
  }
  private async build(doc: Record) {
    const scratch = join(this.directory, 'builds', randomUUID());
    this.save({ ...doc, state: 'building' });
    try {
      const source = await this.source(doc);
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      let output = source.path;
      if (doc.kind === 'tex') {
        const compiler = latexCompiler();
        if (!compiler)
          throw new Error(
            'LaTeX is not installed on this computer. Ask your setup agent to install Tectonic or TeX Live with latexmk, then choose Rebuild. Existing PDFs need no compiler.',
          );
        const out = join(scratch, 'output');
        await mkdir(out, { mode: 0o700 });
        const input = source.path;
        if (this.stopped) throw new Error('Build interrupted. Choose Rebuild to try again.');
        const args =
          compiler.name === 'tectonic'
            ? ['--untrusted', '--keep-logs', '--outdir', out, `./${basename(input)}`]
            : [
                '-norc',
                '-pdf',
                '-interaction=nonstopmode',
                '-halt-on-error',
                '-file-line-error',
                '-no-shell-escape',
                `-outdir=${out}`,
                `./${basename(input)}`,
              ];
        await new Promise<void>((resolve, reject) => {
          let timedOut = false,
            tooMuchOutput = false,
            outputBytes = 0,
            outputText = '';
          const deadline = setTimeout(() => {
            timedOut = true;
            this.stopCompiler();
          }, 120000);
          const child = (this.child = spawn(compiler.path, args, {
            cwd: dirname(input),
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: {
              ...process.env,
              PATH: `${dirname(compiler.path)}${delimiter}${process.env.PATH ?? ''}`,
              openout_any: 'p',
              openin_any: 'a',
              TEXMFOUTPUT: out,
              TECTONIC_UNTRUSTED_MODE: '1',
            },
          }));
          const collect = (chunk: Buffer) => {
            outputBytes += chunk.length;
            outputText = (outputText + chunk.toString()).slice(-6000);
            if (outputBytes > 1024 * 1024) {
              tooMuchOutput = true;
              this.stopCompiler();
            }
          };
          child.stdout!.on('data', collect);
          child.stderr!.on('data', collect);
          child.once('error', (error) => {
            clearTimeout(deadline);
            this.child = null;
            reject(error);
          });
          child.once('close', (code) => {
            clearTimeout(deadline);
            this.child = null;
            if (code === 0) resolve();
            else
              reject(
                new Error(
                  timedOut
                    ? 'The build exceeded two minutes. The previous PDF is safe. Check the source and try again.'
                    : tooMuchOutput
                      ? 'The compiler produced too many errors. Check the source before rebuilding.'
                      : outputText
                          .replaceAll(scratch, '[build]')
                          .replaceAll(doc.root, '[source]')
                          .trim()
                          .slice(-5000) ||
                        'LaTeX could not build this file. Check the source and try again.',
                ),
              );
          });
        });
        output = join(out, `${basename(source.path, extname(source.path))}.pdf`);
      }
      const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (!info.isFile() || info.size > maxBytes || header.toString() !== '%PDF-')
          throw new Error('The build did not produce a valid PDF smaller than 50 MB.');
        await writeFile(join(scratch, 'ready.pdf'), await handle.readFile(), { mode: 0o600 });
      } finally {
        await handle.close();
      }
      await rename(join(scratch, 'ready.pdf'), this.pdfPath(doc.id));
      this.save({
        ...this.read(doc.id),
        state: 'ready',
        hasPdf: true,
        error: null,
        builtAt: now(),
        revision: source.revision,
      });
    } catch (error) {
      this.save({
        ...this.read(doc.id),
        state: 'failed',
        error:
          error instanceof Error ? error.message : 'Build failed. Choose Rebuild to try again.',
      });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  private pdfPath(id: string) {
    return join(this.directory, `${z.string().uuid().parse(id)}.pdf`);
  }
  async pdf(id: string) {
    const doc = this.read(id);
    const path = this.pdfPath(id);
    if (!doc.hasPdf || !existsSync(path))
      throw new Missing('The PDF is not ready. Open the document to build it.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return { data: await handle.readFile(), name: doc.name.replace(/\.tex$/i, '.pdf') };
    } finally {
      await handle.close();
    }
  }
  async close() {
    this.stopped = true;
    this.stopCompiler();
    await this.active;
    await this.readingQueue;
  }
}

export function registerDocumentRoutes(app: FastifyInstance, documents: Documents) {
  const id = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.get('/api/documents', () => documents.list());
  app.post('/api/documents/from-message', (request) => documents.fromSavedLink(request.body));
  app.get('/api/documents/browse', (request) => {
    const query = documentBrowseQuerySchema.parse(request.query);
    return documents.browse(query.folderId, query.offset);
  });
  app.get('/api/documents/:id', (request) => documents.get(id(request.params)));
  app.get('/api/documents/:id/reading', (request) => documents.reading(id(request.params)));
  app.get('/api/documents/:id/assets/:asset', async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), asset: z.string() }).parse(request.params);
    const data = await documents.readingAsset(params.id, params.asset);
    const extension = extname(params.asset).slice(1);
    return reply
      .header('Cache-Control', 'private, max-age=3600')
      .type(`image/${extension === 'jpg' ? 'jpeg' : extension}`)
      .send(data);
  });
  for (const action of ['open', 'build'])
    app.post(`/api/documents/:id/${action}`, (request) =>
      documents.open(
        id(request.params),
        documentActionSchema.parse(request.body).key,
        action === 'build',
      ),
    );
  app.get('/api/documents/:id/pdf', async (request, reply) => {
    const pdf = await documents.pdf(id(request.params));
    return reply
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Disposition',
        `inline; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(pdf.name)}`,
      )
      .type('application/pdf')
      .send(pdf.data);
  });
}
