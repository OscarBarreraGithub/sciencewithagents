import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/server/dist/store.js';
import { Runtime } from '../apps/server/dist/runtime.js';
import { git, integrationPreview } from '../apps/server/dist/workspaces.js';
import { usageSummary } from '../apps/server/dist/usage.js';

assert(
  process.argv.includes('--run'),
  'Pass --run for a bounded disposable real Claude/Codex team check using existing local sign-ins.',
);
process.umask(0o077);
mkdirSync(resolve('data/smoke'), { recursive: true, mode: 0o700 });
const root = mkdtempSync(resolve('data/smoke/mixed-'));
const projectRoot = join(root, 'project');
mkdirSync(projectRoot, { mode: 0o700 });
await git(projectRoot, ['init', '--template=', '--initial-branch=main']);
await git(projectRoot, ['config', 'user.name', 'Agent Dock Smoke']);
await git(projectRoot, ['config', 'user.email', 'smoke@example.invalid']);
writeFileSync(join(projectRoot, 'README.md'), '# Disposable mixed-provider fixture\n');
await git(projectRoot, ['add', 'README.md']);
await git(projectRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Create fixture']);
const database = join(root, 'dock.sqlite');
let store = new Store(database);
const project = store.register(
  projectRoot,
  'Mixed-provider fixture',
  'Only this disposable fixture is in scope.',
  'claude',
);
let runtime = new Runtime(store, root, process.env.DOCK_CODEX_BIN ?? 'codex');
const evidence = { root, checks: [], success: false };
console.log(`Owned mixed-provider fixture ${root}`);
try {
  const manager = store.agent(project.managerId);
  const claudeModels = await runtime.loadModels(manager);
  const codexModels = await runtime.loadModels(manager, 'codex');
  const claude = claudeModels.find(
    (model) => model.id === 'sonnet' && model.efforts.includes('medium'),
  );
  const codex = codexModels.find((model) => model.isDefault && model.efforts.includes('medium'));
  assert(
    claude && codex,
    'The installed providers must report the selected fixture models and effort.',
  );
  store.updateAgent(manager.id, { model: claude.id, effort: 'medium' });
  await runtime.initialize();
  const request = `This is one bounded mixed-provider test in a disposable repository. Create exactly ONE task to add result.txt containing exactly MIXED-PROVIDER-READY followed by a newline. Acceptance: result.txt has exactly that content; README.md is unchanged; no other file changes. No planner is needed. Delegate exactly one implementer using execution {provider:"codex",model:${JSON.stringify(codex.id)},effort:"medium",reason:"Owner-selected disposable integration check"}. Tell it to edit only result.txt and save a checkpoint; the host will commit automatically. When its completion arrives, delegate exactly one independent reviewer using execution {provider:"claude",model:${JSON.stringify(claude.id)},effort:"medium",reason:"Independent Claude review fixture"}. Reviewer must use dock_inspect with its taskId and changes:true to inspect the exact clean-checkpoint Git patch, with optional Read on result.txt and README.md inside its assigned task worktree. The native Read display adds line numbers: use the actual diff hunk/newline metadata, not displayed blank rows, to judge newline changes. Then dock_review approve if correct and dock_checkpoint. Do not use native helpers, external MCPs, network, credentials, shell commands, pushing or deployment. After successful review finishes, dock_decide complete, save your checkpoint, report MIXED-PROVIDER-READY and stop. Do not integrate or create follow-up work.`;
  store.enqueue(manager.id, randomUUID(), request);
  runtime.kick();
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await delay(250);
    for (const approval of store.approvals().filter((item) => item.status === 'pending')) {
      const agent = store.agent(approval.agentId);
      const file = approval.params.input?.file_path;
      // This probe's explicit consent is only for the two disposable review files
      // and listing that exact task folder to check that no other files changed.
      // Unexpected permissions stop the check; no blanket approval is installed.
      const safeRead =
        approval.params.toolName === 'Read' &&
        typeof file === 'string' &&
        [join(agent.cwd, 'result.txt'), join(agent.cwd, 'README.md')].includes(
          resolve(agent.cwd, file),
        );
      const safeListing =
        approval.params.toolName === 'Glob' &&
        approval.params.input?.path === agent.cwd &&
        ['*', '**/*'].includes(approval.params.input?.pattern);
      assert(
        agent.provider === 'claude' && agent.role === 'reviewer' && (safeRead || safeListing),
        'Unexpected permission; inspect retained fixture, do not auto-approve.',
      );
      await runtime.approve(approval.id, 'accept');
      evidence.checks.push(
        `Answered original ${approval.params.toolName} request limited to the disposable task`,
      );
    }
    const failed = store.agents().find((agent) => ['failed', 'interrupted'].includes(agent.status));
    assert(
      !failed,
      `A fixture agent needs attention: ${failed?.name}. Inspect the private archive.`,
    );
    if (
      store.tasks().some((task) => task.status === 'done') &&
      store.agent(manager.id).status === 'idle'
    )
      break;
  }
  const tasks = store.tasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'done', 'The bounded manager/review workflow did not finish.');
  const workers = store.agents().filter((agent) => agent.parentId === manager.id);
  assert.equal(workers.length, 2);
  assert(workers.some((agent) => agent.role === 'implementer' && agent.provider === 'codex'));
  assert(workers.some((agent) => agent.role === 'reviewer' && agent.provider === 'claude'));
  assert(workers.every((agent) => agent.cwd === tasks[0].worktree && agent.checkpoint));
  assert.equal(
    readFileSync(join(tasks[0].worktree, 'result.txt'), 'utf8'),
    'MIXED-PROVIDER-READY\n',
  );
  assert.equal(
    readFileSync(join(tasks[0].worktree, 'README.md'), 'utf8'),
    '# Disposable mixed-provider fixture\n',
  );
  assert.equal(await git(tasks[0].worktree, ['status', '--porcelain']), '');
  const preview = await integrationPreview(store, tasks[0].id);
  assert(preview);
  assert(
    store
      .entries(manager.id)
      .some((entry) => entry.kind === 'assistant' && entry.text.includes('MIXED-PROVIDER-READY')),
  );
  assert(
    usageSummary(store, project.id, manager.id).tokenSnapshots.some(
      (report) => report.provider === 'claude' && report.last.outputTokens !== null,
    ),
  );
  evidence.checks.push(
    'Real Claude manager delegated Codex implementation and independent Claude review',
    'Task workspace committed, reviewed, finished; original project untouched',
    'All three visible histories, checkpoints, usage and manager report retained',
  );
  const identities = store
    .agents()
    .map(({ id, threadId, provider }) => ({ id, threadId, provider }));
  const runsBefore = store.runs().map(({ id, status }) => ({ id, status }));
  await runtime.close();
  store.close();
  store = new Store(database);
  runtime = new Runtime(store, root, process.env.DOCK_CODEX_BIN ?? 'codex');
  await runtime.initialize();
  const restored = await runtime.restoreSessions(identities.map((agent) => agent.id));
  assert(restored.every((result) => result.state === 'connected'));
  assert.deepEqual(
    store.agents().map(({ id, threadId, provider }) => ({ id, threadId, provider })),
    identities,
  );
  assert.deepEqual(
    store.runs().map(({ id, status }) => ({ id, status })),
    runsBefore,
  );
  evidence.checks.push(
    'Restart retained exact provider identities and lazy Claude restoration started no new turn',
  );
  evidence.success = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Probe failed';
  throw error;
} finally {
  await runtime.close();
  store.close();
  writeFileSync(join(root, 'verification.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ root, success: evidence.success, checks: evidence.checks.length }));
}
