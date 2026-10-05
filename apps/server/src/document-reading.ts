import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { DocumentReading } from '@dock/shared';

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
// TeX collects a macro as one argument before expanding it. Preserve that group
// when Pandoc expands zero-argument definitions (e.g. \frac\dd{\dd t}).
function groupMacroExpansions(source: string) {
  const declarations =
    /\\(?:re)?newcommand\*?\s*(?:\{\\[A-Za-z]+\}|\\[A-Za-z]+)\s*(?:\[0\]\s*)?\{/g;
  let result = '',
    at = 0;
  for (const match of source.matchAll(declarations)) {
    const start = match.index! + match[0].length;
    let depth = 1,
      end = start;
    for (; end < source.length && depth; end++) {
      if (source[end] === '\\') {
        end++;
        continue;
      }
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
    }
    if (depth || match.index! < at) continue;
    result += source.slice(at, start) + '{' + source.slice(start, end - 1) + '}}';
    at = end;
  }
  return result + source.slice(at);
}
function command(executable: string, args: string[], cwd: string, input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 ** 2 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(stderr.slice(-1500) || 'Document conversion failed or exceeded 30 seconds.'),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}
/** Pandoc parses TeX; this loader only supplies bounded local includes and figures.
 * Sandbox mode prevents the converter itself from reading arbitrary files or fetching URLs.
 * No source filters, scripts, shell escapes or document-provided compiler configuration run.
 */
/** Bounded, read-only include expansion shared with the optional formatting worker. */
export async function expandReadingSource(source: string, root: string): Promise<string> {
  root = await realpath(root);
  source = await realpath(source);
  let total = 0,
    files = 0;
  async function local(path: string) {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!within(root, canonical) || !info.isFile() || info.size > limit)
      throw new Error('A document input is outside its folder or larger than 8 MB.');
    return canonical;
  }
  async function expand(path: string, ancestors: string[] = []): Promise<string> {
    path = await local(path);
    if (ancestors.includes(path) || ++files > 100)
      throw new Error('This document has recursive or too many included files.');
    let text = await readFile(path, 'utf8');
    total += Buffer.byteLength(text);
    if (total > limit) throw new Error('The combined LaTeX source exceeds the 8 MB reading limit.');
    // TeX comments are not content, and must not introduce file reads.
    text = text.replace(/(?<!\\)%[^\n]*/g, '');
    const aliases = [...text.matchAll(/\\let\\([a-zA-Z]+)\\(?:@@input|input)\b/g)].map(
      (match) => match[1]!,
    );
    for (const alias of aliases)
      text = text.replace(new RegExp('\\\\' + alias + '\\s+(?!\\\\)', 'g'), '\\input ');
    const include = /\\(?:input|include)\b\s*(?:\{([^{}]+)\}|([^\s{}\\]+))/g;
    let output = '',
      at = 0;
    for (const match of text.matchAll(include)) {
      output += text.slice(at, match.index);
      const name = match[1] ?? match[2]!;
      if (/[:\0]/.test(name))
        throw new Error('Only local LaTeX includes are supported in reading mode.');
      const included = resolve(dirname(source), extname(name) ? name : name + '.tex');
      output += await expand(included, [...ancestors, path]);
      at = match.index! + match[0].length;
    }
    return output + text.slice(at);
  }
  return expand(source);
}
export async function buildReading(
  source: string,
  root: string,
  assets: string,
  formattedText?: string,
): Promise<DocumentReading> {
  root = await realpath(root);
  source = await realpath(source);
  const pandoc = readerExecutable('pandoc');
  if (!pandoc)
    throw new Error(
      'Reading mode needs Pandoc on this computer. Ask your setup agent to install pandoc. Original PDF still works.',
    );
  const warnings = new Set<string>();
  const labels: Record<string, string> = {};
  async function local(path: string) {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!within(root, canonical) || !info.isFile() || info.size > limit)
      throw new Error('A document input is outside its folder or larger than 8 MB.');
    return canonical;
  }
  let text = groupMacroExpansions(
    formattedText ?? (await expandReadingSource(source, root)),
  ).replace(/\\hfill\b/g, ' ');
  // Read labels as data, never execute an auxiliary TeX file.
  try {
    const aux = await readFile(await local(source.replace(/\.tex$/i, '.aux')), 'utf8');
    for (const match of aux.matchAll(/\\newlabel\{([^{}]+)\}\{\{([0-9A-Za-z.:-]+)\}/g))
      labels[match[1]!] = match[2]!;
  } catch {
    /* A never-compiled source still has reading-local equation references. */
  }
  // Pandoc reads the bibliography prose but otherwise drops manual citation labels.
  const bibliography = new Map<string, number>();
  text = text.replace(/\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}/g, (_, key: string) => {
    const number = bibliography.size + 1;
    bibliography.set(key, number);
    return `\\hypertarget{bib-${key}}{[${number}]} `;
  });
  text = text.replace(/\\cite[tp]?(?:\[[^\]]*\])?\{([^{}]+)\}/g, (_, keys: string) =>
    keys
      .split(',')
      .map((key) => {
        key = key.trim();
        const number = bibliography.get(key);
        if (!number)
          warnings.add('Some citations need the original PDF for their bibliography labels.');
        return `\\hyperlink{bib-${key}}{[${number ?? key}]}`;
      })
      .join(', '),
  );
  await mkdir(assets, { recursive: true, mode: 0o700 });
  let html = await command(
    pandoc,
    [
      '--sandbox',
      '--from=latex',
      '--to=html5',
      '--mathjax',
      '--wrap=none',
      '+RTS',
      '-M256M',
      '-RTS',
    ],
    dirname(source),
    text,
  );
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
  return { available: true, html, warnings: [...warnings], labels };
}
