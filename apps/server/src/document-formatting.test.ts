import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Documents } from './documents.js';
import { ModelPolicy } from './model-policy.js';
import { DocumentFormatting } from './document-formatting.js';
import { defaultModelPolicy } from '@dock/shared';

it('queues one selectable native formatter, preserves original inputs, rejects stale copies and keeps retry receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'document-format-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const docs = new Documents(store, root, root);
  try {
    store.setSetting('model-policy', defaultModelPolicy);
    const policy = new ModelPolicy(store, async () => [
      {
        id: 'claude-sonnet-5-5',
        label: 'Sonnet 5.5',
        efforts: ['low', 'medium', 'high'],
        isDefault: true,
      },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'], isDefault: false },
    ]);
    const format = new DocumentFormatting(
      store,
      docs,
      policy,
      root,
      () => 'The work queue is paused.',
    );
    const folder = join(root, 'report');
    await mkdir(folder);
    const original = String.raw`\documentclass{article}\begin{document}\input{equation}See \eqref{energy}.\end{document}`;
    const math = String.raw`\begin{equation}\label{energy}E=mc^2\end{equation}`;
    await writeFile(join(folder, 'report.tex'), original);
    await writeFile(join(folder, 'equation.tex'), math);
    const doc = await docs.registerRelative(folder, 'report.tex');
    expect(await format.status(doc.id)).toBeNull();
    const input = { key: randomUUID() };
    const first = await format.ask(doc.id, input);
    expect(first).toMatchObject({
      state: 'queued',
      model: 'claude-sonnet-5-5',
      message: 'The work queue is paused.',
    });
    expect(await format.ask(doc.id, input)).toEqual(first);
    expect(store.runs()).toHaveLength(1);
    await expect(format.ask(doc.id, { key: randomUUID() })).rejects.toThrow(/already/);
    await expect(format.ask(doc.id, { ...input, model: 'claude-opus-5-5' })).rejects.toThrow();
    const agent = store.agent(first.agentId);
    expect(agent).toMatchObject({
      provider: 'claude',
      role: 'implementer',
      permission: 'workspace-write',
      toolPolicy: 'native',
    });
    expect(format.isAgent(agent.id)).toBe(true);
    expect(await readFile(join(agent.cwd, 'source.tex'), 'utf8')).toContain(math);
    const copy = original.replace('\\input{equation}', math);
    await writeFile(join(agent.cwd, 'formatted.tex'), copy);
    store.updateRun(store.runs()[0]!.id, { status: 'completed' });
    expect((await format.status(doc.id))?.state).toBe('ready');
    await writeFile(join(agent.cwd, 'formatted.tex'), copy.replace('\\label{energy}', ''));
    expect((await format.status(doc.id))?.state).toBe('failed');
    await writeFile(
      join(agent.cwd, 'formatted.tex'),
      copy.replace('\\eqref{energy}', '\\eqref{other}'),
    );
    expect(await format.status(doc.id)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('references'),
    });
    await writeFile(join(agent.cwd, 'formatted.tex'), copy.replace('{article}', '{book}'));
    expect(await format.status(doc.id)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('preamble'),
    });
    await writeFile(join(agent.cwd, 'formatted.tex'), copy);
    await writeFile(join(folder, 'equation.tex'), math + 'Changed.');
    expect((await format.status(doc.id))?.state).toBe('stale');
    await expect(format.reading(doc.id, first.id)).rejects.toThrow(/source changed/);
    expect(await readFile(join(folder, 'report.tex'), 'utf8')).toBe(original);
    const next = await format.ask(doc.id, {
      key: randomUUID(),
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    expect(next.model).toBe('claude-opus-5-5');
    expect(store.runs()).toHaveLength(2);
  } finally {
    await docs.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
