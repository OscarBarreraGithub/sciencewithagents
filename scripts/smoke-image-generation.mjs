// One built-in image generation in a disposable project; never a separate image API client.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { git } from '../apps/server/dist/workspaces.js';
import { createServer } from '../apps/server/dist/server.js';
import { decodeGeneratedImage } from '../apps/server/dist/images.js';

const native = process.argv.includes('--native'),
  verifyOnly = process.argv.includes('--verify');
assert(
  verifyOnly || process.argv.includes('--run'),
  'Pass --run for one image, or <fixture-id> --verify for no-model checks.',
);
const previous = native || verifyOnly ? process.argv[2] : null;
if (previous) assert(/^[a-f0-9]{8}$/.test(previous));
process.umask(0o077);
const fixture = previous ?? randomUUID().slice(0, 8),
  root = resolve('data/smoke', fixture),
  projectRoot = join(root, 'project');
if (previous) assert(existsSync(join(root, 'dock.sqlite')));
else {
  mkdirSync(projectRoot, { recursive: true });
  await git(projectRoot, ['init', '-b', 'main']);
  await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
  await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
  writeFileSync(join(projectRoot, 'README.md'), '# Built-in image fixture\n');
  await git(projectRoot, ['add', 'README.md']);
  await git(projectRoot, ['commit', '-m', 'Fixture']);
}
console.log(`Image generation fixture: ${fixture}`);
let store = new Store(join(root, 'dock.sqlite'));
const project = store.register(projectRoot, 'Image smoke', 'One harmless generated test image.');
const worker = previous
  ? store.agents().find((agent) => agent.name === 'Image fixture worker')
  : store.addAgent({
      projectId: project.id,
      parentId: null,
      taskId: null,
      role: 'researcher',
      name: 'Image fixture worker',
      cwd: projectRoot,
    });
assert(worker?.status === 'idle');
if (!previous) store.updateAgent(worker.id, { webSearch: 'disabled' });
// One-time recovery of the original protocol probe, not another model generation.
if (process.argv.includes('--recover')) {
  assert(previous && verifyOnly);
  const item = JSON.parse(readFileSync(join(root, 'image-result.json'), 'utf8'));
  const old = store.entries(worker.id).find((entry) => entry.id === `${worker.id}:${item.id}`);
  assert(
    old && !old.image && old.status === 'complete' && store.run(old.runId).status === 'completed',
  );
  // The envelope validator puts id/type first; compare the same canonical field order.
  assert(
    old.text.startsWith(
      JSON.stringify({ id: item.id, type: item.type, ...item }, null, 2).slice(0, 10_000),
    ),
  );
  writeFileSync(join(root, 'entry-before-image-retention.json'), JSON.stringify(old), {
    flag: 'wx',
  });
  store.imageEntry(
    { ...old, title: 'Generated image', text: item.revisedPrompt ?? '' },
    decodeGeneratedImage(item.result).bytes,
  );
  console.log(
    'Retained the original completed image from its saved protocol bytes; no model replay.',
  );
}
const original = store.entries(worker.id);
let runtime = new Runtime(store, root, 'codex'),
  app,
  browser;
const origin = 'http://127.0.0.1:4349';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const waitFor = async (fn, message, timeout = 300_000) => {
  const deadline = Date.now() + timeout;
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  assert(fn(), message);
};
const openWorker = async (viewport) => {
  const page = await browser.newPage({ viewport });
  await page.goto(origin);
  if (viewport.width < 1191) await page.getByRole('button', { name: 'Open team' }).click();
  await page.getByRole('button', { name: /Image fixture worker Researcher/ }).click();
  return page;
};
try {
  await runtime.initialize();
  app = await createServer(store, runtime, { port: 4349, webDir: resolve('apps/web/dist') });
  await app.listen({ host: '127.0.0.1', port: 4349 });
  browser = await chromium.launch();
  if (!previous) {
    const phone = await openWorker({ width: 412, height: 915 });
    await phone.locator('.model-button').click();
    await phone
      .getByRole('checkbox', { name: 'Use built-in image generation', exact: true })
      .check();
    await phone.getByRole('button', { name: 'Save settings', exact: true }).click();
    await waitFor(
      () => store.agent(worker.id).imageGeneration,
      'Phone opt-in must persist.',
      10_000,
    );
    assert.equal(store.runs().length, 0);
    await phone.close();
  }
  if (!verifyOnly) {
    const prompt = `Use the built-in image_gen tool exactly once to generate a photorealistic small ${native ? 'blue ceramic' : 'terracotta'} flowerpot containing a green fern, on a plain cream studio background. No text, people or logos. This is a disposable preview, not a repository asset; leave the generated output at its normal location. Do not use commands, MCP, plugins, web search, subagents or an API-key fallback. After the actual image result, reply ${native ? 'DOCK-NATIVE-IMAGE' : 'DOCK-IMAGE-READY'} and stop.`;
    let run, desktop;
    if (native) {
      const oldRuns = new Set(store.runs().map((value) => value.id));
      const oldThread = store.agent(worker.id).threadId;
      desktop = await openWorker({ width: 1440, height: 1000 });
      await desktop.getByRole('button', { name: 'Native terminal', exact: true }).click();
      await desktop
        .getByText('Native Codex · connected', { exact: true })
        .waitFor({ timeout: 25_000 });
      await desktop.locator('.xterm-helper-textarea').focus();
      await desktop.keyboard.type('/new', { delay: 30 });
      await desktop.keyboard.press('Enter');
      await waitFor(
        () => store.agent(worker.id).threadId !== oldThread,
        'Native new context must be registered.',
        20_000,
      );
      await desktop
        .getByText('Native Codex · connected', { exact: true })
        .waitFor({ timeout: 25_000 });
      await desktop.locator('.xterm-helper-textarea').focus();
      await desktop.keyboard.type(prompt, { delay: 15 });
      await desktop.waitForTimeout(500);
      await desktop.keyboard.press('Enter');
      await waitFor(
        () => (run = store.runs().find((value) => !oldRuns.has(value.id))),
        'Native image input must create a tracked run.',
        20_000,
      );
    } else {
      run = store.enqueue(worker.id, randomUUID(), prompt);
      runtime.kick();
    }
    console.log('Submitted one image-generation turn.');
    await waitFor(
      () => !['queued', 'running'].includes(store.run(run.id).status),
      'Image turn must complete.',
    );
    assert.equal(store.run(run.id).status, 'completed');
    const generated = store
      .entries(worker.id)
      .filter((entry) => entry.runId === run.id && entry.image);
    assert.equal(generated.length, 1, 'Require exactly one new run-owned retained image.');
    assert(
      store
        .entries(worker.id)
        .some(
          (entry) =>
            entry.runId === run.id &&
            entry.kind === 'assistant' &&
            entry.text.includes(native ? 'DOCK-NATIVE-IMAGE' : 'DOCK-IMAGE-READY'),
        ),
    );
    if (desktop) {
      await desktop.getByRole('button', { name: 'Return to chat', exact: true }).click();
      await desktop.close();
    }
  }
  const generated = store.entries(worker.id).filter((entry) => entry.image);
  assert(generated.length);
  assert.deepEqual(store.entries(worker.id).slice(0, original.length), original);
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['phone', 412, 915],
    ['small-phone', 360, 800],
    ['landscape', 915, 412],
  ]) {
    const page = await openWorker({ width, height });
    await page.reload();
    const preview = page.getByRole('img', { name: 'Generated image', exact: true }).last();
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((img) => img.naturalWidth))
      .toBe(generated.at(-1).image.width);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(root, `${name}-image.png`) });
    const opening = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open generated image', exact: true }).last().click();
    const fullSize = await opening;
    await fullSize.waitForLoadState('domcontentloaded');
    assert.equal(await fullSize.evaluate(() => window.opener), null);
    await expect
      .poll(() => fullSize.locator('img').evaluate((img) => img.naturalWidth))
      .toBe(generated.at(-1).image.width);
    await fullSize.close();
    await page
      .getByRole('link', { name: 'Download PNG', exact: true })
      .last()
      .scrollIntoViewIfNeeded();
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download PNG', exact: true }).last().click();
    assert.equal(await (await downloading).failure(), null);
    await page.close();
  }
  const entries = store.entries(worker.id),
    runs = store.runs(),
    threadId = store.agent(worker.id).threadId;
  const bytes = generated.map((entry) => store.image(worker.id, entry.image.id));
  for (const [index, entry] of generated.entries()) {
    const response = await fetch(`${origin}/api/agents/${worker.id}/images/${entry.image.id}`);
    assert.equal(response.status, 200);
    assert(Buffer.from(await response.arrayBuffer()).equals(bytes[index]));
    const detail = await (await fetch(`${origin}/api/agents/${worker.id}`)).text();
    assert(!detail.includes(bytes[index].toString('base64').slice(0, 1000)));
    assert(!detail.includes('savedPath'));
  }
  assert.equal(store.approvals().length, 0);
  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, 'codex');
  await runtime.attach(worker.id);
  assert.equal(store.agent(worker.id).imageGeneration, true);
  assert.equal(store.agent(worker.id).threadId, threadId);
  assert.deepEqual(store.entries(worker.id), entries);
  assert.deepEqual(store.runs(), runs);
  for (const [index, entry] of generated.entries())
    assert(store.image(worker.id, entry.image.id).equals(bytes[index]));
  assert.equal(await git(projectRoot, ['status', '--porcelain']), '');
  console.log(
    `PASS: retained ${generated.length} images, desktop/three-phone preview/download, same-context restart with exact bytes/history. Fixture ${fixture}; worker ${worker.id}.`,
  );
} finally {
  await browser?.close();
  if (app) await app.close();
  else {
    await runtime.close();
    store.close();
  }
}
