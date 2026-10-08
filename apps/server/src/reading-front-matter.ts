import type { ReadingHealth } from '@dock/shared';
import { applied, bodyStart, groupEnd } from './reading-source-rules.js';

/** Title, authors, affiliations, date and abstract at the top of Reading.
 * Pandoc reads title/author/date/abstract into document metadata, which fragment HTML never
 * shows, and skips class-specific commands (revtex/aastex `\affiliation`, `\email`,
 * `\correspondingauthor`, amsart `\address`, JHEP `\abstract{…}`). The source pass below maps
 * those to plain LaTeX Pandoc reads; `withFrontMatter` then prepends the metadata as blocks.
 */
const affiliationCommands = new Set(['affiliation', 'affil', 'altaffiliation', 'address']);
const contactCommands = new Set(['email', 'emailAdd', 'correspondingauthor']);
const frontCommand =
  /\\(author|affiliation|affil|altaffiliation|address|emailAdd|email|correspondingauthor)(?![A-Za-z])\*?\s*(?:\[([^\]]*)\]\s*)?(?=\{)/g;

function insertAtBody(text: string, insertion: string) {
  const start = bodyStart(text);
  if (start < 0) return insertion + text;
  const end = text.indexOf('}', start) + 1;
  return text.slice(0, end) + '\n' + insertion + text.slice(end);
}
/** JHEP-style `\abstract{…}` and preamble abstract environments → a body abstract. */
function bodyAbstract(text: string, health: ReadingHealth) {
  const abstracts: string[] = [];
  let output = '',
    at = 0;
  for (const match of text.matchAll(/\\abstract(?![A-Za-z])\s*(?=\{)/g)) {
    if (match.index! < at) continue;
    const open = match.index! + match[0].length;
    const end = groupEnd(text, open);
    if (end < 0) continue;
    abstracts.push(text.slice(open + 1, end - 1));
    output += text.slice(at, match.index);
    at = end;
  }
  text = output + text.slice(at);
  const start = bodyStart(text);
  if (start > 0) {
    const preamble = text
      .slice(0, start)
      .replace(/\\begin\s*\{abstract\}([\s\S]*?)\\end\s*\{abstract\}/g, (_, body: string) => {
        abstracts.push(body);
        return '';
      });
    text = preamble + text.slice(start);
  }
  if (!abstracts.length) return text;
  applied(health, 'abstract-command', abstracts.length);
  return insertAtBody(text, `\\begin{abstract}${abstracts.join('\n\n')}\\end{abstract}\n`);
}
type Token = { name: string; label?: string; content: string; start: number; end: number };
/** Authors keep Pandoc's own metadata; affiliations and contacts become numbered lists. */
function authorAffiliations(text: string, health: ReadingHealth) {
  const tokens: Token[] = [];
  for (const match of text.matchAll(frontCommand)) {
    const open = match.index! + match[0].length;
    const end = groupEnd(text, open);
    if (end < 0 || (tokens.length && match.index! < tokens.at(-1)!.end)) continue;
    tokens.push({
      name: match[1]!,
      label: match[2]?.trim() || undefined,
      content: text.slice(open + 1, end - 1).trim(),
      start: match.index!,
      end,
    });
  }
  const affiliations = tokens.filter((token) => affiliationCommands.has(token.name));
  const contacts = tokens.filter((token) => contactCommands.has(token.name));
  if (!affiliations.length && !contacts.length) return text;
  const labelled = affiliations.some((token) => token.label);
  const marks = new Map<Token, string[]>();
  const list: { mark: string; content: string }[] = [];
  if (labelled) {
    for (const token of affiliations)
      list.push({ mark: token.label ?? String(list.length + 1), content: token.content });
    for (const token of tokens)
      if (token.name === 'author' && token.label)
        marks.set(
          token,
          token.label.split(',').map((label) => label.trim()),
        );
  } else {
    // revtex/aastex/amsart: an affiliation belongs to the authors written just before it.
    let group: Token[] = [],
      previous = '';
    for (const token of tokens) {
      if (token.name === 'author') {
        if (affiliationCommands.has(previous)) group = [];
        group.push(token);
      } else if (affiliationCommands.has(token.name)) {
        const content = token.content.replace(/\s+/g, ' ');
        let index = list.findIndex((item) => item.content.replace(/\s+/g, ' ') === content);
        if (index < 0) index = list.push({ mark: String(list.length + 1), content }) - 1;
        for (const author of group) {
          const own = marks.get(author) ?? [];
          if (!own.includes(list[index]!.mark)) own.push(list[index]!.mark);
          marks.set(author, own);
        }
      }
      if (token.name === 'author' || affiliationCommands.has(token.name)) previous = token.name;
    }
  }
  const numbered = list.length > 1;
  let output = '',
    at = 0;
  for (const token of tokens) {
    output += text.slice(at, token.start);
    at = token.end;
    if (token.name !== 'author') continue;
    const own = marks.get(token);
    output += `\\author{${token.content}${numbered && own?.length ? `\\textsuperscript{${own.join(',')}}` : ''}}`;
  }
  text = output + text.slice(at);
  const lines = list.map(
    ({ mark, content }) => (numbered ? `\\textsuperscript{${mark}}` : '') + content,
  );
  const emails = contacts
    .filter((token) => token.name !== 'correspondingauthor')
    .map((token) => token.content);
  const corresponding = contacts.find((token) => token.name === 'correspondingauthor');
  const contact = [
    ...(emails.length ? [`Email: ${emails.join(', ')}`] : []),
    ...(corresponding ? [`Corresponding author: ${corresponding.content}`] : []),
  ];
  applied(health, 'affiliation', list.length);
  applied(health, 'contact', contacts.length);
  return insertAtBody(
    text,
    (lines.length
      ? `\\begin{reading-affiliations}\n${lines.join('\n\n')}\n\\end{reading-affiliations}\n`
      : '') +
      (contact.length
        ? `\\begin{reading-contact}\n${contact.join('\n\n')}\n\\end{reading-contact}\n`
        : ''),
  );
}
/** Pandoc only reads `\title`/`\author` as metadata at the top level, so a title page that
 * sets them inside `titlepage` or `center` loses them. Move the ones written before the first
 * section into the preamble, in order.
 */
function hoistTitle(text: string, health: ReadingHealth) {
  const start = bodyStart(text);
  if (start < 0) return text;
  const section = text.slice(start).search(/\\(?:part|chapter|section)\*?\s*[[{]/);
  const end = section < 0 ? text.length : start + section;
  let body = '',
    at = start;
  const hoisted: string[] = [];
  for (const match of text
    .slice(start, end)
    .matchAll(/\\(?:title|author|date)(?![A-Za-z])\s*(?:\[[^\]]*\]\s*)?(?=\{)/g)) {
    const from = start + match.index!;
    if (from < at) continue;
    const close = groupEnd(text, from + match[0].length);
    if (close < 0 || close > end) continue;
    hoisted.push(text.slice(from, close));
    body += text.slice(at, from);
    at = close;
  }
  if (!hoisted.length) return text;
  applied(health, 'title-hoisted', hoisted.length);
  return text.slice(0, start) + hoisted.join('\n') + '\n' + body + text.slice(at);
}
/** A paper that restyles its title commands or abstract environment would hide them from
 * Pandoc's metadata (and print them as layout boxes). Reading shows them its own way.
 */
function dropRestyling(text: string, health: ReadingHealth) {
  const names = 'title|author|date|address|email|affiliation|maketitle';
  const definition = new RegExp(
    String.raw`\\(?:(?:(?:(?:re)?newcommand|providecommand)\*?\s*(?:\{\s*\\(?:${names})\s*\}|\\(?:${names}))|[egx]?def\s*\\(?:${names})(?:#\d)*)(?![A-Za-z])|(?:re)?newenvironment\*?\s*\{abstract\})(?:\s*\[[^\]]*\]){0,2}\s*(?=\{)`,
    'g',
  );
  let output = '',
    at = 0,
    times = 0;
  for (const match of text.matchAll(definition)) {
    if (match.index! < at) continue;
    let end = groupEnd(text, match.index! + match[0].length);
    // An environment has a second group: the code run at its end.
    if (end > 0 && /newenvironment/.test(match[0])) {
      const open = end + (text.slice(end).match(/^\s*/)?.[0].length ?? 0);
      end = text[open] === '{' ? groupEnd(text, open) : -1;
    }
    if (end < 0) continue;
    output += text.slice(at, match.index);
    at = end;
    times++;
  }
  applied(health, 'front-matter-restyle', times);
  return output + text.slice(at);
}
export function mapFrontMatter(text: string, health: ReadingHealth) {
  text = text.replace(/\\A(?:nd|ND)(?![A-Za-z])/g, '\\and');
  text = text.replace(/\\date\s*\{\s*(?:\\today\s*)?\}/g, '');
  text = dropRestyling(text, health);
  return hoistTitle(authorAffiliations(bodyAbstract(text, health), health), health);
}

type Node = { t: string; c?: unknown };
type PandocDocument = { meta: Record<string, Node>; blocks: Node[] };
const space: Node = { t: 'Space' };
function blocksToInlines(blocks: Node[]): Node[] {
  return blocks.flatMap((block, index) => {
    const inlines = block.t === 'Para' || block.t === 'Plain' ? (block.c as Node[]) : [];
    return index ? [{ t: 'LineBreak' }, ...inlines] : inlines;
  });
}
function inlines(value: Node | undefined): Node[] {
  if (!value) return [];
  if (value.t === 'MetaInlines') return value.c as Node[];
  if (value.t === 'MetaBlocks') return blocksToInlines(value.c as Node[]);
  if (value.t === 'MetaString') return [{ t: 'Str', c: value.c }];
  if (value.t === 'MetaList')
    return (value.c as Node[]).flatMap((item, index) =>
      index ? [{ t: 'Str', c: ',' }, space, ...inlines(item)] : inlines(item),
    );
  return [];
}
function trim(nodes: Node[]) {
  const blank = (node: Node | undefined) =>
    !!node &&
    (['Space', 'SoftBreak', 'LineBreak'].includes(node.t) ||
      // `\bfseries` before a macro title leaves an empty <strong>.
      (['Strong', 'Emph', 'Span', 'SmallCaps', 'Underline'].includes(node.t) && !text([node])));
  nodes = [...nodes];
  while (blank(nodes[0])) nodes.shift();
  while (blank(nodes.at(-1))) nodes.pop();
  // JHEP writes the last author as `\author{and Name}`.
  if (nodes[0]?.t === 'Str' && nodes[0].c === 'and' && blank(nodes[1])) nodes.splice(0, 2);
  return nodes;
}
/** Visible words of inline nodes, including those nested in emphasis, links and notes. */
const text = (nodes: Node[]): string =>
  nodes
    .map((node): string => {
      if (node.t === 'Str') return String(node.c);
      if (node.t === 'Space') return ' ';
      if (node.t === 'Math') return 'x';
      if (node.t === 'Note') return '';
      const content = Array.isArray(node.c) ? (node.c as unknown[]) : [];
      const children = content.find(
        (part): part is Node[] => Array.isArray(part) && part.every((item) => !!item?.t),
      );
      return children
        ? text(children)
        : content.every((item) => (item as Node)?.t)
          ? text(content as Node[])
          : '';
    })
    .join('')
    .trim();
const div = (name: string, blocks: Node[]): Node => ({ t: 'Div', c: [['', [name], []], blocks] });
const raw = (html: string): Node => ({ t: 'RawBlock', c: ['html', html] });
/** Prepend title, authors, affiliations, contacts, date and abstract as one header block. */
export function withFrontMatter(document: PandocDocument): PandocDocument {
  const { meta } = document;
  const extracted = new Map<string, Node[]>();
  const blocks = document.blocks.filter((block) => {
    if (block.t !== 'Div') return true;
    const [[, classes], children] = block.c as [[string, string[]], Node[]];
    const name = classes.find(
      (value) => value === 'reading-affiliations' || value === 'reading-contact',
    );
    if (!name) return true;
    extracted.set(name, children);
    return false;
  });
  const front: Node[] = [];
  const title = trim(inlines(meta.title));
  if (text(title) || title.some((node) => node.t === 'Math'))
    front.push({ t: 'Header', c: [1, ['', ['reading-title'], []], title] });
  const authorValues =
    meta.author?.t === 'MetaList' ? (meta.author.c as Node[]) : meta.author ? [meta.author] : [];
  const authors = authorValues.map((value) => trim(inlines(value))).filter((nodes) => nodes.length);
  if (authors.length) {
    // Article/NeurIPS style writes each author as name \\ affiliation \\ email: one compact
    // paragraph per author with only the name emphasised.
    const stacked = authors.some((nodes) => nodes.some((node) => node.t === 'LineBreak'));
    front.push(
      stacked
        ? div(
            'reading-authors-stacked',
            authors.map((nodes) => {
              const name = nodes.findIndex((node) => node.t === 'LineBreak');
              return name < 0
                ? { t: 'Para', c: [{ t: 'Strong', c: nodes }] }
                : {
                    t: 'Para',
                    c: [{ t: 'Strong', c: nodes.slice(0, name) }, ...nodes.slice(name)],
                  };
            }),
          )
        : div('reading-authors', [
            {
              t: 'Para',
              c: authors.flatMap((nodes, index) =>
                index ? [{ t: 'Str', c: ',' }, space, ...nodes] : nodes,
              ),
            },
          ]),
    );
  }
  for (const name of ['reading-affiliations', 'reading-contact'])
    if (extracted.get(name)?.length) front.push(div(name, extracted.get(name)!));
  const date = trim(inlines(meta.date));
  if (text(date) && !/^1970-01-01$/.test(text(date)))
    front.push(div('reading-date', [{ t: 'Para', c: date }]));
  const abstract = meta.abstract;
  const abstractBlocks =
    abstract?.t === 'MetaBlocks'
      ? (abstract.c as Node[])
      : inlines(abstract).length
        ? [{ t: 'Para', c: inlines(abstract) }]
        : [];
  if (abstractBlocks.length)
    front.push(
      raw('<section class="reading-abstract">'),
      {
        t: 'Header',
        c: [2, ['', ['reading-abstract-heading'], []], [{ t: 'Str', c: 'Abstract' }]],
      },
      ...abstractBlocks,
      raw('</section>'),
    );
  // Raw wrappers: Pandoc turns a Div that starts with a heading into a <section> and copies
  // the heading's classes onto it.
  return front.length
    ? {
        ...document,
        blocks: [
          raw('<header class="reading-front-matter">'),
          ...front,
          raw('</header>'),
          ...blocks,
        ],
      }
    : { ...document, blocks };
}
