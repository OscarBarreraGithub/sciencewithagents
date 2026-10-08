import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModelPolicy } from '@dock/shared';
import { Store } from './store.js';
import { Documents } from './documents.js';
import { ModelPolicy } from './model-policy.js';
import { DocumentFormatting } from './document-formatting.js';

const catalog = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'high'], isDefault: true },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'], isDefault: false },
];
const original = String.raw`\documentclass{article}
\begin{document}Full scientific prose.
\begin{equation}\label{energy}E=mc^2+V\end{equation}
See \eqref{energy}.\end{document}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'automatic-format-'));
  const database = join(root, 'dock.sqlite');
  const store = new Store(database);
  store.setSetting('model-policy', defaultModelPolicy);
  const docs = new Documents(store, root, root);
  const discover = vi.fn(async () => catalog);
  const policy = new ModelPolicy(store, discover);
  const format = new DocumentFormatting(store, docs, policy, root, () => null);
  const folder = join(root, 'report');
  await mkdir(folder);
  const path = join(folder, 'report.tex');
  await writeFile(path, original);
  const doc = await docs.registerRelative(folder, 'report.tex');
  const hash = (await docs.formattingSource(doc.id)).hash;
  const enable = (model = 'claude-sonnet-5-5', effort = 'low') =>
    format.saveAutomaticPreference(doc.id, {
      key: randomUUID(),
      expectedRevision: format.automaticPreference(doc.id).revision,
      enabled: true,
      provider: 'claude',
      model,
      effort,
    });
  return {
    root,
    database,
    store,
    docs,
    discover,
    policy,
    format,
    path,
    doc,
    hash,
    enable,
    async close() {
      await docs.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it('requires opt-in and deduplicates source/model passes across simultaneous tabs, reopening and changed source', async () => {
  const f = await fixture();
  const otherStore = new Store(f.database);
  const otherDocs = new Documents(otherStore, f.root, f.root);
  const other = new DocumentFormatting(
    otherStore,
    otherDocs,
    new ModelPolicy(otherStore, async () => catalog),
    f.root,
    () => null,
  );
  try {
    expect(f.format.automaticPreference(f.doc.id)).toMatchObject({ enabled: false, revision: 0 });
    expect(await f.format.automatic(f.doc.id, { sourceHash: f.hash })).toBeNull();
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.store.runs()).toHaveLength(0);
    f.enable();
    const receipts = await Promise.all([
      f.format.automatic(f.doc.id, { sourceHash: f.hash }),
      other.automatic(f.doc.id, { sourceHash: f.hash }),
      f.format.automatic(f.doc.id, { sourceHash: f.hash }),
    ]);
    expect(new Set(receipts.map((receipt) => receipt?.id)).size).toBe(1);
    expect(f.store.runs()).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({ state: 'queued', model: 'claude-sonnet-5-5' });
    const agent = f.store.agent(receipt.agentId);
    expect(await readFile(join(agent.cwd, 'source.tex'), 'utf8')).toBe(original);
    expect(await readFile(f.path, 'utf8')).toBe(original);
    await writeFile(join(agent.cwd, 'formatted.tex'), original);
    f.store.updateRun(f.store.runs()[0]!.id, { status: 'completed' });
    expect(await other.automatic(f.doc.id, { sourceHash: f.hash })).toMatchObject({
      id: receipt.id,
      state: 'ready',
    });
    // A preference revision alone is not a new formatting policy or paid pass.
    f.enable();
    expect(await f.format.automatic(f.doc.id, { sourceHash: f.hash })).toMatchObject({
      id: receipt.id,
    });
    expect(f.store.runs()).toHaveLength(1);
    await writeFile(f.path, original.replace('mc^2+V', 'mc^2+V+K'));
    await expect(f.format.automatic(f.doc.id, { sourceHash: f.hash })).rejects.toThrow(
      /source changed/,
    );
    expect(f.store.runs()).toHaveLength(1);
    const changedHash = (await f.docs.formattingSource(f.doc.id)).hash;
    const changed = await other.automatic(f.doc.id, { sourceHash: changedHash });
    expect(changed?.id).not.toBe(receipt.id);
    expect(f.store.runs()).toHaveLength(2);
    expect(await readFile(f.path, 'utf8')).toBe(original.replace('mc^2+V', 'mc^2+V+K'));
  } finally {
    await otherDocs.close();
    otherStore.close();
    await f.close();
  }
});

it('does not retry failed/interrupted passes automatically and retains explicit retry and model choices', async () => {
  const f = await fixture();
  try {
    f.enable();
    const first = (await f.format.automatic(f.doc.id, { sourceHash: f.hash }))!;
    f.store.updateRun(f.store.runs()[0]!.id, { status: 'failed' });
    const reopened = new DocumentFormatting(f.store, f.docs, f.policy, f.root, () => null);
    for (let i = 0; i < 3; i++)
      expect(await reopened.automatic(f.doc.id, { sourceHash: f.hash })).toMatchObject({
        id: first.id,
        state: 'interrupted',
      });
    expect(f.store.runs()).toHaveLength(1);
    const explicit = await f.format.ask(f.doc.id, {
      key: randomUUID(),
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'low',
    });
    expect(explicit.id).not.toBe(first.id);
    expect(await reopened.automatic(f.doc.id, { sourceHash: f.hash })).toMatchObject({
      id: explicit.id,
      state: 'queued',
    });
    await writeFile(join(f.store.agent(explicit.agentId).cwd, 'formatted.tex'), original);
    f.store.updateRun(f.store.runs()[1]!.id, { status: 'completed' });
    expect(await reopened.automatic(f.doc.id, { sourceHash: f.hash })).toMatchObject({
      id: explicit.id,
      state: 'ready',
    });
    f.enable('claude-opus-5-5', 'high');
    const opus = (await reopened.automatic(f.doc.id, { sourceHash: f.hash }))!;
    expect(opus).toMatchObject({ model: 'claude-opus-5-5', state: 'queued' });
    f.store.updateRun(f.store.runs()[2]!.id, { status: 'interrupted' });
    expect(await f.format.automatic(f.doc.id, { sourceHash: f.hash })).toMatchObject({
      id: opus.id,
      state: 'interrupted',
    });
    expect(f.store.runs()).toHaveLength(3);
    expect(await readFile(f.path, 'utf8')).toBe(original);
  } finally {
    await f.close();
  }
});

it('fences stale preference edits and opt-out during model discovery without queuing a turn', async () => {
  const f = await fixture();
  let release!: (value: typeof catalog) => void;
  const delayed = new ModelPolicy(
    f.store,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const format = new DocumentFormatting(f.store, f.docs, delayed, f.root, () => null);
  try {
    const preference = f.enable();
    const pending = format.automatic(f.doc.id, { sourceHash: f.hash });
    await expect.poll(() => typeof release).toBe('function');
    const disable = {
      key: randomUUID(),
      expectedRevision: preference.revision,
      enabled: false,
      provider: preference.provider,
      model: preference.model,
      effort: preference.effort,
    };
    expect(format.saveAutomaticPreference(f.doc.id, disable).enabled).toBe(false);
    expect(format.saveAutomaticPreference(f.doc.id, disable).enabled).toBe(false);
    expect(() =>
      format.saveAutomaticPreference(f.doc.id, { ...disable, key: randomUUID() }),
    ).toThrow(/another device/);
    release(catalog);
    await expect(pending).rejects.toThrow(/Automatic formatting changed/);
    expect(f.store.runs()).toHaveLength(0);
    expect(await readFile(f.path, 'utf8')).toBe(original);
  } finally {
    await f.close();
  }
});

it('publishes the exact expanded source hash that fences an automatic request', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, original.replace('Full scientific prose.', String.raw`\input{body}`));
    await writeFile(join(f.root, 'report', 'body.tex'), 'Full scientific prose.');
    const source = await f.docs.formattingSource(f.doc.id);
    const reading = await f.docs.reading(f.doc.id);
    expect(reading.available).toBe(true);
    expect(reading.sourceHash).toBe(source.hash);
    expect(reading.html).toContain('Full scientific prose.');
    expect(f.store.runs()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
