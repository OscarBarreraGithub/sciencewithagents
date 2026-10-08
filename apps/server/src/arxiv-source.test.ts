import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import {
  ArxivLinkError,
  detectMainFile,
  extractTar,
  gunzipLimited,
  gzipName,
  parseArxivLink,
  sniffFormat,
  UnsafeArchiveError,
} from './arxiv-source.js';
import { parseArxivAtom } from './arxiv-import.js';
import { tar, tarHeader } from './arxiv-tar.fixture.js';

const pax = (path: string) => {
  const record = (length: number) => `${length} path=${path}\n`;
  let length = record(0).length;
  while (record(length).length !== length) length = record(length).length;
  return record(length);
};

describe('parseArxivLink', () => {
  it.each([
    ['https://arxiv.org/abs/2401.12345', '2401.12345', null],
    ['https://arxiv.org/abs/2401.12345v3', '2401.12345', 3],
    ['http://arxiv.org/pdf/2401.12345v2.pdf', '2401.12345', 2],
    ['https://arxiv.org/pdf/2401.12345', '2401.12345', null],
    ['arxiv.org/pdf/1501.00001v1', '1501.00001', 1],
    ['https://www.arxiv.org/html/2401.12345v1/', '2401.12345', 1],
    ['https://arxiv.org/format/0704.0001', '0704.0001', null],
    ['https://export.arxiv.org/abs/2401.12345?context=hep-th', '2401.12345', null],
    ['https://arxiv.org/src/2401.12345v4', '2401.12345', 4],
    ['arXiv:2401.12345v2', '2401.12345', 2],
    ['ARXIV: 0704.0001', '0704.0001', null],
    ['2401.12345', '2401.12345', null],
    ['  0704.0001v1 ', '0704.0001', 1],
    ['hep-th/9901001', 'hep-th/9901001', null],
    ['hep-th/9901001v2', 'hep-th/9901001', 2],
    ['math.GT/0309136', 'math/0309136', null],
    ['https://arxiv.org/abs/cond-mat/0001001v1', 'cond-mat/0001001', 1],
    ['https://arxiv.org/pdf/hep-ph/0601001.pdf', 'hep-ph/0601001', null],
  ])('%s', (link, id, version) => {
    expect(parseArxivLink(link)).toEqual({ id, version });
  });
  it.each([
    '',
    'hello',
    '2401.123',
    '2413.12345',
    '2401.12345v0',
    'https://example.com/abs/2401.12345',
    'https://arxiv.org.evil.com/abs/2401.12345',
    'https://arxiv.org/list/hep-th/new',
    'ftp://arxiv.org/abs/2401.12345',
    'javascript:alert(1)',
    'arXiv:not-an-id',
    'file:///etc/passwd',
    'https://arxiv.org/abs/../../etc/passwd',
  ])('rejects %j with a short human message', (link) => {
    let error: unknown;
    try {
      parseArxivLink(link);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArxivLinkError);
    expect((error as Error).message).toMatch(/^[A-Z][^{}[\]]{10,200}\.$/);
  });
});

describe('formats', () => {
  it('sniffs gzip, tar, PDF, PostScript, TeX and unknown payloads by content', () => {
    const tex = '\\documentclass{article}\\begin{document}Hi\\end{document}';
    expect(sniffFormat(gzipSync(tex))).toBe('gzip');
    expect(sniffFormat(tar([{ name: 'a.tex', data: tex }]))).toBe('tar');
    expect(sniffFormat(Buffer.from('%PDF-1.5\n'))).toBe('pdf');
    expect(sniffFormat(Buffer.from('%!PS-Adobe-3.0\n'))).toBe('postscript');
    expect(sniffFormat(Buffer.from(tex))).toBe('tex');
    expect(sniffFormat(Buffer.from('<html>blocked</html>'))).toBe('unknown');
  });
  it('reads the original gzip file name and caps decompression', async () => {
    const plain = gzipSync('x');
    expect(gzipName(plain)).toBeNull();
    const named = Buffer.concat([
      plain.subarray(0, 10),
      Buffer.from('paper.tex\0'),
      plain.subarray(10),
    ]);
    named[3] = named[3]! | 8;
    expect(gzipName(named)).toBe('paper.tex');
    expect((await gunzipLimited(named, 100)).toString()).toBe('x');
    await expect(gunzipLimited(gzipSync(Buffer.alloc(2 * 1024 ** 2)), 1024 ** 2)).rejects.toThrow(
      /250 MB/,
    );
    await expect(gunzipLimited(Buffer.from([0x1f, 0x8b, 8, 0, 1, 2]), 100)).rejects.toBeInstanceOf(
      UnsafeArchiveError,
    );
  });
});

describe('extractTar', () => {
  let root: string, out: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swa-arxiv-tar-'));
    out = join(root, 'out');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('extracts files, folders, ustar prefixes, GNU long names and pax paths with private modes', async () => {
    const long = `figures/${'f'.repeat(120)}.png`;
    const prefixed = tarHeader('deep.tex', 4, '0');
    prefixed.write('chapters/part', 345);
    prefixed.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of prefixed) sum += byte;
    prefixed.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const archive = Buffer.concat([
      tar([
        { name: './', type: '5' },
        { name: './main.tex', data: 'main' },
        { name: 'figures/', type: '5' },
        { name: '././LongLink', type: 'L', data: long + '\0' },
        { name: 'ignored-short-name', data: 'png' },
        { name: 'PaxHeader', type: 'x', data: pax('sections/pax.tex') },
        { name: 'short', data: 'pax' },
      ]).subarray(0, -1024),
      prefixed,
      Buffer.from('deep'),
      Buffer.alloc(508 + 1024),
    ]);
    const result = await extractTar(archive, out);
    expect(result.skipped).toBe(0);
    expect(result.files.map((file) => file.path).sort()).toEqual(
      ['chapters/part/deep.tex', long, 'main.tex', 'sections/pax.tex'].sort(),
    );
    expect(await readFile(join(out, long), 'utf8')).toBe('png');
    expect(await readFile(join(out, 'sections/pax.tex'), 'utf8')).toBe('pax');
    expect((await stat(join(out, 'main.tex'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(out, 'figures'))).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['absolute paths', '/etc/evil.tex', /absolute/],
    ['parent traversal', '../evil.tex', /outside/],
    ['nested traversal', 'figs/../../evil.tex', /outside/],
    ['dot-prefixed traversal', './../evil.tex', /outside/],
    ['drive letters', 'C:/evil.tex', /absolute/],
    ['backslashes', '..\\evil.tex', /unsafe/],
  ])('rejects %s and writes nothing outside', async (_, name, message) => {
    const archive = tar([
      { name: 'ok.tex', data: 'ok' },
      { name, data: 'evil' },
    ]);
    await expect(extractTar(archive, out)).rejects.toThrow(message);
    expect(existsSync(join(root, 'evil.tex'))).toBe(false);
  });

  it('rejects traversal hidden in GNU long names and pax headers', async () => {
    for (const archive of [
      tar([
        { name: '././LongLink', type: 'L', data: '../evil.tex\0' },
        { name: 'innocent.tex', data: 'evil' },
      ]),
      tar([
        { name: 'PaxHeader', type: 'x', data: pax('/tmp/evil.tex') },
        { name: 'innocent.tex', data: 'evil' },
      ]),
    ])
      await expect(extractTar(archive, out)).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(join(root, 'evil.tex'))).toBe(false);
  });

  it('never creates symlinks, hardlinks or devices, even when later members write through them', async () => {
    const result = await extractTar(
      tar([
        { name: 'escape', type: '2', linkname: root },
        { name: 'escape/evil.tex', data: 'stays inside' },
        { name: 'hard.tex', type: '1', linkname: '/etc/passwd' },
        { name: 'null', type: '3' },
        { name: 'disk', type: '4' },
        { name: 'pipe', type: '6' },
        { name: 'main.tex', data: 'main' },
      ]),
      out,
    );
    expect(result.skipped).toBe(5);
    expect((await readdir(out)).sort()).toEqual(['escape', 'main.tex']);
    expect((await lstat(join(out, 'escape'))).isDirectory()).toBe(true);
    expect(await readFile(join(out, 'escape/evil.tex'), 'utf8')).toBe('stays inside');
    expect(existsSync(join(root, 'evil.tex'))).toBe(false);
  });

  it('enforces entry and byte caps and refuses damaged or truncated archives', async () => {
    const many = tar(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.tex`, data: 'x' })));
    await expect(extractTar(many, out, { maxEntries: 5, maxBytes: 1e6 })).rejects.toThrow(
      /more than 5 files/,
    );
    const big = tar([
      { name: 'a.tex', data: 'x'.repeat(600) },
      { name: 'b.tex', data: 'x'.repeat(600) },
    ]);
    await expect(
      extractTar(big, join(root, 'b'), { maxEntries: 10, maxBytes: 1000 }),
    ).rejects.toThrow(/250 MB/);
    const damaged = Buffer.concat([tarHeader('a.tex', 1, '0', '', false), Buffer.alloc(1536)]);
    await expect(extractTar(damaged, join(root, 'c'))).rejects.toThrow(/damaged/);
    const truncated = tar([{ name: 'a.tex', data: 'x'.repeat(2000) }]).subarray(0, 1024);
    await expect(extractTar(truncated, join(root, 'd'))).rejects.toThrow(/truncated/);
  });
});

describe('detectMainFile', () => {
  const doc = (body = '') => `\\documentclass{article}\n\\begin{document}${body}\\end{document}`;
  it('follows 00README.json and legacy 00README.XXX toplevel directives', () => {
    const files = [
      { path: 'main.tex', size: 900, text: doc() },
      { path: 'supplement.tex', size: 100, text: doc() },
    ];
    expect(
      detectMainFile([
        ...files,
        {
          path: '00README.json',
          size: 80,
          text: JSON.stringify({ sources: [{ filename: 'supplement.tex', usage: 'toplevel' }] }),
        },
      ]),
    ).toBe('supplement.tex');
    expect(
      detectMainFile([
        ...files,
        { path: '00README.XXX', size: 30, text: 'supplement.tex toplevelfile\n' },
      ]),
    ).toBe('supplement.tex');
    // A README naming a missing or unsafe file falls back to the heuristic.
    expect(
      detectMainFile([
        ...files,
        { path: '00README.XXX', size: 30, text: '../x.tex toplevelfile\nmissing.tex toplevelfile' },
      ]),
    ).toBe('main.tex');
    expect(
      detectMainFile([
        { path: 'main.tex', size: 900, text: doc() },
        { path: 'zeta.tex', size: 100, text: doc() },
        { path: '00README.XXX', size: 30, text: 'main.tex ignore' },
      ]),
    ).toBe('zeta.tex');
  });
  it('excludes standalone files included by another candidate', () => {
    expect(
      detectMainFile([
        { path: 'appendix.tex', size: 50_000, text: doc() },
        {
          path: 'body/thesis.tex',
          size: 100,
          text: doc('\\include{../appendix}\\input{body/chapter}'),
        },
        { path: 'body/chapter.tex', size: 20, text: doc() },
      ]),
    ).toBe('body/thesis.tex');
  });
  it('ignores commented \\documentclass, accepts LaTeX 2.09 and tie-breaks by name then size', () => {
    expect(
      detectMainFile([
        { path: 'notes.tex', size: 9999, text: '% \\documentclass{article}\n% \\begin{document}' },
        {
          path: 'old.tex',
          size: 10,
          text: '\\documentstyle[12pt]{article}\\begin{document}x\\end{document}',
        },
      ]),
    ).toBe('old.tex');
    const files = [
      { path: 'big.tex', size: 5000, text: doc() },
      { path: 'small.tex', size: 50, text: doc() },
    ];
    expect(detectMainFile(files)).toBe('big.tex');
    expect(detectMainFile([...files, { path: 'Paper.tex', size: 1, text: doc() }])).toBe(
      'Paper.tex',
    );
    expect(
      detectMainFile([
        ...files,
        { path: 'paper.tex', size: 1, text: doc() },
        { path: 'ms.tex', size: 1, text: doc() },
      ]),
    ).toBe('ms.tex');
  });
  it('falls back to a single TeX file and returns null without TeX', () => {
    expect(detectMainFile([{ path: 'only.tex', size: 10, text: '\\section{Plain}' }])).toBe(
      'only.tex',
    );
    expect(detectMainFile([{ path: 'fig.png', size: 10 }])).toBeNull();
    expect(
      detectMainFile([
        { path: 'a.tex', size: 10, text: '\\input{b}' },
        { path: 'b.tex', size: 10, text: 'text' },
      ]),
    ).toBeNull();
  });
});

describe('parseArxivAtom', () => {
  it('reads the latest version, title, authors and abstract', () => {
    const xml = `<?xml version="1.0"?><feed><id>http://arxiv.org/api/x</id><title>ArXiv Query</title>
      <entry><id>http://arxiv.org/abs/hep-th/9901001v3</id><title>Strings &amp;
        Branes &#x3B1;</title><summary>  An <![CDATA[abstract]]>.  </summary>
        <author><name>A. Author</name></author><author>\n<name>B. Author</name><arxiv:affiliation>X</arxiv:affiliation></author></entry></feed>`;
    expect(parseArxivAtom(xml, { id: 'hep-th/9901001', version: null })).toEqual({
      id: 'hep-th/9901001',
      version: 3,
      title: 'Strings & Branes α',
      authors: ['A. Author', 'B. Author'],
      abstract: 'An abstract.',
      absUrl: 'https://arxiv.org/abs/hep-th/9901001v3',
    });
  });
  it('reports missing papers and API errors as short sentences', () => {
    const error = `<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title></entry></feed>`;
    expect(() => parseArxivAtom(error, { id: '2401.99999', version: null })).toThrow(
      'arXiv has no paper with the ID 2401.99999.',
    );
    expect(() => parseArxivAtom('<feed></feed>', { id: '2401.99999', version: 9 })).toThrow(
      'arXiv has no version 9 of 2401.99999.',
    );
  });
});
