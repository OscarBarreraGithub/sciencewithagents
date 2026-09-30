import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { repoRoot } from './paths.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dock-public-site-'));
  roots.push(root);
  const landing = join(root, 'landing'),
    graph = join(root, 'graph'),
    output = join(root, 'output');
  mkdirSync(join(landing, 'assets'), { recursive: true });
  mkdirSync(join(graph, 'data'), { recursive: true });
  writeFileSync(
    join(landing, 'index.html'),
    '<!doctype html><head><link href="/styles.css"></head><body><a href="/syllabusgraph/">Graph</a>',
  );
  writeFileSync(join(landing, 'styles.css'), 'body { color: black; }');
  writeFileSync(join(landing, 'assets/mark.svg'), '<svg/>');
  writeFileSync(join(landing, 'README.md'), 'Not a public page.');
  writeFileSync(join(graph, 'index.html'), '<head><script src="explorer.js"></script></head>');
  writeFileSync(join(graph, 'explorer.js'), 'fetch("catalog.json");');
  writeFileSync(join(graph, 'explorer.css'), 'body { color: green; }');
  writeFileSync(
    join(graph, '404.html'),
    '<link href="/explorer.css"><a href="/">Return</a><a href="https://example.com/">External</a>',
  );
  writeFileSync(
    join(graph, '_headers'),
    "/*\n  Content-Security-Policy: default-src 'self'\n/data/*\n  Cache-Control: no-cache\n",
  );
  writeFileSync(
    join(graph, 'catalog.json'),
    JSON.stringify({ version: 1, graphs: [{ id: 'sample', file: 'data/sample.json' }] }),
  );
  writeFileSync(join(graph, 'data/sample.json'), '{"knowledge":{"nodes":[]}}');
  const build = () =>
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'scripts/build-public-site.mjs'),
        '--landing',
        landing,
        '--graph',
        graph,
        '--out',
        output,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
  return { root, landing, graph, output, build };
}

describe('public site staging', () => {
  it('preserves graph data and relative assets under its prefix and relocates headers and error links', () => {
    const f = fixture();
    expect(f.build()).toContain('1 graph(s)');
    expect(readFileSync(join(f.output, 'syllabusgraph/data/sample.json'), 'utf8')).toBe(
      readFileSync(join(f.graph, 'data/sample.json'), 'utf8'),
    );
    expect(readFileSync(join(f.output, 'syllabusgraph/index.html'), 'utf8')).toBe(
      readFileSync(join(f.graph, 'index.html'), 'utf8'),
    );
    expect(existsSync(join(f.output, 'assets/mark.svg'))).toBe(true);
    expect(existsSync(join(f.output, 'README.md'))).toBe(false);
    expect(existsSync(join(f.output, 'syllabusgraph/_headers'))).toBe(false);
    expect(readFileSync(join(f.output, '_headers'), 'utf8')).toContain(
      "/syllabusgraph/*\n  Content-Security-Policy: default-src 'self'",
    );
    expect(readFileSync(join(f.output, '_headers'), 'utf8')).toContain('/syllabusgraph/data/*');
    expect(readFileSync(join(f.output, '_redirects'), 'utf8')).toContain(
      '/catalog.json /syllabusgraph/catalog.json 301',
    );
    expect(readFileSync(join(f.output, '_redirects'), 'utf8')).toContain(
      '/data/sample.json /syllabusgraph/data/sample.json 301',
    );
    const errorPage = readFileSync(join(f.output, 'syllabusgraph/404.html'), 'utf8');
    expect(errorPage).toContain('href="/syllabusgraph/explorer.css"');
    expect(errorPage).toContain('href="/syllabusgraph/"');
    expect(errorPage).toContain('href="https://example.com/"');
    expect(readFileSync(join(f.graph, '404.html'), 'utf8')).toContain('href="/explorer.css"');
  });

  it('moves legacy root graph hashes once while preserving landing anchors and complete graph state', () => {
    const f = fixture();
    f.build();
    expect(readFileSync(join(f.output, 'index.html'), 'utf8')).toContain(
      '<script src="/legacy-syllabusgraph.js"></script>',
    );
    const code = readFileSync(join(f.output, 'legacy-syllabusgraph.js'), 'utf8');
    const redirects: string[] = [];
    const location = {
      pathname: '/',
      search: '?source=old',
      hash: '#graph=sample&view=records&node=A%26B',
      replace: (url: string) => redirects.push(url),
    };
    runInNewContext(code, { location, URLSearchParams });
    expect(redirects).toEqual(['/syllabusgraph/?source=old#graph=sample&view=records&node=A%26B']);
    location.hash = '#main';
    runInNewContext(code, { location, URLSearchParams });
    location.pathname = '/syllabusgraph/';
    location.hash = '#graph=sample';
    runInNewContext(code, { location, URLSearchParams });
    expect(redirects).toHaveLength(1);
  });

  it('rejects unlisted graph data, unsafe catalog paths, and symbolic links before producing an output', () => {
    const f = fixture();
    writeFileSync(join(f.graph, 'data/private.json'), 'private');
    expect(f.build).toThrow(/Unexpected graph export file/);
    expect(existsSync(f.output)).toBe(false);
    rmSync(join(f.graph, 'data/private.json'));
    writeFileSync(
      join(f.graph, 'catalog.json'),
      JSON.stringify({ version: 1, graphs: [{ file: '../private.json' }] }),
    );
    expect(f.build).toThrow(/non-public payload path/);
    writeFileSync(
      join(f.graph, 'catalog.json'),
      JSON.stringify({ version: 1, graphs: [{ file: 'data/sample.json' }] }),
    );
    symlinkSync(join(f.graph, 'data/sample.json'), join(f.landing, 'assets/leak.txt'));
    expect(f.build).toThrow(/symbolic links/);
    expect(existsSync(f.output)).toBe(false);
  });

  it('never overwrites a previous build and removes only its own incomplete output on failure', () => {
    const f = fixture();
    f.build();
    writeFileSync(join(f.output, 'keep.txt'), 'keep');
    expect(f.build).toThrow(/Output already exists/);
    expect(readFileSync(join(f.output, 'keep.txt'), 'utf8')).toBe('keep');
    rmSync(f.output, { recursive: true });
    writeFileSync(join(f.landing, 'index.html'), '<body>No head</body>');
    expect(f.build).toThrow(/needs a head element/);
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(f.landing)).toBe(true);
    expect(existsSync(f.graph)).toBe(true);
  });
});
