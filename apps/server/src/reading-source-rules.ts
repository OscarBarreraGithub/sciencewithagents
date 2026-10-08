import type { ReadingHealth } from '@dock/shared';

/** Deterministic, model-free source rules that let Pandoc read real arXiv sources.
 * Each rule only removes or rewrites TeX text; none executes document code. Every
 * application is counted in the health report so a later reviewer can see what changed.
 */
export function readingHealth(): ReadingHealth {
  return {
    conversion: 'complete',
    plainTex: false,
    missingIncludes: [],
    dropped: [],
    rules: {},
    notes: [],
  };
}
export function applied(health: ReadingHealth, rule: string, times = 1) {
  if (times > 0) health.rules[rule] = (health.rules[rule] ?? 0) + times;
}
/** Index just past the `}` that closes the group opening at `open`, or -1 when unbalanced. */
export function groupEnd(text: string, open: number) {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    const character = text[at];
    if (character === '\\') at++;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return at + 1;
  }
  return -1;
}
/** Brace depth change of a passage: positive when it opens more groups than it closes. */
export function braceBalance(text: string) {
  let depth = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === '{') depth++;
    else if (text[at] === '}') depth--;
  }
  return depth;
}
const documentStart = /\\begin\s*\{document\}/;
export const bodyStart = (text: string) => text.search(documentStart);
/** Plain TeX (harvmac, `\bye`) has no LaTeX document structure Pandoc can read. */
export function isPlainTex(text: string) {
  return (
    !/\\documentclass\b|\\documentstyle\b|\\begin\s*\{document\}/.test(text) &&
    /\\(?:input\s*\{?\s*|readingmissinginput\{)harvmac\b|\\bye(?![A-Za-z])/.test(text)
  );
}
/** `\global\long\def` and friends: Pandoc only reads the bare definition. */
function bareDefinitions(text: string, health: ReadingHealth) {
  let times = 0;
  text = text.replace(
    /(?:\\(?:global|long|protected|outer)(?![A-Za-z@])\s*)+(?=\\(?:[egx]?def|let)(?![A-Za-z@]))/g,
    () => (times++, ''),
  );
  applied(health, 'prefixed-definition', times);
  return text;
}
/** Preamble `\makeatletter … \makeatother` blocks are TeX programming, not content. */
function dropInternalBlocks(text: string, health: ReadingHealth) {
  const start = bodyStart(text);
  if (start < 0) return text;
  let times = 0;
  const preamble = text
    .slice(0, start)
    .replace(
      /\\makeatletter(?![A-Za-z])[\s\S]*?(?:\\makeatother(?![A-Za-z])|$)/g,
      () => (times++, ''),
    );
  applied(health, 'makeatletter-block', times);
  return preamble + text.slice(start);
}
const expansionControl = /\\(?:expandafter|unexpanded|csname|noexpand)(?![A-Za-z@])/;
/** Definitions that refer to themselves or steer expansion can make Pandoc loop forever. */
function dropUnsafeDefinitions(text: string, health: ReadingHealth) {
  const definition =
    /\\(?:[egx]?def\s*\\([A-Za-z@]+)[^{}\n]{0,80}?|(?:(?:re)?newcommand|providecommand)\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[\d\]\s*)?(?:\[[^\]]*\]\s*)?)(?=\{)/g;
  let output = '',
    at = 0,
    times = 0;
  for (const match of text.matchAll(definition)) {
    const start = match.index!;
    if (start < at) continue;
    const open = start + match[0].length;
    const end = groupEnd(text, open);
    if (end < 0) continue;
    const name = match[1] ?? match[2] ?? match[3]!;
    const body = text.slice(open + 1, end - 1);
    const self = new RegExp('\\\\' + name + '(?![A-Za-z@])');
    if (!self.test(body) && !expansionControl.test(body)) continue;
    output += text.slice(at, start);
    at = end;
    times++;
  }
  applied(health, 'unsafe-definition', times);
  return output + text.slice(at);
}
/** One-paragraph arguments: TeX tolerates a blank line inside them, Pandoc does not. */
function joinArgumentParagraphs(text: string, health: ReadingHealth) {
  const command =
    /\\(?:caption|footnote|thanks|title|author|affiliation|affil|address)\*?\s*(?:\[[^\]]*\]\s*)?(?=\{)/g;
  let output = '',
    at = 0,
    times = 0;
  for (const match of text.matchAll(command)) {
    const open = match.index! + match[0].length;
    if (match.index! < at) continue;
    const end = groupEnd(text, open);
    if (end < 0) continue;
    const argument = text.slice(open, end);
    const joined = argument.replace(/\n[ \t]*\n\s*/g, () => (times++, ' '));
    output += text.slice(at, open) + joined;
    at = end;
  }
  applied(health, 'blank-line-in-argument', times);
  return output + text.slice(at);
}
/** Print-layout commands whose arguments otherwise leak into Reading as stray text. */
function stripLayout(text: string, health: ReadingHealth) {
  const rules: [string, RegExp, string][] = [
    ['bold-math-switch', /\\(?:un)?boldmath(?![A-Za-z])\s*/g, ''],
    ['font-size', /\\fontsize\s*\{[^{}]*\}\s*\{[^{}]*\}\s*(?:\\selectfont(?![A-Za-z])\s*)?/g, ''],
    [
      'title-spacing',
      /\\titlespacing\*?\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{[^{}]*\}(?:\s*\[[^\]]*\])?/g,
      '',
    ],
    [
      'wrapped-float',
      /\\begin\s*\{wrap(figure|table)\}(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}(?:\s*\[[^\]]*\])?\s*\{[^{}]*\}/g,
      '\\begin{$1}',
    ],
    ['wrapped-float-end', /\\end\s*\{wrap(figure|table)\}/g, '\\end{$1}'],
  ];
  for (const [name, pattern, replacement] of rules) {
    let times = 0;
    text = text.replace(pattern, (...match) => {
      times++;
      return replacement.replace('$1', String(match[1]));
    });
    if (name !== 'wrapped-float-end') applied(health, name, times);
  }
  return text;
}
/** TeX collects a macro as one argument before expanding it. Preserve that group when Pandoc
 * expands zero-argument definitions (e.g. \frac\dd{\dd t}). The name must follow on the same
 * line and cannot itself be a definition command (`\let\nc\newcommand`), and a body that opens
 * or closes an environment (`\be` → `\begin{equation}`) is expanded textually, never grouped.
 */
export function groupMacroExpansions(source: string) {
  const declarations =
    /\\(?:re)?newcommand\*?[ \t]*(?:\{\\[A-Za-z]+\}|\\(?!(?:re)?newcommand(?![A-Za-z])|providecommand(?![A-Za-z]))[A-Za-z]+)[ \t]*(?:\[0\][ \t]*)?\{/g;
  let result = '',
    at = 0;
  for (const match of source.matchAll(declarations)) {
    const start = match.index! + match[0].length;
    if (match.index! < at) continue;
    const end = groupEnd(source, start - 1);
    if (end < 0) continue;
    const body = source.slice(start, end - 1);
    if (/\\(?:begin|end)(?![A-Za-z])/.test(body)) continue;
    result += source.slice(at, start) + '{' + body + '}}';
    at = end;
  }
  return result + source.slice(at);
}
/** Rule 1 (b)–(f) of the arXiv corpus study, plus layout-argument cleanup. */
export function applySourceRules(text: string, health: ReadingHealth) {
  text = bareDefinitions(text, health);
  text = dropInternalBlocks(text, health);
  text = dropUnsafeDefinitions(text, health);
  text = stripLayout(text, health);
  text = joinArgumentParagraphs(text, health);
  return groupMacroExpansions(text).replace(/\\hfill\b/g, ' ');
}

export const omittedNote = 'Part of this section is only in the Original PDF.';
const omitted = `\\begin{reading-omitted}${omittedNote}\\end{reading-omitted}`;
const titleOmittedNote = 'The title or author list is only in the Original PDF.';
const titleOmitted = `\\begin{reading-omitted}${titleOmittedNote}\\end{reading-omitted}`;
const excerpt = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 100);
/** Paragraph spans (start/end offsets) of a source, split at blank lines. */
function paragraphs(text: string) {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n[ \t]*\n\s*/g)) {
    spans.push({ start, end: match.index! });
    start = match.index! + match[0].length;
  }
  spans.push({ start, end: text.length });
  return spans;
}
/** Retry step 1: TeX tolerates a `{` left open at a paragraph end; Pandoc rejects the
 * whole document at `\end{document}`. Close it there. Environments may span paragraphs, so
 * paragraphs that open or close one are left alone.
 */
export function closeOpenBraces(text: string, health: ReadingHealth) {
  const start = bodyStart(text);
  if (start < 0) return text;
  let output = text.slice(0, start),
    times = 0;
  const body = text.slice(start);
  let at = 0;
  for (const span of paragraphs(body)) {
    const paragraph = body.slice(span.start, span.end);
    const depth = braceBalance(paragraph);
    output += body.slice(at, span.end);
    at = span.end;
    if (depth > 0 && !/\\(?:begin|end)\s*\{(?!document\})/.test(paragraph)) {
      output += '}'.repeat(depth);
      times++;
    }
  }
  applied(health, 'unbalanced-brace-closed', times);
  return output + body.slice(at);
}
/** Retry step 2: replace the passage Pandoc rejected with a visible note. A passage that
 * leaves a group or environment open grows to its neighbours until it is balanced, so the
 * replacement never strands half an argument.
 */
export function dropPassage(text: string, line: number, reason: string, health: ReadingHealth) {
  const spans = paragraphs(text);
  const lines = text.split('\n');
  const offset = lines.slice(0, Math.max(0, line - 1)).join('\n').length;
  const atEnd = line >= lines.length || /\\end\s*\{document\}/.test(lines[line - 1] ?? '');
  const start = bodyStart(text);
  const balance = (from: number, to: number) => {
    const passage = text.slice(spans[from]!.start, spans[to]!.end);
    const opened = passage.match(/\\begin\s*\{(?!document\})/g)?.length ?? 0;
    const closed = passage.match(/\\end\s*\{(?!document\})/g)?.length ?? 0;
    return { braces: braceBalance(passage), environments: opened - closed };
  };
  // At the end, the cause is the first body paragraph left open; otherwise the reported line.
  let first = atEnd
    ? spans.findIndex(
        (span) => span.end > start && braceBalance(text.slice(span.start, span.end)) !== 0,
      )
    : spans.findIndex((span) => span.end >= offset);
  if (first < 0) return null;
  let last = first;
  for (let grow = 0; grow < 12; grow++) {
    const { braces, environments } = balance(first, last);
    if (braces === 0 && environments === 0) break;
    if ((braces > 0 || environments > 0) && last + 1 < spans.length) last++;
    else if ((braces < 0 || environments < 0) && first > 0) first--;
    else break;
  }
  let from = spans[first]!.start,
    to = spans[last]!.end;
  // Never remove the document's own begin/end: keep the drop on one side of each.
  if (start >= 0 && from <= start && to > start) {
    if (!atEnd && offset < start) to = start;
    else from = start + text.slice(start).match(documentStart)![0].length;
  }
  const end = text.slice(from, to).search(/\\end\s*\{document\}/);
  if (end >= 0) to = from + end;
  const passage = text.slice(from, to);
  if (!passage.trim() || passage.includes(omittedNote)) return null;
  const part = start >= 0 && from < start ? 'preamble' : 'body';
  health.dropped.push({ part, reason, excerpt: excerpt(passage) });
  if (part === 'body') return text.slice(0, from) + `\n\n${omitted}\n\n` + text.slice(to);
  text = text.slice(0, from) + text.slice(to);
  // A dropped title or author list is content: say so at the top of the body.
  if (!/\\(?:title|author)(?![A-Za-z])/.test(passage) || text.includes(titleOmittedNote))
    return text;
  const body = bodyStart(text);
  if (body < 0) return text;
  const after = body + text.slice(body).match(documentStart)![0].length;
  return text.slice(0, after) + `\n${titleOmitted}\n` + text.slice(after);
}
