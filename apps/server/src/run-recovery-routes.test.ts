import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createServer } from './server.js';
import { DemoProvider } from './demo.js';
import { modelFixture } from './model-policy.fixture.js';
import { ClaudePreflightError } from './claude-session.js';
import { prepareRunDelivery, recordRunFailure } from './run-recovery.js';
import { proxyPath } from './hosts.js';

let root: string, store: Store, app: FastifyInstance, agent: string;
const factory = vi.fn(async () => new DemoProvider());
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dock-recovery-api-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  agent = store.register(root, 'Recovery API fixture', '').managerId;
  store.updateAgent(agent, { provider: 'claude' });
  store.setSetting('scheduler:settings', { paused: true, maxConcurrent: 4 });
  factory.mockClear();
  app = await createServer(store, new Runtime(store, root, 'codex', factory), { port: 4999 });
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
function failure() {
  const run = store.enqueue(agent, randomUUID(), 'One original request');
  prepareRunDelivery(store, store.run(run.id));
  recordRunFailure(
    store,
    store.run(run.id),
    new ClaudePreflightError('unavailable', 'Sanitized preflight'),
  );
  store.updateRun(run.id, { status: 'failed' });
  store.updateAgent(agent, { status: 'failed' });
  return run;
}
it('reads recovery and lost-ack receipts without launching a provider, and admits one retry through the typed route', async () => {
  failure();
  const url = `/api/agents/${agent}/run-recovery`;
  const view = (await app.inject({ url, headers })).json();
  expect(view.action).toBe('retry');
  expect(factory).not.toHaveBeenCalled();
  const payload = {
    key: randomUUID(),
    runId: view.runId,
    failureId: view.failureId,
    action: view.action,
  };
  const first = await app.inject({ method: 'POST', url, headers, payload });
  expect(first.statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toEqual(
    first.json(),
  );
  expect((await app.inject({ url: `${url}/receipts/${payload.key}`, headers })).json()).toEqual(
    first.json(),
  );
  expect(store.runs()).toHaveLength(2);
  expect(factory).not.toHaveBeenCalled();
  expect((await app.inject({ url, headers })).json()).toBeNull();
  expect(proxyPath('GET', `/agents/${agent}/run-recovery`)).toBe(
    `/api/agents/${agent}/run-recovery`,
  );
  expect(proxyPath('GET', `/agents/${agent}/run-recovery/receipts/${payload.key}`)).not.toBeNull();
  expect(proxyPath('POST', `/agents/${agent}/run-recovery`)).not.toBeNull();
});
it('rejects another conversation’s proof and cross-origin recovery without submitting', async () => {
  failure();
  const url = `/api/agents/${agent}/run-recovery`;
  const view = (await app.inject({ url, headers })).json();
  const payload = {
    key: randomUUID(),
    runId: view.runId,
    failureId: view.failureId,
    action: 'retry',
  };
  const other = store.register(join(root, 'other'), 'Other fixture', '').managerId;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/agents/${other}/run-recovery`,
        headers,
        payload,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, origin: 'https://foreign.invalid' },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(store.runs()).toHaveLength(1);
  expect(factory).not.toHaveBeenCalled();
});
