import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, Plus } from 'lucide-react';
import {
  ownerTicketRequestSchema,
  ownerTicketResultSchema,
  workItemSchema,
  workItemsSchema,
  type Project,
  type Snapshot,
  type WorkItem,
} from '@dock/shared';
import { api, ApiError, apiScope } from '../api';
import { useReading } from './useHomeData';
import { Modal } from '../Modal';
import './owner-work-board.css';

export type ProjectIdeaSeed = { brief: string; sourceItemIds: string[]; suggestedName?: string };
type Reading = ReturnType<typeof useReading<ReturnType<typeof workItemsSchema.parse>>>;
type Ticket = ReturnType<typeof ownerTicketRequestSchema.parse>;
const statuses: Record<WorkItem['status'], string> = {
  open: 'Not started',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
};
const storageRead = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
const storageWrite = (key: string, value: string | null) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* The in-page draft remains usable when local storage is unavailable. */
  }
};
const canQueue = (item: WorkItem) =>
  item.kind === 'general' &&
  item.status !== 'done' &&
  !item.managerId &&
  !item.taskId &&
  !item.assignmentRunId;
type BoardDraft = {
  view: 'general' | 'idea' | 'done';
  selected: WorkItem[];
  packaging: boolean;
  target: string;
  title: string;
  brief: string;
  acceptance: string;
  priority: number;
  compute: number;
};
function readBoardDraft(key: string, projectId?: string): BoardDraft {
  const draft: BoardDraft = {
    view: 'general',
    selected: [],
    packaging: false,
    target: projectId ?? '',
    title: '',
    brief: '',
    acceptance: 'Complete each selected outcome and report reproducible evidence.',
    priority: 3,
    compute: 3,
  };
  try {
    const raw = JSON.parse(storageRead(key) ?? 'null') as Record<string, unknown> | null;
    if (!raw) return draft;
    if (raw.view === 'general' || raw.view === 'idea' || raw.view === 'done') draft.view = raw.view;
    const selected = workItemSchema.array().max(20).safeParse(raw.selected);
    if (selected.success) draft.selected = selected.data;
    draft.packaging = raw.packaging === true;
    for (const field of ['target', 'title', 'brief', 'acceptance'] as const)
      if (typeof raw[field] === 'string')
        draft[field] = raw[field].slice(
          0,
          field === 'brief' ? 8000 : field === 'acceptance' ? 2000 : 160,
        );
    for (const field of ['priority', 'compute'] as const)
      if (
        typeof raw[field] === 'number' &&
        Number.isInteger(raw[field]) &&
        raw[field] >= 1 &&
        raw[field] <= 5
      )
        draft[field] = raw[field];
  } catch {
    /* An unreadable draft cannot become an enqueue request. */
  }
  return draft;
}

/** Owner inputs are independent of manager messages and read-only manager follow-ups. */
export function OwnerWorkBoard({
  projects,
  tasks,
  reading,
  projectId,
  onSeedProject,
}: {
  projects: Project[];
  tasks: Snapshot['tasks'];
  reading: Reading;
  projectId?: string;
  onSeedProject?: (seed: ProjectIdeaSeed) => void;
}) {
  const id = useId();
  const prefix = `dock:${apiScope()}:${projectId ? `project-todo:${projectId}` : 'home-todo'}`;
  const draftKey = `${prefix}:draft`,
    pendingKey = `${prefix}:ticket-pending`;
  const boardDraftKey = `${prefix}:board-draft`;
  const [initial] = useState(() => readBoardDraft(boardDraftKey, projectId));
  const [text, setText] = useState(() => storageRead(draftKey) ?? '');
  const titleKey = `${prefix}:title-draft`;
  const [newTitle, setNewTitle] = useState(() => storageRead(titleKey) ?? '');
  const [view, setView] = useState(initial.view);
  const [selected, setSelected] = useState(initial.selected);
  const [packaging, setPackaging] = useState(initial.packaging);
  const [target, setTarget] = useState(initial.target);
  const [title, setTitle] = useState(initial.title);
  const [brief, setBrief] = useState(initial.brief);
  const [acceptance, setAcceptance] = useState(initial.acceptance);
  const [priority, setPriority] = useState(initial.priority),
    [compute, setCompute] = useState(initial.compute);
  const [pending, setPending] = useState<Ticket | null>(() => {
    try {
      const parsed = ownerTicketRequestSchema.safeParse(
        JSON.parse(storageRead(pendingKey) ?? 'null'),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [undo, setUndo] = useState<WorkItem | null>(null);
  const [queued, setQueued] = useState<ReturnType<typeof ownerTicketResultSchema.parse> | null>(
    null,
  );
  const inFlight = useRef(false);
  const notepad = useRef<HTMLTextAreaElement>(null);
  const receipts = useRef(new Map<string, { key: string; request: string }>());
  useEffect(() => {
    storageWrite(
      boardDraftKey,
      JSON.stringify({
        view,
        selected,
        packaging,
        target,
        title,
        brief,
        acceptance,
        priority,
        compute,
      }),
    );
  }, [
    boardDraftKey,
    view,
    selected,
    packaging,
    target,
    title,
    brief,
    acceptance,
    priority,
    compute,
  ]);
  useEffect(() => {
    const resize = () => {
      const field = notepad.current;
      if (!field) return;
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [text]);
  const updateText = (value: string) => {
    setText(value);
    storageWrite(draftKey, value || null);
  };
  const updateTitle = (value: string) => {
    const line = value.replace(/[\r\n]+/g, ' ');
    setNewTitle(line);
    storageWrite(titleKey, line || null);
  };
  const refresh = () => {
    reading.retry();
    window.dispatchEvent(new Event('swa:refresh-home'));
  };
  const run = async (name: string, action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError({
        id: name,
        message: reason instanceof Error ? reason.message : 'Could not save. Try again.',
      });
    } finally {
      inFlight.current = false;
      setBusy(null);
      refresh();
    }
  };
  const save = async (name: string, body: Record<string, unknown>) => {
    const storage = `${prefix}:${name}`,
      request = JSON.stringify(body);
    let receipt = receipts.current.get(name);
    try {
      receipt ??= JSON.parse(storageRead(storage) ?? 'null') ?? undefined;
    } catch {
      /* unreadable receipt */
    }
    if (receipt?.request !== request) receipt = { key: crypto.randomUUID(), request };
    receipts.current.set(name, receipt);
    const encoded = JSON.stringify(receipt);
    storageWrite(storage, encoded);
    const item = workItemSchema.parse(await api('/work-items', { key: receipt.key, ...body }));
    if (storageRead(storage) === encoded) storageWrite(storage, null);
    if (receipts.current.get(name) === receipt) receipts.current.delete(name);
    return item;
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    const note = text.trim();
    const heading = newTitle.trim();
    if ((!note && !heading) || view === 'done') return;
    // A typed title wins; otherwise the first line of the notes becomes the title.
    const itemTitle = (heading || note.split(/\r?\n/, 1)[0]).slice(0, 240);
    const detail = heading ? note : note.slice(itemTitle.length).trim();
    void run('add', async () => {
      await save('add', {
        kind: view,
        ...(projectId ? { projectId } : {}),
        title: itemTitle,
        detail,
      });
      setText((current) => (current === text ? '' : current));
      setNewTitle((current) => (current === newTitle ? '' : current));
      if (storageRead(draftKey) === text) storageWrite(draftKey, null);
      if (storageRead(titleKey) === newTitle) storageWrite(titleKey, null);
    });
  };
  const all = reading.data?.items.filter((item) => ['general', 'idea'].includes(item.kind)) ?? [];
  const completed = all.filter((item) => item.status === 'done');
  const visible =
    view === 'done'
      ? completed
      : all.filter((item) => item.kind === view && item.status !== 'done');
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const toggle = (item: WorkItem) =>
    setSelected((old) =>
      old.some((source) => source.id === item.id)
        ? old.filter((source) => source.id !== item.id)
        : [...old, item].slice(0, 20),
    );
  const packageItems = (sources: WorkItem[]) => {
    setSelected(sources);
    setPackaging(true);
    setQueued(null);
    setTitle(
      sources.length === 1 ? sources[0].title.slice(0, 160) : `${sources.length} selected outcomes`,
    );
    setTarget(projectId ?? sources.find((item) => item.projectId)?.projectId ?? '');
  };
  const seed = (sources: WorkItem[]) => {
    setError(null);
    const brief = sources
      .map((item, index) => `${index + 1}. ${item.title}${item.detail ? `\n${item.detail}` : ''}`)
      .join('\n\n');
    if (brief.length > 24_000) {
      setError({
        id: 'seed',
        message:
          'This selection exceeds the 24,000-character project brief limit. Choose fewer ideas; all original items are kept.',
      });
      return;
    }
    try {
      onSeedProject?.({
        brief,
        sourceItemIds: sources.map((item) => item.id),
        ...(sources.length === 1 ? { suggestedName: sources[0].title.slice(0, 160) } : {}),
      });
    } catch {
      setError({
        id: 'seed',
        message:
          'The new-project draft could not be retained in this browser. Your original ideas are kept; try again.',
      });
    }
  };
  const queue = async (request: Ticket) => {
    setPackaging(true);
    setPending(request);
    storageWrite(pendingKey, JSON.stringify(request));
    try {
      const result = ownerTicketResultSchema.parse(await api('/work-items/tickets', request));
      if (storageRead(pendingKey) === JSON.stringify(request)) storageWrite(pendingKey, null);
      setPending(null);
      setQueued(result);
      setPackaging(false);
      setSelected([]);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) {
        setPending(null);
        storageWrite(pendingKey, null);
      }
      throw reason;
    }
  };
  const eligibleProjects = projects.filter((project) =>
    selected.every((item) => !item.projectId || item.projectId === project.id),
  );
  const stale = selected.some(
    (source) => all.find((item) => item.id === source.id)?.revision !== source.revision,
  );
  const locked = !!busy || !!pending;
  const unavailable = reading.error && !reading.data;
  const complete = (item: WorkItem) =>
    void run(item.id, async () => {
      const saved = await save(`done:${item.id}`, {
        id: item.id,
        expectedRevision: item.revision,
        status: 'done',
      });
      setUndo(saved);
      setSelected((old) => old.filter((source) => source.id !== item.id));
    });
  const reopen = (item: WorkItem) =>
    void run(item.id, async () => {
      await save(`undo:${item.id}`, {
        id: item.id,
        expectedRevision: item.revision,
        status: item.managerId ? 'in_progress' : 'open',
      });
      setUndo(null);
    });
  return (
    <section
      className={`overview-todo owner-work-board${projectId ? ' project-owner-board flow-panel' : ''}`}
      aria-labelledby={`${id}-heading`}
    >
      <div className="overview-panel-head">
        <h2 id={`${id}-heading`}>Ideas and to-dos</h2>
        <span className="overview-count">
          {reading.data ? all.filter((item) => item.status !== 'done').length : '—'}
        </span>
      </div>
      <div
        className="overview-section-body"
        role="region"
        aria-label="General to-dos and editor"
        tabIndex={0}
      >
        <div className="owner-board-tabs" aria-label="Owner work views">
          {(['general', 'idea', 'done'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={view === tab}
              onClick={() => {
                setView(tab);
                if (!pending) {
                  setSelected([]);
                  setPackaging(false);
                }
              }}
            >
              {tab === 'general'
                ? 'To-dos'
                : tab === 'idea'
                  ? 'Ideas'
                  : `Completed (${completed.length})`}
            </button>
          ))}
        </div>
        {view !== 'done' && (
          <form className="todo-add" onSubmit={add}>
            <label className="home-sr-only" htmlFor={`${id}-title`}>
              {view === 'idea' ? 'Idea title (optional)' : 'To-do title (optional)'}
            </label>
            <input
              id={`${id}-title`}
              className="todo-title-input"
              value={newTitle}
              maxLength={240}
              autoComplete="off"
              placeholder={view === 'idea' ? 'Idea title (optional)' : 'Title (optional)'}
              disabled={unavailable || busy === 'add'}
              onChange={(event) => updateTitle(event.target.value)}
            />
            <label className="home-sr-only" htmlFor={`${id}-new`}>
              {view === 'idea' ? 'New idea' : 'New to-do'}
            </label>
            <textarea
              ref={notepad}
              id={`${id}-new`}
              value={text}
              rows={2}
              maxLength={8000}
              autoComplete="off"
              placeholder={
                newTitle.trim()
                  ? 'Notes, steps or links…'
                  : view === 'idea'
                    ? 'Keep an idea for later…'
                    : 'Write a to-do…'
              }
              disabled={unavailable || busy === 'add'}
              onChange={(event) => updateText(event.target.value)}
            />
            {(text.trim() || newTitle.trim()) && (
              <button type="submit" disabled={locked || unavailable}>
                <Plus size={17} />
                {busy === 'add' ? 'Adding…' : 'Add'}
              </button>
            )}
          </form>
        )}
        {error?.id === 'add' && (
          <p className="todo-error" role="alert">
            {error.message} Your text is kept; try again.
          </p>
        )}
        {error?.id === 'seed' && (
          <p className="todo-error" role="alert">
            {error.message}
          </p>
        )}
        {undo && (
          <div className="owner-board-receipt" role="status">
            Completed “{undo.title}”.{' '}
            <button type="button" disabled={locked} onClick={() => reopen(undo)}>
              Undo
            </button>
          </div>
        )}
        {queued && (
          <p className="owner-board-receipt" role="status">
            Queued “{queued.task.title}” with QUARK.{' '}
            <a href={`#/work/${queued.task.id}`}>Open ticket</a>
          </p>
        )}
        {pending && !packaging && (
          <div className="owner-ticket-pending" role="status">
            <p>Checking the saved ticket “{pending.title}”. Its selected to-dos are kept.</p>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void run('ticket', () => queue(pending))}
            >
              {busy === 'ticket' ? 'Checking…' : 'Retry ticket save'}
            </button>
          </div>
        )}
        {error?.id === 'ticket' && !packaging && (
          <p className="todo-error" role="alert">
            {error.message} Your ticket is kept.
          </p>
        )}
        {selected.length > 0 && !packaging && !pending && (
          <div className="owner-board-selection">
            <span>{selected.length} selected</span>
            {view === 'general' && (
              <button type="button" onClick={() => packageItems(selected)}>
                Package {selected.length} {selected.length === 1 ? 'to-do' : 'to-dos'}
              </button>
            )}
            {onSeedProject && (
              <button type="button" onClick={() => seed(selected)}>
                Start a new project from selection
              </button>
            )}
          </div>
        )}
        {packaging && (
          <Modal
            title="QUARK background ticket"
            className="owner-ticket-dialog owner-work-board"
            close={() => setPackaging(false)}
          >
            {pending ? (
              <div className="owner-ticket-pending owner-ticket-form" role="status">
                <p>Checking the saved ticket “{pending.title}”. Its selected to-dos are kept.</p>
                <p>
                  Priority {pending.priority}/5 · estimated compute {pending.estimatedCompute}/5
                </p>
                {error?.id === 'ticket' && (
                  <p className="todo-error" role="alert">
                    {error.message} Your ticket is kept.
                  </p>
                )}
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('ticket', () => queue(pending))}
                >
                  {busy === 'ticket' ? 'Checking…' : 'Retry ticket save'}
                </button>
              </div>
            ) : (
              <form
                className="owner-ticket-request"
                aria-label="Package a QUARK ticket"
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsed = ownerTicketRequestSchema.safeParse({
                    key: crypto.randomUUID(),
                    projectId: target,
                    items: selected.map((item) => ({
                      id: item.id,
                      expectedRevision: item.revision,
                    })),
                    title,
                    brief,
                    acceptance,
                    priority,
                    estimatedCompute: compute,
                  });
                  if (!parsed.success) {
                    setError({
                      id: 'ticket',
                      message: 'Choose a project, title and acceptance for 1–20 selected to-dos.',
                    });
                    return;
                  }
                  void run('ticket', () => queue(parsed.data));
                }}
              >
                <div className="owner-ticket-form">
                  <h3>Selected outcomes</h3>
                  <ol className="owner-ticket-sources">
                    {selected.map((item) => (
                      <li key={item.id}>{item.title}</li>
                    ))}
                  </ol>
                  <label>
                    Send to
                    <select
                      value={target}
                      required
                      disabled={!!projectId || !!busy}
                      onChange={(event) => setTarget(event.target.value)}
                    >
                      <option value="">Choose a project</option>
                      {eligibleProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Ticket title
                    <input
                      value={title}
                      maxLength={160}
                      required
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <label>
                    Additional brief
                    <textarea
                      rows={3}
                      maxLength={8000}
                      value={brief}
                      onChange={(event) => setBrief(event.target.value)}
                    />
                  </label>
                  <label>
                    Acceptance
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={acceptance}
                      required
                      onChange={(event) => setAcceptance(event.target.value)}
                    />
                  </label>
                  <div className="owner-ticket-ratings">
                    <label>
                      Priority
                      <input
                        id={`${id}-priority`}
                        type="range"
                        aria-label="Priority"
                        min={1}
                        max={5}
                        step={1}
                        value={priority}
                        onChange={(event) => setPriority(Number(event.target.value))}
                      />
                      <output htmlFor={`${id}-priority`} aria-hidden="true">
                        {priority}/5 · 1 low, 5 high
                      </output>
                    </label>
                    <label>
                      Estimated compute
                      <input
                        id={`${id}-compute`}
                        type="range"
                        aria-label="Estimated compute"
                        min={1}
                        max={5}
                        step={1}
                        value={compute}
                        onChange={(event) => setCompute(Number(event.target.value))}
                      />
                      <output htmlFor={`${id}-compute`} aria-hidden="true">
                        {compute}/5 · 1 small, 5 large
                      </output>
                    </label>
                  </div>
                  <p>
                    Queues one worker directly. Foreground work goes first; the project’s review
                    policy and allowance controls still apply. Compute is a relative estimate.
                  </p>
                  {stale && (
                    <p className="todo-error">
                      A selected to-do changed.{' '}
                      <button
                        type="button"
                        onClick={() =>
                          setSelected((old) =>
                            old.flatMap((source) => {
                              const latest = all.find((item) => item.id === source.id);
                              return latest && canQueue(latest) ? [latest] : [];
                            }),
                          )
                        }
                      >
                        Use latest selection
                      </button>
                    </p>
                  )}
                  {error?.id === 'ticket' && (
                    <p className="todo-error" role="alert">
                      {error.message} Your ticket is kept.
                    </p>
                  )}
                </div>
                <div className="owner-board-actions">
                  <button type="submit" disabled={locked || stale || !target || !selected.length}>
                    Queue with QUARK
                  </button>
                  <button type="button" disabled={!!busy} onClick={() => setPackaging(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </Modal>
        )}
        {unavailable ? (
          <p className="overview-empty">
            Could not load your to-dos.{' '}
            <button type="button" className="todo-inline-button" onClick={reading.retry}>
              Try again
            </button>
          </p>
        ) : !reading.data ? (
          <p className="overview-empty">Reading your to-dos…</p>
        ) : visible.length ? (
          <ul className={view === 'done' ? 'todo-completed-list' : 'todo-list'}>
            {visible.map((item) => {
              const task = tasks.find((task) => task.id === item.taskId);
              return (
                <li key={item.id}>
                  <div className="todo-row">
                    {view === 'done' ? (
                      <button
                        type="button"
                        className="todo-done"
                        disabled={locked}
                        aria-label={`Undo completion of “${item.title}”`}
                        onClick={() => reopen(item)}
                      >
                        Undo
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="todo-done"
                        disabled={locked}
                        aria-label={`Mark “${item.title}” done`}
                        onClick={() => complete(item)}
                      >
                        <Check size={16} />
                      </button>
                    )}
                    <span className="todo-text">
                      {(canQueue(item) ||
                        (item.kind === 'idea' && !item.managerId && item.status !== 'done')) && (
                        <label className="owner-item-selection">
                          <input
                            type="checkbox"
                            aria-label={`Select “${item.title}”`}
                            checked={selected.some((source) => source.id === item.id)}
                            disabled={
                              locked ||
                              (!selected.some((source) => source.id === item.id) &&
                                selected.length >= 20)
                            }
                            onChange={() => toggle(item)}
                          />
                          Select
                        </label>
                      )}
                      <strong>{item.title}</strong>
                      {item.detail && <span className="todo-detail">{item.detail}</span>}
                      <small>
                        {item.ownerTicketId
                          ? 'QUARK ticket'
                          : item.kind === 'idea'
                            ? 'Idea'
                            : item.managerId
                              ? 'Sent to'
                              : 'To-do'}
                        {item.projectId ? ` · ${names.get(item.projectId) ?? 'Project'}` : ''} ·{' '}
                        {statuses[item.status]}
                      </small>
                      {item.ownerTicketId && (
                        <small>
                          Source revision{' '}
                          {task?.ownerTicket?.sourceItems.find((source) => source.id === item.id)
                            ?.revision ?? 'saved'}{' '}
                          · {task?.title ?? 'Saved task'}
                          {` · task ${task?.status.replaceAll('_', ' ') ?? 'status unavailable'}`}
                          {task?.ownerTicket
                            ? ` · priority ${task.ownerTicket.priority}/5 · compute ${task.ownerTicket.estimatedCompute}/5`
                            : ''}
                        </small>
                      )}
                    </span>
                    <div className="owner-row-actions">
                      {item.taskId ? (
                        <a className="todo-action" href={`#/work/${item.taskId}`}>
                          Open ticket
                        </a>
                      ) : item.managerId ? (
                        <a className="todo-action" href={`#/chat/${item.managerId}`}>
                          Open chat
                        </a>
                      ) : view !== 'done' && item.kind === 'general' ? (
                        <button
                          type="button"
                          className="todo-action"
                          disabled={locked || !projects.length}
                          onClick={() => packageItems([item])}
                        >
                          Send to project
                        </button>
                      ) : (
                        view !== 'done' && (
                          <button
                            type="button"
                            className="todo-action"
                            disabled={locked}
                            onClick={() =>
                              void run(item.id, async () => {
                                await save(`actionable:${item.id}`, {
                                  id: item.id,
                                  expectedRevision: item.revision,
                                  kind: 'general',
                                });
                                setSelected((old) => old.filter((source) => source.id !== item.id));
                              })
                            }
                          >
                            Make to-do
                          </button>
                        )
                      )}
                      {view === 'idea' && onSeedProject && (
                        <button
                          type="button"
                          className="todo-action"
                          disabled={locked}
                          onClick={() => seed([item])}
                        >
                          Start new project
                        </button>
                      )}
                    </div>
                  </div>
                  {error?.id === item.id && (
                    <p className="todo-error" role="alert">
                      {error.message} The item is kept; try again.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : view === 'done' ? (
          <p className="overview-empty">Completed ideas and to-dos stay here. Undo reopens them.</p>
        ) : null}
      </div>
    </section>
  );
}

export function ProjectOwnerWorkBoard({
  project,
  state,
  onSeedProject,
}: {
  project: Project;
  state: Snapshot;
  onSeedProject?: (seed: ProjectIdeaSeed) => void;
}) {
  const reading = useReading(
    `/work-items?projectId=${encodeURIComponent(project.id)}`,
    workItemsSchema.parse,
  );
  return (
    <OwnerWorkBoard
      projects={[project]}
      tasks={state.tasks}
      reading={reading}
      projectId={project.id}
      onSeedProject={onSeedProject}
    />
  );
}
