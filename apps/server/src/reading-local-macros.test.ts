import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { localMacroLimits, localReadingMacros } from './reading-local-macros.js';
import { readingHealth } from './reading-source-rules.js';

const source = String.raw`\documentclass{article}\usepackage{author}\begin{document}$\opt$\end{document}`;
const definition = String.raw`\newcommand{\opt}{\mathrm{opt}}`;
describe('bounded local author macro data', () => {
  it('restores an exact zero-argument font atom without rewriting source or math', () => {
    const health = readingHealth();
    const macros = localReadingMacros(source, [{ file: 'author.sty', text: definition }], health);
    expect(macros).toEqual({ '\\opt': String.raw`\mathrm{opt}` });
    expect(health.localMacros).toEqual([
      { name: '\\opt', file: 'author.sty', status: 'restored', reason: null, occurrences: 0 },
    ]);
    expect(() => katex.renderToString(String.raw`\opt`, { throwOnError: true })).toThrow(
      /Undefined control sequence/,
    );
    expect(() =>
      katex.renderToString(String.raw`\opt`, {
        throwOnError: true,
        trust: false,
        maxExpand: 1000,
        macros,
      }),
    ).not.toThrow();
  });
  it.each([
    String.raw`\renewcommand{\opt}{x}`,
    String.raw`\def\opt{x}`,
    String.raw`\gdef\opt{x}`,
    String.raw`\let\opt\other`,
    String.raw`\DeclareMathOperator{\opt}{x}`,
  ])('declines a later source collision %s', (later) => {
    const health = readingHealth();
    expect(
      localReadingMacros(source + later, [{ file: 'author.sty', text: definition }], health),
    ).toEqual({});
    expect(health.localMacros?.[0]?.reason).toBe('conflicting-definition');
  });
  it.each([
    '{' + definition + '}',
    String.raw`\begingroup` + definition + String.raw`\endgroup`,
    String.raw`\iftrue` + definition + String.raw`\fi`,
    definition + String.raw`\iftrue\csname opt\endcsname\fi`,
  ])('declines scoped or conditional style declarations %s', (text) => {
    const health = readingHealth();
    expect(localReadingMacros(source, [{ file: 'author.sty', text }], health)).toEqual({});
    expect(health.localMacros?.[0]?.reason).toBe('scoped-or-conditional');
  });
  it.each([
    String.raw`\newcommand{\opt}{\opt}`,
    String.raw`\newcommand{\opt}[1]{\mathrm{#1}}`,
    String.raw`\newcommand{\opt}[1][x]{\mathrm{#1}}`,
    String.raw`\newcommand{\opt}{\bf x}`,
    String.raw`\newcommand{\opt}{\input{private}}`,
  ])('retains unsupported definitions as fallback %s', (text) => {
    const health = readingHealth();
    expect(localReadingMacros(source, [{ file: 'author.sty', text }], health)).toEqual({});
    expect(health.localMacros?.[0]?.reason).toBe('unsupported-definition');
  });
  it('declines duplicate style definitions and existing renderer primitives', () => {
    const health = readingHealth();
    expect(
      localReadingMacros(
        source,
        [
          { file: 'a.sty', text: definition },
          { file: 'b.sty', text: definition },
        ],
        health,
      ),
    ).toEqual({});
    expect(
      localReadingMacros(
        source,
        [
          { file: 'a.sty', text: definition },
          { file: 'b.sty', text: String.raw`\csname opt\endcsname` },
        ],
        readingHealth(),
      ),
    ).toEqual({});
    expect(
      health.localMacros?.every((binding) => binding.reason === 'conflicting-definition'),
    ).toBe(true);
    expect(
      localReadingMacros(
        source,
        [{ file: 'c.sty', text: String.raw`\newcommand{\frac}{\mathrm{opt}}` }],
        readingHealth(),
      ),
    ).toEqual({});
    expect(
      localReadingMacros(
        source + String.raw`\renewcommand{\mathrm}[1]{\mathbf{#1}}`,
        [{ file: 'a.sty', text: definition }],
        readingHealth(),
      ),
    ).toEqual({});
  });
  it('caps style parsing and provenance without returning a partial unbounded map', () => {
    const health = readingHealth();
    expect(
      localReadingMacros(
        source,
        [
          { file: 'a.sty', text: definition },
          { file: 'large.sty', text: ' '.repeat(localMacroLimits.styleChars) + definition },
        ],
        health,
      ),
    ).toEqual({});
    expect(health.notes).toHaveLength(1);
    const many = Array.from(
      { length: 65 },
      (_, index) =>
        `\\newcommand{\\local${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}}{\\mathrm{x}}`,
    ).join('');
    const bounded = readingHealth();
    expect(
      Object.keys(localReadingMacros(source, [{ file: 'many.sty', text: many }], bounded)),
    ).toHaveLength(64);
    expect(bounded.localMacros).toHaveLength(64);
    expect(bounded.notes).toHaveLength(1);
    const longName = readingHealth();
    expect(
      localReadingMacros(
        source,
        [{ file: 'long.sty', text: `\\newcommand{\\${'x'.repeat(100)}}{\\mathrm{x}}` }],
        longName,
      ),
    ).toEqual({});
    expect(longName.localMacros).toBeUndefined();
    expect(longName.notes).toHaveLength(1);
  });
});
