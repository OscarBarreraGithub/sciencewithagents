#!/usr/bin/env node
// Combine explicitly supplied public exports. This does not build or publish graph sources.
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    landing: { type: 'string', default: join(root, 'site') },
    graph: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node scripts/build-public-site.mjs --graph PREBUILT_PUBLIC_GRAPH --out NEW_DIRECTORY [--landing SITE_DIRECTORY]',
  );
  process.exit(0);
}
if (!values.graph || !values.out)
  throw new Error('--graph and --out are required. Output must be a new directory.');

const landing = await realpath(resolve(values.landing));
const graph = await realpath(resolve(values.graph));
const output = resolve(values.out);
const publicExtensions = new Set([
  '.html',
  '.css',
  '.js',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.txt',
  '.webmanifest',
]);
const special = new Set(['_headers', '_redirects']);
const slash = (path) => path.split(sep).join('/');

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Public exports cannot contain symbolic links: ${name}`);
    // Documentation is source, not a page. No hidden files or private directories are copied.
    if (entry.name === 'README.md') continue;
    if (entry.name.startsWith('.'))
      throw new Error(`Unexpected hidden file in public export: ${name}`);
    if (entry.isDirectory()) result.push(...(await files(directory, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Not a regular public file: ${name}`);
  }
  return result;
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function optional(directory, name) {
  try {
    return await readFile(join(directory, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

const [landingFiles, graphFiles] = await Promise.all([files(landing), files(graph)]);
if (!landingFiles.includes('index.html') || !graphFiles.includes('index.html'))
  throw new Error('Both exports need index.html.');
if (
  landingFiles.some(
    (name) => name === 'legacy-syllabusgraph.js' || name.split(sep)[0] === 'syllabusgraph',
  )
) {
  throw new Error('Landing export uses a reserved SyllabusGraph migration path.');
}
for (const name of landingFiles) {
  if (!publicExtensions.has(extname(name)) && !special.has(name))
    throw new Error(`Unexpected landing file: ${name}`);
}

const catalog = JSON.parse(await readFile(join(graph, 'catalog.json'), 'utf8'));
if (catalog.version !== 1 || !Array.isArray(catalog.graphs) || !catalog.graphs.length)
  throw new Error('Expected a prebuilt public graph catalog, not a source repository.');
const payloads = new Set();
for (const item of catalog.graphs) {
  if (!/^data\/[a-zA-Z][a-zA-Z0-9_-]*\.json$/.test(item.file))
    throw new Error('Graph catalog has a non-public payload path.');
  payloads.add(item.file);
  if (!graphFiles.includes(item.file.split('/').join(sep)))
    throw new Error(`Missing public graph payload: ${item.file}`);
}
for (const name of graphFiles) {
  if (name === 'catalog.json' || payloads.has(slash(name)) || name === '_headers') continue;
  if (name.includes(sep) || !publicExtensions.has(extname(name)))
    throw new Error(`Unexpected graph export file: ${name}`);
}

// Header rules are read only at the asset root, so relocate the graph's rules too.
const graphHeaders = (await optional(graph, '_headers'))
  .split(/\r?\n/)
  .map((line) => {
    if (!line.trim() || /^\s|#/.test(line)) return line;
    if (!line.startsWith('/') || line.startsWith('//'))
      throw new Error('Graph headers must use local paths.');
    return `/syllabusgraph${line}`;
  })
  .join('\n');
const landingHeaders = await optional(landing, '_headers');
const landingRedirects = await optional(landing, '_redirects');
const legacyRedirects = graphFiles
  .filter((name) => name !== 'index.html' && name !== '404.html' && name !== '_headers')
  .filter((name) => !landingFiles.includes(name))
  .map((name) => `/${slash(name)} /syllabusgraph/${slash(name)} 301`);

// Refuse to overwrite input or another build. Failed staging only removes its own new output.
try {
  await lstat(output);
  throw new Error('Output already exists. Choose a new directory.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const outputParent = await realpath(dirname(output));
const canonicalOutput = join(outputParent, basename(output));
if (
  [landing, graph].some(
    (input) => isWithin(input, canonicalOutput) || isWithin(canonicalOutput, input),
  )
) {
  throw new Error('Output must be separate from both inputs.');
}
await mkdir(output);
try {
  for (const [source, names, prefix] of [
    [landing, landingFiles, ''],
    [graph, graphFiles, 'syllabusgraph'],
  ]) {
    for (const name of names) {
      if (special.has(name)) continue;
      const target = join(output, prefix, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(source, name), target);
    }
  }
  if (graphFiles.includes('404.html')) {
    const page = await readFile(join(output, 'syllabusgraph/404.html'), 'utf8');
    await writeFile(
      join(output, 'syllabusgraph/404.html'),
      page.replace(/\b(href|src)=(['"])\/(?!\/)/g, '$1=$2/syllabusgraph/'),
    );
  }
  await writeFile(
    join(output, '_headers'),
    [landingHeaders.trim(), graphHeaders.trim()].filter(Boolean).join('\n\n') + '\n',
  );
  await writeFile(
    join(output, '_redirects'),
    [landingRedirects.trim(), ...legacyRedirects].filter(Boolean).join('\n') + '\n',
  );
  // Fragments never reach the server. Recognize old graph links without hijacking landing anchors.
  await writeFile(
    join(output, 'legacy-syllabusgraph.js'),
    `(() => {
  if (!['/', '/index.html'].includes(location.pathname)) return;
  if (new URLSearchParams(location.hash.slice(1)).get('graph')) {
    location.replace('/syllabusgraph/' + location.search + location.hash);
  }
})();\n`,
  );
  const home = await readFile(join(output, 'index.html'), 'utf8');
  if (!/<head\b[^>]*>/i.test(home)) throw new Error('Landing index.html needs a head element.');
  await writeFile(
    join(output, 'index.html'),
    home.replace(/<head\b[^>]*>/i, '$&\n    <script src="/legacy-syllabusgraph.js"></script>'),
  );
  console.log(`Staged public landing and ${catalog.graphs.length} graph(s) in ${output}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
