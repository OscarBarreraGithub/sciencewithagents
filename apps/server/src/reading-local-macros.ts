import type { ReadingHealth } from '@dock/shared';
import katex from 'katex';
import { bodyStart, braceBalance, groupEnd } from './reading-source-rules.js';

export const localMacroLimits = { styles: 16, styleChars: 65536, bindings: 64 } as const;
const declarations =
  /\\((?:re)?newcommand|providecommand|[egx]?def|let|DeclareMathOperator|DeclareRobustCommand|(?:New|Renew|Provide)DocumentCommand)\*?\s*(?:\{\s*\\([A-Za-z]+)\s*\}|\\([A-Za-z]+))/g;
const opaqueSource = /\\(?:csname|catcode|makeatletter|expandafter|let)\b/;
function undefinedNative(name: string) {
  try {
    katex.renderToString(name, { throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20 });
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes('Undefined control sequence');
  }
}
const programming =
  /\\(?:if[A-Za-z]*|else|fi|begingroup|endgroup|bgroup|egroup|begin|end|csname|catcode|makeatletter)\b/;
// Only scoped font atoms: no definitions, file commands, argument syntax or stateful switches.
const literalBody =
  /^\\(?:mathrm|mathbf|mathbb|mathcal|mathfrak|mathsf|mathtt)\{[A-Za-z0-9 ]{1,64}\}$/;
export type LocalStyle = { file: string; text: string };

/** This is a small data vocabulary, not a TeX interpreter. Collisions anywhere in the
 * loaded source/styles win over a candidate, including later and scoped overrides. */
export function localReadingMacros(source: string, styles: LocalStyle[], health: ReadingHealth) {
  const macros: Record<string, string> = {};
  if (styles.some((style) => style.text.length > localMacroLimits.styleChars)) {
    health.notes.push('Some local macro definitions exceed Reading’s bounded support.');
    return macros;
  }
  const counts = new Map<string, number>();
  for (const text of [source, ...styles.map((style) => style.text)])
    for (const match of text.matchAll(declarations)) {
      const name = match[2] ?? match[3]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  const bindings: NonNullable<ReadingHealth['localMacros']> = [];
  const preamble = source.slice(0, Math.max(0, bodyStart(source)));
  const opaque = [source, ...styles.map((style) => style.text)].some((text) =>
    opaqueSource.test(text),
  );
  for (const { file, text } of styles) {
    for (const match of text.matchAll(declarations)) {
      if (match[1] !== 'newcommand') continue;
      if (bindings.length === localMacroLimits.bindings) {
        health.notes.push('Some local macro definitions exceed Reading’s bounded support.');
        break;
      }
      const name = '\\' + (match[2] ?? match[3]!);
      if (name.length > 41) {
        const note = 'A local macro name exceeds Reading’s bounded support.';
        if (!health.notes.includes(note)) health.notes.push(note);
        continue;
      }
      const following = text.slice(match.index! + match[0].length);
      const opening = /^\s*(?:\[0\]\s*)?\{/.exec(following);
      const open = opening ? match.index! + match[0].length + opening[0].length - 1 : -1;
      const end = open >= 0 ? groupEnd(text, open) : -1;
      const body = end >= 0 ? text.slice(open + 1, end - 1) : '';
      const prefix = text.slice(0, match.index);
      const reason =
        counts.get(name.slice(1)) !== 1
          ? 'conflicting-definition'
          : braceBalance(prefix) !== 0 ||
              programming.test(text) ||
              programming.test(preamble) ||
              opaque
            ? 'scoped-or-conditional'
            : !literalBody.test(body)
              ? 'unsupported-definition'
              : counts.has(body.slice(1, body.indexOf('{'))) || !undefinedNative(name)
                ? 'conflicting-definition'
                : null;
      bindings.push({
        name,
        file,
        status: reason ? 'declined' : 'restored',
        reason,
        occurrences: 0,
      });
      if (!reason) macros[name] = body;
    }
  }
  if (bindings.length) health.localMacros = bindings;
  return macros;
}
