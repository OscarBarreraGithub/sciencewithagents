import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Provider } from './codex.js';
import type { Store } from './store.js';

/** Explicit demo only. Tests and first-look UI never consume a model call. */
export class DemoProvider extends EventEmitter implements Provider {
  ready = true;
  threadId: string = randomUUID();
  constructor(readonly savedRoot = '') {
    super();
  }
  async request(method: string, raw?: unknown) {
    const params = raw as Record<string, unknown>;
    if (method === 'account/read')
      return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    if (method === 'config/read')
      return { config: { mcp_servers: { demo_docs: { enabled: false } } } };
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    if (method === 'thread/start' && params.ephemeral)
      return { thread: { id: randomUUID(), turns: [] }, model: 'demo' };
    const saved = ['desktop', 'phone', 'small-phone', 'landscape', 'iphone-webkit'].map(
      (name, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index + 1}`,
        cwd: this.savedRoot,
        name: `Saved ${name} session`,
        preview: 'Example historical question',
        updatedAt: 1788799884,
        status: { type: 'notLoaded' },
      }),
    );
    if (method === 'thread/list') return { data: saved, nextCursor: null };
    if (method === 'thread/read') return { thread: saved.find((t) => t.id === params.threadId) };
    if (method === 'thread/turns/list')
      return {
        data: [
          {
            id: 'saved-turn',
            items: [
              {
                id: 'saved-question',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Example historical question' }],
              },
              {
                id: 'saved-answer',
                type: 'agentMessage',
                text: 'Example saved answer. This is demonstration history, not a real model response.',
              },
            ],
          },
        ],
        nextCursor: null,
      };
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'demo',
            model: 'demo',
            displayName: 'Demo · no model calls',
            isDefault: true,
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
          },
        ],
      };
    if (method === 'thread/start' || method === 'thread/resume') {
      this.threadId = typeof params.threadId === 'string' ? params.threadId : this.threadId;
      return { thread: { id: this.threadId, turns: [] }, model: 'demo' };
    }
    if (method === 'turn/start') {
      const turnId = randomUUID(),
        itemId = randomUUID();
      setTimeout(() => {
        if (!this.ready) return;
        this.emit('notification', 'turn/started', {
          threadId: this.threadId,
          turn: { id: turnId },
        });
        this.emit('notification', 'item/completed', {
          threadId: this.threadId,
          turnId,
          item: {
            id: itemId,
            type: 'agentMessage',
            text: 'Your message is saved. This is **demo mode**, so no model was called.\n\nWith Codex connected, your manager delegates bounded tasks, records decisions, and brings results back here. You can inspect each worker’s conversation in the team panel.',
          },
        });
        this.emit('notification', 'turn/completed', {
          threadId: this.threadId,
          turn: { id: turnId, status: 'completed' },
        });
      }, 180);
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    return {};
  }
  respond() {}
  async close() {
    this.ready = false;
    this.removeAllListeners();
  }
}
export function seedDemo(store: Store, root: string) {
  if (store.projects().length) return;
  const project = store.register(
    root,
    'Fieldnotes',
    'A focused writing app. Example project for exploring sciencewithagents.',
  );
  const task = store.addTask(project.id, {
    title: 'Keep drafts across reloads',
    goal: 'A writer should never lose an unfinished note when the browser refreshes.',
    acceptance: 'Reload an unfinished note and verify that its text and title return.',
    parentId: null,
  });
  const worker = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: task.id,
    name: 'Draft persistence',
    role: 'implementer',
    cwd: root,
  });
  const reviewer = store.addAgent({
    projectId: project.id,
    parentId: project.managerId,
    taskId: task.id,
    name: 'Persistence review',
    role: 'reviewer',
    cwd: root,
  });
  store.updateAgent(project.managerId, {
    checkpoint:
      'Focus on a simple, reliable writing experience. First milestone: drafts survive refresh. Keep implementation in small tasks and review the actual changes.',
  });
  store.updateTask(task.id, { status: 'review', review: 'approve', reviewAgentId: reviewer.id });
  const entries = [
    [
      project.managerId,
      'user',
      'You',
      'Let’s make sure I never lose a draft when I refresh the page.',
    ],
    [
      project.managerId,
      'assistant',
      'Fieldnotes manager',
      'I scoped this to one result: **a draft survives a refresh**.\n\nDraft persistence handled the implementation, and Persistence review checked the reload behavior. Their conversations and evidence are in the team panel. The example task is ready for a final decision.',
    ],
    [
      worker.id,
      'assistant',
      worker.name,
      'Example implementation report: drafts are stored locally as you type, and restored when you return. Validation covers title, body, and an empty draft. This is demonstration content; no repository files were changed.',
    ],
    [
      reviewer.id,
      'assistant',
      reviewer.name,
      'Example review: the acceptance check is clear and bounded. One follow-up consideration is showing a save failure if browser storage is full. This is demonstration content, not an executed test result.',
    ],
  ] as const;
  for (const [agentId, kind, title, text] of entries)
    store.entry({
      id: randomUUID(),
      agentId,
      runId: null,
      kind,
      title,
      text,
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
  store.decision({
    projectId: project.id,
    taskId: task.id,
    agentId: project.managerId,
    kind: 'note',
    rationale:
      'Keep this task limited to draft recovery. Cross-device synchronization is a separate deliverable.',
    evidence: 'Example decision, provided to demonstrate the retained audit trail.',
  });
}
