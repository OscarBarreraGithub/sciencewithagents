import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  appRemoveRequestSchema,
  managerAppRequestSchema,
  projectAppSchema,
  projectAppsStatusSchema,
  type AppState,
  type ProjectApp,
} from '@dock/shared';
import { Conflict, Missing, Store, now } from './store.js';

const perProject = 24;
const checkMs = 800;
const reuseMs = 4000;
export type PortProbe = (port: number) => Promise<AppState>;

/** TCP connect only. No request reaches the app, so a check never triggers its work. */
export const probeLoopbackPort: PortProbe = async (port) => {
  const attempt = (host: string) =>
    new Promise<'open' | 'closed' | 'slow'>((resolve) => {
      const socket = connect({ host, port });
      const finish = (result: 'open' | 'closed' | 'slow') => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(checkMs, () => finish('slow'));
      socket.once('connect', () => finish('open'));
      socket.once('error', (error: NodeJS.ErrnoException) =>
        finish(
          ['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(
            error.code ?? '',
          )
            ? 'closed'
            : 'slow',
        ),
      );
    });
  // Development servers often bind only one of IPv4/IPv6 loopback.
  const results = await Promise.all(['127.0.0.1', '::1'].map(attempt));
  if (results.includes('open')) return 'running';
  return results.includes('slow') ? 'not_responding' : 'stopped';
};

/** Project-owned app registrations. Managers run apps natively; this records where to open them. */
export class ProjectApps {
  private reserved = new Set<number>();
  private checks = new Map<number, { at: number; state: Promise<AppState> }>();
  constructor(
    private store: Store,
    private probe: PortProbe = probeLoopbackPort,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS project_apps (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        body TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS project_apps_project ON project_apps(project_id);
    `);
  }
  /** This installation's own listeners are never registered as project apps. */
  reserve(ports: (number | undefined)[]) {
    for (const port of ports) if (port) this.reserved.add(port);
  }
  private read(id: string) {
    const row = this.store.db
      .prepare('SELECT body FROM project_apps WHERE id=? AND removed_at IS NULL')
      .get(z.string().uuid().parse(id));
    if (!row) throw new Missing('This app is not registered on this computer.');
    return projectAppSchema.parse(JSON.parse(String(row.body)));
  }
  list(projectId?: string): ProjectApp[] {
    const rows = projectId
      ? this.store.db
          .prepare(
            'SELECT body FROM project_apps WHERE project_id=? AND removed_at IS NULL ORDER BY rowid',
          )
          .all(projectId)
      : this.store.db
          .prepare('SELECT body FROM project_apps WHERE removed_at IS NULL ORDER BY rowid')
          .all();
    return rows.map((row) => projectAppSchema.parse(JSON.parse(String(row.body))));
  }
  private write(app: ProjectApp, type: 'registered' | 'updated') {
    this.store.db
      .prepare(
        'INSERT INTO project_apps(id,project_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(app.id, app.projectId, JSON.stringify(app));
    this.store.event(`app.${type}`, app.projectId, app.managerId, app);
    return app;
  }
  private requirePort(app: Pick<ProjectApp, 'id' | 'port' | 'path'>) {
    if (this.reserved.has(app.port))
      throw new Conflict(
        `Port ${app.port} belongs to sciencewithagents itself. Register the port your app listens on.`,
      );
    const same = this.list().find(
      (other) => other.id !== app.id && other.port === app.port && other.path === app.path,
    );
    if (same)
      throw new Conflict(
        `localhost:${app.port}${app.path} is already registered as “${same.name}”. Update that app instead.`,
      );
  }
  /** Receipt-keyed, revision-checked changes from an authenticated project manager. */
  saveForManager(managerId: string, receipt: string, raw: unknown) {
    const manager = this.store.agent(managerId);
    if (manager.role !== 'manager' || manager.interview || manager.archivedAt)
      throw new Conflict('Only an active project manager can register project apps.');
    const input = managerAppRequestSchema.parse(raw);
    return this.store.operation(`project-app:${receipt}`, { managerId, input }, () => {
      if (input.id) {
        const previous = this.read(input.id);
        if (previous.projectId !== manager.projectId)
          throw new Conflict('Managers can only change apps registered in their own project.');
        if (input.expectedRevision !== previous.revision)
          throw new Conflict(
            `This app changed (current revision ${previous.revision}). Read it again before saving.`,
          );
        if (input.action === 'remove') {
          this.store.db
            .prepare('UPDATE project_apps SET removed_at=? WHERE id=?')
            .run(now(), previous.id);
          this.store.event('app.removed', previous.projectId, managerId, {
            id: previous.id,
            name: previous.name,
          });
          return { removed: true, id: previous.id };
        }
        const next = projectAppSchema.parse({
          ...previous,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.remoteUrl !== undefined ? { remoteUrl: input.remoteUrl } : {}),
          revision: previous.revision + 1,
          updatedAt: now(),
        });
        this.requireName(next);
        this.requirePort(next);
        return this.write(next, 'updated');
      }
      if (input.action === 'remove') throw new Conflict('Choose the registered app id to remove.');
      if (!input.name || input.port === undefined)
        throw new Conflict('Give the app a short name and the local port it listens on.');
      if ((input.expectedRevision ?? 0) !== 0)
        throw new Conflict('A new app registration starts at revision zero.');
      const candidate = {
        name: input.name,
        description: input.description ?? '',
        port: input.port,
        path: input.path ?? '/',
        remoteUrl: input.remoteUrl ?? null,
      };
      const existing = this.list(manager.projectId).find(
        (app) => app.name.toLowerCase() === candidate.name.toLowerCase(),
      );
      if (existing) {
        // A repeated registration after compaction is not a second app.
        if (
          existing.description === candidate.description &&
          existing.port === candidate.port &&
          existing.path === candidate.path &&
          existing.remoteUrl === candidate.remoteUrl
        )
          return existing;
        throw new Conflict(
          `“${existing.name}” is already registered (id ${existing.id}, revision ${existing.revision}). Update it with that id and expectedRevision.`,
        );
      }
      if (this.list(manager.projectId).length >= perProject)
        throw new Conflict(`A project can register up to ${perProject} apps. Remove unused ones.`);
      const created = now();
      const app = projectAppSchema.parse({
        id: randomUUID(),
        projectId: manager.projectId,
        managerId,
        ...candidate,
        revision: 1,
        createdAt: created,
        updatedAt: created,
      });
      this.requirePort(app);
      return this.write(app, 'registered');
    });
  }
  private requireName(app: ProjectApp) {
    if (
      this.list(app.projectId).some(
        (other) => other.id !== app.id && other.name.toLowerCase() === app.name.toLowerCase(),
      )
    )
      throw new Conflict(`Another app in this project is already named “${app.name}”.`);
  }
  /** Owner removal from the Apps list. The app, its files and its process are untouched. */
  remove(id: string, raw: unknown) {
    const input = appRemoveRequestSchema.parse(raw);
    return this.store.operation(`project-app-remove:${input.key}`, { id, input }, () => {
      const previous = this.read(id);
      if (previous.revision !== input.expectedRevision)
        throw new Conflict('This app changed. Review it again before removing it.');
      this.store.db.prepare('UPDATE project_apps SET removed_at=? WHERE id=?').run(now(), id);
      this.store.event('app.removed', previous.projectId, null, {
        id: previous.id,
        name: previous.name,
      });
      return { removed: true, id };
    });
  }
  private state(port: number) {
    const cached = this.checks.get(port);
    if (cached && Date.now() - cached.at < reuseMs) return cached.state;
    const state = this.probe(port).catch((): AppState => 'not_responding');
    this.checks.set(port, { at: Date.now(), state });
    return state;
  }
  async status(openHere: boolean) {
    const projects = new Map(this.store.projects().map((project) => [project.id, project]));
    const apps = this.list().filter((app) => projects.has(app.projectId));
    const states = await Promise.all(apps.map((app) => this.state(app.port)));
    return projectAppsStatusSchema.parse({
      apps: apps.map((app, index) => {
        let managerName: string | null = null;
        try {
          managerName = app.managerId ? this.store.agent(app.managerId).name : null;
        } catch (error) {
          if (!(error instanceof Missing)) throw error;
        }
        return {
          ...app,
          projectName: projects.get(app.projectId)!.name,
          managerName,
          localUrl: `http://localhost:${app.port}${app.path}`,
          state: states[index],
        };
      }),
      openHere,
      checkedAt: now(),
    });
  }
}

export function registerProjectAppRoutes(
  app: FastifyInstance,
  apps: ProjectApps,
  openHere: (request: FastifyRequest) => boolean,
) {
  app.get('/api/apps', async (request) => apps.status(openHere(request)));
  app.post<{ Params: { id: string } }>('/api/apps/:id/remove', async (request) =>
    apps.remove(request.params.id, request.body),
  );
}
