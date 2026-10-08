/** One visual break, never algebra: keep both original substrings verbatim.
 * Decline uncertain TeX contexts rather than interpreting macros or paired delimiters. */
export function readingEqualityLayout(tex: string): string | null {
  if (
    tex.length > 4096 ||
    /[&%$|]/.test(tex) ||
    /\\\\|\\[={}()[\]]|\\(?:begin|end|left|right|text\w*|mbox|hbox|verb\w*|over|atop|above|choose|def|newcommand|not|displaystyle|textstyle|scriptstyle|scriptscriptstyle|color|bf|rm|it|sf|tt|cal|mit|tiny|sixptsize|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|langle|rangle|lvert|rvert|lVert|rVert|lbrace|rbrace|lbrack|rbrack|vert|Vert|mid)\b/.test(
      tex,
    )
  )
    return null;
  const groups: string[] = [];
  let relation = -1;
  for (let at = 0; at < tex.length; at++) {
    const character = tex[at]!;
    if (character === '\\') {
      const command = /^\\(?:[A-Za-z]+|.)/.exec(tex.slice(at));
      if (!command) return null;
      at += command[0].length - 1;
    } else if ('({['.includes(character)) groups.push(character);
    else if (')}]'.includes(character)) {
      if (groups.pop() !== '({['[')}]'.indexOf(character)]) return null;
    } else if (character === '=' && !groups.length) {
      if (relation >= 0 || /[<>=!:]\s*$/.test(tex.slice(0, at)) || /^\s*=/.test(tex.slice(at + 1)))
        return null;
      relation = at;
    }
  }
  if (
    groups.length ||
    relation < 0 ||
    !tex.slice(0, relation).trim() ||
    !tex.slice(relation + 1).trim()
  )
    return null;
  return String.raw`\begin{gathered}${tex.slice(0, relation)}\\${tex.slice(relation)}\end{gathered}`;
}
