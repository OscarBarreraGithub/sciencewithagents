import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Store } from './store.js';
import { Documents, latexCompiler, registerDocumentRoutes } from './documents.js';
import { proxyPath } from './hosts.js';

let root: string, home: string, data: string, store: Store, documents: Documents;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'swa-documents-'));
  home = join(root, 'home');
  data = join(root, 'data');
  await mkdir(home);
  store = new Store(join(data, 'dock.sqlite'));
  documents = new Documents(store, data, home);
});
afterEach(async () => {
  await documents.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});
async function done(id: string) {
  await expect
    .poll(() => documents.get(id).state, { timeout: 60000 })
    .not.toMatch(/^(queued|building)$/);
  return documents.get(id);
}
const tex = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Thermal report}
Temperature follows $T(t)=T_0 e^{-kt}$. \input{chapter}
\newpage
\section{Measurements}
A second page with selectable text and a displayed equation.
\[\frac{dT}{dt}=-k(T-T_{\mathrm{ambient}})\]
\end{document}
`;
it('browses host-issued folders and supported files without exposing paths or accepting path injection', async () => {
  await writeFile(join(home, 'report.tex'), tex);
  await writeFile(join(home, 'secret.key'), 'not a document');
  await mkdir(join(home, 'chapters'));
  await symlink(data, join(home, 'private-runtime'));
  const result = await documents.browse();
  expect(result.files.map((x) => x.name)).toEqual(['report.tex']);
  expect(result.folders.map((x) => x.name)).toEqual(['chapters']);
  expect(JSON.stringify(result)).not.toContain(home);
  expect(documents.list().documents).toHaveLength(0);
  await expect(documents.browse(randomUUID())).rejects.toThrow(/expired/);
  await expect(documents.registerRelative(home, '../data/dock.sqlite')).rejects.toThrow(/relative/);
  await symlink(join(home, 'report.tex'), join(root, 'escape.tex'));
  await expect(documents.registerRelative(root, 'escape.tex')).resolves.toMatchObject({
    kind: 'tex',
  });
  await symlink(join(root, 'escape.tex'), join(home, 'linked.tex'));
  // Registration resolves symlinks but must remain inside the explicitly registered root.
  await writeFile(join(root, 'outside.tex'), tex);
  await symlink(join(root, 'outside.tex'), join(home, 'outside.tex'));
  await expect(documents.registerRelative(home, 'outside.tex')).rejects.toThrow(/within/);
});
it('opens an existing PDF, preserves recent documents across restart and rejects key reuse', async () => {
  const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
  await writeFile(join(home, 'existing.pdf'), pdf);
  const document = await documents.registerRelative(home, 'existing.pdf');
  const key = randomUUID();
  const initial = await documents.open(document.id, key);
  expect(await done(document.id)).toMatchObject({ state: 'ready', hasPdf: true });
  expect((await documents.pdf(document.id)).data).toEqual(pdf);
  expect(await documents.open(document.id, key)).toEqual(initial);
  await expect(documents.open(document.id, key, true)).rejects.toThrow(/different/);
  await documents.close();
  documents = new Documents(store, data, home);
  expect(documents.list().documents).toHaveLength(1);
  await rm(join(home, 'existing.pdf'));
  expect(await documents.open(document.id, key)).toEqual(initial);
  expect(await documents.open(document.id, randomUUID())).toMatchObject({ hasPdf: true });
  await expect(documents.open(document.id, randomUUID(), true)).rejects.toThrow(/unavailable/);
});
it.skipIf(!latexCompiler())(
  'compiles real LaTeX with includes; retry retains a good PDF and never writes beside source',
  async () => {
    await writeFile(join(home, 'report.tex'), tex);
    await writeFile(join(home, 'chapter.tex'), String.raw`Included chapter. \input{../shared}`);
    await writeFile(join(root, 'shared.tex'), 'Shared parent-folder preamble support.');
    const document = await documents.registerRelative(home, 'report.tex');
    await documents.open(document.id, randomUUID());
    const built = await done(document.id);
    expect(built.error).toBeNull();
    expect(built.state).toBe('ready');
    const good = (await documents.pdf(document.id)).data;
    expect(good.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await readdir(home)).sort()).toEqual(['chapter.tex', 'report.tex']);
    expect(await readFile(join(home, 'report.tex'), 'utf8')).toBe(tex);
    await writeFile(join(home, 'chapter.tex'), String.raw`\deliberatelyUndefinedCommand`);
    await documents.open(document.id, randomUUID(), true);
    expect(await done(document.id)).toMatchObject({ state: 'failed', hasPdf: true });
    expect((await documents.pdf(document.id)).data).toEqual(good);
    await writeFile(join(home, 'chapter.tex'), 'Corrected chapter.');
    await documents.open(document.id, randomUUID(), true);
    expect(await done(document.id)).toMatchObject({ state: 'ready', error: null });
    expect(await readdir(join(data, 'documents/builds'))).toHaveLength(0);
  },
  90000,
);
it.skipIf(!latexCompiler())(
  'ignores project compiler scripts and refuses TeX writes outside the output directory',
  async () => {
    const sentinel = join(root, 'keep.txt');
    await writeFile(sentinel, 'Owner content');
    await writeFile(join(home, '.latexmkrc'), 'die "Do not execute project config";');
    await writeFile(
      join(home, 'safe.tex'),
      String.raw`\documentclass{article}\begin{document}Safe\end{document}`,
    );
    const safe = await documents.registerRelative(home, 'safe.tex');
    await documents.open(safe.id, randomUUID());
    expect(await done(safe.id)).toMatchObject({ state: 'ready' });
    await writeFile(
      join(home, 'escape.tex'),
      String.raw`\documentclass{article}\begin{document}\newwrite\outputfile\immediate\openout\outputfile=../keep.txt\immediate\write\outputfile{Replaced}\end{document}`,
    );
    const escape = await documents.registerRelative(home, 'escape.tex');
    await documents.open(escape.id, randomUUID());
    await done(escape.id);
    expect(await readFile(sentinel, 'utf8')).toBe('Owner content');
  },
);

it('serves only registered PDF IDs and proxies documents to the selected computer', async () => {
  const app = Fastify();
  registerDocumentRoutes(app, documents);
  try {
    const id = randomUUID();
    expect(proxyPath('GET', '/documents')).toBe('/api/documents');
    expect(proxyPath('GET', `/documents/${id}/pdf`)).toBe(`/api/documents/${id}/pdf`);
    expect(proxyPath('POST', `/documents/${id}/build`)).toBe(`/api/documents/${id}/build`);
    expect(proxyPath('GET', `/documents/browse?folderId=${id}&offset=100`)).not.toBeNull();
    expect(proxyPath('GET', `/documents/${id}/reading`)).toBe(`/api/documents/${id}/reading`);
    expect(proxyPath('GET', `/documents/${id}/assets/${'a'.repeat(64)}.png`)).toBe(
      `/api/documents/${id}/assets/${'a'.repeat(64)}.png`,
    );
    expect(proxyPath('POST', '/documents/from-message')).toBe('/api/documents/from-message');
    expect(proxyPath('GET', '/documents/browse?path=/etc')).toBeNull();
    expect((await app.inject('/api/documents/browse?path=/etc')).statusCode).not.toBe(200);
    expect((await app.inject('/api/documents/not-an-id/pdf')).statusCode).not.toBe(200);
    await writeFile(join(home, 'report.pdf'), '%PDF-1.4\nfixture');
    const doc = await documents.registerRelative(home, 'report.pdf');
    await documents.open(doc.id, randomUUID());
    await done(doc.id);
    const response = await app.inject(`/api/documents/${doc.id}/pdf`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await app.close();
  }
});

it('resolves only recorded document links within the conversation workspaces', async () => {
  const project = store.register(home, 'Research', 'Test saved links', 'codex');
  const agent = store.agent(project.managerId);
  const legacy = join(data, 'managers', agent.id);
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'report.pdf'), '%PDF-1.4\nreport');
  const entryId = `${agent.id}:msg_provider-message-id`;
  store.entry({
    id: entryId,
    agentId: agent.id,
    runId: null,
    kind: 'assistant',
    title: '',
    text: `[Read report](${join(legacy, 'report.pdf')})\n[Outside](${join(root, 'outside.pdf')})`,
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  await writeFile(join(root, 'outside.pdf'), '%PDF-1.4\nprivate');
  // Match migrated installations: cwd now points to the project, while saved links
  // still refer to this manager's previous private workspace.
  store.updateAgent(agent.id, { cwd: home });
  const input = { agentId: agent.id, entryId, index: 0 };
  const found = await documents.fromSavedLink(input);
  expect(found.name).toBe('report.pdf');
  expect(await documents.registerAgentRelative(agent.id, 'report.pdf')).toEqual(found);
  expect(await documents.fromSavedLink(input)).toEqual(found);
  await expect(documents.fromSavedLink({ ...input, index: 1 })).rejects.toThrow(/outside/);
  await expect(documents.fromSavedLink({ ...input, entryId: randomUUID() })).rejects.toThrow(
    /saved message/,
  );
  await expect(documents.fromSavedLink({ ...input, path: '/etc/passwd' })).rejects.toThrow();
});
