import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { groupContextSchema, type GroupContext } from '@dock/shared';
import { groupNativeGitRequestSchema } from '@dock/shared/dist/group-native-git.js';
import { GroupHostNativeGit } from './group-host-native-git.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { LocalAccess, prepareLocalAccess } from './local-access.js';
import { PhoneAccess } from './phone-access.js';
import { Terminals } from './terminal.js';
import { localRequestProof, type LocalRole } from '@dock/shared/dist/local-authorization.js';
import { Missing, Store } from './store.js';
import { modelFixture } from './model-policy.fixture.js';
import { git, ensureWorktree, checkpointWorktree, integrationPreview } from './workspaces.js';
import * as workspaces from './workspaces.js';

let root: string, cwd: string, origin: string, store: Store, db: DatabaseSync;
let adapter: GroupHostNativeGit, host: GroupHost, runtime: Runtime;
let context: GroupContext, binding: ReturnType<GroupHostNativeRuntime['resolveLocalContext']>;
let handle: string;
const requests = new Map<string, ReturnType<GroupHostNativeRuntime['context']>>();
const completions = new Set<string>();
beforeEach(async () => {
  mkdirSync('data/tests', { recursive: true });
  root = mkdtempSync(resolve('data/tests/native-group-git-'));
  cwd = join(root, 'shared');
  origin = join(root, 'remote.git');
  await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  await git(root, ['clone', origin, cwd]);
  await git(cwd, ['config', 'user.name', 'Fixture']);
  await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  db = new DatabaseSync(join(root, 'host.sqlite'));
  const project = store.register(cwd, 'Shared fixture', '');
  handle = randomUUID();
  context = groupContextSchema.parse({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    sessionId: randomUUID(),
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: 'fixture-shared',
  });
  binding = {
    anchor: context,
    context,
    enrollmentHandle: randomUUID(),
    projectId: project.id,
    agentId: project.managerId,
    provider: 'codex',
    executionMode: 'managed',
    cwd,
  };
  host = {
    db,
    directory: root,
    localVisible: () => true,
    localContributing: () => true,
    send: vi.fn(async () => ({ delivery: 'complete' })),
    authenticatedContext: async ({ handle: selected }: { handle: string }) => {
      if (selected !== handle) throw new Error('Unknown saved member');
      return { context, enrollmentHandle: binding.enrollmentHandle, revalidate: async () => {} };
    },
    nativeFeatureContext: async () => ({ handle, revalidate: async () => {} }),
  } as unknown as GroupHost;
  runtime = { store, dataDir: root, externalControl: new Set<string>() } as Runtime;
  requests.clear();
  completions.clear();
  const connector = {
    resolveLocalContext: () => binding,
    context: (id: string) => requests.get(id) ?? null,
    completionPending: () => false,
    inspect: async ({ requestId }: { requestId: string }) => ({
      requestId,
      state: completions.has(requestId) ? 'completed' : 'blocked',
      message: 'Exact fixture completion',
      result: { context: requests.get(requestId)?.context },
    }),
  } as unknown as GroupHostNativeRuntime;
  adapter = new GroupHostNativeGit(host, runtime, connector, true);
});
afterEach(async () => {
  await adapter?.close();
  if (db?.isOpen) db.close();
  if (store?.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const sync = () => adapter.request({ action: 'sync', handle, key: randomUUID() });
const status = () => adapter.request({ action: 'status', handle });
async function externalCheckpoint() {
  await seed();
  vi.spyOn(
    adapter as unknown as { privateAccess(cwd: string, origin: string): Promise<void> },
    'privateAccess',
  ).mockResolvedValue();
  await adapter.request({ action: 'connect', handle, key: randomUUID() });
  const { GroupsConversationJournal } = await import('./groups-conversation-journal.js');
  const journal = new GroupsConversationJournal(root),
    sessionId = randomUUID();
  journal.registerSession(sessionId);
  journal.select({ handle: binding.enrollmentHandle, sessionId, key: randomUUID() });
  journal.close();
  writeFileSync(join(cwd, 'external-result.txt'), 'A verified external result\n');
  await git(cwd, ['add', 'external-result.txt']);
  await git(cwd, ['commit', '-m', 'Ordinary Claude checkpoint']);
  const head = await git(cwd, ['rev-parse', 'HEAD']),
    key = randomUUID();
  await adapter.externalRequest({ action: 'propose', handle, key, head });
  const view = await adapter.externalRequest({ action: 'preview', handle, id: key });
  return { head, key, preview: view.preview!, sessionId };
}
it('publishes only an exact owner-reviewed ordinary Claude SHA with live dirty checkout, later commits and no app Work receipt', async () => {
  const { head, key, preview } = await externalCheckpoint();
  const before = await git(root, ['--git-dir', origin, 'rev-parse', 'main']);
  expect(before).not.toBe(head);
  expect(preview.patch).toContain('A verified external result');
  const approval = {
    action: 'approve',
    handle,
    id: key,
    key: randomUUID(),
    fingerprint: preview.fingerprint,
  };
  await expect(adapter.externalRequest(approval)).rejects.toThrow('Native agents cannot attest');
  writeFileSync(join(cwd, 'later-result.txt'), 'Later unreviewed result\n');
  await git(cwd, ['add', 'later-result.txt']);
  await git(cwd, ['commit', '-m', 'Later native work']);
  const laterHead = await git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(join(cwd, '.env'), 'PRIVATE_UNCOMMITTED=retained\n');
  writeFileSync(join(cwd, 'external-result.txt'), 'More local work, still uncommitted\n');
  expect((await status()).busyReason).toBe('external-claude');
  const result = await adapter.externalRequest(approval, true);
  expect(result.proposals[0].state).toBe('shared');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(head);
  expect(await git(root, ['--git-dir', origin, 'rev-parse', preview.branch])).toBe(head);
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(laterHead);
  expect(await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  expect(readFileSync(join(cwd, 'external-result.txt'), 'utf8')).toContain('More local work');
  expect(readFileSync(join(cwd, '.env'), 'utf8')).toContain('PRIVATE_UNCOMMITTED');
  expect(store.runs()).toEqual([]);
  expect(requests.size).toBe(0);
  expect(host.send).toHaveBeenCalledWith(
    expect.objectContaining({ key, text: expect.stringContaining(head) }),
  );
  const calls = vi.mocked(host.send).mock.calls.length;
  await adapter.externalRequest(approval, true);
  expect(vi.mocked(host.send).mock.calls.length).toBe(calls);
  await expect(
    adapter.externalRequest({ ...approval, fingerprint: '0'.repeat(64) }, true),
  ).rejects.toThrow('original exact');
});
it('retains deleted intermediate binary paths and one exact proposal after concurrent ordinary-Claude retries', async () => {
  await externalCheckpoint();
  writeFileSync(join(cwd, 'intermediate-figure.bin'), Buffer.from([0, 1, 2, 3]));
  await git(cwd, ['add', 'intermediate-figure.bin']);
  await git(cwd, [
    'commit',
    '-m',
    'Intermediate figure',
    '-m',
    'Exact middle commit body\n\nCo-Authored-By: Example Reviewer <reviewer@example.invalid>',
  ]);
  await git(cwd, ['rm', 'intermediate-figure.bin']);
  await git(cwd, ['commit', '-m', 'Remove earlier figure']);
  const input = {
    action: 'propose',
    handle,
    key: randomUUID(),
    head: await git(cwd, ['rev-parse', 'HEAD']),
  };
  await Promise.all([adapter.externalRequest(input), adapter.externalRequest(input)]);
  const view = await adapter.externalRequest({ action: 'preview', handle, id: input.key });
  expect(view.preview!.files).toContain('intermediate-figure.bin');
  expect(view.preview!.patch).toContain('Intermediate figure');
  expect(view.preview!.patch).toContain('Exact middle commit body');
  expect(view.preview!.patch).toContain(
    'Co-Authored-By: Example Reviewer <reviewer@example.invalid>',
  );
  expect(view.preview!.patch).toContain('Author:');
  expect(view.preview!.patch).toContain('Commit:');
  expect(view.preview!.patch).toContain('Remove earlier figure');
  expect(db.prepare('SELECT count(*) n FROM gex_proposals WHERE id=?').get(input.key)!.n).toBe(1);
  await adapter.externalRequest(
    { action: 'reject', handle, id: input.key, key: randomUUID() },
    true,
  );
  expect(host.send).not.toHaveBeenCalled();
});
it('refuses credentials in ordinary-Claude intermediate commit metadata even when absent from all file blobs', async () => {
  await externalCheckpoint();
  const before = await git(root, ['--git-dir', origin, 'rev-parse', 'main']);
  await git(cwd, [
    'commit',
    '--allow-empty',
    '-m',
    'Secret only in commit body',
    '-m',
    'sk-' + 'a'.repeat(40),
  ]);
  await git(cwd, ['commit', '--allow-empty', '-m', 'Later clean metadata']);
  await expect(
    adapter.externalRequest({
      action: 'propose',
      handle,
      key: randomUUID(),
      head: await git(cwd, ['rev-parse', 'HEAD']),
    }),
  ).rejects.toThrow('credential in commit metadata');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(before);
  expect(host.send).not.toHaveBeenCalled();
});
it('reviews raw commit authors despite an uncommitted mailmap and preserves native author mapping', async () => {
  const { head } = await externalCheckpoint();
  await git(cwd, ['config', 'log.mailmap', 'true']);
  writeFileSync(
    join(cwd, '.mailmap'),
    'Mapped Owner <mapped@example.invalid> Fixture <fixture@example.invalid>\n',
  );
  expect(await git(cwd, ['log', '-1', '--format=fuller', head])).toContain(
    'mapped@example.invalid',
  );
  const key = randomUUID();
  await adapter.externalRequest({ action: 'propose', handle, key, head });
  const view = await adapter.externalRequest({ action: 'preview', handle, id: key });
  expect(view.preview!.patch).toContain('Fixture <fixture@example.invalid>');
  expect(view.preview!.patch).not.toContain('mapped@example.invalid');
  expect(await git(cwd, ['log', '-1', '--format=fuller', head])).toContain(
    'mapped@example.invalid',
  );
});
it('refuses raw credential-like author metadata hidden by a working-folder mailmap', async () => {
  await externalCheckpoint();
  const secret = 'ghp_' + 'a'.repeat(36),
    email = `${secret}@example.invalid`;
  await git(cwd, ['config', 'user.email', email]);
  await git(cwd, ['commit', '--allow-empty', '-m', 'Hidden raw identity']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  await git(cwd, ['config', 'log.mailmap', 'true']);
  writeFileSync(
    join(cwd, '.mailmap'),
    `Mapped Owner <mapped@example.invalid> Fixture <${email}>\n`,
  );
  expect(await git(cwd, ['log', '-1', '--format=fuller', head])).not.toContain(secret);
  await expect(
    adapter.externalRequest({ action: 'propose', handle, key: randomUUID(), head }),
  ).rejects.toThrow('credential in commit metadata');
  expect(host.send).not.toHaveBeenCalled();
});
it('scans the transported commit tree despite a benign replacement commit', async () => {
  const { head: parent } = await externalCheckpoint();
  writeFileSync(join(cwd, 'private-result.txt'), 'ghp_' + 'b'.repeat(36));
  await git(cwd, ['add', 'private-result.txt']);
  await git(cwd, ['commit', '-m', 'Raw private checkpoint']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const replacement = await git(cwd, [
    'commit-tree',
    await git(cwd, ['rev-parse', `${parent}^{tree}`]),
    '-p',
    parent,
    '-m',
    'Virtual safe checkpoint',
  ]);
  await git(cwd, ['replace', head, replacement]);
  expect(await git(cwd, ['ls-tree', '-r', head])).not.toContain('private-result.txt');
  await expect(
    adapter.externalRequest({ action: 'propose', handle, key: randomUUID(), head }),
  ).rejects.toThrow('likely credential');
  expect(await git(cwd, ['replace', '-l'])).toContain(head);
  expect(host.send).not.toHaveBeenCalled();
});
it('scans the transported blob despite a same-size benign replacement blob', async () => {
  await externalCheckpoint();
  const secret = 'ghp_' + 'c'.repeat(36);
  writeFileSync(join(cwd, 'private-result.txt'), secret);
  await git(cwd, ['add', 'private-result.txt']);
  await git(cwd, ['commit', '-m', 'Raw private blob']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const blob = await git(cwd, ['rev-parse', `${head}:private-result.txt`]);
  writeFileSync(join(cwd, 'benign-blob.txt'), 'x'.repeat(secret.length));
  const replacement = await git(cwd, ['hash-object', '-w', 'benign-blob.txt']);
  await git(cwd, ['replace', blob, replacement]);
  expect(await git(cwd, ['cat-file', 'blob', blob])).toBe('x'.repeat(secret.length));
  await expect(
    adapter.externalRequest({ action: 'propose', handle, key: randomUUID(), head }),
  ).rejects.toThrow('likely credential');
  expect(await git(cwd, ['replace', '-l'])).toContain(blob);
  expect(host.send).not.toHaveBeenCalled();
});
it('refuses an older retained mailmapped proposal before approval or already-approved publication', async () => {
  const { head } = await externalCheckpoint();
  await git(cwd, ['config', 'log.mailmap', 'true']);
  writeFileSync(
    join(cwd, '.mailmap'),
    'Mapped Owner <mapped@example.invalid> Fixture <fixture@example.invalid>\n',
  );
  const realGit = workspaces.git;
  const oldDisplay = vi.spyOn(workspaces, 'git').mockImplementation((dir, args) =>
    realGit(
      dir,
      args.filter((arg) => arg !== '--no-mailmap'),
    ),
  );
  const key = randomUUID();
  await adapter.externalRequest({ action: 'propose', handle, key, head });
  const view = await adapter.externalRequest({ action: 'preview', handle, id: key });
  oldDisplay.mockRestore();
  expect(view.preview!.patch).toContain('mapped@example.invalid');
  const approval = {
    action: 'approve',
    handle,
    id: key,
    key: randomUUID(),
    fingerprint: view.preview!.fingerprint,
  };
  await expect(adapter.externalRequest(approval, true)).rejects.toThrow('raw committed history');
  // A previous release may already have recorded approval; its immutable receipt must remain,
  // but a background/retry publication must recheck the exact raw display before any push.
  db.prepare('INSERT INTO gex_decisions VALUES(?,?,?,?,?)').run(
    randomUUID(),
    key,
    '{}',
    'approved',
    'Legacy owner approval',
  );
  const retry = await adapter.externalRequest(
    { action: 'retry', handle, id: key, key: randomUUID() },
    true,
  );
  expect(retry.proposals.find((p) => p.id === key)).toMatchObject({
    state: 'approved',
    retryable: true,
  });
  expect(retry.proposals.find((p) => p.id === key)!.message).toContain('raw committed history');
  expect(await git(cwd, ['ls-remote', origin, `refs/heads/${view.preview!.branch}`])).toBe('');
  expect(host.send).not.toHaveBeenCalled();
});
it.each(['rewound', 'removed'])(
  'refuses a checkpoint when reviewed remote history was %s before publication',
  async (change) => {
    const { key, preview } = await externalCheckpoint();
    const original = preview.base;
    await adapter.externalRequest(
      { action: 'approve', handle, id: key, key: randomUUID(), fingerprint: preview.fingerprint },
      true,
    );
    writeFileSync(join(cwd, 'next-result.txt'), 'Next reviewed result\n');
    await git(cwd, ['add', 'next-result.txt']);
    await git(cwd, ['commit', '-m', 'Next checkpoint']);
    const nextKey = randomUUID(),
      head = await git(cwd, ['rev-parse', 'HEAD']);
    await adapter.externalRequest({ action: 'propose', handle, key: nextKey, head });
    const next = (await adapter.externalRequest({ action: 'preview', handle, id: nextKey }))
      .preview!;
    expect(next.base).toBe(preview.head);
    await git(root, [
      '--git-dir',
      origin,
      'update-ref',
      ...(change === 'removed' ? ['-d', 'refs/heads/main'] : ['refs/heads/main', original]),
    ]);
    const calls = vi.mocked(host.send).mock.calls.length;
    const result = await adapter.externalRequest(
      { action: 'approve', handle, id: nextKey, key: randomUUID(), fingerprint: next.fingerprint },
      true,
    );
    expect(result.proposals.find((p) => p.id === nextKey)).toMatchObject({
      state: 'approved',
      retryable: true,
    });
    expect(await git(cwd, ['ls-remote', origin, `refs/heads/${next.branch}`])).toBe('');
    expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(vi.mocked(host.send).mock.calls.length).toBe(calls);
  },
);
it('preserves divergent peer history and publishes the reviewed ordinary-Claude checkpoint on its own ref', async () => {
  const { head, key, preview } = await externalCheckpoint();
  const peer = await remoteAdvance('peer-checkpoint');
  const result = await adapter.externalRequest(
    { action: 'approve', handle, id: key, key: randomUUID(), fingerprint: preview.fingerprint },
    true,
  );
  expect(result.proposals[0].state).toBe('branch-shared');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(peer);
  expect(await git(root, ['--git-dir', origin, 'rev-parse', preview.branch])).toBe(head);
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
});
it('retains exact ordinary-Claude file approval and retries only its group announcement across restart after a lost reply', async () => {
  const { key, preview } = await externalCheckpoint();
  vi.mocked(host.send).mockRejectedValueOnce(new Error('Owned lost delivery acknowledgement'));
  const approval = {
    action: 'approve',
    handle,
    id: key,
    key: randomUUID(),
    fingerprint: preview.fingerprint,
  };
  const first = await adapter.externalRequest(approval, true);
  expect(first.proposals[0]).toMatchObject({ state: 'shared', retryable: true });
  const sent = vi.mocked(host.send).mock.calls[0][0];
  const connector = (adapter as unknown as { connector: GroupHostNativeRuntime }).connector;
  await adapter.close();
  db.close();
  db = new DatabaseSync(join(root, 'host.sqlite'));
  host = { ...host, db } as GroupHost;
  adapter = new GroupHostNativeGit(host, runtime, connector, true);
  expect((await adapter.externalRequest({ action: 'status', handle })).proposals[0]).toMatchObject({
    state: 'shared',
    retryable: true,
  });
  const retry = { action: 'retry', handle, id: key, key: randomUUID() };
  expect((await adapter.externalRequest(retry)).proposals[0]).toMatchObject({
    state: 'shared',
    retryable: false,
  });
  expect(vi.mocked(host.send).mock.calls[1][0]).toEqual(sent);
  const calls = vi.mocked(host.send).mock.calls.length;
  await adapter.externalRequest(retry);
  expect(vi.mocked(host.send).mock.calls.length).toBe(calls);
  expect(() => db.prepare('DELETE FROM gex_proposals').run()).toThrow('retained');
});
it('announces a confirmed ordinary-Claude checkpoint ref when the default rejects its push', async () => {
  const { head, key, preview } = await externalCheckpoint();
  const originalGit = workspaces.git;
  const refuse = vi.spyOn(workspaces, 'git').mockImplementation((dir, args) => {
    if (args.includes('push') && args.includes(`${head}:refs/heads/main`))
      return Promise.reject(new Error('Owned simulated remote default policy refusal'));
    return originalGit(dir, args);
  });
  const approval = {
    action: 'approve',
    handle,
    id: key,
    key: randomUUID(),
    fingerprint: preview.fingerprint,
  };
  const result = await adapter.externalRequest(approval, true);
  expect(result.proposals[0]).toMatchObject({ state: 'branch-shared', retryable: false });
  expect(result.proposals[0].message).toContain('default branch could not be updated');
  expect(await originalGit(root, ['--git-dir', origin, 'rev-parse', preview.branch])).toBe(head);
  expect(host.send).toHaveBeenCalledTimes(1);
  refuse.mockRestore();
});
it('recognizes a reviewed ordinary-Claude SHA already in later shared default history without overwriting the peer', async () => {
  const { head, key, preview } = await externalCheckpoint();
  await git(cwd, ['push', 'origin', `${head}:main`]);
  const laterPeer = await remoteAdvance('later-peer-after-reviewed-commit');
  const result = await adapter.externalRequest(
    { action: 'approve', handle, id: key, key: randomUUID(), fingerprint: preview.fingerprint },
    true,
  );
  expect(result.proposals[0]).toMatchObject({ state: 'shared', retryable: false });
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(laterPeer);
  expect(host.send).toHaveBeenCalledTimes(1);
});
it('keeps ordinary-Claude proposals unpublished after refusal, reselection or an unreviewed secret-bearing intermediate commit', async () => {
  const { key, preview } = await externalCheckpoint();
  const baseline = await git(root, ['--git-dir', origin, 'rev-parse', 'main']);
  const approval = {
    action: 'approve',
    handle,
    id: key,
    key: randomUUID(),
    fingerprint: '0'.repeat(64),
  };
  await expect(adapter.externalRequest(approval, true)).rejects.toThrow('display changed');
  await expect(
    adapter.externalRequest({ ...approval, fingerprint: preview.fingerprint }, true),
  ).rejects.toThrow('original exact');
  const { GroupsConversationJournal } = await import('./groups-conversation-journal.js');
  const journal = new GroupsConversationJournal(root),
    next = randomUUID();
  journal.registerSession(next);
  journal.select({ handle: binding.enrollmentHandle, sessionId: next, key: randomUUID() });
  journal.close();
  await expect(
    adapter.externalRequest(
      { ...approval, key: randomUUID(), fingerprint: preview.fingerprint },
      true,
    ),
  ).rejects.toThrow('conversation, folder or repository changed');
  writeFileSync(join(cwd, 'temporary.txt'), 'sk-' + 'a'.repeat(40));
  await git(cwd, ['add', 'temporary.txt']);
  await git(cwd, ['commit', '-m', 'Temporary private credential']);
  await git(cwd, ['rm', 'temporary.txt']);
  await git(cwd, ['commit', '-m', 'Remove private credential']);
  await expect(
    adapter.externalRequest({
      action: 'propose',
      handle,
      key: randomUUID(),
      head: await git(cwd, ['rev-parse', 'HEAD']),
    }),
  ).rejects.toThrow('likely credential');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(baseline);
  expect(host.send).not.toHaveBeenCalled();
});
it('holds external Claude checkouts after Stop until exact owner closure, then applies clean fetched changes', async () => {
  await seed();
  const { GroupsConversationJournal } = await import('./groups-conversation-journal.js');
  const journal = new GroupsConversationJournal(runtime.dataDir);
  try {
    const sessionId = randomUUID();
    journal.registerSession(sessionId);
    journal.select({ handle: binding.enrollmentHandle, sessionId, key: randomUUID() });
    expect(await status()).toMatchObject({ busy: true, busyReason: 'external-claude' });
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    const remote = await remoteAdvance('external-shared-result');
    expect((await sync()).message).toContain('External Claude may still be using');
    expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
    journal.stop({ handle: binding.enrollmentHandle, key: randomUUID() });
    expect((await status()).busy).toBe(true);
    const generation = journal.selection(binding.enrollmentHandle)!.generation;
    const confirmation = {
      action: 'confirm-external-closed',
      handle,
      key: randomUUID(),
      generation,
    };
    await expect(adapter.request(confirmation)).rejects.toThrow('Native agents cannot confirm');
    await expect(
      adapter.request({ ...confirmation, generation: generation - 1 }, true),
    ).rejects.toThrow('current conversation');
    expect((await adapter.request(confirmation, true)).busy).toBe(false);
    expect((await adapter.request(confirmation, true)).busy).toBe(false);
    await sync();
    expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(remote);
    journal.select({ handle: binding.enrollmentHandle, sessionId, key: randomUUID() });
    expect((await status()).busy).toBe(true);
    await adapter.request(confirmation, true);
    expect((await status()).busy).toBe(true);
    expect(() => journal.db.prepare('DELETE FROM gc_closures').run()).toThrow('retained');
  } finally {
    journal.close();
  }
});
async function nativeCheckpoint() {
  const base = await seed();
  const project = store.register(cwd, 'Native Group fixture', '', 'codex', randomUUID(), 'direct');
  binding = {
    ...binding,
    projectId: project.id,
    agentId: project.managerId,
    executionMode: 'direct',
  };
  const requestId = await work();
  writeFileSync(join(cwd, 'native-result.txt'), 'Confirmed Group Work result\n');
  await git(cwd, ['add', 'native-result.txt']);
  await git(cwd, ['commit', '-m', 'Native Group checkpoint']);
  const run = store.enqueue(binding.agentId!, requestId, 'Exact native Group Work');
  requests.set(requestId, { ...binding, runId: run.id, intent: 'work' });
  store.updateRun(run.id, { status: 'completed' });
  store.updateAgent(binding.agentId!, { status: 'idle' });
  completions.add(requestId);
  (adapter as unknown as { starting: Map<string, unknown> }).starting.clear();
  return { base, requestId, head: await git(cwd, ['rev-parse', 'HEAD']) };
}
it('shares native committed Group work only after exact owner preview approval, retains retry and makes no model run', async () => {
  const checkpoint = await nativeCheckpoint();
  const runs = store.runs().length;
  expect((await sync()).message).toContain('ready for review');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.base);
  const first = await adapter.request({ action: 'preview-native', handle });
  expect(first.nativeReviewAvailable).toBe(true);
  expect(first.nativePreview).toMatchObject({
    requestId: checkpoint.requestId,
    base: checkpoint.base,
    head: checkpoint.head,
    files: ['native-result.txt'],
  });
  expect(first.nativePreview!.patch).toContain('+Confirmed Group Work result');
  expect((await adapter.request({ action: 'preview-native', handle })).nativePreview).toEqual(
    first.nativePreview,
  );
  const approval = {
    action: 'approve-native' as const,
    handle,
    key: randomUUID(),
    previewId: first.nativePreview!.id,
    fingerprint: first.nativePreview!.fingerprint,
  };
  await expect(adapter.request(approval)).rejects.toThrow('authenticated app');
  expect(groupNativeGitRequestSchema.safeParse({ ...approval, humanReview: true }).success).toBe(
    false,
  );
  const accepted = await adapter.request(approval, true);
  expect(await adapter.request(approval, true)).toEqual(accepted);
  await expect(adapter.request({ ...approval, fingerprint: '0'.repeat(64) }, true)).rejects.toThrow(
    'exact saved Git operation',
  );
  expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(1);
  expect(() => db.prepare('UPDATE gng_native_reviews SET body=?').run('{}')).toThrow(
    'retained owner review',
  );
  expect((await sync()).message).toContain('work shared');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.head);
  expect(store.runs().length).toBe(runs);
  expect(store.tasks()).toEqual([]);
});
it('refuses an older retained native Work author display and offers a fresh raw preview', async () => {
  await nativeCheckpoint();
  await git(cwd, ['config', 'log.mailmap', 'true']);
  writeFileSync(
    join(cwd, '.mailmap'),
    'Mapped Owner <mapped@example.invalid> Fixture <fixture@example.invalid>\n',
  );
  await git(cwd, ['add', '.mailmap']);
  await git(cwd, ['commit', '-m', 'Native author mapping']);
  const realGit = workspaces.git;
  const oldDisplay = vi.spyOn(workspaces, 'git').mockImplementation((dir, args) =>
    realGit(
      dir,
      args.filter((arg) => arg !== '--no-mailmap'),
    ),
  );
  const old = (await adapter.request({ action: 'preview-native', handle })).nativePreview!;
  oldDisplay.mockRestore();
  expect(old.patch).toContain('Author:     Mapped Owner <mapped@example.invalid>');
  await expect(
    adapter.request(
      {
        action: 'approve-native',
        handle,
        key: randomUUID(),
        previewId: old.id,
        fingerprint: old.fingerprint,
      },
      true,
    ),
  ).rejects.toThrow('raw committed history');
  expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(0);
  const fresh = (await adapter.request({ action: 'preview-native', handle })).nativePreview!;
  expect(fresh.fingerprint).not.toBe(old.fingerprint);
  expect(fresh.patch).toContain('Author:     Fixture <fixture@example.invalid>');
  expect(await git(cwd, ['log', '-1', '--format=fuller'])).toContain('mapped@example.invalid');
});
it('withholds a previously approved native Work mailmapped display during automatic sync', async () => {
  const checkpoint = await nativeCheckpoint();
  await git(cwd, ['config', 'log.mailmap', 'true']);
  writeFileSync(
    join(cwd, '.mailmap'),
    'Mapped Owner <mapped@example.invalid> Fixture <fixture@example.invalid>\n',
  );
  await git(cwd, ['add', '.mailmap']);
  await git(cwd, ['commit', '-m', 'Native author mapping']);
  const realGit = workspaces.git;
  const oldDisplay = vi.spyOn(workspaces, 'git').mockImplementation((dir, args) =>
    realGit(
      dir,
      args.filter((arg) => arg !== '--no-mailmap'),
    ),
  );
  const old = (await adapter.request({ action: 'preview-native', handle })).nativePreview!;
  await adapter.request(
    {
      action: 'approve-native',
      handle,
      key: randomUUID(),
      previewId: old.id,
      fingerprint: old.fingerprint,
    },
    true,
  );
  oldDisplay.mockRestore();
  expect((await sync()).message).toContain('ready for review');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.base);
  expect(await git(cwd, ['ls-remote', origin, `refs/heads/${old.branch}`])).toBe('');
  expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(1);
});
it('includes changes introduced only by a merge commit in the exact native owner preview', async () => {
  await nativeCheckpoint();
  const workBranch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  await git(cwd, ['switch', '-c', 'fixture-side']);
  writeFileSync(join(cwd, 'side-result.txt'), 'Side branch result\n');
  await git(cwd, ['add', 'side-result.txt']);
  await git(cwd, ['commit', '-m', 'Side result']);
  await git(cwd, ['switch', workBranch]);
  writeFileSync(join(cwd, 'main-result.txt'), 'Work branch result\n');
  await git(cwd, ['add', 'main-result.txt']);
  await git(cwd, ['commit', '-m', 'Work result']);
  await git(cwd, ['merge', '--no-commit', 'fixture-side']);
  writeFileSync(join(cwd, 'merge-result.txt'), 'Owner must see this merge-only result\n');
  await git(cwd, ['add', 'merge-result.txt']);
  await git(cwd, ['commit', '-m', 'Resolve exact native merge']);
  const { nativePreview: preview } = await adapter.request({ action: 'preview-native', handle });
  expect(preview!.patch).toContain('Owner must see this merge-only result');
  expect(preview!.files).toContain('merge-result.txt');
});
it.each(['new-first', 'shared-first'] as const)(
  'shows a native merge reverting files to an already shared parent (%s) in the owner preview',
  async (order) => {
    const { base, head } = await nativeCheckpoint();
    const parents = order === 'new-first' ? [head, base] : [base, head];
    const merge = await git(cwd, [
      'commit-tree',
      `${base}^{tree}`,
      '-p',
      parents[0]!,
      '-p',
      parents[1]!,
      '-m',
      'Return to an earlier shared tree',
    ]);
    await git(cwd, ['read-tree', '-u', '-m', head, merge]);
    await git(cwd, ['update-ref', 'HEAD', merge, head]);
    const { nativePreview: preview } = await adapter.request({ action: 'preview-native', handle });
    expect(preview!.patch).toContain('-Confirmed Group Work result');
    expect(preview!.patch).toContain('deleted file mode');
  },
);
it('refuses oversized native text previews with a readable status while preserving the checkpoint', async () => {
  await nativeCheckpoint();
  writeFileSync(
    join(cwd, 'large-review.txt'),
    'An ordinary bounded scientific result line.\n'.repeat(110000),
  );
  await git(cwd, ['add', 'large-review.txt']);
  await git(cwd, ['commit', '-m', 'Large exact review']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  await expect(adapter.request({ action: 'preview-native', handle })).rejects.toThrow(
    'too large for the exact review screen',
  );
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
  expect(Number(db.prepare('SELECT count(*) n FROM gng_native_previews').get()!.n)).toBe(0);
});
it('keeps shared file status readable when an old bound agent is unavailable', async () => {
  await nativeCheckpoint();
  const original = store.agent.bind(store);
  vi.spyOn(store, 'agent').mockImplementation((id) => {
    if (id === binding.agentId) throw new Missing('Saved agent unavailable');
    return original(id);
  });
  expect((await status()).nativeReviewAvailable).toBe(false);
});
it.each([
  'head',
  'dirty',
  'native-session',
  'completion',
  'membership',
  'origin',
  'workspace',
  'fingerprint',
] as const)(
  'refuses stale native owner approval after %s changes, preserving files and unpublished history',
  async (change) => {
    const checkpoint = await nativeCheckpoint();
    const { nativePreview: p } = await adapter.request({ action: 'preview-native', handle });
    if (change === 'head') {
      writeFileSync(join(cwd, 'later.txt'), 'Later unreviewed work\n');
      await git(cwd, ['add', 'later.txt']);
      await git(cwd, ['commit', '-m', 'Later checkpoint']);
    }
    if (change === 'dirty') writeFileSync(join(cwd, 'unfinished.txt'), 'Unfinished owner work');
    if (change === 'native-session') {
      const request = requests.get(checkpoint.requestId)!;
      requests.set(checkpoint.requestId, {
        ...request,
        context: { ...request.context, nativeSessionId: 'different-native-session' },
      });
    }
    if (change === 'completion') completions.delete(checkpoint.requestId);
    if (change === 'membership')
      vi.spyOn(host, 'authenticatedContext').mockRejectedValue(new Error('Member revoked'));
    if (change === 'origin')
      await git(cwd, ['remote', 'set-url', 'origin', join(root, 'unexpected.git')]);
    if (change === 'workspace') binding = { ...binding, workspaceChoiceKey: randomUUID() };
    const headBefore = await git(cwd, ['rev-parse', 'HEAD']);
    await expect(
      adapter.request(
        {
          action: 'approve-native',
          handle,
          key: randomUUID(),
          previewId: p!.id,
          fingerprint: change === 'fingerprint' ? '0'.repeat(64) : p!.fingerprint,
        },
        true,
      ),
    ).rejects.toThrow();
    expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(0);
    expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.base);
  },
);
it('rechecks native origin before publishing an approved checkpoint and blocks private intermediate commits', async () => {
  const checkpoint = await nativeCheckpoint();
  const { nativePreview: p } = await adapter.request({ action: 'preview-native', handle });
  await adapter.request(
    {
      action: 'approve-native',
      handle,
      key: randomUUID(),
      previewId: p!.id,
      fingerprint: p!.fingerprint,
    },
    true,
  );
  await git(cwd, ['remote', 'set-url', 'origin', join(root, 'unexpected.git')]);
  await expect(sync()).rejects.toThrow();
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.base);
  await git(cwd, ['remote', 'set-url', 'origin', origin]);
  writeFileSync(join(cwd, '.env'), 'PRIVATE_TEST_MARKER=never-share\n');
  await git(cwd, ['add', '.env']);
  await git(cwd, ['commit', '-m', 'Private intermediate checkpoint']);
  await git(cwd, ['rm', '.env']);
  await git(cwd, ['commit', '-m', 'Remove private file']);
  await expect(adapter.request({ action: 'preview-native', handle })).rejects.toThrow('private');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.base);
});
it('accepts actual browser and paired-device review while denying native owner/host/bridge credentials, wrong origins and revoked phones', async () => {
  await nativeCheckpoint();
  const { nativePreview: p } = await adapter.request({ action: 'preview-native', handle });
  const url = '/api/groups/native-git';
  const input = () => ({
    action: 'approve-native',
    handle,
    key: randomUUID(),
    previewId: p!.id,
    fingerprint: p!.fingerprint,
  });
  const launches = vi.fn(async () => {
    throw new Error('No real providers allowed');
  });
  const ownedRuntime = new Runtime(store, root, 'unavailable-provider', launches);
  const access = new LocalAccess(prepareLocalAccess(root, 4999));
  const app = await createServer(store, ownedRuntime, {
    port: 4999,
    localAccess: access,
    groupHost: host,
    ownsRuntime: false,
  });
  const cli = (role: LocalRole, selectedPath = url) => {
    const challenge = randomBytes(32).toString('hex'),
      proof = access.proof({ role, challenge });
    return {
      host: '127.0.0.1:4999',
      origin: 'http://127.0.0.1:4999',
      authorization: `Dock ${role}.${proof.nonce}.${localRequestProof(access.configuration[role], 'http://127.0.0.1:4999', role, challenge, proof.nonce, 'POST', selectedPath)}`,
    };
  };
  let remote: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    for (const role of ['owner', 'host', 'bridge'] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: cli(role),
        payload: input(),
      });
      expect(response.statusCode, response.body).toBe(role === 'bridge' ? 401 : 409);
    }
    expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(0);
    const cookie = access.consumeHandoff(access.issueHandoff().ticket).split(';')[0];
    const headers = {
      host: new URL(access.browserOrigin).host,
      origin: access.browserOrigin,
      cookie,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, origin: 'https://foreign.example.test' },
          payload: input(),
        })
      ).statusCode,
    ).toBe(403);
    const accepted = await app.inject({ method: 'POST', url, headers, payload: input() });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(1);
    const phone = new PhoneAccess(store, {
      origin: 'https://swa.example.test',
      authentication: 'access',
      issuer: 'https://owner.cloudflareaccess.com',
      audience: 'a'.repeat(64),
      owner: 'owner@example.test',
      port: 4998,
    });
    phone.setEnabled(true);
    const identity = {
      email: 'owner@example.test',
      subject: 'fixture-phone',
      expiresAt: Date.now() + 60_000,
    };
    vi.spyOn(phone, 'identity').mockResolvedValue(identity);
    const paired = phone.pair(identity, {
      code: phone.issueCode(randomUUID()).code,
      name: 'Owned test phone',
    });
    remote = await createServer(store, ownedRuntime, {
      port: 4998,
      phone,
      terminals: new Terminals(ownedRuntime),
      groupHost: host,
      remote: true,
      ownsRuntime: false,
    });
    const pairedHeaders = {
      host: 'swa.example.test',
      origin: 'https://swa.example.test',
      cookie: paired.cookie.split(';')[0],
      'cf-access-jwt-assertion': 'fixture-only',
    };
    const pairedReview = await remote.inject({
      method: 'POST',
      url,
      headers: pairedHeaders,
      payload: input(),
    });
    expect(pairedReview.statusCode, pairedReview.body).toBe(200);
    phone.revoke(phone.status(false).devices[0]!.id);
    expect(
      (await remote.inject({ method: 'POST', url, headers: pairedHeaders, payload: input() }))
        .statusCode,
    ).toBe(401);
    expect(Number(db.prepare('SELECT count(*) n FROM gng_native_reviews').get()!.n)).toBe(1);
    expect(launches).not.toHaveBeenCalled();
    const { GroupsConversationJournal } = await import('./groups-conversation-journal.js');
    const journal = new GroupsConversationJournal(root);
    try {
      const sessionId = randomUUID();
      journal.registerSession(sessionId);
      journal.select({ handle: binding.enrollmentHandle, sessionId, key: randomUUID() });
      const stopped = journal.stop({ handle: binding.enrollmentHandle, key: randomUUID() });
      const closure = {
        action: 'confirm-external-closed',
        handle,
        key: randomUUID(),
        generation: 'generation' in stopped ? stopped.generation : 0,
      };
      for (const role of ['owner', 'host'] as const) {
        const refused = await app.inject({
          method: 'POST',
          url,
          headers: cli(role),
          payload: closure,
        });
        expect(refused.statusCode).toBe(409);
        expect(refused.body).toContain('Native agents cannot confirm');
      }
      expect(journal.closurePending(binding.enrollmentHandle)).toBe(true);
      const confirmed = await app.inject({ method: 'POST', url, headers, payload: closure });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(journal.closurePending(binding.enrollmentHandle)).toBe(false);
    } finally {
      journal.close();
    }
    const { key: fileId, preview: filePreview } = await externalCheckpoint();
    const fileInput = {
      action: 'approve',
      handle,
      id: fileId,
      key: randomUUID(),
      fingerprint: filePreview.fingerprint,
    };
    for (const role of ['owner', 'host'] as const) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/groups/files',
        headers: cli(role, '/api/groups/files'),
        payload: fileInput,
      });
      expect(denied.statusCode, denied.body).toBe(409);
      expect(denied.body).toContain('Native agents cannot attest');
    }
    const fileAccepted = await app.inject({
      method: 'POST',
      url: '/api/groups/files',
      headers,
      payload: fileInput,
    });
    expect(fileAccepted.statusCode, fileAccepted.body).toBe(200);
    expect(fileAccepted.json().proposals[0].state).toBe('shared');
  } finally {
    await remote?.close();
    await app.close();
    await ownedRuntime.close();
  }
});
it('settles known refused reviews and recovers a lost approved reply without reauthorizing a later head', async () => {
  const checkpoint = await nativeCheckpoint();
  const { nativePreview: p } = await adapter.request({ action: 'preview-native', handle });
  const refused = {
    action: 'approve-native',
    handle,
    key: randomUUID(),
    previewId: p!.id,
    fingerprint: '0'.repeat(64),
  };
  await expect(adapter.request(refused, true)).rejects.toThrow('identity changed');
  expect(
    db.prepare('SELECT result FROM gng_operations WHERE key=?').get(refused.key)!.result,
  ).not.toBeNull();
  await expect(adapter.request(refused, true)).rejects.toThrow('identity changed');
  const accepted = {
    action: 'approve-native',
    handle,
    key: randomUUID(),
    previewId: p!.id,
    fingerprint: p!.fingerprint,
  };
  const view = vi.spyOn(
    adapter as unknown as { view: (...args: unknown[]) => Promise<unknown> },
    'view',
  );
  view.mockRejectedValueOnce(new Error('Lost HTTP response after review was recorded'));
  await expect(adapter.request(accepted, true)).rejects.toThrow('Lost HTTP');
  writeFileSync(join(cwd, 'later.txt'), 'Later unreviewed native result\n');
  await git(cwd, ['add', 'later.txt']);
  await git(cwd, ['commit', '-m', 'Later unreviewed native checkpoint']);
  expect((await adapter.request(accepted, true)).message).toContain('review was recorded');
  expect((await sync()).message).toContain('ready for review');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).toBe(checkpoint.base);
  const saved = String(
    db.prepare('SELECT body FROM gng_native_previews WHERE id=?').get(p!.id)!.body,
  );
  expect(saved).not.toContain('Confirmed Group Work result');
  expect(saved).not.toContain('patch');
});
async function chosenAdapter(verify = vi.fn(async () => {})) {
  await adapter.close();
  binding = { ...binding, workspaceChoiceKey: randomUUID() };
  const connector = {
    workspaceScope: () => binding,
    context: (id: string) => requests.get(id) ?? null,
    completionPending: () => false,
    inspect: async ({ requestId }: { requestId: string }) => ({
      requestId,
      state: completions.has(requestId) ? 'completed' : 'blocked',
      message: 'Exact fixture completion',
      result: { context: requests.get(requestId)?.context },
    }),
  } as unknown as GroupHostNativeRuntime;
  adapter = new GroupHostNativeGit(host, runtime, connector, true, verify);
  return verify;
}
it('turns sync on only after a new verified connection, retains explicit Off and fences exact retries to their original folder', async () => {
  await seed();
  const verify = await chosenAdapter();
  expect(await status()).toMatchObject({ autoSync: false, connected: false });
  const connect = { action: 'connect' as const, handle, key: randomUUID() };
  const first = await adapter.request(connect);
  expect(first).toMatchObject({ autoSync: true, connected: true });
  expect(await adapter.request(connect)).toEqual(first);
  expect(verify).toHaveBeenCalledTimes(1);
  const retained = Number(db.prepare('SELECT count(*) n FROM gng_operations').get()!.n);
  const automatic = adapter as unknown as { pass(): Promise<void>; last: Map<string, number> };
  for (let poll = 0; poll < 5; poll++) {
    automatic.last.clear();
    await automatic.pass();
  }
  expect(Number(db.prepare('SELECT count(*) n FROM gng_operations').get()!.n)).toBe(retained);
  expect(store.runs()).toEqual([]);
  await adapter.request({
    action: 'configure',
    handle,
    key: randomUUID(),
    githubUsername: '',
    autoSync: false,
  });
  await adapter.request({ ...connect, key: randomUUID() });
  expect(await status()).toMatchObject({ autoSync: false, connected: true });
  const oldChoice = binding.workspaceChoiceKey;
  binding = { ...binding, workspaceChoiceKey: randomUUID() };
  expect(await status()).toMatchObject({ autoSync: false, connected: false });
  expect(await adapter.request(connect)).toEqual(first);
  expect(
    db
      .prepare('SELECT count(*) n FROM gng_connections WHERE scope_key=?')
      .get(binding.workspaceChoiceKey!)!.n,
  ).toBe(0);
  const pending = { ...connect, key: randomUUID() };
  db.prepare('INSERT INTO gng_operations VALUES(?,?,NULL)').run(
    pending.key,
    JSON.stringify({ ...pending, workspaceChoiceKey: oldChoice }),
  );
  await expect(adapter.request(pending)).rejects.toThrow('original shared folder');
  expect(verify).toHaveBeenCalledTimes(2);
  await adapter.request({ ...connect, key: randomUUID() });
  expect(await status()).toMatchObject({ autoSync: false, connected: true });
});

it('verifies only the intended private GitHub repo through bounded native metadata and exposes no command or credential output', async () => {
  const bin = join(root, 'fixture-bin');
  mkdirSync(bin);
  const metadata = join(root, 'metadata.json');
  const argumentsFile = join(root, 'arguments.json');
  const script = join(bin, 'gh');
  writeFileSync(
    script,
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(fs.readFileSync(${JSON.stringify(metadata)}, 'utf8'));\n`,
  );
  chmodSync(script, 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const verify = (
    adapter as unknown as { privateAccess(cwd: string, origin: string): Promise<void> }
  ).privateAccess.bind(adapter);
  const origin = 'git@github.com:fixture-owner/research.git';
  writeFileSync(
    metadata,
    JSON.stringify({
      nameWithOwner: 'fixture-owner/research',
      isPrivate: true,
      viewerPermission: 'WRITE',
    }),
  );
  await verify(cwd, origin);
  expect(JSON.parse(readFileSync(argumentsFile, 'utf8'))).toEqual([
    'repo',
    'view',
    'https://github.com/fixture-owner/research',
    '--json',
    'nameWithOwner,isPrivate,viewerPermission',
  ]);
  for (const invalid of [
    { nameWithOwner: 'fixture-owner/research', isPrivate: false, viewerPermission: 'WRITE' },
    { nameWithOwner: 'other/research', isPrivate: true, viewerPermission: 'WRITE' },
    { nameWithOwner: 'fixture-owner/research', isPrivate: true, viewerPermission: 'UNKNOWN' },
  ]) {
    writeFileSync(metadata, JSON.stringify(invalid));
    await expect(verify(cwd, origin)).rejects.toThrow('Verify native GitHub sign-in');
  }
  writeFileSync(metadata, 'PRIVATE_FIXTURE_DO_NOT_RETURN'.repeat(1000));
  await expect(verify(cwd, origin)).rejects.toThrow('Verify native GitHub sign-in');
  await expect(verify(cwd, 'https://arbitrary.invalid/repository')).rejects.toThrow(
    'intended private GitHub',
  );
});
it('local removal pauses the automatic Git pass before polling the group or remote', async () => {
  await seed();
  await adapter.request({
    action: 'configure',
    handle,
    key: randomUUID(),
    githubUsername: '',
    autoSync: true,
  });
  vi.spyOn(host, 'localVisible').mockReturnValue(false);
  const resolve = vi.spyOn(host, 'authenticatedContext');
  await (adapter as unknown as { pass(): Promise<void> }).pass();
  expect(resolve).not.toHaveBeenCalled();
  expect((await status()).autoSync).toBe(true); // Saved choice stays intact for restore.
});
it('owner status shows unfinished group/task edits without returning contents or sharing private names', async () => {
  await seed();
  writeFileSync(join(cwd, 'unfinished.txt'), 'local draft');
  writeFileSync(join(cwd, '.env'), 'PRIVATE_FIXTURE');
  const task = store.addTask(binding.projectId, {
    title: 'Pending task',
    goal: 'Work',
    acceptance: 'Review',
    parentId: null,
  });
  const taskPath = await ensureWorktree(store, task, root);
  writeFileSync(join(taskPath, 'worker.txt'), 'worker draft');
  const view = await status();
  expect(view.localEdits).toMatchObject([
    {
      taskId: null,
      state: 'changed',
      changed: 2,
      withheld: 1,
      files: [{ path: 'unfinished.txt', status: '??' }],
    },
    { taskId: task.id, state: 'changed', files: [{ path: 'worker.txt', status: '??' }] },
  ]);
  expect(JSON.stringify(view.localEdits)).not.toContain('PRIVATE_FIXTURE');
  expect(JSON.stringify(view.localEdits)).not.toContain('.env');
  expect(await git(cwd, ['ls-files', '--', 'unfinished.txt'])).toBe('');
  expect(readFileSync(join(taskPath, 'worker.txt'), 'utf8')).toBe('worker draft');
});
it('shows external project dataset names in root and task status while withholding credentials and databases', async () => {
  const appData = join(root, 'private-app-data');
  mkdirSync(appData);
  (runtime as unknown as { dataDir: string }).dataDir = appData;
  await seed();
  await chosenAdapter();
  mkdirSync(join(cwd, 'data'));
  writeFileSync(join(cwd, 'data/measurements.csv'), 'initial measurement\n');
  await git(cwd, ['add', 'data/measurements.csv']);
  await git(cwd, ['commit', '-m', 'Track scientific dataset']);
  const task = store.addTask(binding.projectId, {
    title: 'Dataset analysis',
    goal: 'Analyze measurements',
    acceptance: 'Reviewed outcome',
    parentId: null,
  });
  const taskPath = await ensureWorktree(store, task, appData);
  for (const workspace of [cwd, taskPath]) {
    writeFileSync(join(workspace, 'data/measurements.csv'), 'PRIVATE_DATASET_CONTENT_FIXTURE\n');
    writeFileSync(join(workspace, '.env'), 'PRIVATE_CREDENTIAL_CONTENT_FIXTURE');
    writeFileSync(join(workspace, 'conversation.sqlite'), 'PRIVATE_DATABASE_CONTENT_FIXTURE');
  }
  const view = await status();
  for (const taskId of [null, task.id]) {
    const row = view.localEdits.find((item) => item.taskId === taskId)!;
    expect(row).toMatchObject({
      state: 'changed',
      changed: 3,
      withheld: 2,
      files: [{ path: 'data/measurements.csv', status: ' M' }],
    });
  }
  const body = JSON.stringify(view.localEdits);
  expect(body).not.toContain('PRIVATE_');
  expect(body).not.toContain('.env');
  expect(body).not.toContain('conversation.sqlite');
  // Reclassifying this checkout as app-owned storage restores the strict data policy.
  (runtime as unknown as { dataDir: string }).dataDir = root;
  const legacy = await status();
  for (const row of legacy.localEdits)
    expect(row).toMatchObject({ changed: 3, withheld: 3, files: [] });
});

async function seed() {
  await git(cwd, ['commit', '--allow-empty', '-m', 'Canonical shared baseline']);
  await git(cwd, ['push', 'origin', 'HEAD:refs/heads/main']);
  await sync();
  return git(cwd, ['rev-parse', 'HEAD']);
}
async function work(intent: 'ask' | 'work' = 'work') {
  const id = randomUUID();
  requests.set(id, { ...binding, runId: null, intent });
  await adapter.beforeWork(context, id);
  // The native connector immediately queues a run after the preparation hook.
  requests.set(id, { ...binding, runId: randomUUID(), intent });
  return id;
}
async function reviewed(name = 'drawing') {
  const task = store.addTask(binding.projectId, {
    title: name,
    goal: `Add ${name}`,
    acceptance: 'One shared file',
    parentId: null,
  });
  const path = await ensureWorktree(store, task, root);
  writeFileSync(join(path, `${name}.txt`), `${name} shared outcome\n`);
  const source = await checkpointWorktree(store, task.id);
  const reviewer = store.addAgent({
    projectId: binding.projectId,
    parentId: task.managerId,
    taskId: task.id,
    role: 'reviewer',
    name: 'Independent reviewer',
    cwd: path,
  });
  store.updateTask(task.id, {
    status: 'done',
    reviewedCommit: source,
    reviewAgentId: reviewer.id,
    review: 'Independent review approved',
  });
  return { task: store.task(task.id), path, source };
}
async function apply(taskId: string, key = randomUUID()) {
  const result = await adapter.request({ action: 'preview', handle, taskId });
  return {
    input: {
      action: 'apply' as const,
      handle,
      key,
      taskId,
      source: result.preview!.source,
      target: result.preview!.target,
    },
    result,
  };
}
async function remoteAdvance(name: string) {
  const other = join(root, name);
  await git(root, ['clone', origin, other]);
  await git(other, ['config', 'user.name', 'Other member']);
  await git(other, ['config', 'user.email', 'other@example.invalid']);
  writeFileSync(join(other, `${name}.txt`), `${name}\n`);
  await git(other, ['add', `${name}.txt`]);
  await git(other, ['commit', '-m', name]);
  await git(other, ['push', 'origin', 'HEAD:refs/heads/main']);
  return git(other, ['rev-parse', 'HEAD']);
}

it('starts with blank GitHub identity, retains settings, and never accepts browser paths or private scope', async () => {
  expect(await status()).toMatchObject({ githubUsername: '', autoSync: false, workspacePath: cwd });
  const input = {
    action: 'configure',
    handle,
    key: randomUUID(),
    githubUsername: '',
    autoSync: true,
  };
  const configured = await adapter.request(input);
  expect(configured).toMatchObject({ githubUsername: '', autoSync: true });
  expect(await adapter.request(input)).toEqual(configured);
  await expect(adapter.request({ ...input, githubUsername: 'someone-else' })).rejects.toThrow(
    'exact saved',
  );
  await expect(adapter.request({ action: 'status', handle, cwd: '/private' })).rejects.toThrow();
  context = { ...context, visibility: 'private' };
  await expect(status()).rejects.toThrow('shared group conversation');
});

it('Ask preserves files and branches; Work creates an empty member/request branch without staging files', async () => {
  writeFileSync(join(cwd, 'private-note.txt'), 'Never stage this fixture note');
  await work('ask');
  expect(await git(cwd, ['branch', '--show-current'])).toBe('main');
  expect(await git(cwd, ['ls-files'])).toBe('');
  await expect(work()).rejects.toThrow('Finish active shared work');
  expect(readFileSync(join(cwd, 'private-note.txt'), 'utf8')).toContain('Never stage');
  rmSync(join(cwd, 'private-note.txt'));
  const id = await work();
  expect(await git(cwd, ['branch', '--show-current'])).toMatch(
    new RegExp(`^swa/member-[a-f0-9]{12}/work-${id}$`),
  );
  expect(await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('');
  expect(await git(cwd, ['ls-remote', 'origin', 'refs/heads/main'])).toBe('');
});

it('pulls only a clean idle default branch and prepares later Work from current shared default while retaining old branches', async () => {
  await seed();
  const first = await remoteAdvance('first');
  runtime.externalControl.add(binding.agentId);
  const initial = await git(cwd, ['rev-parse', 'HEAD']);
  expect((await sync()).busy).toBe(true);
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(initial);
  await expect(work()).rejects.toThrow('Finish active shared work');
  runtime.externalControl.clear();
  await sync();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(first);
  await work();
  const oldBranch = await git(cwd, ['branch', '--show-current']);
  const second = await remoteAdvance('second');
  await sync();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(first);
  expect(await git(cwd, ['branch', '--show-current'])).toBe(oldBranch);
  await work();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(second);
  expect(await git(cwd, ['rev-parse', oldBranch])).toBe(first);
  writeFileSync(join(cwd, 'unfinished.txt'), 'Local unfinished work');
  await remoteAdvance('third');
  await sync();
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(second);
  expect(readFileSync(join(cwd, 'unfinished.txt'), 'utf8')).toBe('Local unfinished work');
});

it.each([
  'unowned',
  'missing-request',
  'failed',
  'uncertain',
  'dirty',
  'active',
  'queued-child',
  'unpublished',
  'divergent-default',
  'pending-git',
  'late-active',
] as const)(
  'preserves current branch and files when completed-work return-to-default proof is %s',
  async (disposition) => {
    await seed();
    const requestId = await work();
    const original = await git(cwd, ['branch', '--show-current']);
    const run = store.enqueue(binding.agentId, requestId, 'Exact saved Work');
    requests.set(requestId, { ...binding, runId: run.id, intent: 'work' });
    store.updateRun(run.id, { status: 'completed' });
    store.updateAgent(binding.agentId, { status: 'idle' });
    completions.add(requestId);
    (adapter as unknown as { starting: Map<string, unknown> }).starting.clear();
    if (disposition === 'unowned') await git(cwd, ['checkout', '-b', 'owner-topic']);
    if (disposition === 'missing-request') requests.delete(requestId);
    if (disposition === 'failed') store.updateRun(run.id, { status: 'failed' });
    if (disposition === 'uncertain') completions.delete(requestId);
    if (disposition === 'dirty')
      writeFileSync(join(cwd, 'unfinished.txt'), 'Unfinished owner work');
    if (disposition === 'active') runtime.externalControl.add(binding.agentId);
    if (disposition === 'queued-child') {
      const child = store.addAgent({
        projectId: binding.projectId,
        parentId: binding.agentId,
        taskId: null,
        name: 'Retained queued child',
        role: 'researcher',
        cwd,
      });
      store.enqueue(child.id, randomUUID(), 'Retained child input');
    }
    if (disposition === 'unpublished') {
      writeFileSync(join(cwd, 'unpublished.txt'), 'Owner checkpoint');
      await git(cwd, ['add', 'unpublished.txt']);
      await git(cwd, ['commit', '-m', 'Unpublished owner checkpoint']);
    }
    if (disposition === 'divergent-default') {
      await git(cwd, ['checkout', 'main']);
      writeFileSync(join(cwd, 'default-only.txt'), 'Retained local default branch checkpoint');
      await git(cwd, ['add', 'default-only.txt']);
      await git(cwd, ['commit', '-m', 'Local default checkpoint']);
      await git(cwd, ['checkout', original]);
    }
    if (disposition === 'pending-git') {
      const key = randomUUID();
      db.prepare('INSERT INTO gng_operations VALUES(?,?,NULL)').run(
        key,
        JSON.stringify({ action: 'apply', handle, key, source: randomUUID() }),
      );
    }
    if (disposition === 'late-active') {
      let validations = 0;
      host.authenticatedContext = async () =>
        ({
          context,
          enrollmentHandle: binding.enrollmentHandle,
          revalidate: async () => {
            if (++validations === 2) runtime.externalControl.add(binding.agentId);
          },
        }) as Awaited<ReturnType<GroupHost['authenticatedContext']>>;
    }
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    const branch = await git(cwd, ['branch', '--show-current']);
    await remoteAdvance('incoming-after-work');
    await sync();
    expect(await git(cwd, ['branch', '--show-current'])).toBe(branch);
    expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(cwd, ['rev-parse', original])).toBe(head);
    expect(await git(cwd, ['ls-files', '--', 'incoming-after-work.txt'])).toBe('');
    if (disposition === 'dirty')
      expect(readFileSync(join(cwd, 'unfinished.txt'), 'utf8')).toContain('Unfinished owner');
    expect(store.run(run.id).key).toBe(requestId);
  },
);

it('publishes only independently reviewed exact applies, suppresses implicit tags/mirroring, and retains lost acknowledgements', async () => {
  const base = await seed();
  await work();
  const item = await reviewed();
  const { input } = await apply(item.task.id);
  await adapter.request(input);
  // Simulate a response lost after the integration event was committed.
  db.prepare('UPDATE gng_operations SET result=NULL WHERE key=?').run(input.key);
  await adapter.request(input);
  expect(
    store.db.prepare("SELECT count(*) n FROM events WHERE type='task.integrated'").get()!.n,
  ).toBe(1);
  await git(cwd, ['tag', '-a', 'unrequested-tag', '-m', 'Do not publish this tag', item.source]);
  await git(cwd, ['config', 'push.followTags', 'true']);
  await git(cwd, ['config', 'remote.origin.mirror', 'true']);
  expect((await sync()).message).toContain('Reviewed committed work shared');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).toBe(item.source);
  expect(await git(root, ['--git-dir', origin, 'tag', '--list'])).toBe('');
  expect(
    await git(root, [
      '--git-dir',
      origin,
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/dock',
    ]),
  ).toBe('');
  expect(base).not.toBe(item.source);
});

it('recovers the crash gap after an authorized Git apply and refuses stale previews or unreviewed direct commits', async () => {
  await seed();
  await work();
  const item = await reviewed();
  const { input, result } = await apply(item.task.id);
  // Saved exact authorization, then Git completed before task/event acknowledgement.
  db.prepare('INSERT INTO gng_operations VALUES (?,?,NULL)').run(
    input.key,
    JSON.stringify(groupNativeGitRequestSchema.parse(input)),
  );
  db.prepare('INSERT INTO gng_applies VALUES (?,?)').run(input.key, JSON.stringify(result.preview));
  await git(cwd, ['merge', '--ff-only', item.source]);
  await adapter.request(input);
  expect(store.task(item.task.id).status).toBe('integrated');
  expect(
    store.db.prepare("SELECT count(*) n FROM events WHERE type='task.integrated'").get()!.n,
  ).toBe(1);
  const other = await reviewed('later');
  const stale = await integrationPreview(store, other.task.id);
  writeFileSync(join(cwd, 'unreviewed.txt'), 'Direct unreviewed change\n');
  await git(cwd, ['add', 'unreviewed.txt']);
  await git(cwd, ['commit', '-m', 'Unreviewed direct change']);
  await expect(
    adapter.request({
      action: 'apply',
      handle,
      key: randomUUID(),
      taskId: other.task.id,
      source: stale.source,
      target: stale.target,
    }),
  ).rejects.toThrow('preview changed');
  expect((await sync()).message).toContain('await independent task review');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).not.toBe(
    await git(cwd, ['rev-parse', 'HEAD']),
  );
});

it('shares a reviewed divergent work branch without replacing default or discarding either member’s work', async () => {
  await seed();
  await work();
  const branch = await git(cwd, ['branch', '--show-current']);
  const item = await reviewed();
  await adapter.request((await apply(item.task.id)).input);
  const remote = await remoteAdvance('other-member');
  expect((await sync()).message).toContain('default branch advanced separately');
  expect(await git(root, ['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).toBe(remote);
  expect(await git(root, ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`])).toBe(
    item.source,
  );
  expect(await git(cwd, ['rev-parse', 'HEAD'])).toBe(item.source);
  await expect(work()).rejects.toThrow('unpublished or divergent');
});

it('rejects a separate push destination and refuses credentials even when later removed from history', async () => {
  await seed();
  const foreign = join(root, 'foreign.git');
  await git(root, ['init', '--bare', foreign]);
  await git(cwd, ['remote', 'set-url', '--push', 'origin', foreign]);
  await expect(sync()).rejects.toThrow('fetch and push destinations differ');
  await git(cwd, ['config', '--unset-all', 'remote.origin.pushurl']);
  await work();
  const item = await reviewed();
  writeFileSync(join(item.path, 'notes.txt'), `ghp_${'a'.repeat(36)}\n`);
  await git(item.path, ['add', 'notes.txt']);
  await git(item.path, ['commit', '-m', 'Bad checkpoint']);
  rmSync(join(item.path, 'notes.txt'));
  await git(item.path, ['add', '-u']);
  await git(item.path, ['commit', '-m', 'Remove bad checkpoint']);
  const head = await git(item.path, ['rev-parse', 'HEAD']);
  store.updateTask(item.task.id, { reviewedCommit: head });
  await adapter.request((await apply(item.task.id)).input);
  await expect(sync()).rejects.toThrow('likely credential');
  expect(await git(root, ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'])).toBe('');
});
it('syncs reviewed scientific data and a large figure from an outside project to another checkout', async () => {
  const privateRuntime = join(root, 'private-runtime');
  mkdirSync(privateRuntime);
  Object.defineProperty(runtime, 'dataDir', { value: privateRuntime });
  await seed();
  await work();
  const item = await reviewed('Scientific files');
  mkdirSync(join(item.path, 'data'));
  writeFileSync(join(item.path, 'data', 'measurements.csv'), 'energy,count\n1,42\n');
  const figure = Buffer.alloc(5 * 1024 ** 2, 0x41);
  figure[0] = 0;
  writeFileSync(join(item.path, 'figure.bin'), figure);
  await git(item.path, ['add', 'data/measurements.csv', 'figure.bin']);
  await git(item.path, ['commit', '-m', 'Reviewed scientific data and figure']);
  const head = await git(item.path, ['rev-parse', 'HEAD']);
  store.updateTask(item.task.id, { reviewedCommit: head });
  await adapter.request((await apply(item.task.id)).input);
  expect((await sync()).message).toContain('Reviewed committed work shared');
  const other = join(root, 'reader');
  await git(root, ['clone', origin, other]);
  expect(readFileSync(join(other, 'data', 'measurements.csv'), 'utf8')).toBe(
    'energy,count\n1,42\n',
  );
  const received = readFileSync(join(other, 'figure.bin'));
  expect(received.length).toBe(figure.length);
  expect(createHash('sha256').update(received).digest('hex')).toBe(
    createHash('sha256').update(figure).digest('hex'),
  );
});
it('local task repository without a remote keeps optional GitHub setup available', async () => {
  await git(cwd, ['remote', 'remove', 'origin']);
  const view = await adapter.request({ action: 'status', handle });
  expect(view.available).toBe(false);
});

it.each(['data/runtime-canary.txt', 'nested/data/runtime-canary.txt', '.env', 'notes.sqlite'])(
  'native Git still refuses the private/runtime path %s',
  async (name) => {
    await seed();
    await work();
    const item = await reviewed();
    mkdirSync(join(item.path, name, '..'), { recursive: true });
    writeFileSync(join(item.path, name), 'Private runtime canary');
    await git(item.path, ['add', name]);
    await git(item.path, ['commit', '-m', 'Private path checkpoint']);
    const head = await git(item.path, ['rev-parse', 'HEAD']);
    store.updateTask(item.task.id, { reviewedCommit: head });
    await adapter.request((await apply(item.task.id)).input);
    await expect(sync()).rejects.toThrow('likely private or runtime file');
    expect(await git(root, ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'])).toBe('');
  },
);

it('keeps untouched group file status optional after another enrollment proposes and the adapter restarts', async () => {
  const untouched = randomUUID(),
    enrollment = randomUUID();
  const untouchedContext = {
    ...context,
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
  };
  const authenticate = host.authenticatedContext.bind(host);
  Object.assign(host, {
    authenticatedContext: async (input: { handle: string }) =>
      input.handle === untouched
        ? { context: untouchedContext, enrollmentHandle: enrollment, revalidate: async () => {} }
        : authenticate(input),
  });
  const connector = (adapter as unknown as { connector: GroupHostNativeRuntime }).connector;
  const resolveContext = connector.resolveLocalContext.bind(connector);
  connector.resolveLocalContext = (...args) =>
    args[0].groupId === untouchedContext.groupId ? null : resolveContext(...args);
  const empty = { proposals: [], preview: null };
  await expect(adapter.externalRequest({ action: 'status', handle: untouched })).resolves.toEqual(
    empty,
  );
  await expect(adapter.externalRequest({ action: 'status', handle: randomUUID() })).rejects.toThrow(
    'Unknown saved member',
  );
  const proposal = await externalCheckpoint();
  expect(db.prepare('SELECT count(*) n FROM gex_proposals').get()!.n).toBe(1);
  expect(db.prepare('SELECT count(*) n FROM gex_proposals WHERE handle=?').get(enrollment)!.n).toBe(
    0,
  );
  await expect(adapter.externalRequest({ action: 'status', handle: untouched })).resolves.toEqual(
    empty,
  );
  Object.assign(host, { localContributing: (selected: string) => selected !== untouched });
  await expect(adapter.externalRequest({ action: 'status', handle: untouched })).resolves.toEqual(
    empty,
  );
  await expect(
    adapter.externalRequest({
      action: 'propose',
      handle: untouched,
      key: randomUUID(),
      head: proposal.head,
    }),
  ).rejects.toThrow('Resume automatic sharing');
  untouchedContext.visibility = 'private';
  await expect(adapter.externalRequest({ action: 'status', handle: untouched })).rejects.toThrow(
    'visible shared group',
  );
  untouchedContext.visibility = 'shared';
  Object.assign(host, { localVisible: (selected: string) => selected !== untouched });
  await expect(adapter.externalRequest({ action: 'status', handle: untouched })).rejects.toThrow(
    'visible shared group',
  );
  Object.assign(host, { localVisible: () => true });
  await adapter.close();
  adapter = new GroupHostNativeGit(host, runtime, connector, true);
  await expect(adapter.externalRequest({ action: 'status', handle: untouched })).resolves.toEqual(
    empty,
  );
  const view = await adapter.externalRequest({ action: 'status', handle });
  expect(view.proposals[0].id).toBe(proposal.key);
  connector.resolveLocalContext = () => null;
  await expect(adapter.externalRequest({ action: 'status', handle })).rejects.toThrow(
    'Choose the intended shared folder',
  );
  expect(db.prepare('SELECT count(*) n FROM gex_proposals').get()!.n).toBe(1);
});
