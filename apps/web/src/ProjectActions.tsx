import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  agentSchema,
  jobEstimateSchema,
  taskDraftSchema,
  managerDraftSchema,
  type Agent,
} from '@dock/shared';
import { api, apiScope, ApiError } from './api';
import { useFormAction } from './useFormAction';
import { Modal } from './Modal';
import { JobEstimateFields } from './JobEstimateFields';

// A lost response keeps the exact submitted payload immutable across reload. The
// server's atomic creation receipt makes a deliberate retry safe for either form.
function useCreationDraft<T extends { key: string; submitted: boolean }>(
  storageKey: string,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
  initial: () => NoInfer<T>,
) {
  const [draft, setDraft] = useState<T>(() => {
    try {
      const saved = schema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
      if (saved.success) return saved.data;
    } catch {
      /* Start with an empty draft if the saved value is unreadable. */
    }
    return initial();
  });
  const [storageError, setStorageError] = useState('');
  const save = (next: T) => {
    setDraft(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError('');
    } catch {
      setStorageError(
        'This browser cannot save the draft. Keep this page open until the request is confirmed.',
      );
    }
  };
  useEffect(() => {
    save(draft);
  }, []);
  return {
    draft,
    storageError,
    change: (value: Partial<T>) => {
      if (!draft.submitted) save({ ...draft, ...value, key: crypto.randomUUID() });
    },
    submit: async (send: () => Promise<void>) => {
      save({ ...draft, submitted: true });
      try {
        await send();
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* Creation is confirmed. */
        }
      } catch (error) {
        if (error instanceof ApiError && [400, 404, 409, 422].includes(error.status))
          save({ ...draft, submitted: false });
        throw error;
      }
    },
  };
}
export function TaskModal({
  projectId,
  managers,
  initialManagerId,
  close,
  act,
}: {
  projectId: string;
  managers: Agent[];
  initialManagerId: string;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { draft, change, submit, storageError } = useCreationDraft(
    `dock:${apiScope()}:task-draft:${projectId}`,
    taskDraftSchema,
    () => ({
      key: crypto.randomUUID(),
      submitted: false,
      managerId: initialManagerId,
      title: '',
      goal: '',
      acceptance: '',
      scheduling: jobEstimateSchema.parse({}),
    }),
  );
  const action = useFormAction(act);
  return (
    <Modal
      title="A small task. A clear result."
      close={() => {
        if (!action.pending) close();
      }}
    >
      <p>
        Describe one outcome. Creating the task queues a request for its manager through QUARK.
        Estimates guide scheduling; set a project allowance cap in QUARK before starting if you need
        a spending limit.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await submit(async () => {
              await api(`/projects/${projectId}/tasks`, {
                key: draft.key,
                managerId: draft.managerId,
                task: {
                  title: draft.title,
                  goal: draft.goal,
                  acceptance: draft.acceptance,
                  scheduling: draft.scheduling,
                },
              });
            });
            close();
          });
        }}
      >
        <label>
          Responsible manager
          <select
            disabled={action.pending || draft.submitted}
            value={draft.managerId}
            onChange={(event) => change({ managerId: event.target.value })}
          >
            {managers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.name}
              </option>
            ))}
          </select>
        </label>
        <JobEstimateFields
          value={draft.scheduling}
          change={(scheduling) => change({ scheduling })}
          disabled={action.pending || draft.submitted}
        />
        <label>
          Task name
          <input
            autoFocus
            required
            maxLength={160}
            placeholder="Keep drafts across reloads"
            value={draft.title}
            disabled={action.pending || draft.submitted}
            onChange={(event) => change({ title: event.target.value })}
          />
        </label>
        <label>
          What should change?
          <textarea
            required
            maxLength={4000}
            rows={3}
            placeholder="Describe the outcome you want…"
            value={draft.goal}
            disabled={action.pending || draft.submitted}
            onChange={(event) => change({ goal: event.target.value })}
          />
        </label>
        <label>
          How will we know it works?
          <textarea
            required
            maxLength={2000}
            rows={2}
            placeholder="What would a good result look like?"
            value={draft.acceptance}
            disabled={action.pending || draft.submitted}
            onChange={(event) => change({ acceptance: event.target.value })}
          />
        </label>
        {draft.submitted && (
          <p role="status">
            The submitted details are retained. Check this request to confirm its result without
            creating a duplicate.
          </p>
        )}
        {storageError && <p role="alert">{storageError}</p>}
        {action.error && (
          <p className="session-error" role="alert">
            {action.error}
          </p>
        )}
        <button className="primary" type="submit" disabled={action.pending}>
          <Plus size={16} />{' '}
          {action.pending ? 'Checking…' : draft.submitted ? 'Check task request' : 'Create task'}
        </button>
      </form>
    </Modal>
  );
}

export function ManagerModal({
  projectId,
  close,
  act,
  onCreated,
}: {
  projectId: string;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onCreated: (id: string) => void;
}) {
  const { draft, change, submit, storageError } = useCreationDraft(
    `dock:${apiScope()}:manager-draft:${projectId}`,
    managerDraftSchema,
    () => ({
      key: crypto.randomUUID(),
      submitted: false,
      name: '',
      scope: '',
      provider: 'policy' as const,
    }),
  );
  const action = useFormAction(act);
  return (
    <Modal
      title="Add module manager"
      close={() => {
        if (!action.pending) close();
      }}
    >
      <p>
        Give one part of the project its own manager—for example, design or research. Managers can
        share what they know and talk to each other. Each task has one responsible manager.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            let createdId = '';
            await submit(async () => {
              const manager = agentSchema.parse(
                await api(`/projects/${projectId}/managers`, {
                  key: draft.key,
                  name: draft.name,
                  scope: draft.scope,
                  ...(draft.provider !== 'policy' ? { provider: draft.provider } : {}),
                }),
              );
              createdId = manager.id;
            });
            onCreated(createdId);
            close();
          });
        }}
      >
        <label>
          Manager name
          <input
            autoFocus
            required
            maxLength={80}
            placeholder="Interface manager"
            value={draft.name}
            disabled={action.pending || draft.submitted}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <label>
          Area of responsibility
          <textarea
            required
            maxLength={2000}
            rows={3}
            placeholder="The web interface, mobile layout and accessibility."
            value={draft.scope}
            disabled={action.pending || draft.submitted}
            onChange={(event) => change({ scope: event.target.value })}
          />
        </label>
        <label>
          Manager provider
          <select
            value={draft.provider}
            disabled={action.pending || draft.submitted}
            onChange={(event) => change({ provider: event.target.value as Agent['provider'] })}
          >
            <option value="policy">Follow model settings</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <p className="muted">
          Uses that provider’s sign-in on this computer. Codex and Claude managers can share a
          project; each saved conversation keeps its own provider.
        </p>
        <p className="muted">
          This tells the manager what to look after. Specialists still do the work and review it; it
          does not grant access to additional files.
        </p>
        {draft.submitted && (
          <p role="status">
            The submitted details are retained. Check this request to confirm its result without
            creating a duplicate.
          </p>
        )}
        {storageError && <p role="alert">{storageError}</p>}
        {action.error && (
          <p className="session-error" role="alert">
            {action.error}
          </p>
        )}
        <button className="primary" type="submit" disabled={action.pending}>
          <Plus size={16} />{' '}
          {action.pending
            ? 'Checking…'
            : draft.submitted
              ? 'Check manager request'
              : 'Create manager'}
        </button>
      </form>
    </Modal>
  );
}
