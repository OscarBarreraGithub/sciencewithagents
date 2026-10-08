import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  documentReadingResponseSchema,
  documentReadingSchema,
  type DocumentReading,
} from '@dock/shared';
import {
  buildReading,
  expandReadingSource,
  readerExecutable,
  type ReadingOptions,
} from './document-reading.js';

it.skipIf(!readerExecutable('pandoc'))(
  'reflows real LaTeX macros, includes, tables, citations and figures without executing source',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'swa-reading-'));
    try {
      const home = join(root, 'source');
      await mkdir(home);
      await writeFile(
        join(home, 'chapter.tex'),
        String.raw`\section{Included chapter}Included prose.\begin{tabular}{ll}Name&Value\\Temperature&$T$\end{tabular}`,
      );
      const source = String.raw`\documentclass{article}\usepackage{amsmath,graphicx}
\newcommand{\energy}{\mathcal{E}}\newcommand{\dd}{\mathrm d}
\begin{document}\section{A readable report}Ordinary text $\energy=mc^2$.
\input{chapter}\[\frac\dd{\dd t}\energy=\sum_{n=1}^{100}a_n\]
\includegraphics{figure.png}\cite{sample}
\begin{thebibliography}{9}\bibitem{sample}A reference.\end{thebibliography}\end{document}`;
      const input = join(home, 'report.tex');
      await writeFile(input, source);
      await writeFile(
        join(home, 'figure.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBbkAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      const output = await buildReading(input, home, join(root, 'assets'));
      expect(output.available).toBe(true);
      expect(output.html).toContain('Included chapter');
      expect(output.html).toContain('<table>');
      expect(output.html).toContain('mathcal');
      expect(output.html).toContain(String.raw`\frac{\mathrm d}`);
      expect(output.html).toContain('reader-asset:');
      expect(output.html).toContain('href="#bib-sample"');
      expect(output.html).toContain('A reference.');
      expect(output.warnings).toEqual([]);
      expect(await readFile(input, 'utf8')).toBe(source);
      expect((await readdir(home)).sort()).toEqual(['chapter.tex', 'figure.png', 'report.tex']);
      await writeFile(join(root, 'private.tex'), 'PRIVATE SENTINEL');
      await writeFile(input, String.raw`\input{../private}`);
      await expect(buildReading(input, home, join(root, 'assets'))).rejects.toThrow(/outside/);
      await writeFile(input, String.raw`\input{report}`);
      await expect(buildReading(input, home, join(root, 'assets'))).rejects.toThrow(/recursive/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Synthetic fixtures for the failures measured in the arXiv corpus study (R0 report §8).
// Each is written from scratch and reproduces one cause; none contains paper text.
describe.skipIf(!readerExecutable('pandoc'))('arXiv source rules', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swa-reading-rules-'));
    await mkdir(join(root, 'source'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  async function read(body: string, preamble = '', options?: ReadingOptions) {
    const input = join(root, 'source', 'main.tex');
    await writeFile(
      input,
      `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`,
    );
    return buildReading(input, join(root, 'source'), join(root, 'assets'), undefined, options);
  }
  const visible = (reading: DocumentReading) =>
    [reading.html.replace(/<[^>]+>/g, ' '), ...reading.warnings].join('\n');
  function expectHumanMessages(reading: DocumentReading) {
    expect(visible(reading)).not.toMatch(/ENOENT|realpath|Error at|swa-reading/);
    expect(visible(reading)).not.toContain(root);
  }

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBbkAAAAASUVORK5CYII=',
    'base64',
  );
  it('shares one deadline across PDF figures while retaining converted figures, raster images and body', async () => {
    const home = join(root, 'source');
    const bin = join(root, 'bin');
    const calls = join(root, 'figure-calls');
    await mkdir(bin);
    for (const name of ['converted', 'slow', 'later-one', 'later-two'])
      await writeFile(join(home, name + '.pdf'), `%PDF-1.4\n${name}\n`);
    await writeFile(join(home, 'before.png'), png);
    await writeFile(join(home, 'after.png'), png);
    // The slow converter owns only its Node process; timeout cleanup leaves no shell children.
    await writeFile(
      join(bin, 'pdftoppm'),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const source = path.basename(process.argv.at(-2));
fs.appendFileSync(${JSON.stringify(calls)}, source + '\\n');
if (source === 'converted.pdf') {
  fs.writeFileSync(process.argv.at(-1) + '.png', Buffer.from('${png.toString('base64')}', 'base64'));
} else {
  setTimeout(() => process.exit(1), 60000);
}
`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
    try {
      const started = Date.now();
      const reading = await read(
        String.raw`Original prose $x=1$.
\includegraphics{before.png}\includegraphics{converted.pdf}\includegraphics{slow.pdf}
\includegraphics{later-one.pdf}\includegraphics{later-two.pdf}\includegraphics{after.png}
Final prose.`,
        '',
        { budgetMs: 5500 },
      );
      expect(Date.now() - started).toBeLessThan(8500);
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual([
        'converted.pdf',
        'slow.pdf',
      ]);
      expect(reading.available).toBe(true);
      expect(reading.html).toContain('Original prose');
      expect(reading.html).toContain('Final prose');
      expect(reading.html).toContain('x=1');
      expect(reading.html.match(/reader-asset:/g)).toHaveLength(3);
      expect(reading.html.match(/Figure available in Original PDF\./g)).toHaveLength(3);
      expect(await readdir(join(root, 'assets'))).toHaveLength(2);
      expect(await readFile(join(home, 'after.png'))).toEqual(png);
      expect(await readFile(join(home, 'slow.pdf'), 'utf8')).toBe('%PDF-1.4\nslow\n');
      expectHumanMessages(reading);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 10000);

  it('resolves an explicitly named extensionless figure without changing source or math', async () => {
    const home = join(root, 'source');
    await mkdir(join(home, 'Figures'));
    await writeFile(join(home, 'Figures', 'diagram.png'), png);
    const reading = await read(String.raw`Original prose $x=1$.\includegraphics{Figures/diagram}`);
    expect(reading.html).toMatch(/reader-asset:[a-f0-9]{64}\.png/);
    expect(reading.html).toContain('Original prose');
    expect(reading.html).toContain('x=1');
    expect(reading.warnings).toEqual([]);
    expect(await readFile(join(home, 'Figures', 'diagram.png'))).toEqual(png);
    expect(await readFile(join(home, 'main.tex'), 'utf8')).toContain(
      String.raw`\includegraphics{Figures/diagram}`,
    );
  });

  it('keeps exact figure names and uses a fixed extension order only for omitted extensions', async () => {
    const home = join(root, 'source');
    await writeFile(join(home, 'diagram.png'), png);
    await writeFile(join(home, 'diagram.jpg'), Buffer.concat([png, Buffer.from('different')]));
    const reading = await read(String.raw`\includegraphics{diagram}\includegraphics{diagram.jpg}`);
    expect(reading.html).toMatch(/reader-asset:[a-f0-9]{64}\.png/);
    expect(reading.html).toMatch(/reader-asset:[a-f0-9]{64}\.jpg/);
    expect(reading.warnings).toEqual([]);
    const absent = await read(String.raw`\includegraphics{diagram.jpeg}`);
    expect(absent.html).not.toContain('reader-asset:');
    expect(absent.html).toContain('Figure available in Original PDF');
  });

  it('resolves literal preamble graphicspath directories with existing name and extension precedence', async () => {
    const home = join(root, 'source');
    await mkdir(join(home, 'figures'));
    await mkdir(join(home, 'other'));
    const secondary = Buffer.concat([png, Buffer.from('secondary')]);
    await writeFile(join(home, 'local.png'), png);
    await writeFile(join(home, 'figures', 'local.png'), secondary);
    await writeFile(join(home, 'figures', 'diagram.png'), png);
    await writeFile(join(home, 'figures', 'diagram.jpg'), secondary);
    await writeFile(join(home, 'other', 'diagram.png'), secondary);
    const body = String.raw`Original prose $x=1$.
\includegraphics{local}\includegraphics{diagram}\includegraphics{diagram.jpg}
\includegraphics{diagram.jpeg}`;
    const preamble = String.raw`\usepackage{graphicx}\graphicspath{{figures/}{other/}}`;
    const reading = await read(body, preamble);
    expect(reading.html.match(/reader-asset:/g)).toHaveLength(3);
    const images = [...reading.html.matchAll(/reader-asset:([a-f0-9]{64}\.[a-z]+)/g)].map(
      (match) => match[1],
    );
    expect(images[0]).toBe(images[1]);
    expect(images[2]).toMatch(/\.jpg$/);
    expect(reading.html.match(/Figure available in Original PDF\./g)).toHaveLength(1);
    expect(reading.html).toContain('Original prose');
    expect(reading.html).toContain('x=1');
    expect(await readFile(join(home, 'main.tex'), 'utf8')).toContain(preamble);
    expect(await readFile(join(home, 'figures', 'diagram.png'))).toEqual(png);
  });

  it('keeps graphicspath candidates within the registered folder and rejects oversized assets', async () => {
    const home = join(root, 'source');
    await mkdir(join(home, 'figures'));
    await writeFile(join(root, 'outside.png'), png);
    await symlink(join(root, 'outside.png'), join(home, 'figures', 'diagram.png'));
    const preamble = String.raw`\graphicspath{{figures/}}`;
    const outside = await read(String.raw`Body.\includegraphics{diagram}`, preamble);
    expect(outside.html).not.toContain('reader-asset:');
    expect(outside.html).toContain('Figure available in Original PDF');
    await rm(join(home, 'figures', 'diagram.png'));
    await writeFile(join(home, 'figures', 'diagram.png'), Buffer.alloc(8 * 1024 ** 2 + 1));
    const oversized = await read(String.raw`Body.\includegraphics{diagram}`, preamble);
    expect(oversized.html).not.toContain('reader-asset:');
    expect(oversized.html).toContain('Figure available in Original PDF');
    expectHumanMessages(outside);
    expectHumanMessages(oversized);
  });

  it('does not infer graphicspath directories from macros, conditionals or ambiguous declarations', async () => {
    const home = join(root, 'source');
    await mkdir(join(home, 'figures'));
    await writeFile(join(home, 'figures', 'diagram.png'), png);
    for (const preamble of [
      String.raw`\newcommand{\unused}{\graphicspath{{figures/}}}`,
      String.raw`\iffalse\graphicspath{{figures/}}\fi`,
      String.raw`\begingroup\graphicspath{{figures/}}\endgroup`,
      String.raw`\bgroup\graphicspath{{figures/}}\egroup`,
      String.raw`\begin{filecontents}{fake.tex}
\graphicspath{{figures/}}
\end{filecontents}`,
      String.raw`\newcommand{\figurefolder}{figures/}\graphicspath{{\figurefolder}}`,
      String.raw`\graphicspath{{figures/}}\graphicspath{{\unknown}}`,
      `\\graphicspath{${'{figures/}'.repeat(17)}}`,
    ]) {
      const reading = await read(String.raw`Body.\includegraphics{diagram}`, preamble);
      expect(reading.html).not.toContain('reader-asset:');
      expect(reading.html).toContain('Figure available in Original PDF');
    }
    const laterOverride = await read(
      String.raw`\graphicspath{{unknown/}}Body.\includegraphics{diagram}`,
      String.raw`\graphicspath{{figures/}}`,
    );
    expect(laterOverride.html).not.toContain('reader-asset:');
    expect(laterOverride.html).toContain('Figure available in Original PDF');
  });

  it('retains placeholders for unavailable, outside-root and oversized extensionless figures', async () => {
    const home = join(root, 'source');
    await writeFile(join(root, 'outside.png'), png);
    await symlink(join(root, 'outside.png'), join(home, 'diagram.png'));
    const outside = await read(String.raw`Body.\includegraphics{diagram}\includegraphics{absent}`);
    expect(outside.html).not.toContain('reader-asset:');
    expect(outside.html).toContain('Figure available in Original PDF');
    expectHumanMessages(outside);
    await rm(join(home, 'diagram.png'));
    await writeFile(join(home, 'diagram.png'), Buffer.alloc(8 * 1024 ** 2 + 1));
    const oversized = await read(String.raw`Body.\includegraphics{diagram}`);
    expect(oversized.html).not.toContain('reader-asset:');
    expect(oversized.html).toContain('Figure available in Original PDF');
    expectHumanMessages(oversized);
  });

  it('1: joins a blank line inside a caption', async () => {
    const reading = await read(
      'Opening text.\n\n\\begin{figure}\\caption{First half\n\nsecond half.}\\end{figure}\n\nClosing text.',
    );
    expect(reading.html).toContain('second half.');
    expect(reading.html).toContain('Closing text.');
    expect(reading.health?.rules['blank-line-in-argument']).toBe(1);
    expect(reading.health?.dropped).toEqual([]);
    expect(reading.health?.conversion).toBe('complete');
  });

  it('2: closes a brace TeX tolerates at a paragraph end', async () => {
    const reading = await read(
      'Devices are noisy ({\\textit{i.e.}, not ideal) today.\n\nA later paragraph.',
    );
    expect(reading.html).toContain('not ideal) today.');
    expect(reading.html).toContain('A later paragraph.');
    expect(reading.health?.rules['unbalanced-brace-closed']).toBe(1);
    expect(reading.health?.dropped).toEqual([]);
  });

  it('3: does not group a definition named on another line or named \\renewcommand', async () => {
    const reading = await read(
      'Bars $\\left. a \\bar b$ and $\\half$.',
      '\\let\\nc\\newcommand\n\\renewcommand{\\bar}{\\;\\right|\\;}\n\\nc{\\half}{\\frac12}',
    );
    expect(reading.html).toContain('Bars');
    expect(reading.html).not.toContain('{{\\bar}}');
    expect(reading.health?.dropped).toEqual([]);
  });

  it('4: drops TeX programming and self-referential definitions instead of hanging', async () => {
    const started = Date.now();
    const reading = await read(
      '\\tableofcontents\nVisible body text.',
      '\\makeatletter\n\\def\\a@b#1 {#1}\n\\makeatother\n\\edef\\tableofcontents{\\unexpanded\\expandafter{\\tableofcontents}}',
      { timeoutMs: 8000 },
    );
    expect(Date.now() - started).toBeLessThan(8000);
    expect(reading.html).toContain('Visible body text.');
    expect(reading.health?.rules['makeatletter-block']).toBe(1);
    expect(reading.health?.rules['unsafe-definition']).toBe(1);
    expect(reading.health?.conversion).toBe('complete');
  });

  it('4: stops a conversion that exceeds its per-pass time limit with a sentence', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'pandoc'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const started = Date.now();
      const reading = await read('Body.', '', { timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(4000);
      expect(reading.available).toBe(true);
      expect(reading.health?.conversion).toBe('unavailable');
      expect(reading.html).toContain('Use Original PDF');
      expectHumanMessages(reading);
    } finally {
      process.env.PATH = path;
    }
  });

  it('5: reads \\global\\long\\def as \\def', async () => {
    const reading = await read('Set $\\U$ here.', '\\global\\long\\def\\U{\\mathbb{U}}');
    expect(reading.html).toContain('\\mathbb{U}');
    expect(reading.health?.rules['prefixed-definition']).toBe(1);
  });

  it('6: skips a missing include, records it and shows a note', async () => {
    const reading = await read('Before the gap.\n\n\\input{nothere}\n\nAfter the gap.');
    expect(reading.available).toBe(true);
    expect(reading.html).toContain('After the gap.');
    expect(reading.health?.missingIncludes).toEqual(['nothere.tex']);
    expect(reading.health?.conversion).toBe('partial');
    expect(reading.html).toContain('Part of this paper (nothere.tex) is only in the Original PDF.');
    expect(reading.warnings.join('\n')).toContain('nothere.tex');
    expectHumanMessages(reading);
  });

  it('inlines the main job bibliography with its original prose and citation links', async () => {
    const home = join(root, 'source');
    const bbl = String.raw`\begin{thebibliography}{9}
\bibitem[First(2024)]{first}A. First. Original reference with $E=mc^2$.
\bibitem{second}B. Second. A qualified result, under the stated assumptions.
\end{thebibliography}`;
    await writeFile(join(home, 'main.bbl'), bbl);
    // The argument names BibTeX databases. Their similarly named .bbl is not this job's output.
    await writeFile(join(home, 'database.bbl'), 'WRONG BIBLIOGRAPHY SENTINEL');
    const reading = await read(String.raw`Body \cite{first,second}.
\bibliography{database,other-database}`);
    expect(reading.html).toContain('A. First. Original reference');
    expect(reading.html).toContain('E=mc^2');
    expect(reading.html).toContain('under the stated assumptions');
    expect(reading.html).toContain('href="#bib-first"');
    expect(reading.html).toContain('href="#bib-second"');
    expect(reading.html).not.toContain('WRONG BIBLIOGRAPHY');
    expect(reading.warnings).toEqual([]);
    expect(reading.health?.rules['bibliography-bbl-inlined']).toBe(1);
    expect(await readFile(join(home, 'main.bbl'), 'utf8')).toBe(bbl);
  });

  it('reads an included bibliography command from the main job and ignores commented commands', async () => {
    const home = join(root, 'source');
    await mkdir(join(home, 'parts'));
    await writeFile(join(home, 'parts', 'ending.tex'), String.raw`\bibliography{references}`);
    await writeFile(
      join(home, 'main.bbl'),
      String.raw`\begin{thebibliography}{9}
\bibitem{source}Main job reference.\end{thebibliography}`,
    );
    const reading = await read(String.raw`\cite{source}
% \bibliography{commented}
\input{parts/ending}`);
    expect(reading.html).toContain('Main job reference');
    expect(reading.html).toContain('href="#bib-source"');
    expect(reading.health?.rules['bibliography-bbl-inlined']).toBe(1);
    expect(reading.warnings).toEqual([]);
  });

  it('preserves supplied natbib author-year labels and notes in textual and parenthetical citations', async () => {
    const bbl = String.raw`\begin{thebibliography}{9}
\providecommand{\natexlab}[1]{#1}
\bibitem[Aster et~al.(2020)Aster, Birch, and Cedar]{aster}Original first reference.
\bibitem[{Birch} \& Cedar(2021{\natexlab{a}})Birch and Cedar]{birch}Original second reference.
\end{thebibliography}`;
    await writeFile(join(root, 'source', 'main.bbl'), bbl);
    const reading = await read(String.raw`According to \citet{aster}, the result is $E=mc^2$.
Compare \citep[see][pp.~4--6]{aster,birch} with \citet[chap.~2]{birch}.
\bibliography{references}`);
    const prose = reading.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    expect(prose).toContain('According to Aster et al. (2020), the result');
    expect(prose).toContain('(see Aster et al., 2020; Birch &amp; Cedar, 2021a, pp. 4–6)');
    expect(prose).toContain('Birch &amp; Cedar (2021a, chap. 2)');
    expect(reading.html).toContain('href="#bib-aster"');
    expect(reading.html).toContain('href="#bib-birch"');
    expect(reading.html).toContain('E=mc^2');
    expect(reading.html).toContain('Original first reference');
    expect(reading.html).toContain('Original second reference');
    expect(reading.warnings).toEqual([]);
    expect(await readFile(join(root, 'source', 'main.bbl'), 'utf8')).toBe(bbl);
  });

  it('retains citation notes and missing-key evidence without guessing authors from reference prose', async () => {
    const reading = await read(String.raw`Numeric \citep[see][p.~7]{numbered}.
Unknown \citep[compare][p.~9]{absent}. Unsupported label \citet{alpha}.
\begin{thebibliography}{9}
\bibitem{numbered}A. Scientist. Original numbered reference, 2020.
\bibitem[AB21]{alpha}A. Author and B. Author. Original alpha reference, 2021.
\end{thebibliography}`);
    const prose = reading.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    expect(prose).toContain('Numeric see [1], p. 7.');
    expect(prose).toContain('Unknown compare [absent], p. 9.');
    expect(prose).toContain('Unsupported label [2].');
    expect(reading.html).toContain('Original numbered reference');
    expect(reading.warnings).toContain(
      'Some citations need the original PDF for their bibliography labels.',
    );
  });

  it.each([
    String.raw`\usepackage[numbers]{natbib}`,
    String.raw`\usepackage[numbers]{graphicx,natbib,url}`,
    String.raw`\PassOptionsToPackage{numbers}{natbib}`,
    String.raw`\setcitestyle{numbers,square}`,
  ])('retains the numeric fallback when the source explicitly selects %s', async (preamble) => {
    const reading = await read(
      String.raw`Numeric \citep{aster} and \citet{aster}.
\begin{thebibliography}{9}
\bibitem[Aster(2020)]{aster}Original reference.\end{thebibliography}`,
      preamble,
    );
    expect(reading.html).toContain('<a href="#bib-aster">[1]</a>');
    expect(reading.html).not.toContain('Aster (2020)');
    expect(reading.html).not.toContain('Aster, 2020');
    expect(reading.warnings).toEqual([]);
  });

  it('keeps a missing bibliography visible without generating or guessing its contents', async () => {
    const reading = await read(String.raw`Opening prose.\bibliography{references}Closing prose.`);
    expect(reading.html).toContain('Opening prose.');
    expect(reading.html).toContain('Closing prose.');
    expect(reading.html).toContain('main.bbl');
    expect(reading.html).not.toContain('PRIVATE BIB SENTINEL');
    expect(reading.health?.missingIncludes).toEqual(['main.bbl']);
    expect(reading.health?.conversion).toBe('partial');
    expectHumanMessages(reading);
  });

  it('applies the existing root and byte limits to supplied bibliographies', async () => {
    const home = join(root, 'source');
    const input = join(home, 'main.tex');
    await writeFile(input, String.raw`\bibliography{references}`);
    await writeFile(join(root, 'outside.bbl'), 'OUTSIDE BIBLIOGRAPHY SENTINEL');
    await symlink(join(root, 'outside.bbl'), join(home, 'main.bbl'));
    await expect(expandReadingSource(input, home)).rejects.toThrow(/outside/);
    await rm(join(home, 'main.bbl'));
    await writeFile(join(home, 'main.bbl'), 'x'.repeat(8 * 1024 ** 2));
    await expect(expandReadingSource(input, home)).rejects.toThrow(/combined/);
  });

  it('renders cited local bib-only references with author-date links and notes without changing source', async () => {
    const home = join(root, 'source');
    const bib =
      '@article{aster,author={Ann Aster},title={{Original reference title}},year={2020},journal={Journal of Results}}\n' +
      '@article{unused,author={Ben Birch},title={Uncited reference sentinel},year={2021}}';
    await writeFile(join(home, 'references.bib'), bib);
    const reading = await read(String.raw`According to \citet{aster}, $E=mc^2$ remains unchanged.
Compare \citep[see][p.~7]{aster}.\bibliography{references}`);
    const prose = reading.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    expect(prose).toMatch(/According to Aster\s*\(2020\)/);
    expect(prose).toContain('see');
    expect(prose).toContain('7');
    expect(reading.html).toContain('href="#ref-aster"');
    expect(reading.html).toContain('id="ref-aster"');
    expect(reading.html).toContain('Original reference title');
    expect(reading.html).not.toContain('Uncited reference sentinel');
    expect(reading.html).toContain('E=mc^2');
    expect(reading.health?.missingIncludes).toEqual([]);
    expect(reading.health?.rules['bibliography-bib-loaded']).toBe(1);
    expect(reading.health?.conversion).toBe('complete');
    expect(reading.warnings.join(' ')).toContain('author–date');
    expect(await readFile(join(home, 'references.bib'), 'utf8')).toBe(bib);
    const expanded = await expandReadingSource(join(home, 'main.tex'), home);
    const formatted = await buildReading(
      join(home, 'main.tex'),
      home,
      join(root, 'formatted'),
      expanded,
    );
    expect(formatted.html).toContain('id="ref-aster"');
    expect(formatted.html).toContain('E=mc^2');
  });

  it('loads multiple bib databases named by an included command and ignores comments', async () => {
    const home = join(root, 'source');
    await mkdir(join(home, 'parts'));
    await writeFile(join(home, 'parts', 'end.tex'), String.raw`\bibliography{first.bib,second}`);
    await writeFile(
      join(home, 'first.bib'),
      '@article{one,title={First supplied title},author={A. First},year={2020}}',
    );
    await writeFile(
      join(home, 'second.bib'),
      '@book{two,title={Second supplied title},author={B. Second},year={2021}}',
    );
    const reading = await read(String.raw`\citep{one,two}
% \bibliography{not-present}
\input{parts/end}`);
    expect(reading.html).toContain('id="ref-one"');
    expect(reading.html).toContain('id="ref-two"');
    expect(reading.html).toMatch(/First supplied title/i);
    expect(reading.html).toMatch(/Second supplied title/i);
    expect(reading.health?.rules['bibliography-bib-loaded']).toBe(2);
    expect(reading.health?.missingIncludes).toEqual([]);
  });

  it('prefers the supplied bbl without accessing its bib databases', async () => {
    const home = join(root, 'source');
    await writeFile(
      join(home, 'main.bbl'),
      String.raw`\begin{thebibliography}{9}\bibitem{one}Supplied final reference.\end{thebibliography}`,
    );
    await writeFile(join(root, 'outside.bib'), '@article{one,title={OUTSIDE DATABASE SENTINEL}}');
    await symlink(join(root, 'outside.bib'), join(home, 'references.bib'));
    const reading = await read(String.raw`\cite{one}\bibliography{references}`);
    expect(reading.html).toContain('Supplied final reference');
    expect(reading.html).toContain('href="#bib-one"');
    expect(reading.html).not.toContain('OUTSIDE DATABASE SENTINEL');
    expect(reading.health?.rules['bibliography-bib-loaded']).toBeUndefined();
    expect(reading.warnings).toEqual([]);
  });

  it('retains missing database and unknown citation evidence beside available bib references', async () => {
    await writeFile(
      join(root, 'source', 'references.bib'),
      '@article{one,title={Available reference},author={A. First},year={2020}}',
    );
    const reading = await read(
      String.raw`Body \cite{one,unknown}.\bibliography{references,absent}`,
    );
    expect(reading.html).toMatch(/Available reference/i);
    expect(reading.html).toContain('unknown');
    expect(reading.health?.missingIncludes).toContain('absent.bib');
    expect(reading.health?.conversion).toBe('partial');
    expect(reading.warnings.join(' ')).toContain('bibliography labels');
    expectHumanMessages(reading);
  });

  it('applies canonical root, combined byte and file-count limits to bib databases', async () => {
    const home = join(root, 'source'),
      input = join(home, 'main.tex');
    await writeFile(input, String.raw`\bibliography{references}`);
    await writeFile(join(root, 'outside.bib'), '@article{one,title={OUTSIDE DATABASE SENTINEL}}');
    await symlink(join(root, 'outside.bib'), join(home, 'references.bib'));
    await expect(expandReadingSource(input, home)).rejects.toThrow(/outside/);
    await rm(join(home, 'references.bib'));
    await writeFile(join(home, 'references.bib'), 'x'.repeat(8 * 1024 ** 2));
    await expect(expandReadingSource(input, home)).rejects.toThrow(/combined/);
    await rm(join(home, 'references.bib'));
    const names = Array.from({ length: 100 }, (_, i) => `db${i}`);
    for (const name of names) await writeFile(join(home, name + '.bib'), '@comment{empty}');
    await writeFile(input, `\\bibliography{${names.join(',')}}`);
    await expect(expandReadingSource(input, home)).rejects.toThrow(/too many/);
  });

  it('keeps body and unresolved citation when bib parsing fails', async () => {
    await writeFile(join(root, 'source', 'references.bib'), '@article{broken, title={unterminated');
    const reading = await read(
      String.raw`Original body $x=1$.\cite{broken}\bibliography{references}`,
    );
    expect(reading.html).toContain('Original body');
    expect(reading.html).toContain('x=1');
    expect(reading.html).toContain('broken');
    expect(reading.health?.conversion).toBe('partial');
    expect(reading.warnings.join(' ')).toContain('bibliography');
    expectHumanMessages(reading);
  });

  it('bounds bib parsing time and retains body content after a bibliography timeout', async () => {
    const realPandoc = readerExecutable('pandoc')!;
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'pandoc'),
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--from=biblatex" ]; then sleep 5; exit 1; fi\ndone\nexec "${realPandoc}" "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, 'source', 'references.bib'),
      '@article{one,title={One},year={2020}}',
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const started = Date.now();
      const reading = await read(
        String.raw`Preserved body $x=1$.\cite{one}\bibliography{references}`,
        '',
        { timeoutMs: 300 },
      );
      expect(Date.now() - started).toBeLessThan(4000);
      expect(reading.html).toContain('Preserved body');
      expect(reading.html).toContain('x=1');
      expect(reading.health?.conversion).toBe('partial');
      expect(reading.warnings.join(' ')).toContain('bibliography could not be converted');
    } finally {
      process.env.PATH = path;
    }
  });

  it('7: expands environment shortcuts without grouping them', async () => {
    const reading = await read(
      'Shortcut:\n\\be x=1 \\ee',
      '\\newcommand{\\be}{\\begin{equation}}\\newcommand{\\ee}{\\end{equation}}',
    );
    const math = /<span class="math display">([^<]*)<\/span>/.exec(reading.html)?.[1] ?? '';
    // Pandoc versions retain the equation environment inside \[...\] or normalize it.
    expect(math).toMatch(/^\\\[\s*(?:x=1|\\begin\{equation\}\s*x=1\s*\\end\{equation\})\s*\\\]$/);
    expect(math).not.toMatch(/^\\\[\s*\}|\{\s*\\\]$/);
  });

  it('11: shows revtex title, authors with affiliations and abstract first', async () => {
    const input = join(root, 'source', 'main.tex');
    await writeFile(
      input,
      String.raw`\documentclass[aps,prl]{revtex4-2}
\begin{document}
\title{A tiny result on $x^2$}
\author{Ann Alpha}
\email{ann@example.org}
\affiliation{First Institute, Town}
\author{Ben Beta}
\affiliation{Second Laboratory, City}
\date{\today}
\begin{abstract}
We show a small thing.
\end{abstract}
\maketitle
\section{Introduction}
Body text.
\end{document}
`,
    );
    const reading = await buildReading(input, join(root, 'source'), join(root, 'assets'));
    const html = reading.html;
    expect(html.indexOf('reading-front-matter')).toBeLessThan(html.indexOf('Introduction'));
    expect(html).toMatch(
      /<h1[^>]*class="reading-title"[^>]*>A tiny result on <span class="math inline">/,
    );
    expect(html).toMatch(
      /class="reading-authors"[\s\S]*Ann Alpha<sup>1<\/sup>, Ben Beta<sup>2<\/sup>/,
    );
    expect(html).toMatch(/class="reading-affiliations"[\s\S]*<sup>1<\/sup>First Institute, Town/);
    expect(html).toContain('<sup>2</sup>Second Laboratory, City');
    expect(html).toContain('ann@example.org');
    expect(html).toMatch(/class="reading-abstract"[\s\S]*Abstract[\s\S]*We show a small thing\./);
    expect(html).not.toContain('1970');
    expect(reading.warnings).toEqual([]);
  });

  it('11: maps JHEP-style labels, \\abstract{} and strips leaked layout arguments', async () => {
    const reading = await read(
      '\\maketitle\n\\begin{wrapfigure}{r}{0.29\\textwidth}\nA wrapped float.\n\\end{wrapfigure}\nBody.',
      String.raw`\titlespacing*{\section}
{0pt}{8pt}{4pt}
\title{\boldmath{Bold title}}
\author[a]{Ann Alpha}
\author[b]{and Ben Beta}
\affiliation[a]{Dept A}
\affiliation[b]{Dept B}
\emailAdd{ann@example.org}
\abstract{An abstract.

Second paragraph.}`,
    );
    const text = reading.html.replace(/<[^>]+>/g, ' ');
    expect(reading.html).toMatch(/class="reading-title"[^>]*>Bold title/);
    expect(reading.html).toMatch(/Ann Alpha<sup>a<\/sup>, Ben Beta<sup>b<\/sup>/);
    expect(reading.html).toContain('<sup>b</sup>Dept B');
    expect(reading.html).toMatch(/reading-abstract[\s\S]*An abstract\.[\s\S]*Second paragraph\./);
    expect(text).not.toMatch(/0pt|8pt|\br\b|0\.29/);
    expect(text).toContain('A wrapped float.');
  });

  it('21: plain TeX shows an Original PDF sentence, not a raw error', async () => {
    const input = join(root, 'source', 'paper.tex');
    await writeFile(input, '\\input harvmac\n\\Title{x}{y}\nSome text.\n\\bye\n');
    const reading = await buildReading(input, join(root, 'source'), join(root, 'assets'));
    expect(reading.available).toBe(true);
    expect(reading.health?.plainTex).toBe(true);
    expect(reading.health?.missingIncludes).toEqual(['harvmac.tex']);
    expect(reading.html).toContain('Use Original PDF to read it.');
    expect(reading.warnings.join('\n')).toContain('This paper loads harvmac.tex');
    expectHumanMessages(reading);
  });

  it('replaces a passage Pandoc still rejects with a recorded, visible note', async () => {
    const reading = await read(
      'Intro paragraph.\n\n\\textbf{bold start\n\nbold end} after.\n\nFinal paragraph.',
    );
    expect(reading.html).toContain('Intro paragraph.');
    expect(reading.html).toContain('Final paragraph.');
    expect(reading.html).toContain('Part of this section is only in the Original PDF.');
    expect(reading.health?.dropped).toHaveLength(1);
    expect(reading.health?.dropped[0]).toMatchObject({ part: 'body' });
    expect(reading.health?.conversion).toBe('partial');
    expect(reading.warnings.join('\n')).toContain('only in the Original PDF');
  });

  it('drops a rejected last paragraph without touching the document end', async () => {
    const reading = await read('Kept paragraph.\n\n\\textbf{bold start\n\nbold end} after.');
    expect(reading.health?.conversion).toBe('partial');
    expect(reading.html).toContain('Kept paragraph.');
    expect(reading.html).toContain('Part of this section is only in the Original PDF.');
    expect(reading.health?.dropped).toHaveLength(1);
  });

  it('reads missing-include markers back from a phone-formatting copy', async () => {
    const input = join(root, 'source', 'main.tex');
    await writeFile(
      input,
      '\\documentclass{article}\n\\input{macros}\n\\begin{document}\nBefore.\n\n\\input{nothere}\n\nAfter.\n\\end{document}\n',
    );
    // The formatting worker expands without a health report; markers still mark the gaps,
    // stay out of the formatter's file-command check and keep the preamble comparable.
    const expanded = await expandReadingSource(input, join(root, 'source'));
    expect(expanded).toContain('\\readingmissinginput{macros.tex}');
    expect(expanded).toContain('\\readingmissinginput{nothere.tex}');
    expect(/\\(?:input|include|write18|openout|read)\b/.test(expanded)).toBe(false);
    const formatted = expanded.replace('After.', 'After, formatted.');
    expect(formatted.split('\\begin{document}')[0]).toBe(expanded.split('\\begin{document}')[0]);
    const reading = await buildReading(
      input,
      join(root, 'source'),
      join(root, 'assets'),
      formatted,
    );
    expect(reading.html).toContain('After, formatted.');
    expect(reading.html).toContain('Part of this paper (nothere.tex) is only in the Original PDF.');
    expect(reading.health?.missingIncludes).toEqual(['macros.tex', 'nothere.tex']);
    expect(reading.health?.conversion).toBe('partial');
    expect(reading.warnings.join('\n')).toContain('This paper loads nothere.tex');
  });

  it('notes a title or author list lost with a rejected preamble passage', async () => {
    const reading = await read('Body text.', '\\title{Lost title}\n\\author{Ann}\n\\def\\x#1 {y}');
    expect(reading.health?.dropped).toEqual([expect.objectContaining({ part: 'preamble' })]);
    expect(reading.html).toContain('The title or author list is only in the Original PDF.');
    expect(reading.html).toContain('Body text.');
  });

  it('reports a vanished source as a sentence without its path', async () => {
    const error = await buildReading(
      join(root, 'source', 'gone.tex'),
      join(root, 'source'),
      join(root, 'assets'),
    ).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/ENOENT|realpath/);
    expect((error as Error).message).not.toContain(root);
  });
});

it('parses readings from older and newer servers on the client', () => {
  const older = { available: true, html: '<p>x</p>', warnings: [], labels: {} };
  expect(documentReadingResponseSchema.parse(older)).toMatchObject({ html: '<p>x</p>' });
  expect(documentReadingResponseSchema.parse(older).health).toBeUndefined();
  const newer = documentReadingResponseSchema.parse({
    ...older,
    figures: [{ later: true }],
    health: {
      conversion: 'needs-fixer',
      dropped: [{ part: 'appendix', reason: 'r', excerpt: 'e', line: 3 }],
      bibliography: { resolved: 2 },
    },
  });
  expect(newer).not.toHaveProperty('figures');
  expect(newer.health).toMatchObject({
    conversion: 'needs-fixer',
    plainTex: false,
    missingIncludes: [],
    dropped: [{ part: 'appendix', reason: 'r', excerpt: 'e' }],
  });
  expect(newer.health).not.toHaveProperty('bibliography');
  // The server contract itself stays strict.
  expect(documentReadingSchema.safeParse({ ...older, figures: [] }).success).toBe(false);
});
