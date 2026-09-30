// Real native child viewing/handoff check against one disposable existing child fixture.
// Uses one bounded parent/child checkpoint turn; never connects to the live app.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { Terminals } from '../apps/server/dist/terminal.js';
import { createServer } from '../apps/server/dist/server.js';
const fixture = process.argv[2];
assert(
  /^[a-f0-9]{8}$/.test(fixture) && process.argv.includes('--run'),
  'Use one disposable native child fixture and --run',
);
process.umask(0o077);
const root = resolve('data/smoke', fixture),
  host = 'http://127.0.0.1:4342';
const store = new Store(join(root, 'dock.sqlite'));
const parent = store.agents().find((a) => a.name === 'Native parent'),
  child = store.agents().find((a) => a.nativeRootId === parent?.id);
assert(
  parent &&
    child &&
    store.agents().every((a) => !['running', 'waiting', 'queued'].includes(a.status)),
  'Fixture must have idle native parent and child',
);
assert(
  parent.role === 'researcher' &&
    parent.permission === 'read-only' &&
    !parent.taskId &&
    !parent.pluginsEnabled &&
    !parent.mcpServers.length,
  'Use the plain read-only child fixture, without MCP or plugins',
);
const priorEntries = store.entries(child.id),
  marker = 'NATIVE-CHILD-VIEW-' + Date.now();
const firstEvent = store.head;
// Use ordinary worker configuration, not a fixture-only native enablement override.
const runtime = new Runtime(store, root, 'codex');
runtime.externalControl.add(parent.parentId);
let release,
  held = false;
const tool = runtime.tool.bind(runtime);
runtime.tool = async (agentId, key, name, raw) => {
  if (agentId === child.id && name === 'dock_checkpoint' && raw.summary === marker) {
    held = true;
    console.log('Child checkpoint held for native observation.');
    await new Promise((resolve) => {
      release = resolve;
    });
  }
  return tool(agentId, key, name, raw);
};
const trace = [];
const prepare = Terminals.prototype.prepare;
Terminals.prototype.prepare = function (agentId, method, raw) {
  trace.push({ agentId, method, threadId: raw?.threadId });
  return prepare.call(this, agentId, method, raw);
};
let browser,
  app,
  cli,
  cliOutput = '';
try {
  await runtime.initialize();
  await runtime.attach(parent.id);
  app = await createServer(store, runtime, { port: 4342, webDir: resolve('apps/web/dist') });
  await app.listen({ host: '127.0.0.1', port: 4342 });
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  browser = await require('@playwright/test').chromium.launch();
  let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  await page.addInitScript((id) => localStorage.setItem('dock:selected', id), parent.id);
  await page.goto(host);
  await page.getByRole('button', { name: 'Native terminal', exact: true }).click();
  await page.getByText('Native Codex · connected', { exact: true }).waitFor({ timeout: 25_000 });
  await page.waitForTimeout(500);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(
    `Follow up with the SAME existing probe_child. Do not create a replacement. Ask it to call dock_checkpoint with summary ${marker} and then reply CHILD-VIEW-DONE. Wait for it, then call your own dock_checkpoint with summary PARENT-${marker} and reply PARENT-VIEW-DONE. This is an explicit one-child check: do not use any other tools, read files, run commands or delegate other work.`,
    { delay: 3 },
  );
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(root, 'native-child-submitted.png') });
  const deadline = Date.now() + 90_000;
  while (!held && Date.now() < deadline) await page.waitForTimeout(250);
  if (!held) await page.screenshot({ path: join(root, 'native-child-not-started.png') });
  assert(held, 'Existing child must reach its own host checkpoint');
  await page.screenshot({ path: join(root, 'native-child-active.png') });
  await page.keyboard.type('/resume ' + child.threadId, { delay: 50 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(root, 'native-child-active-open.png') });
  assert(
    !trace.some((t) => t.method === 'thread/resume' && t.threadId === child.threadId),
    'The tested CLI refuses /resume while a task is running before it reaches the provider',
  );
  release();
  release = null;
  const completion = Date.now() + 60_000;
  while (store.agent(parent.id).status === 'running' && Date.now() < completion)
    await page.waitForTimeout(250);
  await page.screenshot({ path: join(root, 'native-child-active-finished.png') });
  assert.equal(store.agent(parent.id).status, 'idle');
  assert.equal(store.agent(child.id).checkpoint, marker);
  assert.equal(store.agent(parent.id).checkpoint, 'PARENT-' + marker);
  assert.equal(store.agent(parent.id).threadId, parent.threadId);
  assert.deepEqual(store.entries(child.id).slice(0, priorEntries.length), priorEntries);
  await page.keyboard.press('Control+u');
  await page.keyboard.type('/resume ' + child.threadId, { delay: 50 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(root, 'native-child-idle-open.png') });
  const observations = () => store.events(firstEvent).filter((e) => e.type === 'terminal.observed');
  assert.deepEqual(
    observations().map((e) => e.data.observedAgentId),
    [child.id],
    'Native child resume must acknowledge observation, not transfer or replace the parent',
  );
  const archive = store.entries(child.id),
    parentArchive = store.entries(parent.id);
  for (const [width, height] of [
    [412, 915],
    [360, 800],
    [915, 412],
  ]) {
    const previous = page;
    page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(15_000);
    await page.addInitScript((id) => localStorage.setItem('dock:selected', id), parent.id);
    await page.goto(host);
    await page.getByRole('button', { name: 'Native terminal', exact: true }).click();
    await page.getByText('Native Codex · connected', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(root, `native-child-view-${width}x${height}.png`) });
    await previous.close();
  }
  const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
  cli = serverRequire('node-pty').spawn(
    process.execPath,
    ['apps/server/dist/cli.js', 'attach', parent.id],
    {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, DOCK_PORT: '4342' },
    },
  );
  cli.onData((data) => {
    cliOutput = (cliOutput + data).slice(-500_000);
    if (data.includes('\u001b[6n')) cli.write('\u001b[1;1R');
  });
  const attached = Date.now() + 8000;
  while (!cliOutput.includes('Viewing sub-agent') && Date.now() < attached)
    await page.waitForTimeout(200);
  assert(
    cliOutput.includes('Viewing sub-agent'),
    'Local dock attach must retain the actual read-only child view',
  );
  // Parent-owned native views allow the bare picker command, not /resume with arguments.
  for (const character of '/resume') {
    cli.write(character);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  cli.write('\r');
  await page.waitForTimeout(1000);
  for (const character of parent.threadId) {
    cli.write(character);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1000);
  cli.write('\r');
  const returned = Date.now() + 15_000;
  while (observations().at(-1)?.data.observedAgentId !== parent.id && Date.now() < returned)
    await page.waitForTimeout(200);
  assert.equal(
    observations().at(-1)?.data.observedAgentId,
    parent.id,
    'Native child view returns to the original parent',
  );
  assert.equal(store.agent(parent.id).threadId, parent.threadId);
  assert.equal(store.agent(child.id).threadId, child.threadId);
  assert.deepEqual(store.entries(child.id), archive);
  assert.deepEqual(store.entries(parent.id), parentArchive);
  assert(!store.events(firstEvent).some((e) => e.type === 'terminal.transferred'));
  console.log(
    'PASS: native child observation, three phone handoffs, local CLI return to parent, exact archives and ownership.',
  );
} finally {
  release?.();
  cli?.kill();
  await browser?.close();
  for (const run of store
    .runs()
    .filter((r) => r.agentId === parent.parentId && r.status === 'queued'))
    store.updateRun(run.id, { status: 'cancelled' });
  store.updateAgent(parent.parentId, { status: 'idle' });
  writeFileSync(join(root, 'native-child-navigation.json'), JSON.stringify(trace), { mode: 0o600 });
  writeFileSync(join(root, 'native-child-cli.txt'), cliOutput, { mode: 0o600 });
  if (app) await app.close();
  else {
    await runtime.close();
    store.close();
  }
}
