import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { DocumentReading, ReadingHealth } from '@dock/shared';
import { mapFrontMatter, withFrontMatter } from './reading-front-matter.js';
import {
  applySourceRules,
  bodyStart,
  closeOpenBraces,
  dropPassage,
  isPlainTex,
  readingHealth,
} from './reading-source-rules.js';

export function readerExecutable(name: string) {
  for (const directory of [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean)) {
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* next install */
    }
  }
  return null;
}
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const limit = 8 * 1024 ** 2;
/** A failure whose message is already a sentence for the reader (no paths, no codes). */
export class ReadingProblem extends Error {}
class ConversionFailure extends Error {
  constructor(
    readonly detail: string,
    readonly timedOut: boolean,
  ) {
    super(detail);
  }
}
function command(
  executable: string,
  args: string[],
  cwd: string,
  input?: string,
  timeout = 30000,
  maxBuffer = 16 * 1024 ** 2,
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd, timeout, killSignal: 'SIGKILL', maxBuffer },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new ConversionFailure(
              stderr.slice(-1500),
              error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' &&
                ((error as { killed?: boolean }).killed === true || error.signal === 'SIGKILL'),
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}
const missingMarker = /\\readingmissinginput\{([^{}\\]*)\}/g;
async function canonicalSource(source: string, root: string) {
  try {
    return { root: await realpath(root), source: await realpath(source) };
  } catch {
    throw new ReadingProblem(
      'The LaTeX source of this document is no longer in its folder. Original PDF may still work.',
    );
  }
}
/** Pandoc parses TeX; this loader only supplies bounded local includes and figures.
 * Sandbox mode prevents the converter itself from reading arbitrary files or fetching URLs.
 * No source filters, scripts, shell escapes or document-provided compiler configuration run.
 */
/** Bounded, read-only include expansion shared with the optional formatting worker.
 * A missing include is skipped, never fatal: it leaves a marker that Reading turns into a
 * visible note, and is recorded in the health report when one is passed.
 */
export async function expandReadingSource(
  source: string,
  root: string,
  health?: ReadingHealth,
): Promise<string> {
  ({ root, source } = await canonicalSource(source, root));
  let total = 0,
    files = 0;
  async function local(path: string) {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!within(root, canonical) || !info.isFile() || info.size > limit)
      throw new ReadingProblem('A document input is outside its folder or larger than 8 MB.');
    return canonical;
  }
  const missing = (name: string) => {
    // Shown to the reader and placed in TeX: the bare file name, without special characters.
    const file = basename(extname(name) ? name : name + '.tex').replace(/[^\w.+-]/g, '_');
    // The marker also survives into a phone-formatting copy, which Reading reads back.
    if (health && !health.missingIncludes.includes(file)) health.missingIncludes.push(file);
    return `\\readingmissinginput{${file}}`;
  };
  async function expand(path: string, ancestors: string[] = []): Promise<string> {
    path = await local(path);
    if (ancestors.includes(path) || ++files > 100)
      throw new ReadingProblem('This document has recursive or too many included files.');
    let text = await readFile(path, 'utf8');
    total += Buffer.byteLength(text);
    if (total > limit)
      throw new ReadingProblem('The combined LaTeX source exceeds the 8 MB reading limit.');
    // TeX comments are not content, and must not introduce file reads.
    text = text.replace(/(?<!\\)%[^\n]*/g, '');
    const aliases = [...text.matchAll(/\\let\\([a-zA-Z]+)\\(?:@@input|input)\b/g)].map(
      (match) => match[1]!,
    );
    for (const alias of aliases)
      text = text.replace(new RegExp('\\\\' + alias + '\\s+(?!\\\\)', 'g'), '\\input ');
    // BibTeX writes the current TeX job's .bbl, not one .bbl per database name.
    // Supply that existing file to sandboxed Pandoc exactly where TeX would read it.
    const include =
      /\\(?:input|include)\b\s*(?:\{([^{}]+)\}|([^\s{}\\]+))|\\(bibliography)\b\s*\{[^{}]*\}/g;
    let output = '',
      at = 0;
    for (const match of text.matchAll(include)) {
      output += text.slice(at, match.index);
      at = match.index! + match[0].length;
      const bibliography = match[3] === 'bibliography';
      const name = bibliography
        ? basename(source, extname(source)) + '.bbl'
        : (match[1] ?? match[2]!);
      // Only local files are read; a URL-like or absent include is skipped.
      if (/[:\0]/.test(name)) {
        output += missing(name);
        continue;
      }
      const included = resolve(dirname(source), extname(name) ? name : name + '.tex');
      const present = await stat(included).then(
        () => true,
        () => false,
      );
      if (present) {
        output += await expand(included, [...ancestors, path]);
        if (bibliography && health)
          health.rules['bibliography-bbl-inlined'] =
            (health.rules['bibliography-bbl-inlined'] ?? 0) + 1;
      } else output += missing(name);
    }
    return output + text.slice(at);
  }
  return expand(source);
}
const plainTexSentence =
  'This paper is written in plain TeX, which Reading cannot reflow. Use Original PDF to read it.';
const unavailableSentence = 'Reading could not convert this paper. Use Original PDF to read it.';
/** Pandoc to JSON with a retry ladder: close braces left open, then replace the passage
 * Pandoc rejects with a visible note. Each pass is time-limited and the attempts are capped.
 */
async function readLatex(
  pandoc: string,
  text: string,
  cwd: string,
  health: ReadingHealth,
  deadline: number,
  { timeoutMs = 20000, attempts = 8 }: ReadingOptions,
) {
  let closed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const output = await command(
        pandoc,
        ['--sandbox', '--from=latex', '--to=json', '+RTS', '-M256M', '-RTS'],
        cwd,
        text,
        Math.min(timeoutMs, remaining),
        96 * 1024 ** 2,
      );
      return JSON.parse(output) as Parameters<typeof withFrontMatter>[0];
    } catch (error) {
      if (!(error instanceof ConversionFailure)) throw error;
      if (error.timedOut) {
        health.notes.push('Conversion exceeded its time limit.');
        return null;
      }
      const position = /\(line (\d+), column \d+\)/.exec(error.detail);
      if (!position) {
        health.notes.push('Pandoc rejected the source without a location.');
        return null;
      }
      const line = Number(position[1]);
      const lines = text.split('\n');
      const atEnd = line >= lines.length || /\\end\s*\{document\}/.test(lines[line - 1] ?? '');
      if (atEnd && !closed) {
        closed = true;
        const next = closeOpenBraces(text, health);
        if (next !== text) {
          text = next;
          continue;
        }
      }
      const reason =
        error.detail
          .split('\n')
          .map((value) => value.trim())
          .find((value) => /^(?:unexpected|expecting)/.test(value)) ?? 'unreadable';
      const next = dropPassage(text, line, reason, health);
      if (!next) return null;
      text = next;
    }
  }
  health.notes.push('Conversion stopped after its retry limit.');
  return null;
}
export type ReadingOptions = { timeoutMs?: number; attempts?: number; budgetMs?: number };
/** Time kept back from the Pandoc retries for the final HTML pass. */
const htmlReserveMs = 5000;
/** Builds Reading; every failure it reports is a sentence without paths or error codes. */
export async function buildReading(
  source: string,
  root: string,
  assets: string,
  formattedText?: string,
  options: ReadingOptions = {},
): Promise<DocumentReading> {
  try {
    return await convertReading(source, root, assets, formattedText, options);
  } catch (error) {
    if (error instanceof ReadingProblem) throw error;
    throw new ReadingProblem(
      'Reading mode could not convert this document. Original PDF still works.',
    );
  }
}
async function convertReading(
  source: string,
  root: string,
  assets: string,
  formattedText: string | undefined,
  options: ReadingOptions,
): Promise<DocumentReading> {
  ({ root, source } = await canonicalSource(source, root));
  const pandoc = readerExecutable('pandoc');
  if (!pandoc)
    throw new ReadingProblem(
      'Reading mode needs Pandoc on this computer. Ask your setup agent to install pandoc. Original PDF still works.',
    );
  const warnings = new Set<string>();
  const labels: Record<string, string> = {};
  const health = readingHealth();
  async function local(path: string) {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!within(root, canonical) || !info.isFile() || info.size > limit)
      throw new ReadingProblem('A document input is outside its folder or larger than 8 MB.');
    return canonical;
  }
  const deadline = Date.now() + (options.budgetMs ?? 60000);
  let text = formattedText ?? (await expandReadingSource(source, root, health));
  // A formatted copy carries the markers of the source it was made from.
  for (const [, name] of text.matchAll(missingMarker))
    if (!health.missingIncludes.includes(name!)) health.missingIncludes.push(name!);
  for (const name of health.missingIncludes)
    warnings.add(
      `This paper loads ${name}, which is not in its source files. That part is only in the Original PDF.`,
    );
  const unavailable = (sentence: string): DocumentReading => {
    health.conversion = 'unavailable';
    warnings.add(sentence);
    return {
      available: true,
      html: `<p class="reading-unavailable">${sentence}</p>`,
      warnings: [...warnings],
      labels,
      health,
    };
  };
  if (isPlainTex(text)) {
    health.plainTex = true;
    return unavailable(plainTexSentence);
  }
  text = mapFrontMatter(applySourceRules(text, health), health);
  const body = bodyStart(text);
  text = text.replace(missingMarker, (_, name: string, offset: number) =>
    offset > body
      ? `\\begin{reading-omitted}Part of this paper (${name.replace(/_/g, '\\_')}) is only in the Original PDF.\\end{reading-omitted}`
      : '',
  );
  // Read labels as data, never execute an auxiliary TeX file.
  try {
    const aux = await readFile(await local(source.replace(/\.tex$/i, '.aux')), 'utf8');
    for (const match of aux.matchAll(/\\newlabel\{([^{}]+)\}\{\{([0-9A-Za-z.:-]+)\}/g))
      labels[match[1]!] = match[2]!;
  } catch {
    /* A never-compiled source still has reading-local equation references. */
  }
  // Pandoc drops manual citation labels. Use supplied natbib Author(Year) data,
  // never infer author/year from bibliography prose or execute a bibliography tool.
  const numericCitations =
    [...text.matchAll(/\\(?:usepackage|RequirePackage)\s*\[([^\]]*)\]\s*\{([^}]+)\}/g)].some(
      ([, options, packages]) =>
        /(?:^|,)\s*(?:numbers|super)\s*(?:,|$)/.test(options!) &&
        packages!.split(',').some((name) => name.trim() === 'natbib'),
    ) ||
    /\\PassOptionsToPackage\s*\{[^}]*\b(?:numbers|super)\b[^}]*\}\s*\{natbib\}/.test(text) ||
    /\\setcitestyle\s*\{[^}]*\b(?:numbers|super)\b/.test(text);
  const bibliography = new Map<
    string,
    { number: number; authorYear: { author: string; year: string } | null }
  >();
  text = text.replace(
    /\\bibitem\s*(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/g,
    (_, label: string | undefined, key: string) => {
      const number = bibliography.size + 1;
      const parts = label?.match(/^(.+?)\(([^()]*)\)/s);
      const year = parts?.[2]?.replace(/\\natexlab\{([a-z])\}/g, '$1').replace(/[{}]/g, '');
      const authorYear =
        parts && year && /^\d{4}[a-z]?$/.test(year) ? { author: parts[1]!.trim(), year } : null;
      bibliography.set(key, { number, authorYear });
      return `\\hypertarget{bib-${key}}{[${number}]} `;
    },
  );
  text = text.replace(
    /\\cite([tp]?)\s*(?:\[([^\]]*)\]\s*)?(?:\[([^\]]*)\]\s*)?\{([^{}]+)\}/g,
    (_, kind: string, first: string | undefined, second: string | undefined, keys: string) => {
      const prenote = second === undefined ? '' : (first ?? '');
      const postnote = second ?? first ?? '';
      const prefix = prenote ? `${prenote} ` : '';
      const suffix = postnote ? `, ${postnote}` : '';
      const citations = keys.split(',').map((key) => {
        key = key.trim();
        const entry = bibliography.get(key);
        if (!entry)
          warnings.add('Some citations need the original PDF for their bibliography labels.');
        return { key, entry };
      });
      const link = (key: string, label: string) => `\\hyperlink{bib-${key}}{${label}}`;
      if (
        !numericCitations &&
        (kind === 'p' || kind === 't') &&
        citations.every(({ entry }) => entry?.authorYear)
      ) {
        const rendered = citations.map(({ key, entry }, index) => {
          const { author, year } = entry!.authorYear!;
          return link(
            key,
            kind === 'p'
              ? `${author}, ${year}`
              : `${author} (${year}${index === citations.length - 1 ? suffix : ''})`,
          );
        });
        return kind === 'p'
          ? `(${prefix}${rendered.join('; ')}${suffix})`
          : `${prefix}${rendered.join('; ')}`;
      }
      return (
        prefix +
        citations.map(({ key, entry }) => link(key, `[${entry?.number ?? key}]`)).join(', ') +
        suffix
      );
    },
  );
  await mkdir(assets, { recursive: true, mode: 0o700 });
  const parsed = await readLatex(
    pandoc,
    text,
    dirname(source),
    health,
    deadline - htmlReserveMs,
    options,
  );
  if (!parsed) return unavailable(unavailableSentence);
  if (health.missingIncludes.length) health.conversion = 'partial';
  if (health.dropped.some((drop) => drop.part === 'body')) {
    health.conversion = 'partial';
    warnings.add(
      'Some passages could not be converted. Each is marked where it is only in the Original PDF.',
    );
  }
  // The HTML pass shares the total budget; when it is nearly spent, the title block is the
  // part left out.
  const remaining = deadline - Date.now();
  let pandocDocument = parsed;
  if (remaining >= htmlReserveMs) pandocDocument = withFrontMatter(parsed);
  else health.notes.push('The title block was skipped because conversion time ran out.');
  let html: string;
  try {
    html = await command(
      pandoc,
      [
        '--sandbox',
        '--from=json',
        '--to=html5',
        '--mathjax',
        '--wrap=none',
        '+RTS',
        '-M256M',
        '-RTS',
      ],
      dirname(source),
      JSON.stringify(pandocDocument),
      Math.max(1000, remaining),
    );
  } catch (error) {
    if (!(error instanceof ConversionFailure)) throw error;
    health.notes.push('The final HTML conversion did not finish in time.');
    return unavailable(unavailableSentence);
  }
  // Only explicitly referenced local image files can become opaque reader assets.
  const paths = [
    ...new Set(
      [...html.matchAll(/<(?:img|embed)\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((match) => match[1]!),
    ),
  ];
  for (const encoded of paths) {
    const name = encoded
      .replaceAll('&amp;', '&')
      .replaceAll('&#39;', "'")
      .replaceAll('&quot;', '"');
    let replacement = '<span class="reading-missing">Figure available in Original PDF.</span>';
    try {
      if (/^(?:[a-z]+:|\/|\\)/i.test(name)) throw new Error('Only local figures');
      const path = await local(resolve(dirname(source), name));
      const extension = extname(path).toLowerCase();
      const data = await readFile(path);
      const key = createHash('sha256').update(data).digest('hex');
      let output: string;
      if (extension === '.pdf' && data.subarray(0, 5).toString() === '%PDF-') {
        const converter = readerExecutable('pdftoppm');
        if (!converter) throw new Error('PDF figures need Poppler');
        output = key + '.png';
        await command(
          converter,
          ['-f', '1', '-singlefile', '-scale-to', '1600', '-png', path, join(assets, key)],
          dirname(source),
        );
      } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
        output = key + extension;
        await writeFile(join(assets, output), data, { mode: 0o600 });
      } else throw new Error('Unsupported figure');
      replacement = `<img src="reader-asset:${output}" alt="Figure" loading="lazy" />`;
    } catch {
      warnings.add(
        'Some figures are only available in Original PDF. Local PDF figures require Poppler.',
      );
    }
    html = html.replace(/<(?:img|embed)\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (tag, src: string) =>
      src === encoded ? replacement : tag,
    );
  }
  return { available: true, html, warnings: [...warnings], labels, health };
}
