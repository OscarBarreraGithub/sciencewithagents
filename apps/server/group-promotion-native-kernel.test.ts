// Run only in the exact native source projection described in GROUP_PROMOTION.md.
// Real execution/journal code; provider transport and namespace are protocol fakes.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupNativeExecution } from './src/group-native-execution.js';
import { GroupNativeJournal } from './src/group-native.js';
import { GroupEventRepository } from './src/group-events.js';
import { Store } from './src/store.js';
import type { GroupContainer } from './src/group-container.js';
import type { NativeProviderBoundary } from './src/native-provider-boundary.js';
import { groupPromotionNativeBindingSchema } from './src/group-promotion-native-synthesis.js';

const calls: unknown[][] = [],
  adapters: Array<EventEmitter & { request: ReturnType<typeof vi.fn> }> = [];
let lostAck = false;
vi.mock('./src/codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./src/codex.js')>();
  const { EventEmitter } = await import('node:events');
  class FakeRpc extends EventEmitter {
    constructor(...args: unknown[]) {
      super();
      calls.push(args);
      adapters.push(this);
    }
    start = vi.fn(async () => {});
    close = vi.fn(async () => {});
    respond = vi.fn();
    request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'config/read')
        return {
          config: {
            cli_auth_credentials_store: 'file',
            mcp_servers: { history: { enabled: true, command: 'untrusted-history-tool' } },
          },
        };
      if (method === 'configRequirements/read') return { requirements: null };
      if (method === 'account/read')
        return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } };
      if (method === 'thread/start') return { thread: { id: 'exact-synthesis-thread' } };
      if (method === 'thread/read')
        return {
          thread: {
            id: 'exact-synthesis-thread',
            turns: [
              {
                id: 'exact-synthesis-turn',
                status: 'completed',
                items: [
                  {
                    id: 'summary-output',
                    type: 'agentMessage',
                    text: '{"category":"Idea","sentences":["Use a blinded control."],"evidenceRefs":[]}',
                  },
                ],
              },
            ],
          },
        };
      if (method === 'turn/start') {
        const threadId = 'exact-synthesis-thread';
        this.emit('notification', 'turn/started', {
          threadId,
          turn: { id: 'exact-synthesis-turn' },
        });
        this.emit('notification', 'item/completed', {
          threadId,
          turnId: 'exact-synthesis-turn',
          item: {
            id: 'summary-output',
            type: 'agentMessage',
            text: '{"category":"Idea","sentences":["Use a blinded control."],"evidenceRefs":[]}',
          },
        });
        this.emit('notification', 'turn/completed', {
          threadId,
          turn: { id: 'exact-synthesis-turn', status: 'completed' },
        });
        if (lostAck) throw new Error('Lost exact turn acknowledgment');
        return { turn: { id: 'exact-synthesis-turn' } };
      }
      return {};
    });
  }
  return { ...actual, CodexRpc: FakeRpc };
});
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  calls.length = 0;
  adapters.length = 0;
  lostAck = false;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'promotion-kernel-')),
    store = new Store(join(root, 'store.sqlite')),
    events = new GroupEventRepository(join(root, 'events.sqlite')),
    journal = new GroupNativeJournal(join(root, 'native.sqlite'), events);
  cleanup = () => {
    journal.close();
    events.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  const project = store.register(root, 'Protocol only', '', 'codex');
  const agent = store.updateAgent(project.managerId, {
    model: 'protocol-model',
    effort: 'high',
    permission: 'read-only',
  });
  const group = events.createGroup('Protocol owner'),
    owner = journal.issue({ ...group, visibility: 'shared' }, agent.id, 'codex');
  const handle = journal.issue({ ...group, visibility: 'shared' }, agent.id, 'codex');
  const synthesisId = randomUUID(),
    binding = groupPromotionNativeBindingSchema.parse({
      synthesisId,
      sourceHash: 'a'.repeat(64),
      contextId: journal.resolve(handle).context.sessionId,
      sharedContextId: journal.resolve(owner).context.sessionId,
      writer: journal.resolve(owner).context,
      writerId: randomUUID(),
      volume: `swa-group-${randomUUID()}`,
      image: `sha256:${'b'.repeat(64)}`,
      stateBase: root,
      forbiddenPaths: [root],
      outbound: [],
    });
  const run = store.enqueue(agent.id, randomUUID(), 'Protocol synthesis');
  store.updateRun(run.id, { status: 'running' });
  const create = () => {
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const container = {
      start: async () => {},
      openCodexSocket: async () => '/tmp/protocol-only.sock',
      closed,
      nativeJson: async (argv: string[]) =>
        argv.at(-1) === 'privacy'
          ? { uid: 1000, forbiddenDenied: true, capabilitiesZero: true, noNewPrivileges: true }
          : { nested: true, chromiumNativeSandbox: true },
      close: async () => {
        stopped();
      },
    } as unknown as GroupContainer;
    return new GroupNativeExecution(
      container,
      store.agent(agent.id),
      store,
      run.id,
      journal,
      handle,
      () => {},
      {
        retained: true,
        synthesisBinding: binding,
        workspace: `/tmp/group-synthesis/${synthesisId}`,
        tools: [],
      },
    );
  };
  journal.beginRequest(handle, synthesisId, 'Exact authorized source');
  journal.requestEvent(handle, synthesisId, { state: 'admitted' });
  return { create, journal, handle, synthesisId };
}
it('actual native execution suppresses publication aliases and excludes native history MCP configuration', async () => {
  const f = fixture(),
    execution = f.create();
  await execution.initialize();
  const boundary = calls[0]![10] as NativeProviderBoundary;
  expect(boundary.codexArgs).toContain('shell_tool');
  expect(boundary.codexArgs).toContain('memories');
  const result = await execution.turn('Exact authorized source', f.synthesisId);
  expect(result.source).toBeUndefined();
  expect(f.journal.request(f.handle, f.synthesisId)?.source).toBeUndefined();
  const request = adapters[0]!.request.mock.calls.find(
    ([method]) => method === 'thread/start',
  )![1] as {
    config: { mcp_servers: Record<string, { enabled: boolean }> };
    dynamicTools: unknown[];
    sandbox: string;
  };
  expect(request.config.mcp_servers.history.enabled).toBe(false);
  expect(request.dynamicTools).toEqual([]);
  expect(request.sandbox).toBe('read-only');
  await execution.close();
});
it('actual native lost-ack journal reconciliation reads the exact original turn without resubmission or a feed alias', async () => {
  const f = fixture();
  lostAck = true;
  let execution = f.create();
  await execution.initialize();
  await expect(execution.turn('Exact authorized source', f.synthesisId)).rejects.toThrow(
    'Lost exact',
  );
  expect(f.journal.request(f.handle, f.synthesisId)?.nativeTurnId).toBe('exact-synthesis-turn');
  lostAck = false;
  execution = f.create();
  await execution.initialize();
  await execution.reconcile(f.synthesisId);
  expect(f.journal.request(f.handle, f.synthesisId)?.state).toBe('completed');
  expect(f.journal.request(f.handle, f.synthesisId)?.source).toBeUndefined();
  expect(
    adapters.flatMap((a) => a.request.mock.calls).filter(([method]) => method === 'turn/start'),
  ).toHaveLength(1);
  await execution.close();
});
