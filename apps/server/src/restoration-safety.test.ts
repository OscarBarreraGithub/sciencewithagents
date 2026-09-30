import { modelFixture } from './model-policy.fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { WorkspaceState } from './workspace-state.js';

const fixtures: {
  root: string;
  store: Store;
  runtime: Runtime;
  provider: DemoProvider;
  app?: FastifyInstance;
}[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app?.close();
    if (fixture.store.db.isOpen) await fixture.runtime.close();
    // Even a failed shutdown regression must not leak the deliberately delayed fixture.
    await fixture.provider.close();
    if (fixture.store.db.isOpen) fixture.store.close();
    rmSync(fixture.root, { recursive: true });
  }
});
const headers = {
  host: '127.0.0.1:4969',
  origin: 'http://127.0.0.1:4969',
  'content-type': 'application/json',
};

describe('independent restoration safety regressions', () => {
  it('closes a provider whose delayed startup finishes while the app is shutting down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dock-restore-race-'));
    const store = new Store(join(root, 'dock.sqlite'));
    modelFixture(store);
    const manager = store.register(root, 'Delayed startup fixture', '').managerId;
    store.updateAgent(manager, { threadId: randomUUID() });
    const provider = new DemoProvider();
    const request = vi.spyOn(provider, 'request');
    let release!: (provider: DemoProvider) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const factory = vi.fn(async () => {
      enter();
      return await new Promise<DemoProvider>((resolve) => {
        release = resolve;
      });
    });
    const runtime = new Runtime(store, root, 'codex', factory);
    fixtures.push({ root, store, runtime, provider });
    const restoring = runtime.restoreSessions([manager]);
    await entered;
    const closing = runtime.close();
    release(provider);
    await Promise.allSettled([restoring, closing]);
    expect(provider.ready).toBe(false);
    expect([...runtime.clients.values()].every((client) => !client.ready)).toBe(true);
    expect(
      request.mock.calls.some(([method]) =>
        ['thread/resume', 'thread/start', 'turn/start'].includes(method),
      ),
    ).toBe(false);
    await runtime.restoreSessions([manager]).catch(() => {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(store.runs()).toEqual([]);
  });

  it.each([false, true])(
    'an old %s draft receipt cannot unblock later interrupted work or change its payload',
    async (guarded) => {
      const root = mkdtempSync(join(tmpdir(), 'dock-receipt-race-'));
      const store = new Store(join(root, 'dock.sqlite'));
      modelFixture(store);
      const manager = store.register(root, 'Old receipt fixture', '').managerId;
      const provider = new DemoProvider();
      const request = vi.spyOn(provider, 'request');
      const runtime = new Runtime(store, root, 'codex', async () => provider);
      const app = await createServer(store, runtime, {
        port: 4969,
        demo: true,
        ownsRuntime: false,
      });
      fixtures.push({ root, store, runtime, provider, app });
      const workspace = new WorkspaceState(store);
      const client = workspace.register({ key: randomUUID(), label: 'Old browser' }).client;
      const saved = workspace.saveDraft(client.id, manager, {
        key: randomUUID(),
        hostId: workspace.hostId,
        revision: 0,
        action: { kind: 'save', text: 'The earlier completed request' },
      }).state.own;
      const draft = {
        hostId: workspace.hostId,
        clientId: client.id,
        revision: saved.revision,
        deliveryKey: saved.deliveryKey!,
      };
      const originalKey = randomUUID();
      const previous = store.transaction(() =>
        store.enqueue(
          manager,
          guarded
            ? workspace.reserveSubmission(manager, draft, originalKey, saved.text)
            : originalKey,
          saved.text,
        ),
      );
      store.updateRun(previous.id, { status: 'completed' });
      store.updateAgent(manager, { status: 'running' });
      const later = store.enqueue(
        manager,
        randomUUID(),
        'A later action waiting behind interrupted work',
      );
      store.updateAgent(manager, { status: 'interrupted', turnId: null });
      const before = store.agent(manager),
        head = store.head;
      const key = guarded ? randomUUID() : originalKey;
      const payload = { key, text: saved.text, ...(guarded ? { draft } : {}) };
      const reply = await app.inject({
        method: 'POST',
        url: `/api/agents/${manager}/messages`,
        headers,
        payload,
      });
      expect(reply.statusCode).toBe(202);
      expect(reply.json().id).toBe(previous.id);
      expect(store.agent(manager)).toEqual(before);
      expect(store.run(later.id).status).toBe('queued');
      expect(store.head).toBe(head);
      expect(request).not.toHaveBeenCalled();
      const altered = await app.inject({
        method: 'POST',
        url: `/api/agents/${manager}/messages`,
        headers,
        payload: { ...payload, text: 'Different text must not reuse an old receipt' },
      });
      expect(altered.statusCode).toBe(409);
      expect(store.agent(manager)).toEqual(before);
      expect(store.run(later.id).status).toBe('queued');
      const receipt = await app.inject({
        method: 'GET',
        url: `/api/agents/${manager}/receipts/${key}`,
        headers,
      });
      expect(receipt.json().submitted).toEqual({ text: saved.text, steer: false });
    },
  );
});
