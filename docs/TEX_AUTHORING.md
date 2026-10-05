# LaTeX for phone reading

These conventions apply to reports shared through sciencewithagents, including manager and
worker output. Keep the original scientific content and a readable font size. **Reading**
reflows the source; **Original PDF** preserves printed pages.

- Prefer `equation` containing `aligned`. Put one relation or continuation on each line.
  If the left side is long, give it its own line. Aim for roughly 12 math em per line;
  15 is a useful upper target at the default phone text size, not a guarantee of fit.
- Break before a binary operator. When breaking a juxtaposed product, make the continued
  multiplication explicit with `\times`. Use fixed `\bigl` / `\bigr` delimiters across
  lines; never split a `\left` / `\right` pair across rows.
- Move explanatory sentences into prose. Clearly defined subexpressions can shorten a
  formula, but keep every definition, bound, sign, index, unit and condition explicit.
  Never cancel, divide, factor or regroup an expression just to save width.
- Keep labels, citations, references, manual tags and numbered/unnumbered status intact.
  Use meaningful labels for new numbered equations. Prefer standard KaTeX-compatible
  math; print-only `\intertext`, `\displaybreak` and `\MoveEqLeft` are not supported.
- Keep tables narrow, preferably two or three columns. A vertical layout must retain each
  value's sample, full quantity name and unit. Do not split numbers across lines. For a
  wide matrix, retain its shape and entry order; do not silently turn columns into unrelated equations.
- Never shrink math with `\resizebox`, tiny type or scriptsize to make it fit. Do not hide
  terms or rasterize text. Retain an honest, individually scrollable expression when a
  clearer equivalent layout is uncertain.

Example:

```tex
\begin{equation}\label{eq:energy}
\begin{aligned}
E &= E_{\mathrm{kinetic}} \\
  &\quad + E_{\mathrm{potential}}.
\end{aligned}
\end{equation}
```

Check the actual Reading view at 360 and 412 pixels, with default and larger text.
Check desktop and landscape too. A successful TeX compile or an estimated width does not
prove that the phone layout fits. Keep at most two formatting passes per expression;
retain and identify anything still wide.

**Format for phone** in the LaTeX reader requests one QUARK-supervised formatting turn.
The default follows the latest Sonnet family in the live catalog (currently Sonnet 5.5);
provider, exact model and thinking level can be selected for the request. It creates a
private reading copy and leaves the source/PDF untouched. The host checks source changes,
labels, references, tags and the preamble before allowing the copy to open. These checks
are not a proof of mathematical equivalence: compare important equations with the original.
A failed/interrupted pass retains the original. Opening a document alone spends no AI allowance.
