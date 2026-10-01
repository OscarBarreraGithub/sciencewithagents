import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import {
  catalogPageSchema,
  catalogQuerySchema,
  historyItemSchema,
  historyPageSchema,
  historyQuerySchema,
  historyReadSchema,
  recoveryReasonSchema,
  recoveryRecordSchema,
  type HistoryItem,
  type HistoryQuery,
  type RecoveryReason,
} from '@dock/shared';
import { Conflict, Missing, Store, now, publicTask } from './store.js';

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    entries: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    throughEventId: z.number().int().nonnegative(),
    before: z.tuple([
      z.string().max(100),
      z.enum(['entry', 'decision']),
      z.number().int().positive(),
    ]),
  })
  .strict();

// Select only archived display evidence. Never search whole JSON bodies: private
// approval parameters and owner-only elicitation URLs are not model-facing evidence.
const archiveSql = `
  SELECT e.rowid AS ordinal, 'entry' AS source, e.id, a.project_id,
    e.agent_id, json_extract(a.body, '$.taskId') AS task_id,
    json_extract(e.body, '$.runId') AS run_id,
    CASE WHEN sender.project_id=a.project_id THEN sender.id ELSE NULL END AS sender_id,
    json_extract(e.body, '$.kind') AS kind, json_extract(e.body, '$.title') AS title,
    json_extract(e.body, '$.text') AS text, json_extract(e.body, '$.status') AS status,
    json_extract(e.body, '$.createdAt') AS created_at
  FROM entries e JOIN agents a ON a.id=e.agent_id
  LEFT JOIN runs r ON r.id=json_extract(e.body, '$.runId') AND r.agent_id=e.agent_id
  LEFT JOIN agents sender ON sender.id=json_extract(r.body, '$.sourceId')
  UNION ALL
  SELECT d.rowid, 'decision', d.id, d.project_id, json_extract(d.body, '$.agentId'),
    json_extract(d.body, '$.taskId'), NULL, NULL, json_extract(d.body, '$.kind'),
    'Decision: ' || json_extract(d.body, '$.kind'),
    json_extract(d.body, '$.rationale') || char(10) || char(10) || 'Evidence: ' || json_extract(d.body, '$.evidence'),
    'recorded', json_extract(d.body, '$.createdAt')
  FROM decisions d`;

type ArchiveRow = {
  ordinal: number;
  source: 'entry' | 'decision';
  id: string;
  project_id: string;
  agent_id: string;
  task_id: string | null;
  run_id: string | null;
  sender_id: string | null;
  kind: string;
  title: string;
  text: string;
  status: string;
  created_at: string;
};

function scopeFor(projectId: string, query: HistoryQuery) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        projectId,
        query.agentId ?? null,
        query.taskId ?? null,
        query.source,
        query.query,
      ]),
    )
    .digest('hex');
}

function projectScope(store: Store, projectId: string, agentId?: string, taskId?: string) {
  store.project(projectId);
  if (agentId && store.agent(agentId).projectId !== projectId)
    throw new Conflict('Agent is outside this project.');
  if (taskId && store.task(taskId).projectId !== projectId)
    throw new Conflict('Task is outside this project.');
}

function projectItem(row: ArchiveRow, offset: number, limit: number): HistoryItem {
  return historyItemSchema.parse({
    source: row.source,
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    runId: row.run_id,
    senderId: row.sender_id,
    kind: row.kind,
    title: row.title.slice(0, 2000),
    text: row.text.slice(offset, offset + limit),
    status: row.status,
    createdAt: row.created_at,
    offset,
    totalCharacters: row.text.length,
    nextOffset: offset + limit < row.text.length ? offset + limit : null,
  });
}

/** Newest-first, project-bound keyset pagination. Refresh to include newly recorded items. */
export function historyPage(store: Store, projectId: string, raw: unknown) {
  const query = historyQuerySchema.parse(raw);
  projectScope(store, projectId, query.agentId, query.taskId);
  const scope = scopeFor(projectId, query);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new Conflict('This history page is no longer valid. Start the search again.');
    }
    if (cursor.scope !== scope)
      throw new Conflict('This history page belongs to a different project or search.');
  }
  const entries =
    cursor?.entries ??
    Number(store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM entries').get()!.value);
  const decisions =
    cursor?.decisions ??
    Number(store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM decisions').get()!.value);
  const throughEventId = cursor?.throughEventId ?? store.head;
  const where = [
    'project_id=?',
    "((source='entry' AND ordinal<=?) OR (source='decision' AND ordinal<=?))",
  ];
  const args: SQLInputValue[] = [projectId, entries, decisions];
  if (query.agentId) {
    where.push('agent_id=?');
    args.push(query.agentId);
  }
  if (query.taskId) {
    where.push('task_id=?');
    args.push(query.taskId);
  }
  if (query.source === 'conversations') where.push("source='entry'");
  if (query.source === 'messages') where.push("source='entry' AND kind='message'");
  if (query.source === 'decisions') where.push("source='decision'");
  if (query.query) {
    where.push("instr(lower(COALESCE(title,'') || char(10) || COALESCE(text,'')),lower(?))>0");
    args.push(query.query);
  }
  if (cursor) {
    where.push('(created_at,source,ordinal)<(?,?,?)');
    args.push(...cursor.before);
  }
  args.push(query.limit + 1);
  const rows = store.db
    .prepare(
      `WITH archive AS (${archiveSql}) SELECT * FROM archive WHERE ${where.join(' AND ')} ORDER BY created_at DESC, source DESC, ordinal DESC LIMIT ?`,
    )
    .all(...args) as unknown as ArchiveRow[];
  const selected = rows.slice(0, query.limit);
  const last = selected.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            scope,
            entries,
            decisions,
            throughEventId,
            before: [last.created_at, last.source, last.ordinal],
          }),
        ).toString('base64url')
      : null;
  return historyPageSchema.parse({
    items: selected.map((row) => {
      const match = query.query ? row.text.toLowerCase().indexOf(query.query.toLowerCase()) : -1;
      return projectItem(row, Math.max(0, match - 100), 1200);
    }),
    nextCursor,
    throughEventId,
    notice:
      'Saved visible evidence, not hidden context. New records appear after refresh; an existing streaming item may finish while you browse. Search matches literal text (ASCII case-insensitive). Open a result to read all retained text.',
  });
}

/** Read all retained characters in bounded chunks, without a filesystem or raw JSON endpoint. */
export function historyRead(store: Store, projectId: string, raw: unknown) {
  const input = historyReadSchema.parse(raw);
  projectScope(store, projectId);
  const row = store.db
    .prepare(
      `WITH archive AS (${archiveSql}) SELECT * FROM archive WHERE project_id=? AND source=? AND id=?`,
    )
    .get(projectId, input.source, input.id) as ArchiveRow | undefined;
  if (!row) throw new Missing('Saved evidence was not found in this project.');
  if (input.offset > row.text.length)
    throw new Conflict('This saved item changed. Open it again from the beginning.');
  return projectItem(row, input.offset, input.limit);
}

const catalogCursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().length(64),
    maximum: z.number().int().nonnegative(),
    before: z.number().int().positive(),
  })
  .strict();

/** Discover every recorded identity, including idle agents without conversation entries. */
export function projectCatalog(store: Store, projectId: string, raw: unknown) {
  const query = catalogQuerySchema.parse(raw);
  projectScope(store, projectId);
  const agentStatuses = ['idle', 'queued', 'running', 'waiting', 'interrupted', 'failed'];
  const taskStatuses = [
    'open',
    'working',
    'review',
    'needs_decision',
    'done',
    'integrated',
    'split',
    'cancelled',
  ];
  if (
    !['all', 'active', ...(query.kind === 'agents' ? agentStatuses : taskStatuses)].includes(
      query.status,
    )
  )
    throw new Conflict('This status does not apply to the selected catalog.');
  const scope = createHash('sha256')
    .update(JSON.stringify([projectId, query.kind, query.query, query.status]))
    .digest('hex');
  let cursor: z.infer<typeof catalogCursorSchema> | undefined;
  if (query.cursor) {
    try {
      cursor = catalogCursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new Conflict('This catalog page is no longer valid. Start the search again.');
    }
    if (cursor.scope !== scope)
      throw new Conflict('This catalog page belongs to a different project or search.');
  }
  // Only these two fixed table names can reach SQL; all browser values are bound.
  const table = query.kind === 'agents' ? 'agents' : 'tasks';
  const maximum =
    cursor?.maximum ??
    Number(store.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS value FROM ${table}`).get()!.value);
  const where = ['project_id=?', 'rowid<=?'];
  const args: SQLInputValue[] = [projectId, maximum];
  const title =
    query.kind === 'agents' ? "json_extract(body, '$.name')" : "json_extract(body, '$.title')";
  const summary =
    query.kind === 'agents'
      ? "COALESCE(json_extract(body, '$.scope'),'')"
      : "json_extract(body, '$.goal') || char(10) || json_extract(body, '$.acceptance')";
  if (query.status === 'active')
    where.push(
      query.kind === 'agents'
        ? "json_extract(body, '$.status')<>'idle'"
        : "json_extract(body, '$.status') IN ('open','working','review','needs_decision')",
    );
  else if (query.status !== 'all') {
    where.push("json_extract(body, '$.status')=?");
    args.push(query.status);
  }
  if (query.query) {
    where.push(`instr(lower(${title} || char(10) || ${summary}),lower(?))>0`);
    args.push(query.query);
  }
  const total = Number(
    store.db
      .prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where.join(' AND ')}`)
      .get(...args)!.value,
  );
  if (cursor) {
    where.push('rowid<?');
    args.push(cursor.before);
  }
  const rows = store.db
    .prepare(
      `SELECT rowid AS ordinal, id, ${title} AS title, ${summary} AS summary,
    json_extract(body, '$.status') AS status, json_extract(body, '$.role') AS role,
    json_extract(body, '$.managerId') AS manager_id, json_extract(body, '$.parentId') AS parent_id,
    json_extract(body, '$.taskId') AS task_id, json_extract(body, '$.createdAt') AS created_at
    FROM ${table} WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...args, query.limit + 1);
  const selected = rows.slice(0, query.limit);
  const last = selected.at(-1);
  return catalogPageSchema.parse({
    items: selected.map((row) => ({
      id: row.id,
      projectId,
      kind: query.kind,
      title: row.title,
      summary: String(row.summary).slice(0, 3000),
      status: row.status,
      role: row.role,
      managerId: row.manager_id,
      parentId: row.parent_id,
      taskId: row.task_id,
      createdAt: row.created_at,
    })),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({ version: 1, scope, maximum, before: Number(last.ordinal) }),
          ).toString('base64url')
        : null,
    total,
    notice:
      'Recorded identities, newest first. Refresh for newly created identities or changed status. Summaries are previews; inspect the exact ID for full current task or agent state. This catalog does not invent relationships for imported history.',
  });
}

const recoveryNotice =
  'Host-written references to retained evidence, not an agent-authored summary or hidden context/cache backup. Resume the recorded Codex thread when available. Never automatically repeat an uncertain action or reuse expired approval. Imported history does not reconstruct earlier agent relationships.';

/** Append at host lifecycle boundaries, even when the worker never saved a checkpoint. */
export function recordRecovery(store: Store, agentId: string, reason: RecoveryReason) {
  recoveryReasonSchema.parse(reason);
  store.db.exec('SAVEPOINT history_recovery');
  try {
    const agent = store.agent(agentId);
    const task = agent.taskId ? store.task(agent.taskId) : null;
    const runs = store.runs().filter((run) => run.agentId === agentId);
    const latestRun = runs.at(-1);
    const unsettled = runs.filter((run) =>
      ['running', 'failed', 'interrupted'].includes(run.status),
    );
    const approvals = store.approvals().filter((approval) => approval.agentId === agentId);
    const throughEventId = Number(
      store.db
        .prepare(
          "SELECT COALESCE(MAX(id),0) AS value FROM events WHERE type<>'recovery.recorded' AND (agent_id=? OR (project_id=? AND agent_id IS NULL))",
        )
        .get(agentId, agent.projectId)!.value,
    );
    const pending = approvals.filter((approval) => approval.status === 'pending');
    const value = recoveryRecordSchema.parse({
      id: randomUUID(),
      recordedAt: now(),
      throughEventId,
      reason,
      author: 'host',
      projectId: agent.projectId,
      agentId,
      agentName: agent.name,
      status: agent.status,
      parentId: agent.parentId,
      nativeRootId: agent.nativeRootId,
      provider: agent.provider,
      threadId: agent.threadId,
      turnId: agent.turnId,
      checkpointAvailable: Boolean(agent.checkpoint),
      historyOrigin: store.db
        .prepare("SELECT 1 FROM events WHERE agent_id=? AND type='session.imported' LIMIT 1")
        .get(agentId)
        ? 'imported'
        : 'managed',
      task: task
        ? {
            id: task.id,
            managerId: task.managerId,
            title: task.title,
            status: task.status,
            revisions: task.revisions,
            review: task.review,
            baseCommit: task.baseCommit,
            reviewedCommit: task.reviewedCommit,
          }
        : null,
      recentEntryIds: store.entries(agentId, undefined, 12).map((entry) => entry.id),
      latestRun: latestRun
        ? {
            id: latestRun.id,
            kind: latestRun.kind,
            status: latestRun.status,
            sourceId: latestRun.sourceId,
            turnId: latestRun.turnId,
          }
        : null,
      unsettledRuns: unsettled.slice(-20).map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        sourceId: run.sourceId,
        turnId: run.turnId,
      })),
      unsettledRunCount: unsettled.length,
      queuedRunCount: runs.filter((run) => run.status === 'queued').length,
      approvals: [
        ...pending,
        ...approvals.filter((approval) => approval.status !== 'pending').reverse(),
      ]
        .slice(0, 20)
        .map((approval) => ({
          id: approval.id,
          kind: approval.kind,
          status: approval.status,
          createdAt: approval.createdAt,
        })),
      pendingApprovalCount: pending.length,
      nextAction: agent.nativeRootId
        ? 'parent_controls'
        : ['interrupted', 'failed'].includes(agent.status)
          ? 'inspect_interruption'
          : pending.length
            ? 'answer_approval'
            : ['running', 'queued', 'waiting'].includes(agent.status)
              ? 'wait'
              : 'ready',
      notice: recoveryNotice,
    });
    const previous = latestRecovery(store, agent.projectId, agentId);
    // Calling the boundary twice is not another recovery event. Source state is
    // authoritative; no provider turn, checkpoint, approval or task is modified.
    if (previous?.throughEventId === throughEventId && previous.reason === reason) {
      store.db.exec('RELEASE history_recovery');
      return previous;
    }
    store.event('recovery.recorded', agent.projectId, agentId, value);
    store.db.exec('RELEASE history_recovery');
    return value;
  } catch (error) {
    store.db.exec('ROLLBACK TO history_recovery; RELEASE history_recovery');
    throw error;
  }
}

export function latestRecovery(store: Store, projectId: string, agentId: string) {
  projectScope(store, projectId, agentId);
  const row = store.db
    .prepare(
      "SELECT data FROM events WHERE project_id=? AND agent_id=? AND type='recovery.recorded' ORDER BY id DESC LIMIT 1",
    )
    .get(projectId, agentId);
  return row ? recoveryRecordSchema.parse(JSON.parse(String(row.data))) : null;
}

/** Keep old active work visible before recent completed records consume the prompt budget. */
export function projectContextEvidence(store: Store, projectId: string, focusAgentId: string) {
  projectScope(store, projectId, focusAgentId);
  const focus = store.agent(focusAgentId);
  const tasks = store.tasks().filter((task) => task.projectId === projectId);
  const agents = store.agents().filter((agent) => agent.projectId === projectId);
  const activeTasks = new Set(['open', 'working', 'review', 'needs_decision']);
  const selectedTasks = [...tasks]
    .sort(
      (a, b) =>
        Number(b.id === focus.taskId) - Number(a.id === focus.taskId) ||
        Number(activeTasks.has(b.status)) - Number(activeTasks.has(a.status)) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.id.localeCompare(a.id),
    )
    .slice(0, 30);
  const taskIds = new Set(selectedTasks.map((task) => task.id));
  const selectedAgents = [...agents]
    .sort(
      (a, b) =>
        Number(b.id === focus.id) - Number(a.id === focus.id) ||
        Number(b.role === 'manager') - Number(a.role === 'manager') ||
        Number(b.status !== 'idle') - Number(a.status !== 'idle') ||
        Number(Boolean(b.taskId && taskIds.has(b.taskId))) -
          Number(Boolean(a.taskId && taskIds.has(a.taskId))) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.id.localeCompare(a.id),
    )
    .slice(0, 40);
  return {
    tasks: selectedTasks.map(publicTask),
    agents: selectedAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      taskId: agent.taskId,
      parentId: agent.parentId,
      nativeRootId: agent.nativeRootId,
      nativePath: agent.nativePath,
      nativeThreadId: agent.nativeRootId ? agent.threadId : undefined,
    })),
    omitted: {
      tasks: tasks.length - selectedTasks.length,
      agents: agents.length - selectedAgents.length,
      activeTasks: tasks.filter((task) => activeTasks.has(task.status) && !taskIds.has(task.id))
        .length,
    },
    history: {
      available: true,
      notice:
        'This is an active-first bounded overview, not the full archive. Use catalog paging to discover every agent/task ID and status. Search and page retained conversations, peer messages and decisions; open source items for all retained text.',
    },
  };
}
