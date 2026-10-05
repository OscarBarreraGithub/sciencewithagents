import { it, expect } from 'vitest';
import { readingMathParts, mathRows, latexCommandValues, stripLatexCommand } from '@dock/shared';
it('counts numbered rows including unlabeled ones without splitting inner matrices or duplicating tags', () => {
  const source = String.raw`\begin{align}a&=b\label{first}\\c&=\begin{pmatrix}1\\2\end{pmatrix}\\d&=e\nonumber\\f&=g\tag{$\ast$}\label{star}\end{align}`;
  const parts = readingMathParts(source);
  expect(parts).toHaveLength(4);
  expect(parts.map((p) => p.numbered)).toEqual([true, true, false, false]);
  expect(parts[1]!.tex).toContain(String.raw`\begin{pmatrix}1\\2\end{pmatrix}`);
  expect(parts[3]).toMatchObject({ labels: ['star'], tag: String.raw`$\ast$` });
  expect(latexCommandValues(String.raw`x\tag{\text{A}}y`, 'tag')).toEqual([String.raw`\text{A}`]);
  expect(stripLatexCommand(String.raw`x\tag{\text{A}}y`, 'tag')).toBe('xy');
  expect(readingMathParts(String.raw`\begin{multline}a+b\\+c\end{multline}`)[0]).toMatchObject({
    numbered: true,
    tex: String.raw`\begin{gathered}a+b\\+c\end{gathered}`,
  });
  expect(mathRows(String.raw`\frac{a\\b}{c}\\d`)).toHaveLength(2);
});
