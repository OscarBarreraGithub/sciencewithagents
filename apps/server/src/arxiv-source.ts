import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { dirname, join, posix, sep } from 'node:path';

/** Pure arXiv source helpers: link parsing, format sniffing, safe tar extraction and main-file choice. */

export type ArxivRef = { id: string; version: number | null };
export class ArxivLinkError extends Error {}

const linkHelp =
  'Paste an arXiv link such as arxiv.org/abs/2401.12345 or an ID like hep-th/9901001.';
// New style: YYMM.NNNN (2007–2014) or YYMM.NNNNN (2015+). Old style: archive[.SUBJ]/YYMMNNN.
const newStyle = /^(\d{4}\.\d{4,5})(?:v(\d+))?$/;
const oldStyle = /^([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?$/;
const arxivHosts = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);

function bareId(value: string): ArxivRef | null {
  const match = newStyle.exec(value) ?? oldStyle.exec(value);
  if (!match) return null;
  if (newStyle.test(value)) {
    const month = Number(value.slice(2, 4));
    if (month < 1 || month > 12) return null;
  }
  const version = match[2] === undefined ? null : Number(match[2]);
  if (version === 0) return null;
  // The old-style subject class (math.GT/…) is presentational, not part of the identifier.
  return { id: match[1]!.replace(/\.[A-Z]{2}\//, '/'), version };
}

/** Accepts arXiv abs/pdf/html/format/src links, `arXiv:ID` and bare IDs; returns a canonical reference. */
export function parseArxivLink(input: string): ArxivRef {
  const text = input.trim();
  if (!text || text.length > 2048) throw new ArxivLinkError(linkHelp);
  const prefixed = /^arxiv:\s*(.+)$/i.exec(text);
  const direct = bareId(prefixed ? prefixed[1]!.trim() : text);
  if (direct) return direct;
  if (prefixed) throw new ArxivLinkError(`That is not a valid arXiv ID. ${linkHelp}`);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new ArxivLinkError(linkHelp);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !arxivHosts.has(url.hostname.toLowerCase()))
    throw new ArxivLinkError(`Only arxiv.org links can be imported. ${linkHelp}`);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new ArxivLinkError(linkHelp);
  }
  const match = /^\/(?:abs|pdf|html|format|src|e-print)\/(.+?)\/?$/.exec(path);
  const ref = match && bareId(match[1]!.replace(/\.pdf$/i, ''));
  if (!ref) throw new ArxivLinkError(`That arXiv link does not name a paper. ${linkHelp}`);
  return ref;
}

export const safeArxivId = (id: string) => id.replace('/', '_');

export type SourceFormat = 'gzip' | 'tar' | 'pdf' | 'postscript' | 'tex' | 'unknown';
/** Identifies a payload by content only; arXiv's Content-Type is not trusted. */
export function sniffFormat(data: Uint8Array): SourceFormat {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return 'gzip';
  const head = Buffer.from(data.subarray(0, 1024)).toString('latin1');
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('%!PS')) return 'postscript';
  if (data.length >= 512 && validTarHeader(Buffer.from(data.subarray(0, 512)))) return 'tar';
  if (looksLikeTex(Buffer.from(data.subarray(0, 64 * 1024)).toString('utf8'))) return 'tex';
  return 'unknown';
}
function looksLikeTex(text: string) {
  if (text.includes('\0')) return false;
  return /\\(?:documentclass|documentstyle|begin\s*\{document\}|input|section|title|def)\b/.test(
    text,
  );
}

export type ExtractLimits = { maxEntries: number; maxBytes: number };
export const defaultExtractLimits: ExtractLimits = {
  maxEntries: 5000,
  maxBytes: 250 * 1024 ** 2,
};
export class UnsafeArchiveError extends Error {}

const gunzipAsync = promisify(gunzip);
/** Decompresses with an output cap so a small archive cannot expand without bound. */
export async function gunzipLimited(data: Uint8Array, maxBytes: number) {
  try {
    return await gunzipAsync(data, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw new UnsafeArchiveError('This arXiv source expands beyond the 250 MB import limit.');
    throw new UnsafeArchiveError('This arXiv source is damaged and could not be decompressed.');
  }
}
/** Original file name recorded in a gzip header (FNAME), if any. */
export function gzipName(data: Uint8Array): string | null {
  if (data.length < 10 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) return null;
  const flags = data[3]!;
  let at = 10;
  if (flags & 4) at += 2 + data[at]! + (data[at + 1]! << 8);
  if (!(flags & 8)) return null;
  const end = data.indexOf(0, at);
  if (end < 0 || end - at > 255) return null;
  return Buffer.from(data.subarray(at, end)).toString('latin1');
}

function octal(block: Buffer, start: number, length: number) {
  // GNU base-256 encoding for large values.
  if (block[start]! & 0x80) {
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + block[i]!;
    return value;
  }
  const text = block
    .subarray(start, start + length)
    .toString('latin1')
    .replace(/[\0 ]+$/, '')
    .trim();
  return text ? parseInt(text, 8) : 0;
}
function validTarHeader(block: Buffer) {
  if (block.every((byte) => byte === 0)) return false;
  const recorded = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return Number.isFinite(recorded) && recorded === sum;
}
const cString = (block: Buffer, start: number, length: number) => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString('utf8');
};
function paxPath(data: Buffer) {
  let path: string | null = null;
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(data.subarray(at, space).toString('latin1'));
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    at += length;
  }
  return path;
}

/** Normalises an archive member name or rejects it. Returns null for the archive root itself. */
export function safeMemberPath(name: string): string | null {
  if (/[\0-\x1f\\]/.test(name))
    throw new UnsafeArchiveError('This arXiv source contains an unsafe file name.');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
    throw new UnsafeArchiveError('This arXiv source contains an absolute file path.');
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..'))
    throw new UnsafeArchiveError('This arXiv source tries to write outside its folder.');
  if (parts.length > 32 || name.length > 1024)
    throw new UnsafeArchiveError('This arXiv source has file paths that are too deep.');
  return parts.length ? parts.join('/') : null;
}

export type ExtractResult = { files: { path: string; size: number }[]; skipped: number };
/**
 * Extracts a tar archive into an empty private directory. Unsafe paths reject the whole
 * archive; links, devices and other special members are never created and are counted
 * as skipped. Files are opened with O_NOFOLLOW and private modes.
 */
export async function extractTar(
  archive: Buffer,
  destination: string,
  limits: ExtractLimits = defaultExtractLimits,
): Promise<ExtractResult> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await realpath(destination);
  const files = new Map<string, number>();
  let entries = 0,
    total = 0,
    skipped = 0,
    at = 0,
    longName: string | null = null,
    pax: string | null = null;
  while (at + 512 <= archive.length) {
    const block = archive.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    if (!validTarHeader(block))
      throw new UnsafeArchiveError('This arXiv source archive is damaged.');
    const size = octal(block, 124, 12);
    const type = String.fromCharCode(block[156]!);
    const start = at + 512;
    at = start + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || start + size > archive.length)
      throw new UnsafeArchiveError('This arXiv source archive is truncated.');
    if (++entries > limits.maxEntries)
      throw new UnsafeArchiveError(`This arXiv source has more than ${limits.maxEntries} files.`);
    const data = archive.subarray(start, start + size);
    if (type === 'L') {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      pax = paxPath(data);
      continue;
    }
    if (type === 'g' || type === 'K') continue;
    const prefix =
      block.subarray(257, 262).toString('latin1') === 'ustar' ? cString(block, 345, 155) : '';
    const header = cString(block, 0, 100);
    const name = pax ?? longName ?? (prefix ? `${prefix}/${header}` : header);
    pax = longName = null;
    const path = safeMemberPath(name);
    if (!['0', '\0', '7', '5'].includes(type)) {
      // Symlinks (2), hardlinks (1), devices (3, 4), FIFOs (6) and unknown types.
      skipped++;
      continue;
    }
    if (!path) continue;
    const target = join(root, ...path.split('/'));
    if (type === '5' || name.endsWith('/')) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    total += size;
    if (total > limits.maxBytes)
      throw new UnsafeArchiveError('This arXiv source expands beyond the 250 MB import limit.');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Defence in depth: no member may resolve outside the extraction root.
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep))
      throw new UnsafeArchiveError('This arXiv source tries to write outside its folder.');
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    files.set(path, size);
  }
  return { files: [...files].map(([path, size]) => ({ path, size })), skipped };
}

export type SourceFile = { path: string; size: number; text?: string };
const stripComments = (text: string) => text.replace(/(?<!\\)%[^\n]*/g, '');
const texLike = (path: string) => /\.(?:tex|ltx|latex)$/i.test(path);
const preferredStems = ['main', 'ms', 'paper', 'arxiv'];

/** README directives from arXiv's 00README.json or legacy 00README.XXX, if present. */
function readmeDirectives(files: SourceFile[]) {
  const top: string[] = [];
  const ignored = new Set<string>();
  const json = files.find((file) => file.path === '00README.json');
  if (json?.text) {
    try {
      const value = JSON.parse(json.text) as {
        sources?: { filename?: unknown; usage?: unknown }[];
      };
      for (const source of Array.isArray(value.sources) ? value.sources : []) {
        if (typeof source?.filename !== 'string') continue;
        if (source.usage === 'toplevel') top.push(source.filename);
        if (source.usage === 'ignore') ignored.add(source.filename);
      }
    } catch {
      /* A malformed README is ignored; the heuristic still applies. */
    }
  }
  const legacy = files.find((file) => /^00README\.XXX$/i.test(file.path));
  if (legacy?.text)
    for (const line of legacy.text.split(/\r?\n/)) {
      const [name, directive] = line.trim().split(/\s+/);
      if (!name || !directive) continue;
      if (directive === 'toplevelfile') top.push(name);
      if (directive === 'ignore') ignored.add(name);
    }
  return { top, ignored };
}

/**
 * Chooses the main LaTeX file: arXiv README toplevel → files with \documentclass (or the
 * LaTeX 2.09 \documentstyle) and \begin{document} that no other candidate includes →
 * preferred names (main, ms, paper, arxiv) → larger size. Text is supplied for .tex/README files.
 */
export function detectMainFile(files: SourceFile[]): string | null {
  const known = new Set(files.map((file) => file.path));
  const { top, ignored } = readmeDirectives(files);
  const readme = top.map((name) => safeName(name)).find((name) => name && known.has(name));
  if (readme) return readme;
  const tex = files.filter(
    (file) => texLike(file.path) && file.text !== undefined && !ignored.has(file.path),
  );
  const body = new Map(tex.map((file) => [file.path, stripComments(file.text!)]));
  let candidates = tex.filter((file) => {
    const text = body.get(file.path)!;
    return /\\document(?:class|style)\b/.test(text) && /\\begin\s*\{document\}/.test(text);
  });
  if (!candidates.length)
    candidates = tex.filter((file) => /\\document(?:class|style)\b/.test(body.get(file.path)!));
  if (!candidates.length && tex.length === 1) candidates = tex;
  const included = new Set<string>();
  for (const file of candidates)
    for (const match of body
      .get(file.path)!
      .matchAll(/\\(?:input|include|subfile)\b\s*(?:\{([^{}]+)\}|([^\s{}\\]+))/g)) {
      const name = (match[1] ?? match[2]!).trim();
      for (const base of [posix.dirname(file.path), '.']) {
        const resolved = posix.normalize(posix.join(base, name));
        included.add(resolved);
        included.add(`${resolved}.tex`);
      }
    }
  const remaining = candidates.filter((file) => !included.has(file.path));
  const pool = remaining.length ? remaining : candidates;
  const rank = (path: string) => {
    const stem = posix
      .basename(path)
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    const index = preferredStems.indexOf(stem);
    return index < 0 ? preferredStems.length : index;
  };
  pool.sort(
    (a, b) =>
      rank(a.path) - rank(b.path) ||
      b.size - a.size ||
      a.path.split('/').length - b.path.split('/').length ||
      a.path.localeCompare(b.path),
  );
  return pool[0]?.path ?? null;
}
function safeName(name: string) {
  try {
    return safeMemberPath(name);
  } catch {
    return null;
  }
}
