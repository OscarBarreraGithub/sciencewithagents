import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupNativeExecution } from './group-native-execution.js';
import { GroupNativeJournal } from './group-native.js';
import { GroupEventRepository } from './group-events.js';
import { Store } from './store.js';
import { CodexRpc } from './codex.js';
import { spawnClaudeChannel } from './claude-session.js';
import type { GroupContainer } from './group-container.js';
import type { NativeProviderBoundary } from './native-provider-boundary.js';

vi.mock('./codex.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    CodexRpc: class extends EventEmitter {
      ready = true;
      signedIn = false;
      constructor(...args: unknown[]) {
        super();
        calls.push(args);
        adapters.push(this as unknown as CodexRpc & { signedIn: boolean });
      }
      start = vi.fn(async () => {});
      close = vi.fn(async () => {});
      respond = vi.fn();
      request = vi.fn(async (method: string) => {
        if (method === 'config/read') return { config: { cli_auth_credentials_store: 'file' } };
        if (method === 'configRequirements/read') return { requirements: null };
        if (method === 'account/read')
          return { requiresOpenaiAuth: true, account: this.signedIn ? { type: 'chatgpt' } : null };
        if (method === 'thread/start') return { thread: { id: 'unit-native-thread' } };
        if (method === 'turn/start') {
          this.emit('notification', 'turn/started', {
            threadId: 'unit-native-thread',
            turn: { id: 'unit-turn' },
          });
          this.emit('notification', 'item/completed', {
            threadId: 'unit-native-thread',
            turnId: 'unit-turn',
            item: { id: 'unit-command', type: 'commandExecution' },
          });
          this.emit('notification', 'item/completed', {
            threadId: 'unit-native-thread',
            turnId: 'unit-turn',
            item: { id: 'unit-message', type: 'agentMessage', text: 'unit-only' },
          });
          this.emit('notification', 'turn/completed', {
            threadId: 'unit-native-thread',
            turn: { id: 'unit-turn', status: 'completed' },
          });
          return { turn: { id: 'unit-turn' } };
        }
        return {};
      });
    },
  };
});
const calls: unknown[][] = [],
  adapters: Array<CodexRpc & { signedIn: boolean }> = [];
let root: string, repository: GroupEventRepository, journal: GroupNativeJournal, store: Store;
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = realpathSync.native(mkdtempSync('data/tests/execution-unit-'));
  mkdirSync(join(root, 'workspace'));
  store = new Store(join(root, 'store.sqlite'));
  repository = new GroupEventRepository(join(root, 'events.sqlite'));
  journal = new GroupNativeJournal(join(root, 'native.sqlite'), repository);
  calls.length = 0;
  adapters.length = 0;
});
afterEach(() => {
  journal.close();
  repository.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture(visibility: 'shared' | 'private') {
  const id = store.register(join(root, 'workspace'), 'Unit only', '').managerId;
  const agent = store.updateAgent(id, {
    model: 'unit-model',
    effort: 'high',
    toolPolicy: 'native',
  });
  const run = store.enqueue(id, randomUUID(), 'Unit only');
  store.updateRun(run.id, { status: 'running' });
  const group = repository.createGroup('Unit only'),
    handle = journal.issue(
      {
        groupId: group.groupId,
        memberId: group.memberId,
        installationId: group.installationId,
        visibility,
      },
      id,
      'codex',
    );
  let stopped!: () => void;
  const closed = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const container = {
    start: vi.fn(async () => {}),
    openCodexSocket: vi.fn(async () => '/tmp/unit-only.sock'),
    closed,
    nativeJson: vi.fn(async (argv: string[]) =>
      argv.at(-1) === 'privacy'
        ? { uid: 1000, forbiddenDenied: true, capabilitiesZero: true, noNewPrivileges: true }
        : { nested: true, chromiumNativeSandbox: true },
    ),
    close: vi.fn(async () => {
      stopped();
    }),
  } as unknown as GroupContainer;
  const execution = new GroupNativeExecution(
    container,
    agent,
    store,
    run.id,
    journal,
    handle,
    () => {},
  );
  return { execution, container, handle, run };
}
it.each(['shared', 'private'] as const)(
  'unit protocol preserves native inheritance and local actual-ID alias journal for %s',
  async (visibility) => {
    const f = fixture(visibility);
    await f.execution.initialize();
    expect(calls[0]?.[8]).toBe(true);
    const boundary = calls[0]?.[9] as NativeProviderBoundary;
    expect(boundary.codexArgs).toEqual(['-c', 'cli_auth_credentials_store="file"']);
    expect(boundary.codexSocketManaged).toBe(true);
    expect((vi.mocked(f.container.nativeJson).mock.calls[1]?.[0] as string[]).at(-1)).toBe(
      'nested',
    );
    await expect(f.execution.turn('Unit only')).rejects.toThrow(/sign-in/);
    adapters[0]!.signedIn = true;
    const result = await f.execution.turn('Unit only');
    expect(result.nativeToolItems).toBe(1);
    expect(journal.nativeId(f.handle)).toBe('unit-native-thread');
    expect(JSON.stringify(result)).not.toContain('unit-native-thread');
    expect(JSON.stringify(result)).not.toContain('unit-message');
    if (visibility === 'private') expect(result.source).toBeUndefined();
    else expect(result.source?.messageId).toMatch(/^[a-f0-9-]{36}$/);
    await f.execution.archiveAndClose();
    await f.execution.closed;
    expect(adapters[0]!.request).toHaveBeenCalledWith('thread/archive', {
      threadId: 'unit-native-thread',
    });
    expect(f.container.close).toHaveBeenCalledOnce();
  },
);
it('unit native interaction accepts only the original typed response, no arbitrary provider RPC', async () => {
  const f = fixture('shared');
  await f.execution.initialize();
  let requestId = '';
  f.execution.on('codex-interaction', (event: { requestId: string }) => {
    requestId = event.requestId;
  });
  adapters[0]!.emit('request', 9, 'item/commandExecution/requestApproval', {});
  expect(() =>
    f.execution.answerCodex(requestId, { method: 'arbitrary', decision: 'accept' }),
  ).toThrow();
  f.execution.answerCodex(requestId, { decision: 'accept' });
  expect(adapters[0]!.respond).toHaveBeenCalledWith(9, { decision: 'accept' });
  expect(() => f.execution.answerCodex(requestId, { decision: 'accept' })).toThrow();
  await f.execution.close();
});
it('existing Claude channel can use owned direct CLI and emits only fixed auth classifications', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 1,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  const spawn = vi.fn(() => child),
    diagnostic = vi.fn();
  const boundary: NativeProviderBoundary = {
    claudeDirect: true,
    environment: {},
    check: async () => {},
    spawn,
    verifyClaudeIdentity: async () => {
      throw new Error('Unused');
    },
  };
  const channel = spawnClaudeChannel(
    '/usr/local/bin/claude',
    ['native-arguments'],
    '/workspace',
    diagnostic,
    boundary,
  );
  expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(['/usr/local/bin/claude', ['native-arguments']]);
  child.stderr!.emit(
    'data',
    Buffer.from('unexported-synthetic-text OAuth token refresh failed more-unexported-text'),
  );
  expect(diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ classification: 'refresh-failed' }),
  );
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('unexported');
  child.emit('close', 0);
  await channel.close();
});

it('unit durable actual turn/result binding observes completion before ack and refuses resend', async () => {
  const f = fixture('shared'),
    requestId = randomUUID();
  await f.execution.initialize();
  adapters[0]!.signedIn = true;
  journal.beginRequest(f.handle, requestId, 'unit request');
  journal.requestEvent(f.handle, requestId, { state: 'admitted' });
  await f.execution.turn('unit request', requestId);
  expect(adapters[0]!.request).toHaveBeenCalledWith(
    'turn/start',
    expect.objectContaining({ clientUserMessageId: requestId }),
  );
  expect(journal.request(f.handle, requestId)).toMatchObject({
    state: 'completed',
    nativeTurnId: 'unit-turn',
    text: 'unit-only',
    nativeToolItems: 1,
  });
  await expect(f.execution.turn('unit request', requestId)).rejects.toThrow(/never replay/);
  await f.execution.close();
});
it('unit same-ID recovery reads retained Codex turn only, never re-submits input', async () => {
  const f = fixture('shared'),
    requestId = randomUUID();
  await f.execution.initialize();
  journal.bindNative(f.handle, 'unit-native-thread');
  journal.beginRequest(f.handle, requestId, 'unit lost result');
  journal.requestEvent(f.handle, requestId, { state: 'admitted' });
  journal.requestEvent(f.handle, requestId, { state: 'write-intent' });
  journal.requestEvent(f.handle, requestId, {
    state: 'native-started',
    nativeTurnId: 'retained-turn',
  });
  journal.requestEvent(f.handle, requestId, { state: 'unknown' });
  vi.mocked(adapters[0]!.request).mockResolvedValueOnce({
    thread: {
      id: 'unit-native-thread',
      turns: [
        {
          id: 'unrelated-turn',
          status: 'completed',
          items: [{ id: 'wrong-message', type: 'agentMessage', text: 'WRONG' }],
        },
        {
          id: 'retained-turn',
          status: 'completed',
          items: [
            { id: 'actual-retained-message', type: 'agentMessage', text: 'exact retained result' },
          ],
        },
      ],
    },
  });
  await f.execution.reconcile(requestId);
  expect(journal.request(f.handle, requestId)).toMatchObject({
    state: 'completed',
    text: 'exact retained result',
  });
  expect(adapters[0]!.request).toHaveBeenCalledWith('thread/read', {
    threadId: 'unit-native-thread',
    includeTurns: true,
  });
  expect(
    vi.mocked(adapters[0]!.request).mock.calls.some(([method]) => method === 'turn/start'),
  ).toBe(false);
  await f.execution.close();
});
