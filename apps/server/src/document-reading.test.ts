import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReading, readerExecutable } from './document-reading.js';

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
