import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { MirrorCommand, MirrorResult, MirrorState } from '@dock/shared';
import { repoRoot } from './paths.js';
import { Store } from './store.js';
import { registerMirrorRoutes, VscodeMirrors } from './vscode-mirror.js';

let root: string, store: Store, app: FastifyInstance, mirrors: VscodeMirrors;
let socket: WebSocket | undefined;
const windowId = randomUUID();
const window = {
  windowId,
  provider: 'codex' as const,
  label: 'Fixture',
  title: 'Working',
  threadId: 'thread',
  status: 'busy' as const,
  message: '',
  canSteer: true,
  steerToken: 'observed-turn',
};
const input = () => ({
  key: randomUUID(),
  provider: 'codex' as const,
  threadId: 'thread',
  expectedTurnId: 'observed-turn',
  text: 'Preserve the original output format.',
});
beforeEach(async () => {
  mkdirSync(join(repoRoot, 'data/tests'), { recursive: true });
  root = mkdtempSync(join(repoRoot, 'data/tests/mirror-steering-'));
  store = new Store(join(root, 'dock.sqlite'));
  mirrors = new VscodeMirrors(store);
  app = Fastify();
  await app.register(websocket);
  registerMirrorRoutes(app, mirrors, false);
  await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await app.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function reply(id: string, value: MirrorResult) {
  socket!.send(JSON.stringify({ type: 'chunk', id, text: JSON.stringify(value), last: true }));
}
async function connect(
  handler: (command: MirrorCommand) => void,
  overrides: Partial<MirrorState> = {},
) {
  const address = app.server.address() as { port: number };
  socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/vscode/bridge`);
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve);
    socket!.once('error', reject);
  });
  socket.on('message', (data) => handler(JSON.parse(data.toString()) as MirrorCommand));
  socket.send(JSON.stringify({ type: 'hello', window: { ...window, ...overrides } }));
  await expect.poll(() => mirrors.windows().length).toBe(1);
}

it('forwards only an advertised exact-turn steer and keeps one durable receipt across duplicate requests and restart', async () => {
  const commands: MirrorCommand[] = [];
  await connect((command) => {
    commands.push(command);
  });
  const request = input();
  const first = mirrors.send(windowId, request);
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ type: 'send', input: request });
  expect((await mirrors.send(windowId, request)).state).toBe('uncertain');
  expect(commands).toHaveLength(1);
  reply(commands[0]!.id, { state: 'sent', message: 'Steered observed turn.' });
  const result = await first;
  expect(result.state).toBe('sent');
  const restoredStore = new Store(join(root, 'dock.sqlite'));
  try {
    const restored = new VscodeMirrors(restoredStore);
    expect(await restored.send(randomUUID(), request)).toEqual(result);
    expect(restored.receipt(request.key)).toEqual(result);
  } finally {
    restoredStore.close();
  }
  expect(commands).toHaveLength(1);
  await expect(
    mirrors.send(windowId, { ...request, expectedTurnId: 'later-turn' }),
  ).rejects.toThrow('different message');
  await expect(mirrors.send(windowId, { ...request, expectedTurnId: undefined })).rejects.toThrow(
    'different message',
  );
});

it('retains uncertain steering intent after a lost response instead of replaying into later work', async () => {
  let commands = 0;
  await connect(() => {
    commands++;
    socket!.close();
  });
  const request = input();
  expect((await mirrors.send(windowId, request)).state).toBe('uncertain');
  expect((await new VscodeMirrors(store).send(randomUUID(), request)).state).toBe('uncertain');
  expect(commands).toBe(1);
});

it.each(['older companion', 'Claude'] as const)(
  'refuses steering through %s without forwarding or losing the receipt',
  async (kind) => {
    let commands = 0;
    await connect(
      () => {
        commands++;
      },
      kind === 'Claude'
        ? { provider: 'claude', canSteer: true }
        : { canSteer: undefined, steerToken: undefined },
    );
    const request = { ...input(), ...(kind === 'Claude' ? { provider: 'claude' as const } : {}) };
    const result = await mirrors.send(windowId, request);
    expect(result.state).toBe('not_sent');
    expect(result.message).toContain('does not support live steering');
    expect(commands).toBe(0);
    expect(mirrors.receipt(request.key)).toEqual(result);
    expect(await new VscodeMirrors(store).send(randomUUID(), request)).toEqual(result);
  },
);

it.each(['codex', 'claude'] as const)(
  'forwards an explicitly advertised %s native queue once and retains its acknowledgement',
  async (provider) => {
    const commands: MirrorCommand[] = [];
    await connect(
      (command) => {
        commands.push(command);
        reply(command.id, {
          state: 'sent',
          message: 'Queued in Claude Code. It will run when native work allows.',
        });
      },
      { provider, canSteer: undefined, steerToken: undefined, canQueue: true },
    );
    const request = {
      key: randomUUID(),
      provider,
      threadId: 'thread',
      text: 'Next check the chart.',
      mode: 'queue' as const,
    };
    const result = await mirrors.send(windowId, request);
    expect(result.state).toBe('sent');
    expect(commands[0]).toMatchObject({ type: 'send', input: request });
    expect(await new VscodeMirrors(store).send(randomUUID(), request)).toEqual(result);
    expect(commands).toHaveLength(1);
    await expect(mirrors.send(windowId, { ...request, mode: undefined })).rejects.toThrow(
      'different message',
    );
    await expect(
      mirrors.send(windowId, { ...request, key: randomUUID(), expectedTurnId: 'turn' }),
    ).rejects.toThrow('either native steering or a queued follow-up');
  },
);

it.each(['codex', 'claude'] as const)(
  'does not forward a queue request to an older %s companion',
  async (provider) => {
    let commands = 0;
    await connect(
      () => {
        commands++;
      },
      { provider, canSteer: undefined, steerToken: undefined },
    );
    const request = {
      key: randomUUID(),
      provider,
      threadId: 'thread',
      text: 'Next step',
      mode: 'queue' as const,
    };
    expect((await mirrors.send(windowId, request)).state).toBe('not_sent');
    expect(commands).toBe(0);
    expect(mirrors.receipt(request.key).state).toBe('not_sent');
  },
);
