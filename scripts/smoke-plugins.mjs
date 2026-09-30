// Isolated installed-plugin compatibility check. Does not install plugins or edit host config.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { git } from '../apps/server/dist/workspaces.js';
process.umask(0o077);
const fixture = randomUUID().slice(0, 8);
const native = process.argv.includes('--native');
assert(!native || process.argv.includes('--run'), 'The native child check requires --run.');
const root = resolve('data/smoke', fixture),
  projectRoot = join(root, 'project');
mkdirSync(projectRoot, { recursive: true });
await git(projectRoot, ['init', '-b', 'main']);
await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
writeFileSync(join(projectRoot, 'README.md'), '# Plugin fixture\n');
await git(projectRoot, ['add', 'README.md']);
await git(projectRoot, ['commit', '-m', 'Plugin fixture']);
console.log(`Plugin fixture ${fixture}`);
let store = new Store(join(root, 'dock.sqlite'));
const project = store.register(
  projectRoot,
  'Plugin compatibility',
  'Isolated installed-plugin check.',
);
const worker = store.addAgent({
  projectId: project.id,
  parentId: null,
  taskId: null,
  role: 'researcher',
  name: 'Plugin reader',
  cwd: projectRoot,
});
store.updateAgent(worker.id, { pluginsEnabled: true });
// Exercise production settings, including native activation, with no provider overrides.
const makeRuntime = () => new Runtime(store, root, 'codex');
let runtime = makeRuntime();
let nativeChild;
try {
  const { client, threadId } = await runtime.attach(worker.id);
  const status = await client.request('mcpServerStatus/list', {
    threadId,
    detail: 'toolsAndAuthOnly',
  });
  console.log(
    JSON.stringify({
      threadId,
      servers: status.data.map((s) => ({
        name: s.name,
        pluginId: s.pluginId,
        status: s.runtimeStatus,
        tools: Object.keys(s.tools).length,
      })),
    }),
  );
  assert(status.data.some((s) => s.pluginId && Object.keys(s.tools).length));
  assert(
    status.data.some(
      (s) =>
        s.name === 'codex_apps' && Object.values(s.tools).some((t) => t.name === 'github.get_repo'),
    ),
  );
  if (process.argv.includes('--run')) {
    await runtime.initialize();
    for (const [server, decision, instruction] of [
      [
        'computer-use',
        'decline',
        'Call the computer-use MCP list_apps tool exactly once with empty arguments. This is an approval-decline check; the request will be declined. Stop after decline without retrying. Do not call any other tools, read files, inspect app state or interact with any app.',
      ],
      [
        'codex_apps',
        'decline',
        'Use tool discovery if needed to find the codex_apps GitHub github.get_repo tool, then call it exactly once with repository_full_name="openai/codex" (no repository_id or repository_url). Do not use shell or another service. This is a tool approval check. If declined, stop without retrying. Do nothing else.',
      ],
      [
        'codex_apps',
        'accept',
        'Use tool discovery if needed to find the codex_apps GitHub github.get_repo tool, then call it exactly once with repository_full_name="openai/codex" (no repository_id or repository_url). Do not use shell or another service. If declined, stop. If successful, save exactly DOCK-PLUGINS-READY with dock_checkpoint, then stop. Do not call any other tools or access other repositories.',
      ],
    ]) {
      if (process.argv.includes('--apps-only') && server !== 'codex_apps') continue;
      const childInstruction = instruction.replace('DOCK-PLUGINS-READY', 'CHILD-PLUGINS-READY');
      const nativeInstruction =
        (nativeChild
          ? `Follow up with the SAME native child ${nativeChild.threadId}. Do not create a replacement. `
          : 'Spawn exactly ONE native child named plugin_reader. Native delegation is explicitly requested for this bounded check. ') +
        `Give it this exact assignment: ${childInstruction} It must not spawn children or do other work. ` +
        'You, the parent, must not make the plugin/app call yourself. Wait for your child. ' +
        (decision === 'accept'
          ? 'After it succeeds, save DOCK-PLUGINS-READY with your own dock_checkpoint. '
          : '') +
        'Then stop without further tools or follow-up work.';
      const run = store.enqueue(worker.id, randomUUID(), native ? nativeInstruction : instruction);
      runtime.kick();
      const deadline = Date.now() + 90_000;
      let approval;
      while (
        !(approval = store.approvals().find((a) => a.status === 'pending')) &&
        ['queued', 'running'].includes(store.run(run.id).status) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 250));
      assert(approval, `A ${server} plugin tool must pause for approval.`);
      if (native) {
        const children = store.agents().filter((a) => a.nativeRootId === worker.id);
        assert.equal(children.length, 1);
        nativeChild = children[0];
        assert.equal(approval.agentId, nativeChild.id);
        assert.equal(approval.params.threadId, nativeChild.threadId);
        assert.equal(nativeChild.pluginsEnabled, true);
      } else assert.equal(approval.agentId, worker.id);
      console.log({ kind: approval.kind, title: approval.title, questions: approval.questions });
      assert.equal(approval.kind, 'mcp');
      assert.equal(approval.params.serverName, server);
      if (server === 'computer-use') {
        assert(approval.title.includes('list_apps'));
        assert.deepEqual(approval.params._meta.tool_params, {});
      } else {
        assert(approval.title.includes('get_repo'));
        assert.deepEqual(approval.params._meta.tool_params, {
          repository_full_name: 'openai/codex',
        });
      }
      await runtime.approve(approval.id, decision);
      await runtime.approve(approval.id, decision);
      while (store.run(run.id).status === 'running' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 250));
      assert.equal(store.run(run.id).status, 'completed');
      console.log(`PASS: real ${server} plugin consent received ${decision} once.`);
    }
    assert.equal(store.agent(worker.id).checkpoint, 'DOCK-PLUGINS-READY');
    const calls = store
      .entries(nativeChild?.id ?? worker.id)
      .filter((e) => e.kind === 'tool' && e.title === 'mcpToolCall')
      .map((e) => JSON.parse(e.text));
    assert.equal(calls.filter((c) => c.status === 'completed').length, 1);
    assert(calls.some((c) => c.server === 'codex_apps' && c.status === 'completed' && !c.error));
    const entries = store.entries(worker.id);
    const childEntries = nativeChild ? store.entries(nativeChild.id) : null;
    if (nativeChild) {
      assert.equal(store.agent(nativeChild.id).checkpoint, 'CHILD-PLUGINS-READY');
      assert(
        !entries.some((e) => e.kind === 'tool' && e.title === 'mcpToolCall'),
        'The parent must not substitute for child plugin execution',
      );
    }
    await runtime.close();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    runtime = makeRuntime();
    await runtime.attach(worker.id);
    assert.equal(store.agent(worker.id).threadId, threadId);
    assert.equal(store.agent(worker.id).pluginsEnabled, true);
    assert.equal(store.agent(worker.id).checkpoint, 'DOCK-PLUGINS-READY');
    assert.deepEqual(store.entries(worker.id), entries);
    if (nativeChild) {
      assert.equal(store.agent(nativeChild.id).threadId, nativeChild.threadId);
      assert.equal(store.agent(nativeChild.id).nativeRootId, worker.id);
      assert.equal(store.agent(nativeChild.id).pluginsEnabled, true);
      assert.equal(store.agent(nativeChild.id).checkpoint, 'CHILD-PLUGINS-READY');
      assert.deepEqual(store.entries(nativeChild.id), childEntries);
      console.log(
        'PASS: native child original plugin/app consent, separate checkpoints and exact child identity/archive after restart.',
      );
    }
    console.log(
      'PASS: plugin selection, original consent, tool result, checkpoint and exact history survive restart.',
    );
  }
  console.log(
    `Plugin fixture ${fixture}; worker ${worker.id}. ${process.argv.includes('--run') ? 'Model checks completed.' : 'No model turn started.'}`,
  );
} finally {
  await runtime.close();
  store.close();
}
