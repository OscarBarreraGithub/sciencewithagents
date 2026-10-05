import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  managerWorkItemRequestSchema,
  ownerTicketRequestSchema,
  ownerTicketResultSchema,
  taskCreateSchema,
  jobEstimateSchema,
  modelPolicySchema,
  defaultModelPolicy,
  policyProvider,
  workerDefault,
  ownerRequestQuerySchema,
  ownerRequestHttpQuerySchema,
  ownerRequestPageSchema,
  projectNotesRequestSchema,
  projectNotesSchema,
  workItemQuerySchema,
  workItemPageQuerySchema,
  workItemPageSchema,
  workItemRequestSchema,
  workItemSchema,
  workItemsSchema,
  type ProjectNotes,
  type WorkItem,
  type WorkItemRequest,
} from '@dock/shared';
import { Conflict, Missing, now, Store, publicTask } from './store.js';
import { projectWorkflow } from './project-workflow.js';
import { delegationTools } from './worker-tools.js';

const requestCursor = z
  .object({
    managerId: z.string().uuid(),
    maximum: z.number().int().nonnegative(),
    before: z.number().int().positive(),
    includeHandled: z.boolean(),
  })
  .strict();
// Native owner steering used a system entry before structured provenance existed.
// It was written only after confirmation. Queued/cancelled runs remain visibly distinct.
const ownerSourceSql = `e.agent_id=? AND (
  (json_extract(e.body,'$.kind')='user' AND (json_extract(e.body,'$.ownerInput') IS NOT NULL OR
    r.id IS NULL OR (json_extract(r.body,'$.sourceId') IS NULL AND json_extract(r.body,'$.kind')='user' AND (e.id!=r.id OR r.key NOT LIKE 'native:%'))))
  OR (json_extract(e.body,'$.kind')='system' AND json_extract(e.body,'$.title')='Owner steering')
)`;

/** Durable asks, internal follow-ups and personal to-dos on the existing store/queue. */
export class WorkItems {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        manager_id TEXT REFERENCES agents(id),
        task_id TEXT REFERENCES tasks(id),
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_items_project ON work_items(project_id);
      CREATE TABLE IF NOT EXISTS work_item_sources (
        item_id TEXT NOT NULL REFERENCES work_items(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        entry_id TEXT NOT NULL REFERENCES entries(id),
        PRIMARY KEY(item_id,entry_id)
      );
      CREATE INDEX IF NOT EXISTS work_item_sources_entry ON work_item_sources(agent_id,entry_id);
      INSERT OR IGNORE INTO work_item_sources(item_id,agent_id,entry_id)
        SELECT w.id,json_extract(s.value,'$.agentId'),json_extract(s.value,'$.entryId')
        FROM work_items w,json_each(w.body,'$.sourceMessages') s;
      CREATE TABLE IF NOT EXISTS project_notes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        body TEXT NOT NULL
      );
    `);
  }

  get(id: string): WorkItem {
    const row = this.store.db.prepare('SELECT body FROM work_items WHERE id=?').get(id);
    if (!row) throw new Missing('To-do not found.');
    return workItemSchema.parse(JSON.parse(String(row.body)));
  }

  list(raw: unknown = {}) {
    const query = workItemQuerySchema.parse(raw);
    if (query.projectId) this.store.project(query.projectId);
    const rows = query.projectId
      ? this.store.db
          .prepare('SELECT body FROM work_items WHERE project_id=? ORDER BY rowid DESC')
          .all(query.projectId)
      : this.store.db.prepare('SELECT body FROM work_items ORDER BY rowid DESC').all();
    return workItemsSchema.parse({ items: rows.map((row) => JSON.parse(String(row.body))) });
  }

  page(projectId: string, raw: unknown = {}) {
    this.store.project(projectId);
    const query = workItemPageQuerySchema.parse(raw);
    const cursor = query.cursor
      ? this.store.db
          .prepare('SELECT rowid FROM work_items WHERE project_id=? AND id=?')
          .get(projectId, query.cursor)
      : undefined;
    if (query.cursor && !cursor) throw new Missing('Work-item cursor not found in this project.');
    const boundary = cursor ? Number(cursor.rowid) : Number.MAX_SAFE_INTEGER;
    const where = "project_id=? AND (? OR json_extract(body,'$.status')!='done')";
    const total = Number(
      this.store.db
        .prepare(`SELECT count(*) AS count FROM work_items WHERE ${where}`)
        .get(projectId, Number(query.includeDone))!.count,
    );
    const rows = this.store.db
      .prepare(
        `SELECT rowid, body FROM work_items WHERE ${where} AND rowid<? ORDER BY rowid DESC LIMIT ?`,
      )
      .all(projectId, Number(query.includeDone), boundary, query.limit);
    const last = rows.at(-1);
    const remaining = last
      ? Number(
          this.store.db
            .prepare(`SELECT count(*) AS count FROM work_items WHERE ${where} AND rowid<?`)
            .get(projectId, Number(query.includeDone), Number(last.rowid))!.count,
        )
      : 0;
    const items = rows.map((row) => workItemSchema.parse(JSON.parse(String(row.body))));
    return workItemPageSchema.parse({
      items,
      total,
      remaining,
      nextCursor: remaining ? items.at(-1)!.id : null,
    });
  }

  save(raw: unknown): WorkItem {
    return this.mutate(workItemRequestSchema.parse(raw), null);
  }

  ticket(raw: unknown) {
    const input = ownerTicketRequestSchema.parse(raw);
    return ownerTicketResultSchema.parse(
      this.store.operation(`owner-ticket:${input.key}`, input, () => {
        const project = this.store.project(input.projectId);
        if (project.internal) throw new Conflict('Choose an existing work project.');
        this.store.requireActiveAgent(project.managerId);
        const selected = input.items.map((ref) => {
          const item = this.get(ref.id);
          if (item.revision !== ref.expectedRevision)
            throw new Conflict('A selected to-do changed. Refresh the selection before queueing.');
          if (item.kind !== 'general')
            throw new Conflict('Make an idea actionable before queueing it as a to-do.');
          if (item.status === 'done' || item.taskId || item.assignmentRunId || item.managerId)
            throw new Conflict('Select open, unassigned to-dos. Existing assignments are kept.');
          if (item.projectId && item.projectId !== project.id)
            throw new Conflict('A selected to-do belongs to another project.');
          return item;
        });
        const policy = modelPolicySchema.parse(
          this.store.getSetting('model-policy') ?? defaultModelPolicy,
        );
        const provider = this.store.getSetting(`project-workflow:${project.id}`)
          ? workerDefault(projectWorkflow(this.store, project.id), 'research').provider
          : policyProvider(policy, 'reasoning');
        if (!provider || !policy.enabledProviders.includes(provider))
          throw new Conflict(
            'Choose an enabled worker provider in this project’s model settings first.',
          );
        const grant = delegationTools(this.store, project.id, provider);
        const goal = [
          input.brief,
          'Owner-selected to-dos:',
          ...selected.map(
            (item, index) =>
              `${index + 1}. ${item.title}\n${item.detail}\nSaved source: ${item.id}, revision ${item.revision}`,
          ),
        ]
          .filter(Boolean)
          .join('\n\n');
        const fields = taskCreateSchema.parse({
          title: input.title,
          goal,
          acceptance: input.acceptance,
        });
        const task = this.store.addTask(project.id, {
          ...fields,
          parentId: null,
          ownerTicket: {
            id: randomUUID(),
            priority: input.priority,
            estimatedCompute: input.estimatedCompute,
            sourceItems: selected.map(({ id, revision, title }) => ({ id, revision, title })),
          },
          scheduling: jobEstimateSchema.parse({
            priority: 'background',
            estimateNote: `Owner-estimated relative compute ${input.estimatedCompute}/5. Planning estimates are not spending limits.`,
          }),
        });
        const worker = this.store.addAgent({
          projectId: project.id,
          parentId: task.managerId,
          taskId: task.id,
          role: 'implementer',
          name: 'QUARK ticket worker',
          cwd: project.root,
          provider,
        });
        this.store.updateAgent(worker.id, {
          modelSelection: 'policy',
          toolPolicy: grant.toolPolicy,
          ...grant.tools,
        });
        this.store.setSetting(`model-policy:follow:${worker.id}`, true);
        this.store.setSetting(`worker-tools:grant:${worker.id}`, {
          projectId: project.id,
          revision: grant.revision,
          tools: grant.tools,
        });
        const run = this.store.enqueue(
          worker.id,
          `owner-ticket:${task.id}`,
          [
            'The owner approved this self-contained background ticket. Implement the selected work directly; no initial manager permission/delegation turn is needed.',
            `Task: ${task.title}\nOutcome: ${task.goal}\nAcceptance: ${task.acceptance}`,
            'Keep work bounded, preserve progress and report to the responsible manager for existing independent review/application policy. Do not bypass human review or the two correction-round limit.',
          ].join('\n\n'),
          'delegation',
          task.managerId,
        );
        this.store.setSetting(`owner-ticket:run:${run.id}`, task.id);
        const timestamp = now();
        const linked = selected.map((item) => {
          const value = workItemSchema.parse({
            ...item,
            projectId: project.id,
            managerId: task.managerId,
            taskId: task.id,
            ownerTicketId: task.ownerTicket!.id,
            status: 'in_progress',
            revision: item.revision + 1,
            updatedAt: timestamp,
            resolvedAt: null,
          });
          this.store.db
            .prepare('UPDATE work_items SET project_id=?,manager_id=?,task_id=?,body=? WHERE id=?')
            .run(project.id, task.managerId, task.id, JSON.stringify(value), item.id);
          this.store.event('work-item.updated', project.id, null, {
            item: value,
            actorManagerId: null,
          });
          return value;
        });
        const updated = this.store.updateTask(task.id, { status: 'working' });
        this.store.event('owner-ticket.queued', project.id, null, {
          taskId: task.id,
          workerId: worker.id,
          runId: run.id,
        });
        return { task: publicTask(updated), workerId: worker.id, runId: run.id, items: linked };
      }),
    );
  }

  /** Call in the acknowledgement transaction: a disposition covered the earlier wording. */
  sourceChanged(agentId: string, entryId: string) {
    const rows = this.store.db
      .prepare(
        `SELECT w.body FROM work_item_sources s
      JOIN work_items w ON w.id=s.item_id WHERE s.agent_id=? AND s.entry_id=?
      AND json_extract(w.body,'$.sourceDisposition') IS NOT NULL`,
      )
      .all(agentId, entryId);
    for (const row of rows) {
      const previous = workItemSchema.parse(JSON.parse(String(row.body)));
      const next = {
        ...previous,
        sourceDisposition: null,
        revision: previous.revision + 1,
        updatedAt: now(),
      };
      this.store.db
        .prepare('UPDATE work_items SET body=? WHERE id=?')
        .run(JSON.stringify(next), previous.id);
      this.store.event('work-item.source-changed', previous.projectId, previous.managerId, {
        itemId: previous.id,
        agentId,
        entryId,
        revision: next.revision,
        previousDisposition: previous.sourceDisposition,
      });
    }
  }

  /** Durable inputs are paged independently of the recent conversation preview. */
  ownerRequests(managerId: string, raw: unknown = {}) {
    this.manager(managerId);
    const query = ownerRequestQuerySchema.parse(raw);
    let cursor: z.infer<typeof requestCursor> | undefined;
    if (query.cursor) {
      try {
        cursor = requestCursor.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw new Conflict('Invalid owner-request cursor. Refresh this list.');
      }
      if (cursor.managerId !== managerId || cursor.includeHandled !== query.includeHandled)
        throw new Conflict('Owner-request cursor belongs to another manager or filter.');
    }
    const maximum =
      cursor?.maximum ??
      Number(
        this.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS maximum FROM entries').get()!
          .maximum,
      );
    const handled = query.includeHandled
      ? ''
      : " AND NOT EXISTS (SELECT 1 FROM work_item_sources s JOIN work_items w ON w.id=s.item_id WHERE s.agent_id=e.agent_id AND s.entry_id=e.id AND json_extract(w.body,'$.sourceDisposition') IS NOT NULL)";
    const from = `FROM entries e LEFT JOIN runs r ON r.id=json_extract(e.body,'$.runId') AND r.agent_id=e.agent_id WHERE ${ownerSourceSql} AND e.rowid<=?${handled}`;
    const total = Number(
      this.store.db.prepare(`SELECT count(*) AS total ${from}`).get(managerId, maximum)!.total,
    );
    const rows = this.store.db
      .prepare(
        `SELECT e.rowid,e.body,json_extract(r.body,'$.status') AS run_status ${from} AND e.rowid<? ORDER BY e.rowid DESC LIMIT ?`,
      )
      .all(managerId, maximum, cursor?.before ?? Number.MAX_SAFE_INTEGER, query.limit + 1);
    const selected = rows.slice(0, query.limit);
    const items = selected.map((row) => {
      const entry = JSON.parse(String(row.body)) as {
        id: string;
        text: string;
        createdAt: string;
        kind: string;
        ownerInput?: { delivery: string };
      };
      const links = this.store.db
        .prepare(
          "SELECT w.id,json_extract(w.body,'$.sourceDisposition') AS disposition FROM work_item_sources s JOIN work_items w ON w.id=s.item_id WHERE s.agent_id=? AND s.entry_id=? ORDER BY w.id",
        )
        .all(managerId, entry.id);
      return {
        agentId: managerId,
        entryId: entry.id,
        text: entry.text.slice(0, 1200),
        totalCharacters: entry.text.length,
        createdAt: entry.createdAt,
        delivery:
          entry.ownerInput?.delivery ??
          (entry.kind === 'system' ? 'submitted' : String(row.run_status ?? 'retained')),
        coverage: links.some((link) => link.disposition !== null)
          ? 'triaged'
          : links.length
            ? 'linked'
            : 'untriaged',
        workItemIds: links.map((link) => String(link.id)),
      };
    });
    return ownerRequestPageSchema.parse({
      items,
      total,
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({
                managerId,
                maximum,
                before: Number(selected.at(-1)!.rowid),
                includeHandled: query.includeHandled,
              }),
            ).toString('base64url')
          : null,
      notice:
        'Retained owner messages, not automatically classified tasks. A source link alone leaves the message pending review. After reviewing the whole message and mapping all independent asks, record a sourceDisposition describing that triage or an explicit answer/cancellation/replacement. Triaged does not mean completed. Continue unrelated work. Delivery states do not claim failed, cancelled or uncertain input was received. Refresh for new inputs; use history/read for full text.',
    });
  }

  saveForManager(managerId: string, raw: unknown): WorkItem {
    const manager = this.manager(managerId);
    const input = managerWorkItemRequestSchema.parse(raw);
    return this.mutate(
      {
        ...input,
        projectId: manager.projectId,
        managerId,
        ...(!input.id && !input.kind ? { kind: 'internal' as const } : {}),
      },
      managerId,
    );
  }

  private manager(id: string) {
    const manager = this.store.agent(id);
    if (manager.role !== 'manager' || manager.interview)
      throw new Conflict('Choose an existing project manager.');
    return manager;
  }

  private mutate(input: WorkItemRequest, actorManagerId: string | null): WorkItem {
    return workItemSchema.parse(
      this.store.operation(
        `work-item:${input.key}`,
        {
          actorManagerId,
          input,
        },
        () => {
          const previous = input.id ? this.get(input.id) : null;
          if (previous) {
            if (input.expectedRevision !== previous.revision)
              throw new Conflict('This to-do changed. Refresh it before saving your changes.');
            if (actorManagerId && previous.managerId !== actorManagerId)
              throw new Conflict('Managers can only change their own to-dos and human asks.');
          } else if ((input.expectedRevision ?? 0) !== 0) {
            throw new Conflict('A new to-do must start at revision zero.');
          }
          if (!previous && !input.title) throw new Conflict('Give this to-do a concise title.');

          let projectId =
            input.projectId !== undefined ? input.projectId : (previous?.projectId ?? null);
          const managerId =
            input.managerId !== undefined ? input.managerId : (previous?.managerId ?? null);
          const taskId = input.taskId !== undefined ? input.taskId : (previous?.taskId ?? null);
          const kind = input.kind ?? previous?.kind ?? 'general';
          if (actorManagerId && kind === 'idea') throw new Conflict('Ideas belong to the owner.');
          if (managerId) {
            const manager = this.manager(managerId);
            // Selecting a manager assigns an unscoped personal to-do to their project.
            if (
              input.projectId === undefined &&
              (!previous?.projectId || input.managerId !== undefined)
            )
              projectId = manager.projectId;
            if (manager.projectId !== projectId)
              throw new Conflict('Select a manager belonging to this project.');
          }
          if (projectId) this.store.project(projectId);
          if (!['general', 'idea'].includes(kind) && (!projectId || !managerId))
            throw new Conflict('Human asks and internal to-dos need a project manager.');
          if (taskId) {
            const task = this.store.task(taskId);
            if (task.projectId !== projectId || task.managerId !== managerId)
              throw new Conflict('Select a task belonging to this project and manager.');
          }
          if (
            previous?.managerId &&
            (previous.managerId !== managerId || previous.projectId !== projectId)
          )
            throw new Conflict('An assigned to-do keeps its original project and manager.');
          if (previous?.humanReply && (kind !== previous.kind || taskId !== previous.taskId))
            throw new Conflict('An answered ask keeps its original kind and task.');
          if (previous?.ownerTicketId && (kind !== previous.kind || taskId !== previous.taskId))
            throw new Conflict('A queued ticket keeps its saved source and task binding.');
          const sources = input.sourceMessages ?? previous?.sourceMessages ?? [];
          const sourceKeys = (values: WorkItem['sourceMessages']) =>
            values.map((source) => `${source.agentId}:${source.entryId}`).toSorted();
          const sourcesChanged =
            JSON.stringify(sourceKeys(sources)) !==
            JSON.stringify(sourceKeys(previous?.sourceMessages ?? []));
          if (sources.length && !managerId)
            throw new Conflict('Source messages need their original project manager.');
          for (const source of sources) {
            if (source.agentId !== managerId)
              throw new Conflict('Source messages belong to the receiving manager.');
            if (
              !this.store.db
                .prepare(
                  `SELECT e.id FROM entries e LEFT JOIN runs r ON r.id=json_extract(e.body,'$.runId') AND r.agent_id=e.agent_id WHERE ${ownerSourceSql} AND e.id=?`,
                )
                .get(managerId, source.entryId)
            )
              throw new Conflict('Source is not a retained owner message for this manager.');
          }
          if (input.sourceDisposition && !sources.length)
            throw new Conflict('A source disposition needs a saved source message.');
          const timestamp = now();
          let status = input.status ?? previous?.status ?? (kind === 'human' ? 'waiting' : 'open');
          const value: WorkItem = {
            id: previous?.id ?? randomUUID(),
            projectId,
            managerId,
            taskId,
            kind,
            title: input.title ?? previous!.title,
            detail: input.detail ?? previous?.detail ?? '',
            status,
            revision: (previous?.revision ?? 0) + 1,
            humanReply: previous?.humanReply ?? null,
            repliedAt: previous?.repliedAt ?? null,
            replyRunId: previous?.replyRunId ?? null,
            assignmentRunId: previous?.assignmentRunId ?? null,
            ownerTicketId: previous?.ownerTicketId ?? null,
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
            resolvedAt: null,
            sourceMessages: sources,
            sourceDisposition:
              input.sourceDisposition !== undefined
                ? input.sourceDisposition
                : sourcesChanged
                  ? null
                  : (previous?.sourceDisposition ?? null),
          };
          if (
            kind === 'human' &&
            (value.detail.length > 480 || value.detail.split(/\r?\n/).length > 2)
          )
            throw new Conflict(
              'Keep a human ask to a concise title and one or two short lines of detail.',
            );
          if (input.humanReply !== undefined) {
            if (!previous || kind !== 'human' || !managerId)
              throw new Conflict('Reply to an existing human ask linked to a project manager.');
            if (previous.humanReply !== null || previous.status === 'done')
              throw new Conflict(
                'This ask is already answered or closed. Refresh to see the saved reply.',
              );
            if (input.status !== undefined && !['in_progress', 'done'].includes(input.status))
              throw new Conflict('An answered ask must be in progress or done.');
            status = input.status ?? 'in_progress';
            const run = this.store.enqueue(
              managerId,
              `work-item-reply:${value.id}`,
              [
                'The owner replied to your saved human ask.',
                this.context(value),
                `Owner reply: ${input.humanReply}`,
                'Continue the linked work using this answer. Keep the saved to-do status current.',
              ].join('\n\n'),
            );
            value.humanReply = input.humanReply;
            value.repliedAt = timestamp;
            value.replyRunId = run.id;
          }
          if (kind === 'general' && managerId && !previous?.managerId && !actorManagerId) {
            if (status === 'done')
              throw new Conflict('Reopen this to-do before assigning it to a manager.');
            const run = this.store.enqueue(
              managerId,
              `work-item-assignment:${value.id}`,
              [
                'The owner assigned you a saved to-do.',
                this.context(value),
                'Handle this within the project and keep its saved to-do status current.',
              ].join('\n\n'),
            );
            value.assignmentRunId = run.id;
            status = 'in_progress';
          }
          value.status = status;
          value.resolvedAt = status === 'done' ? (previous?.resolvedAt ?? timestamp) : null;
          const saved = workItemSchema.parse(value);
          this.store.db
            .prepare(
              `
        INSERT INTO work_items(id,project_id,manager_id,task_id,body) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,manager_id=excluded.manager_id,
          task_id=excluded.task_id,body=excluded.body
      `,
            )
            .run(saved.id, projectId, managerId, taskId, JSON.stringify(saved));
          this.store.db.prepare('DELETE FROM work_item_sources WHERE item_id=?').run(saved.id);
          const link = this.store.db.prepare(
            'INSERT INTO work_item_sources(item_id,agent_id,entry_id) VALUES(?,?,?)',
          );
          for (const source of saved.sourceMessages)
            link.run(saved.id, source.agentId, source.entryId);
          this.store.event(
            previous ? 'work-item.updated' : 'work-item.created',
            projectId,
            managerId,
            {
              item: saved,
              actorManagerId,
            },
          );
          return saved;
        },
      ),
    );
  }

  private context(item: WorkItem) {
    return [
      `To-do ID: ${item.id}`,
      `Project ID: ${item.projectId}`,
      `Manager ID: ${item.managerId}`,
      ...(item.taskId ? [`Task ID: ${item.taskId}`] : []),
      `Title: ${item.title}`,
      ...(item.detail ? [`Detail: ${item.detail}`] : []),
    ].join('\n');
  }

  notes(projectId: string): ProjectNotes {
    this.store.project(projectId);
    const row = this.store.db
      .prepare('SELECT body FROM project_notes WHERE project_id=?')
      .get(projectId);
    return projectNotesSchema.parse(
      row
        ? JSON.parse(String(row.body))
        : {
            projectId,
            text: '',
            revision: 0,
            updatedAt: null,
            updatedByManagerId: null,
          },
    );
  }

  saveNotes(projectId: string, raw: unknown): ProjectNotes {
    // Keep the existing owner receipt shape; older saved Notes and history remain readable.
    const actorManagerId = null;
    const input = projectNotesRequestSchema.parse(raw);
    return projectNotesSchema.parse(
      this.store.operation(
        `project-notes:${input.key}`,
        {
          projectId,
          actorManagerId,
          input,
        },
        () => {
          const previous = this.notes(projectId);
          if (input.expectedRevision !== previous.revision)
            throw new Conflict('Project notes changed. Refresh them before saving your changes.');
          const saved = projectNotesSchema.parse({
            projectId,
            text: input.text,
            revision: previous.revision + 1,
            updatedAt: now(),
            updatedByManagerId: actorManagerId,
          });
          this.store.db
            .prepare(
              `INSERT INTO project_notes(project_id,body) VALUES(?,?)
        ON CONFLICT(project_id) DO UPDATE SET body=excluded.body`,
            )
            .run(projectId, JSON.stringify(saved));
          this.store.event('project.notes.updated', projectId, actorManagerId, saved);
          return saved;
        },
      ),
    );
  }
}

export function registerWorkItemRoutes(app: FastifyInstance, items: WorkItems, kick?: () => void) {
  const projectParams = z.object({ id: z.string().uuid() }).strict();
  app.get('/api/work-items', async (request) => items.list(request.query));
  app.get('/api/agents/:id/owner-requests', async (request) =>
    items.ownerRequests(
      projectParams.parse(request.params).id,
      ownerRequestHttpQuerySchema.parse(request.query),
    ),
  );
  app.post('/api/work-items', async (request) => {
    const item = items.save(request.body);
    // Only wakes the existing queue; the durable operation owns enqueue and deduplication.
    if (item.replyRunId || item.assignmentRunId) kick?.();
    return item;
  });
  app.post('/api/work-items/tickets', async (request, reply) => {
    const result = items.ticket(request.body);
    kick?.();
    return reply.code(201).send(result);
  });
  app.get('/api/projects/:id/notes', async (request) =>
    items.notes(projectParams.parse(request.params).id),
  );
  app.post('/api/projects/:id/notes', async (request) =>
    items.saveNotes(projectParams.parse(request.params).id, request.body),
  );
}
