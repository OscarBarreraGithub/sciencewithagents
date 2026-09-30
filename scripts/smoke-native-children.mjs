// Isolated native child compatibility probe with optional legacy/custom-role overrides.
// Ordinary workers already support native helpers; this probe makes no global changes.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { CodexRpc } from '../apps/server/dist/codex.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { Store } from '../apps/server/dist/store.js';
import { omitNullOptions } from '../apps/server/dist/mcp.js';
import { git } from '../apps/server/dist/workspaces.js';
if (!process.argv.includes('--run'))
  throw Error('Pass --run for two bounded parent/child turns using real Codex.');
const mcpCheck = process.argv.includes('--mcp'),
  customAgent = process.argv.includes('--custom');
const classic = process.argv.includes('--classic');
const modelIndex = process.argv.indexOf('--model');
const fixtureModel = modelIndex < 0 ? null : process.argv[modelIndex + 1];
assert(
  modelIndex < 0 || /^[a-zA-Z0-9_.-]{1,100}$/.test(fixtureModel ?? ''),
  'Provide a catalog model after --model.',
);
assert(!customAgent || mcpCheck, 'Custom-agent policy check uses only the harmless MCP fixture.');
process.umask(0o077);
const fixture = randomUUID().slice(0, 8),
  root = resolve('data/smoke', fixture),
  cwd = join(root, 'project');
mkdirSync(cwd, { recursive: true });
await git(cwd, ['init', '-b', 'main']);
await git(cwd, ['config', 'user.name', 'Agent Dock Smoke']);
await git(cwd, ['config', 'user.email', 'smoke@example.invalid']);
writeFileSync(join(cwd, 'README.md'), '# Native child fixture\n');
if (customAgent) {
  mkdirSync(join(cwd, '.codex/agents'), { recursive: true });
  writeFileSync(
    join(cwd, '.codex/agents/fixture_reader.toml'),
    'name="fixture_reader"\ndescription="Only for the explicit Agent Dock native MCP fixture check"\n' +
      'developer_instructions="Do only the assigned fixture task. Never use shell, network or other tools. Use the requested MCP ping and dock_checkpoint, then reply."\n' +
      'approval_policy="never"\n' +
      '[mcp_servers.dock_fixture]\nenabled=true\ndefault_tools_approval_mode="approve"\n' +
      'command=' +
      JSON.stringify(process.execPath) +
      '\nargs=' +
      JSON.stringify([resolve('scripts/fixtures/mcp-server.mjs'), join(root, 'mcp-calls.txt')]) +
      '\n' +
      '[mcp_servers.dock_fixture.tools.ping]\napproval_mode="approve"\n',
  );
}
await git(cwd, ['add', 'README.md']);
await git(cwd, ['commit', '-m', 'Native child fixture']);
console.log(`Native child fixture ${fixture}`);
if (mcpCheck) process.env.DOCK_MCP_FIXTURE = root;
const binary = mcpCheck ? resolve('scripts/fixtures/codex-mcp.mjs') : 'codex';
class ProbeProvider extends CodexRpc {
  async request(method, params) {
    if (['thread/start', 'thread/resume'].includes(method) && !params.ephemeral) {
      const { config } = await super.request('config/read', { includeLayers: false });
      params = {
        ...params,
        config: {
          ...params.config,
          features: {
            ...omitNullOptions(config.features),
            ...params.config?.features,
            multi_agent: true,
            multi_agent_v2: !classic,
          },
          agents: {
            ...omitNullOptions(config.agents),
            enabled: true,
            max_concurrent_threads_per_session: 1,
            ...(customAgent
              ? {
                  fixture_reader: {
                    description:
                      'Only the explicit native MCP fixture task; never choose a fallback role.',
                    config_file: join(cwd, '.codex/agents/fixture_reader.toml'),
                  },
                }
              : {}),
          },
        },
        ...(method === 'thread/start'
          ? {
              developerInstructions:
                'Isolated native-child adapter check. Do only the requested one-child workflow. The owner explicitly asks for one native child. Use only native coordination and dock_checkpoint.' +
                (mcpCheck
                  ? ' The child may also use the harmless dock_fixture MCP ping once per assigned turn, using tool discovery if needed.'
                  : '') +
                ' No shell, files, network, plugins, extra children or other work.',
            }
          : {}),
      };
    }
    return super.request(method, params);
  }
}
let store = new Store(join(root, 'dock.sqlite'));
const project = store.register(
  cwd,
  'Native child compatibility',
  'Isolated real-provider adapter check',
);
const worker = store.addAgent({
  projectId: project.id,
  parentId: project.managerId,
  taskId: null,
  role: 'researcher',
  name: 'Native parent',
  cwd,
});
if (mcpCheck) store.updateAgent(worker.id, { mcpServers: ['dock_fixture'] });
if (fixtureModel) store.updateAgent(worker.id, { model: fixtureModel });
// Hold the manager idle; the probe must not turn one completion report into more work.
const makeRuntime = () => {
  const rt = new Runtime(store, root, 'codex', async (agent) => {
    assert.equal(
      agent.id,
      worker.id,
      'The fixture must not dispatch a manager or independent child',
    );
    const provider = new ProbeProvider(
      binary,
      join(root, 'p.sock'),
      cwd,
      false,
      false,
      classic ? 'classic' : 'v2',
    );
    await provider.start();
    return provider;
  });
  rt.externalControl.add(project.managerId);
  return rt;
};
let runtime = makeRuntime();
const run = async (instruction, decision) => {
  const receipt = store.enqueue(worker.id, randomUUID(), instruction);
  runtime.kick();
  const deadline = Date.now() + 120_000;
  const callsPath = join(root, 'mcp-calls.txt');
  const calls = () => (existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '');
  const before = calls();
  let approvals = 0;
  while (['queued', 'running'].includes(store.run(receipt.id).status) && Date.now() < deadline) {
    const approval = store.approvals().find((a) => a.status === 'pending');
    if (!approvals)
      assert.equal(calls(), before, 'Child MCP cannot execute before its original consent');
    if (approval) {
      assert(mcpCheck && decision, 'No other approval is permitted in this fixture');
      assert.equal(approval.kind, 'mcp');
      assert.equal(approval.params.serverName, 'dock_fixture');
      assert.notEqual(approval.agentId, worker.id);
      assert.equal(store.agent(approval.agentId).nativeRootId, worker.id);
      assert.equal(approvals++, 0, 'One child ping per turn');
      await runtime.approve(approval.id, decision);
      await runtime.approve(approval.id, decision);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(store.run(receipt.id).status, 'completed', 'The observed parent run must complete');
  assert.equal(store.approvals().filter((a) => a.status === 'pending').length, 0);
  if (mcpCheck) {
    assert.equal(approvals, 1);
    assert.equal(calls(), before + (decision === 'accept' ? 'ping\n' : ''));
  }
};
const checkCheckpoint = (agentId, marker, optional = false) => {
  const agent = store.agent(agentId);
  const calls = store
    .entries(agentId)
    .filter((e) => e.kind === 'tool' && e.title === 'dock_checkpoint');
  // Legacy children may retain their reply without invoking the optional host tool.
  // Never synthesize a checkpoint or count the parent's call as the child's evidence.
  if (optional) {
    assert(
      !agent.checkpoint || calls.some((e) => JSON.parse(e.text).input.summary === agent.checkpoint),
      'An optional saved checkpoint must still have a real child-owned tool call',
    );
    return;
  }
  assert(agent.checkpoint.includes(marker));
  assert(calls.some((e) => JSON.parse(e.text).input.summary.includes(marker)));
};
try {
  await runtime.initialize();
  if (fixtureModel) {
    const client = await runtime.client(store.agent(worker.id));
    const catalog = await client.request('model/list', {});
    const selected = catalog.data.find((m) => m.model === fixtureModel && !m.hidden);
    assert(selected, 'The fixture model must be available in the installed catalog');
    if (classic)
      assert.equal(
        selected.multiAgentVersion,
        'v1',
        'The classic capability test needs a model declared v1',
      );
    console.log({ fixtureModel, multiAgentVersion: selected.multiAgentVersion });
  }
  await run(
    'Spawn exactly one native subagent named probe_child' +
      (customAgent ? ' using agent_type fixture_reader' : '') +
      '. Give it this task: ' +
      (mcpCheck
        ? 'Call the dock_fixture MCP ping exactly once with empty arguments (use tool discovery if needed). It will be declined; do not retry. After that decline, '
        : '') +
      'save CHILD-READY with dock_checkpoint and reply CHILD-DONE. Do not call other tools or spawn children. Wait for it, then save PARENT-READY with your own dock_checkpoint and stop. Do nothing else.',
    mcpCheck ? 'decline' : undefined,
  );
  const children = store.agents().filter((a) => a.nativeRootId === worker.id);
  assert.equal(children.length, 1);
  const child = children[0],
    parentThread = store.agent(worker.id).threadId,
    childThread = child.threadId;
  if (customAgent) {
    const childMetadata = await runtime.clients
      .get(worker.id)
      .request('thread/read', { threadId: childThread, includeTurns: false });
    console.log({
      customAgentRole: childMetadata.thread.agentRole,
      sourceRole: childMetadata.thread.source?.subAgent?.thread_spawn?.agent_role,
    });
    assert.equal(
      childMetadata.thread.source?.subAgent?.thread_spawn?.agent_role,
      'fixture_reader',
      'The policy check must use the custom agent, not an ordinary fallback',
    );
  }
  checkCheckpoint(child.id, 'CHILD-READY', classic);
  checkCheckpoint(worker.id, 'PARENT-READY');
  assert(
    store.entries(child.id).some((e) => e.kind === 'assistant' && e.text.includes('CHILD-DONE')),
  );
  assert(
    store
      .entries(child.id)
      .some(
        (e) =>
          e.title === 'Native delegated input' ||
          e.text.includes('does not expose all delegated prompt text'),
      ),
  );
  assert(
    !store.entries(worker.id).some((e) => e.kind === 'tool' && e.text.includes('CHILD-READY')),
    'Child host tools cannot be attributed to the parent',
  );
  const archive = store.entries(child.id);
  await runtime.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  runtime = makeRuntime();
  await runtime.initialize();
  assert.deepEqual(store.entries(child.id), archive, 'Restart preserves the exact child archive');
  await run(
    `Follow up with the SAME existing native child ${childThread}. Do not spawn a replacement. ` +
      (classic
        ? 'First use native resume_agent for that exact saved child ID before send_input. If resume fails, report it and stop; do not retry or replace the child. '
        : '') +
      'Ask it to ' +
      (mcpCheck
        ? 'call dock_fixture MCP ping exactly once with empty arguments (use tool discovery if needed), then '
        : '') +
      'save CHILD-RESUMED with dock_checkpoint and reply CHILD-RESUMED-DONE. Wait for it, then save PARENT-RESUMED with your own dock_checkpoint and stop. Do nothing else.',
    mcpCheck ? 'accept' : undefined,
  );
  assert.equal(store.agents().filter((a) => a.nativeRootId === worker.id).length, 1);
  assert.equal(store.agent(child.id).threadId, childThread);
  assert.equal(store.agent(worker.id).threadId, parentThread);
  checkCheckpoint(child.id, 'CHILD-RESUMED', classic);
  checkCheckpoint(worker.id, 'PARENT-RESUMED');
  assert.deepEqual(store.entries(child.id).slice(0, archive.length), archive);
  assert(
    store
      .entries(child.id)
      .slice(archive.length)
      .some((e) => e.kind === 'assistant' && e.text.includes('CHILD-RESUMED-DONE')),
    'A completed parent turn or an unchanged old archive does not prove child delivery',
  );
  assert.equal(
    store.runs().filter((r) => r.agentId === child.id && r.status === 'completed').length,
    2,
  );
  assert.equal(
    store.runs().filter((r) => r.sourceId === child.id && r.kind === 'report').length,
    0,
  );
  assert.equal(
    store.runs().filter((r) => r.sourceId === worker.id && r.kind === 'report').length,
    2,
  );
  console.log(
    JSON.stringify({
      fixture,
      parentAgent: worker.id,
      childAgent: child.id,
      parentThread,
      childThread,
      childEntries: store.entries(child.id).length,
      mcpCheck,
      customAgent,
      classic,
      childCheckpointSaved: Boolean(store.agent(child.id).checkpoint),
      result:
        'Same child resumed and replied; child-owned tools and exact prior archive retained. Legacy child checkpoint is optional.',
    }),
  );
} finally {
  // Keep the fixture safe to reopen in a read-only browser check: no queued manager work.
  for (const run of store
    .runs()
    .filter((r) => r.agentId === project.managerId && r.status === 'queued'))
    store.updateRun(run.id, { status: 'cancelled' });
  store.updateAgent(project.managerId, { status: 'idle' });
  await runtime.close();
  store.close();
}
