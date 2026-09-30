import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  managerWorkItemRequestSchema,
  projectNotesRequestSchema,
  projectNotesSchema,
  workItemQuerySchema,
  workItemRequestSchema,
  workItemSchema,
  workItemsSchema,
  type ProjectNotes,
  type WorkItem,
  type WorkItemRequest,
} from '@dock/shared';
import { Conflict, Missing, now, Store } from './store.js';

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

  save(raw: unknown): WorkItem {
    return this.mutate(workItemRequestSchema.parse(raw), null);
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
          if (kind !== 'general' && (!projectId || !managerId))
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
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
            resolvedAt: null,
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
    return this.mutateNotes(projectId, raw, null);
  }

  saveNotesForManager(managerId: string, raw: unknown): ProjectNotes {
    return this.mutateNotes(this.manager(managerId).projectId, raw, managerId);
  }

  private mutateNotes(
    projectId: string,
    raw: unknown,
    actorManagerId: string | null,
  ): ProjectNotes {
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
  app.post('/api/work-items', async (request) => {
    const item = items.save(request.body);
    // Only wakes the existing queue; the durable operation owns enqueue and deduplication.
    if (item.replyRunId || item.assignmentRunId) kick?.();
    return item;
  });
  app.get('/api/projects/:id/notes', async (request) =>
    items.notes(projectParams.parse(request.params).id),
  );
  app.post('/api/projects/:id/notes', async (request) =>
    items.saveNotes(projectParams.parse(request.params).id, request.body),
  );
}
