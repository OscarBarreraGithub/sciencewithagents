import { promptTextLimit, queuedMessageReceiptSchema, type Agent, type Run } from '@dock/shared';
import { api } from './api';
import { EditableMessageQueue, type QueuedMessageOperations } from './EditableMessageQueue';
import {
  queuedActionRecoveries,
  clearQueuedAction,
  submitQueuedAction,
} from './queued-action-recovery';

export function AppMessageQueue({ agent, runs }: { agent: Agent; runs: readonly Run[] }) {
  const messages = runs.filter((run) => run.status === 'queued' && run.kind === 'user');
  const operations: QueuedMessageOperations = {
    recoveries: () => queuedActionRecoveries(agent.id),
    clear: (saved) => clearQueuedAction(agent.id, saved),
    submit: (id, input) => submitQueuedAction(agent.id, id, input),
    inspect: async (id, key) => {
      const receipt = queuedMessageReceiptSchema.parse(
        await api(`/agents/${agent.id}/queued/${id}/receipts/${key}`),
      );
      return { status: receipt.status, message: receipt.run };
    },
    read: async (id) => {
      // Even an absent action receipt includes the exact current run. A paged
      // conversation omitting an old input cannot establish its delivery state.
      const receipt = queuedMessageReceiptSchema.parse(
        await api(`/agents/${agent.id}/queued/${id}/receipts/${id}`),
      );
      return receipt.run;
    },
  };
  return (
    <EditableMessageQueue
      key={agent.id}
      target={{
        id: agent.id,
        name: agent.name,
        canSteer: !agent.nativeRootId && agent.provider === 'codex' && agent.status === 'running',
        maxLength: promptTextLimit,
      }}
      messages={messages.map((run) => ({
        ...run,
        queueEditable: !agent.nativeRootId && run.queueEditable,
      }))}
      operations={operations}
      observation={runs}
    />
  );
}
