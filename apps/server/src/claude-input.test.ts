import { chatFileReference, promptTextLimit } from '@dock/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  ClaudeSession,
  claudeAppContextJsonByteLimit,
  parseClaudeIdentity,
  type ClaudeChannel,
} from './claude-session.js';
import { modelFixture } from './model-policy.fixture.js';
import { recoverRun, runRecoveryView } from './run-recovery.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { Store } from './store.js';

const identity = parseClaudeIdentity({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.invalid',
  orgId: 'fixture',
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

/** Real HTTP enqueue, Runtime admission and ClaudeSession validation. Only the
 * local native byte channel and metadata discovery are fixtures; no CLI runs. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dock-claude-input-'));
  const store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const project = store.register(root, 'Input fixture', '');
  const manager = project.managerId;
  store.updateAgent(manager, { provider: 'claude', model: 'default', effort: 'provider-default' });
  const writes: Record<string, any>[] = [];
  const outputs = new Map<string, PassThrough>();
  const spawn = vi.fn();
  const codex = vi.fn(async (): Promise<never> => {
    throw new Error('Codex must not be launched');
  });
  const runtime = new Runtime(store, root, 'never-codex', codex, {
    identity: async () => identity,
    inspect: async () => ({
      identity,
      models: [
        { value: 'default', displayName: 'Fixture', description: '', supportsEffort: false },
      ],
    }),
    session: (options) => {
      const input = new PassThrough(),
        output = new PassThrough();
      outputs.set(options.sessionId, output);
      let end!: (code: number | null) => void;
      const channel: ClaudeChannel = {
        input,
        output,
        exited: new Promise((resolve) => {
          end = resolve;
        }),
        close: async () => {
          input.end();
          output.end();
          end(0);
        },
      };
      input.on('data', (buffer) => {
        const frame = JSON.parse(buffer.toString());
        writes.push(frame);
        if (frame.type === 'control_request')
          queueMicrotask(() =>
            output.write(
              JSON.stringify({
                type: 'control_response',
                response: { subtype: 'success', request_id: frame.request_id, response: {} },
              }) + '\n',
            ),
          );
      });
      return new ClaudeSession(options, {
        identity: async () => identity,
        spawn: (...args) => {
          spawn(...args);
          return channel;
        },
        timeoutMs: 1000,
      });
    },
  });
  await runtime.initialize();
  const app = await createServer(store, runtime, { port: 4330, ownsRuntime: false });
  cleanups.push(async () => {
    await app.close();
    await runtime.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const send = (text: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/agents/${manager}/messages`,
      payload: { key, text },
      headers: { host: '127.0.0.1:4330', origin: 'http://127.0.0.1:4330' },
    });
  const users = () => writes.filter((frame) => frame.type === 'user');
  const finish = async (runId: string) => {
    const frame = users().find((item) => item.uuid === runId)!;
    outputs.get(frame.session_id)!.write(
      JSON.stringify({
        type: 'result',
        uuid: randomUUID(),
        session_id: frame.session_id,
        subtype: 'success',
        is_error: false,
        result: 'Fixture finished',
      }) + '\n',
    );
    await vi.waitFor(() => expect(store.run(runId).status).toBe('completed'));
  };
  return { store, manager, runtime, send, users, spawn, codex, finish };
}

it('delivers the exact owner limit through actual Runtime with app evidence once', async () => {
  const f = await fixture();
  const owner = '界'.repeat(promptTextLimit - 1) + 'z';
  const key = randomUUID();
  const response = await f.send(owner, key);
  expect(response.statusCode).toBe(202);
  expect((await f.send(owner, key)).json().id).toBe(response.json().id);
  await vi.waitFor(() => expect(f.users()).toHaveLength(1));
  const frame = f.users()[0]!;
  expect(frame.uuid).toBe(response.json().id);
  expect(frame.message.content.slice(0, owner.length)).toBe(owner);
  expect(frame.message.content.slice(owner.length)).toContain('<agent-dock-evidence>');
  expect(f.store.run(frame.uuid).text).toBe(owner);
  expect(f.store.getSetting(`run:delivery:${frame.uuid}`)).toMatchObject({
    handoffAt: expect.any(String),
  });
  expect(f.store.entries(f.manager).filter((entry) => entry.kind === 'user')).toHaveLength(1);
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.codex).not.toHaveBeenCalled();
  await f.finish(frame.uuid);
});

it('preserves near-limit owner text and four bounded attachment excerpts plus evidence', async () => {
  const f = await fixture();
  const refs = Array.from({ length: 4 }, (_, i) =>
    chatFileReference(
      f.runtime.chatImages.uploadFile({
        key: randomUUID(),
        name: `evidence-${i}.txt`,
        data: Buffer.from(`${i}:` + 'a'.repeat(5000)).toString('base64'),
      }).id,
    ),
  ).join('\n');
  const owner = 'x'.repeat(promptTextLimit - refs.length - 10) + '\n' + refs;
  const expanded = f.runtime.chatImages.prompt(owner);
  expect(expanded.length).toBeGreaterThan(promptTextLimit);
  const response = await f.send(owner);
  expect(response.statusCode).toBe(202);
  await vi.waitFor(() => expect(f.users()).toHaveLength(1));
  const frame = f.users()[0]!;
  expect(frame.message.content.slice(0, expanded.length)).toBe(expanded);
  expect(frame.message.content.slice(expanded.length)).toContain('<agent-dock-evidence>');
  expect(frame.message.content.match(/"excerptTruncated":true/g)).toHaveLength(4);
  expect(f.store.run(frame.uuid).text).toBe(owner);
  await f.finish(frame.uuid);
});

it('rejects genuinely oversized owner text before enqueue or native handoff', async () => {
  const f = await fixture();
  const response = await f.send('x'.repeat(promptTextLimit + 1));
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 'PROMPT_TOO_LONG' });
  expect(f.store.runs()).toHaveLength(0);
  expect(f.users()).toHaveLength(0);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.codex).not.toHaveBeenCalled();
});

it('retains oversized app context as a pre-handoff failure and explicitly retries the saved owner text once', async () => {
  const f = await fixture();
  // JSON escaping, rather than UTF-16 length alone, determines the app budget.
  const context = vi
    .spyOn(f.runtime, 'context')
    .mockReturnValue('\0'.repeat(Math.ceil(claudeAppContextJsonByteLimit / 6)));
  const owner = 'Original owner message remains exact';
  const response = await f.send(owner);
  expect(response.statusCode).toBe(202);
  const runId = response.json().id;
  await vi.waitFor(() => expect(f.store.run(runId).status).toBe('failed'));
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.users()).toHaveLength(0);
  expect(f.store.run(runId).text).toBe(owner);
  expect(f.store.getSetting(`run:delivery:${runId}`)).toMatchObject({
    handoffAt: null,
    failure: { code: 'input_too_large', retry: true },
  });
  const view = runRecoveryView(f.store, f.manager)!;
  expect(view.action).toBe('retry');
  context.mockRestore();
  const request = {
    key: randomUUID(),
    runId: view.runId,
    failureId: view.failureId,
    action: view.action,
  };
  const receipt = recoverRun(f.store, f.manager, request);
  expect(recoverRun(f.store, f.manager, request)).toEqual(receipt);
  f.runtime.kick();
  await vi.waitFor(() => expect(f.users()).toHaveLength(1));
  expect(f.users()[0]!.message.content.startsWith(owner + '\n\n<agent-dock-evidence>')).toBe(true);
  expect(f.users()[0]!.uuid).toBe(receipt.runId);
  expect(f.store.entries(f.manager).filter((entry) => entry.kind === 'user')).toHaveLength(1);
  await f.finish(receipt.runId);
});
