// Opt-in real MCP approval check. Only a fixed local fixture tool may be approved.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { git } from '../apps/server/dist/workspaces.js';
if (!process.argv.includes('--run'))
  throw new Error('Pass --run for two bounded model turns against a harmless local MCP tool.');
process.umask(0o077);
const fixture = randomUUID().slice(0, 8);
const root = resolve('data/smoke', fixture),
  projectRoot = join(root, 'project');
console.log(`MCP smoke fixture: ${fixture}`);
mkdirSync(projectRoot, { recursive: true });
process.env.DOCK_MCP_FIXTURE = root;
const binary = resolve('scripts/fixtures/codex-mcp.mjs');
await git(projectRoot, ['init', '-b', 'main']);
await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
writeFileSync(join(projectRoot, 'README.md'), '# MCP fixture\n');
await git(projectRoot, ['add', 'README.md']);
await git(projectRoot, ['commit', '-m', 'MCP fixture']);
let store = new Store(join(root, 'dock.sqlite'));
const project = store.register(projectRoot, 'MCP smoke', 'Local MCP approval verification.');
const worker = store.addAgent({
  projectId: project.id,
  parentId: null,
  taskId: null,
  role: 'researcher',
  name: 'MCP fixture reader',
  cwd: projectRoot,
});
let runtime = new Runtime(store, root, binary);
try {
  await runtime.initialize();
  const catalog = await runtime.mcpCatalog(worker.id);
  assert(catalog.some((s) => s.name === 'dock_fixture'));
  store.updateAgent(worker.id, { mcpServers: ['dock_fixture'] });
  for (const decision of ['decline', 'accept']) {
    const run = store.enqueue(
      worker.id,
      randomUUID(),
      'Call the dock_fixture MCP ping tool exactly once. If declined, stop immediately without retrying. If accepted, save its exact marker with dock_checkpoint and report it. Do not use any other tools, commands, files, external services, or agents.',
    );
    runtime.kick();
    const deadline = Date.now() + 90_000;
    let approval;
    while (
      !(approval = store
        .approvals()
        .find((a) => a.agentId === worker.id && a.status === 'pending')) &&
      Date.now() < deadline &&
      ['queued', 'running'].includes(store.run(run.id).status)
    )
      await new Promise((r) => setTimeout(r, 250));
    assert(approval, 'A real MCP call must pause for approval.');
    assert.equal(approval.kind, 'mcp');
    assert.equal(approval.params.serverName, 'dock_fixture');
    assert.equal(approval.params._meta.codex_approval_kind, 'mcp_tool_call');
    assert.deepEqual(approval.params._meta.tool_params, {});
    assert(!existsSync(join(root, 'mcp-calls.txt')), 'The tool must not have run before approval.');
    await runtime.approve(approval.id, decision);
    await runtime.approve(approval.id, decision);
    while (store.run(run.id).status === 'running' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 250));
    assert.equal(store.run(run.id).status, 'completed');
    assert.equal(existsSync(join(root, 'mcp-calls.txt')), decision === 'accept');
    console.log(
      `Real MCP ${decision}: original request resolved once; tool ${decision === 'accept' ? 'called once' : 'not called'}.`,
    );
  }
  assert.equal(readFileSync(join(root, 'mcp-calls.txt'), 'utf8'), 'ping\n');
  assert.equal(store.agent(worker.id).checkpoint, 'DOCK-MCP-READY');
  assert(
    store.entries(worker.id).some((e) => e.kind === 'tool' && e.text.includes('DOCK-MCP-READY')),
  );
  const entries = store.entries(worker.id),
    threadId = store.agent(worker.id).threadId;
  await runtime.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = new Runtime(store, root, binary);
  await runtime.attach(worker.id);
  assert.equal(store.agent(worker.id).threadId, threadId);
  assert.deepEqual(store.agent(worker.id).mcpServers, ['dock_fixture']);
  assert.deepEqual(store.entries(worker.id), entries);
  assert.equal(readFileSync(join(root, 'mcp-calls.txt'), 'utf8'), 'ping\n');
  console.log(
    `PASS: MCP selection, explicit decline/accept, one execution, tool archive and restart. Fixture ${fixture}; agent ${worker.id}.`,
  );
} finally {
  await runtime.close();
  store.close();
}
