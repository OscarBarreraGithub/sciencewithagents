/** Reading-mode structure only, not a TeX interpreter. Keep nested matrices/aligned rows intact. */
export function mathRows(body: string): string[] {
  const rows: string[] = [];
  let at = 0,
    braces = 0,
    environments = 0;
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i);
    const environment = /^\\(begin|end)\{[^{}]+\}/.exec(rest);
    if (environment) {
      environments += environment[1] === 'begin' ? 1 : -1;
      i += environment[0].length - 1;
      continue;
    }
    if (rest.startsWith('\\\\') && braces === 0 && environments === 0) {
      rows.push(body.slice(at, i));
      i++;
      const spacing = /^\*?(?:\[[^\]]*\])?/.exec(body.slice(i + 1))![0];
      i += spacing.length;
      at = i + 1;
    } else if (body[i] === '\\') i++;
    else if (body[i] === '{') braces++;
    else if (body[i] === '}') braces--;
  }
  rows.push(body.slice(at));
  return rows.filter((row) => row.trim());
}
export function latexCommandValues(text: string, command: string): string[] {
  const result: string[] = [];
  const pattern = new RegExp('\\\\' + command + '\\*?(?:\\[[^\\]]*\\])?\\s*\\{', 'g');
  for (const match of text.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    let depth = 1,
      end = start;
    for (; end < text.length && depth; end++) {
      if (text[end] === '\\') {
        end++;
        continue;
      }
      if (text[end] === '{') depth++;
      else if (text[end] === '}') depth--;
    }
    if (!depth) result.push(text.slice(start, end - 1));
  }
  return result;
}
export function stripLatexCommand(text: string, command: string) {
  const pattern = new RegExp('\\\\' + command + '\\*?(?:\\[[^\\]]*\\])?\\s*\\{', 'g');
  let output = '',
    at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! < at) continue;
    let depth = 1,
      end = match.index! + match[0].length;
    for (; end < text.length && depth; end++) {
      if (text[end] === '\\') {
        end++;
        continue;
      }
      if (text[end] === '{') depth++;
      else if (text[end] === '}') depth--;
    }
    if (!depth) {
      output += text.slice(at, match.index);
      at = end;
    }
  }
  return output + text.slice(at);
}
export function readingMathParts(tex: string) {
  const outer =
    /^\s*\\begin\{(equation\*?|align\*?|flalign\*?|gather\*?|multline\*?)\}([\s\S]*)\\end\{\1\}\s*$/.exec(
      tex,
    );
  const environment = outer?.[1] ?? '';
  const split = /^(align|flalign|gather)\*?$/.test(environment);
  const bodies = split ? mathRows(outer![2]!) : [outer?.[2] ?? tex];
  return bodies.map((body) => {
    const labels = latexCommandValues(body, 'label');
    const tag = latexCommandValues(body, 'tag')[0];
    const numbered =
      !!environment &&
      !environment.endsWith('*') &&
      !/\\(?:notag|nonumber)\b/.test(body) &&
      tag === undefined;
    const clean = body.replace(/\\label\{[^{}]+\}/g, '');
    return {
      tex:
        split && /align/.test(environment)
          ? String.raw`\begin{aligned}${clean}\end{aligned}`
          : /^multline/.test(environment)
            ? String.raw`\begin{gathered}${clean}\end{gathered}`
            : clean,
      labels,
      tag,
      numbered,
    };
  });
}
