import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
type Tree = ReturnType<typeof parser.parse>;
type Node = Tree | Tree['children'][number];
type MathValue = { value: string; display: boolean };
const noMath = () => {};

/** Protect Markdown code and link destinations before interpreting TeX delimiters.
 * Temporary code spans keep TeX underscores, backslashes and newlines out of the
 * Markdown parser. Nothing in the retained conversation is modified.
 */
export function prepareChatMath(source: string) {
  if (!/\$|\\[([]/.test(source)) return { text: source, remarkChatMath: noMath };
  const protectedRanges: [number, number][] = [];
  function protect(node: Node) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (
      ['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition'].includes(node.type)
    ) {
      protectedRanges.push([start, end]);
      return;
    }
    if ('children' in node) {
      const children = node.children;
      // Keep URLs/titles untouched, while permitting equations in link labels.
      if (node.type === 'link' || node.type === 'linkReference') {
        protectedRanges.push([start, children[0]?.position?.start.offset ?? end]);
        protectedRanges.push([children.at(-1)?.position?.end.offset ?? start, end]);
      }
      children.forEach(protect);
    }
  }
  protect(parser.parse(source));
  protectedRanges.sort((a, b) => a[0] - b[0]);
  let prefix = 'swa-math-';
  while (source.includes(prefix)) prefix += '-';
  const equations = new Map<string, MathValue>();
  let text = '',
    cursor = 0;
  function plain(chunk: string) {
    let result = '';
    for (let i = 0; i < chunk.length; ) {
      // Bare GFM URLs stay literal here. URLs inside a complete equation are
      // consumed with the equation, so TeX commands cannot become active links.
      if (chunk.startsWith('https://', i) || chunk.startsWith('http://', i)) {
        const url = /^https?:\/\/[^\s<>]+/.exec(chunk.slice(i))?.[0];
        if (url) {
          result += url;
          i += url.length;
          continue;
        }
      }
      const pair = chunk.slice(i, i + 2);
      const opener =
        pair === '\\(' || pair === '\\[' || pair === '$$' ? pair : chunk[i] === '$' ? '$' : '';
      if (!opener) {
        // Escaped dollars/backslashes stay literal.
        const size = chunk[i] === '\\' ? Math.min(2, chunk.length - i) : 1;
        result += chunk.slice(i, i + size);
        i += size;
        continue;
      }
      const closer = opener === '\\(' ? '\\)' : opener === '\\[' ? '\\]' : opener;
      const display = opener === '$$' || opener === '\\[';
      let end = -1;
      if (opener !== '$' || /\S/.test(chunk[i + 1] ?? '')) {
        for (let j = i + opener.length; j < chunk.length; j++) {
          if (!display && chunk[j] === '\n') break;
          if (chunk.startsWith(closer, j)) {
            // Pandoc-style dollar boundaries avoid turning "$5 and $10" into math.
            if (
              opener !== '$' ||
              (/\S/.test(chunk[j - 1] ?? '') && !/\d/.test(chunk[j + 1] ?? ''))
            ) {
              end = j;
              break;
            }
            // A price must not consume a later, unrelated $equation$.
            if (opener === '$') break;
          }
          if (chunk[j] === '\\') j++;
        }
      }
      if (end < 0) {
        // Incomplete streaming equations remain text until their delimiter arrives.
        result += opener;
        i += opener.length;
        continue;
      }
      const value = chunk.slice(i + opener.length, end).trim();
      if (!value) {
        result += chunk.slice(i, end + closer.length);
      } else {
        const token = `${prefix}${equations.size}`;
        equations.set(token, { value, display });
        result += '`' + token + '`';
      }
      i = end + closer.length;
    }
    return result;
  }
  for (const [start, end] of protectedRanges) {
    if (start < cursor) continue;
    text += plain(source.slice(cursor, start)) + source.slice(start, end);
    cursor = end;
  }
  text += plain(source.slice(cursor));

  // rehype-katex consumes these standard math classes, including ```math fences.
  function remarkChatMath() {
    return (tree: Tree) => {
      function visit(node: Node) {
        if (node.type === 'inlineCode' && 'value' in node) {
          const math = equations.get(String(node.value));
          if (math) {
            node.data = {
              hName: 'span',
              hProperties: { className: [math.display ? 'math-display' : 'math-inline'] },
              hChildren: [{ type: 'text', value: math.value }],
            };
          }
        }
        if ('children' in node) node.children.forEach(visit);
      }
      visit(tree);
    };
  }
  return { text, remarkChatMath };
}
