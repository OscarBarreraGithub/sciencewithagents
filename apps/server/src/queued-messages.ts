import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { id, queuedMessageActionSchema, queuedMessageReceiptSchema, runSchema } from '@dock/shared';
import { Conflict, type Store } from './store.js';
import type { Runtime } from './runtime.js';
import type { WorkspaceState } from './workspace-state.js';
import type { Terminals } from './terminal.js';
import { requireActiveAssignment } from './interviews.js';

/** App-owned follow-ups only. Native editor queues remain with their owning extension. */
export function registerQueuedMessageRoutes(
  app: FastifyInstance,
  store: Store,
  runtime: Runtime,
  workspace: WorkspaceState,
  terminals: Terminals,
) {
  app.get('/api/agents/:id/queued/:runId/receipts/:key', async (request) => {
    const params = z.object({ id, runId: id, key: id }).parse(request.params);
    const run = store.run(params.runId);
    if (run.agentId !== params.id)
      throw new Conflict('This queued receipt belongs to another conversation.');
    const operation = `queue:${params.runId}:${params.key}`;
    const saved = store.db.prepare('SELECT input FROM operations WHERE key=?').get(operation);
    const intent = saved
      ? z
          .object({ agentId: id, action: queuedMessageActionSchema.shape.action })
          .passthrough()
          .parse(JSON.parse(String(saved.input)))
      : null;
    if (intent && intent.agentId !== params.id)
      throw new Conflict('This receipt belongs to another conversation.');
    const acknowledged =
      intent?.action !== 'steer' ||
      !!store.db.prepare('SELECT 1 FROM operations WHERE key=?').get(`${operation}:ack`);
    return queuedMessageReceiptSchema.parse({
      status: !intent ? 'not_found' : acknowledged ? 'applied' : 'uncertain',
      run: runSchema.parse(run),
    });
  });
  app.post('/api/agents/:id/queued/:runId', async (request) => {
    const params = z.object({ id, runId: id }).parse(request.params);
    const input = queuedMessageActionSchema.parse(request.body);
    runtime.requireDirectControl(params.id);
    requireActiveAssignment(store, store.agent(params.id));
    workspace.snapshot(input.clientId);
    if (terminals.active(params.id))
      throw new Conflict('Return from the native terminal before changing the chat queue.');
    const operation = `queue:${params.runId}:${input.key}`;
    const intent = { agentId: params.id, runId: params.runId, ...input };
    if (input.action !== 'steer') {
      const result = store.operation(operation, intent, () => {
        const previous = store.run(params.runId);
        const result = store.queuedMessage(params.id, params.runId, input);
        if (
          ['queue', 'remove'].includes(input.action) &&
          (input.text ?? previous.queueEdit?.text ?? previous.text) !== previous.text
        )
          runtime.workItems.sourceChanged(params.id, params.runId);
        return result;
      });
      runtime.kick();
      return result;
    }
    if (store.agent(params.id).provider !== 'codex')
      throw new Conflict('Claude supports queued follow-ups here. Live steering is not enabled.');
    return runtime.withLock(params.id, async () => {
      // Before intent is saved, a finished/disconnected turn leaves the editable draft held.
      if (!store.getSetting(`external:${operation}`)) {
        const agent = store.agent(params.id);
        if (!agent.threadId || !agent.turnId)
          throw new Conflict(
            'That reply finished. Your message is still held; choose Save and queue.',
            'NO_ACTIVE_TURN',
          );
        if (!runtime.clients.get(params.id)?.ready)
          throw new Conflict('Codex is disconnected. Your message remains held.');
      }
      const claimed = store.operation(operation, intent, () =>
        store.queuedMessage(params.id, params.runId, input),
      );
      const text = claimed.queueEdit!.text;
      await store.externalOperation(
        operation,
        { agentId: params.id, runId: params.runId, text },
        async () => {
          const agent = store.agent(params.id);
          const client = runtime.clients.get(params.id);
          if (!agent.threadId || !agent.turnId || !client?.ready)
            throw new Conflict(
              'The connection changed. Steering is uncertain; the message stays held.',
            );
          runtime.ownerSteering(params.id, operation, text, 'uncertain');
          await client.request('turn/steer', {
            threadId: agent.threadId,
            expectedTurnId: agent.turnId,
            input: [{ type: 'text', text: runtime.chatImages.prompt(text), text_elements: [] }],
          });
          runtime.ownerSteering(params.id, operation, text, 'submitted');
          return { submitted: true };
        },
      );
      // A lost HTTP response can retry this exact operation without steering twice.
      return store.operation(`${operation}:ack`, { runId: params.runId }, () => {
        const run = store.run(params.runId);
        if (run.queueEdit?.operationKey !== input.key || run.queueEdit.state !== 'steering')
          throw new Conflict('This queued message changed after steering. It was not resent.');
        const result = store.updateRun(run.id, {
          status: 'cancelled',
          queueEdit: null,
          queueRevision: (run.queueRevision ?? 0) + 1,
        });
        const entry = store.entries(params.id).find((entry) => entry.id === run.id);
        if (entry && entry.text !== text) {
          store.retainQueuedOriginal(run);
          runtime.workItems.sourceChanged(params.id, run.id);
        }
        if (entry) store.entry({ ...entry, status: 'complete', title: 'You · steered', text });
        store.event('queue.steered', store.agent(params.id).projectId, params.id, {
          runId: run.id,
        });
        return runSchema.parse(result);
      });
    });
  });
}
