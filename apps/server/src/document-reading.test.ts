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

  it('keeps a missing bibliography visible without generating or guessing its contents', async () => {
    await writeFile(
      join(root, 'source', 'references.bib'),
      '@article{source,title={PRIVATE BIB SENTINEL}}',
    );
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
