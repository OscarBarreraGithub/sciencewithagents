import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { inspectPng } from './images.js';
import {
  defaultModelPolicy,
  modelPolicySchema,
  policyProvider,
  newProjectWorkflow,
  agentSchema,
  approvalSchema,
  decisionSchema,
  entrySchema,
  eventSchema,
  projectSchema,
  runSchema,
  taskSchema,
  jobEstimateSchema,
  type Agent,
  type Approval,
  type Decision,
  type Entry,
  type Project,
  type Run,
  type Task,
  type ProviderId,
} from '@dock/shared';

export class Conflict extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
export class Missing extends Error {}
export const now = () => new Date().toISOString();
export type PrivateAgent = Agent & {
  threadId: string | null;
  turnId: string | null;
  cwd: string;
  autoTurns: number;
};
export type PrivateProject = Project & { root: string };
export type PrivateTask = Omit<Task, 'hasReviewedChanges'> & {
  worktree: string | null;
  baseCommit: string | null;
  reviewedCommit: string | null;
  reviewAgentId: string | null;
};
export type PrivateRun = Run & { key: string; turnId: string | null };
export type PrivateApproval = Approval & {
  requestId: string | number;
  params: Record<string, unknown>;
};

/** Public task evidence, derived without persisting a second source of truth or paths. */
export function publicTask(task: PrivateTask): Task {
  return taskSchema.parse({
    ...task,
    hasReviewedChanges: Boolean(
      task.worktree &&
        task.baseCommit &&
        task.reviewedCommit &&
        task.reviewedCommit !== task.baseCommit,
    ),
  });
}

export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(readonly path: string) {
    super();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), key TEXT UNIQUE NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, project_id TEXT, agent_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only events'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only events'); END;
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pulsar_leases (run_id TEXT PRIMARY KEY REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quark_runs (run_id TEXT PRIMARY KEY REFERENCES runs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quark_allowances (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quark_intervals (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS quark_intervals_window ON quark_intervals(json_extract(body, '$.provider'),json_extract(body, '$.windowId'),id);
      CREATE INDEX IF NOT EXISTS quark_intervals_observed ON quark_intervals(json_extract(body, '$.observedAt'));
      CREATE TRIGGER IF NOT EXISTS quark_intervals_no_update BEFORE UPDATE ON quark_intervals BEGIN SELECT RAISE(ABORT, 'append-only allowance evidence'); END;
      CREATE TRIGGER IF NOT EXISTS quark_intervals_no_delete BEFORE DELETE ON quark_intervals BEGIN SELECT RAISE(ABORT, 'append-only allowance evidence'); END;
      CREATE TABLE IF NOT EXISTS local_jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contexts (thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id));
      CREATE TABLE IF NOT EXISTS provider_contexts (provider TEXT NOT NULL, thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id), PRIMARY KEY(provider, thread_id));
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, entry_id TEXT UNIQUE NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id), data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(status);
      CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS entries_agent ON entries(agent_id);
      CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);`);
    // A folder can host independent projects/conversations. Rebuild only this table;
    // its IDs, child references, private records and immutable events stay unchanged.
    const projectTable = String(
      this.db.prepare("SELECT sql FROM sqlite_master WHERE name='projects'").get()?.sql,
    );
    if (/root TEXT UNIQUE/i.test(projectTable)) {
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.transaction(() => {
          this.db
            .exec(`CREATE TABLE projects_new (id TEXT PRIMARY KEY, root TEXT NOT NULL, body TEXT NOT NULL);
            INSERT INTO projects_new SELECT id, root, body FROM projects;
            DROP TABLE projects;
            ALTER TABLE projects_new RENAME TO projects;`);
          if (this.db.prepare('PRAGMA foreign_key_check').all().length)
            throw new Error('Project migration failed its reference check.');
        });
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS projects_root ON projects(root)');
    // Additive, repeatable migration: old tasks retain their original project manager.
    // Historical events and conversation identities are never rewritten.
    this.transaction(() => {
      this.db.exec(`
        UPDATE agents SET body=json_set(body, '$.scope', '')
          WHERE json_type(body, '$.scope') IS NULL;
        UPDATE tasks SET body=json_set(body, '$.managerId',
          (SELECT json_extract(projects.body, '$.managerId') FROM projects WHERE projects.id=tasks.project_id))
          WHERE json_type(body, '$.managerId') IS NULL;
      `);
      if (!this.getSetting('migration:contexts:v1')) {
        // Recover prior context ownership from current identities and immutable history.
        // Ambiguous legacy provenance is not permission to adopt a thread.
        this.db.exec(`
          INSERT OR IGNORE INTO contexts(thread_id, agent_id)
          SELECT thread_id, MIN(agent_id) FROM (
            SELECT json_extract(body, '$.threadId') AS thread_id, id AS agent_id FROM agents
            UNION ALL
            SELECT json_extract(data, '$.threadId'), agent_id FROM events
              WHERE type IN ('session.retired', 'session.forked')
            UNION ALL
            SELECT json_extract(data, '$.previousThreadId'), agent_id FROM events
              WHERE type = 'session.forked'
          ) WHERE typeof(thread_id) = 'text' AND length(thread_id) > 0
            AND agent_id IN (SELECT id FROM agents)
          GROUP BY thread_id HAVING COUNT(DISTINCT agent_id) = 1;
        `);
        this.setSetting('migration:contexts:v1', true);
      }
      // Preserve the old Codex index for rollback; new lookups are provider-namespaced.
      // Do not relabel historical records using a future agent's current provider.
      this.db.exec(`INSERT OR IGNORE INTO provider_contexts(provider, thread_id, agent_id)
        SELECT 'codex', thread_id, agent_id FROM contexts;`);
    });
  }
  private transactionNotifications: (() => void)[] | null = null;
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const notifications: (() => void)[] = [];
    this.transactionNotifications = notifications;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.transactionNotifications = null;
      for (const notify of notifications) queueMicrotask(notify);
      return result;
    } catch (error) {
      this.transactionNotifications = null;
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  operation<T>(key: string, input: unknown, fn: () => T): T {
    return this.transaction(() => {
      const serialized = JSON.stringify(input);
      const row = this.db.prepare('SELECT input, result FROM operations WHERE key=?').get(key);
      if (row) {
        if (row.input !== serialized)
          throw new Conflict('This retry key was already used for different input.');
        return JSON.parse(String(row.result)) as T;
      }
      const result = fn();
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?)')
        .run(key, serialized, JSON.stringify(result));
      return result;
    });
  }
  async externalOperation<T>(key: string, input: unknown, fn: () => Promise<T>): Promise<T> {
    const name = `external:${key}`;
    const serialized = JSON.stringify(input);
    const previous = this.getSetting(name) as { input: string; state: string; result?: T } | null;
    if (previous) {
      if (previous.input !== serialized)
        throw new Conflict('This retry key was already used for different input.');
      if (previous.state === 'complete') return previous.result as T;
      throw new Conflict(
        'This command has an uncertain or failed outcome. Inspect current state before explicitly submitting a new command. It will not be repeated automatically.',
      );
    }
    // Persist intent before crossing the process boundary. A crash or lost provider
    // acknowledgement never authorizes a second execution of the same operation.
    this.setSetting(name, { input: serialized, state: 'pending' });
    const result = await fn();
    this.setSetting(name, { input: serialized, state: 'complete', result });
    return result;
  }
  event(type: string, projectId: string | null, agentId: string | null, data: unknown) {
    const createdAt = now();
    const result = this.db
      .prepare('INSERT INTO events(type,project_id,agent_id,data,created_at) VALUES(?,?,?,?,?)')
      .run(type, projectId, agentId, JSON.stringify(data), createdAt);
    const value = { id: Number(result.lastInsertRowid), type, projectId, agentId, data, createdAt };
    // Notify after synchronous transaction boundaries have returned to the event loop.
    const notify = () => {
      if (this.db.isOpen) this.emit('event', value);
    };
    if (this.transactionNotifications) this.transactionNotifications.push(notify);
    else queueMicrotask(notify);
    return value;
  }
  events(after = 0, limit = 300) {
    return this.db
      .prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?')
      .all(after, limit)
      .map((row) =>
        eventSchema.parse({
          id: row.id,
          type: row.type,
          projectId: row.project_id,
          agentId: row.agent_id,
          data: JSON.parse(String(row.data)),
          createdAt: row.created_at,
        }),
      );
  }
  get head() {
    return Number(
      this.db.prepare('SELECT COALESCE(MAX(id),0) AS head FROM events').get()?.head ?? 0,
    );
  }
  private bodies<T>(
    table: 'projects' | 'agents' | 'tasks' | 'runs' | 'entries' | 'approvals' | 'decisions',
  ): T[] {
    return this.db
      .prepare(`SELECT body FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(String(row.body)) as T);
  }
  projects() {
    return this.bodies<PrivateProject>('projects');
  }
  agents() {
    return this.bodies<PrivateAgent>('agents').map((a) => ({
      ...a,
      provider: a.provider ?? 'codex',
      assignment: a.assignment ?? null,
      mcpServers: a.mcpServers ?? [],
      pluginsEnabled: a.pluginsEnabled ?? false,
      webSearch: a.webSearch ?? 'disabled',
      imageGeneration: a.imageGeneration ?? false,
      nativeRootId: a.nativeRootId ?? null,
      nativePath: a.nativePath ?? null,
    }));
  }
  tasks() {
    return this.bodies<PrivateTask>('tasks');
  }
  runs(statuses?: PrivateRun['status'][]) {
    if (!statuses) return this.bodies<PrivateRun>('runs');
    if (!statuses.length) return [];
    return this.db
      .prepare(
        `SELECT body FROM runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY rowid`,
      )
      .all(...statuses)
      .map((row) => JSON.parse(String(row.body)) as PrivateRun);
  }
  runsForAgent(agentId: string, limit = 50) {
    return this.db
      .prepare('SELECT body FROM runs WHERE agent_id=? ORDER BY rowid DESC LIMIT ?')
      .all(agentId, limit)
      .map((row) => JSON.parse(String(row.body)) as PrivateRun)
      .reverse();
  }
  approvals() {
    return this.bodies<PrivateApproval>('approvals');
  }
  decisions() {
    return this.bodies<Decision>('decisions');
  }
  project(id: string) {
    const row = this.db.prepare('SELECT body FROM projects WHERE id=?').get(id);
    if (!row) throw new Missing('Project not found.');
    return JSON.parse(String(row.body)) as PrivateProject;
  }
  agent(id: string) {
    const row = this.db.prepare('SELECT body FROM agents WHERE id=?').get(id);
    if (!row) throw new Missing('Agent not found.');
    const value = JSON.parse(String(row.body)) as PrivateAgent;
    return {
      ...value,
      provider: value.provider ?? 'codex',
      assignment: value.assignment ?? null,
      mcpServers: value.mcpServers ?? [],
      pluginsEnabled: value.pluginsEnabled ?? false,
      webSearch: value.webSearch ?? 'disabled',
      imageGeneration: value.imageGeneration ?? false,
      nativeRootId: value.nativeRootId ?? null,
      nativePath: value.nativePath ?? null,
    };
  }
  task(id: string) {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    if (!row) throw new Missing('Task not found.');
    return JSON.parse(String(row.body)) as PrivateTask;
  }
  run(id: string) {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);
    if (!row) throw new Missing('Run not found.');
    return JSON.parse(String(row.body)) as PrivateRun;
  }
  approval(id: string) {
    const value = this.approvals().find((a) => a.id === id);
    if (!value) throw new Missing('Request not found.');
    return value;
  }
  defaultProvider(role: PrivateAgent['role'], explicit?: ProviderId) {
    const provider = policyProvider(
      modelPolicySchema.parse(this.getSetting('model-policy') ?? defaultModelPolicy),
      role === 'manager' ? 'manager' : 'reasoning',
      explicit,
    );
    if (!provider) throw new Conflict('Pick as I go: choose Codex or Claude for this new agent.');
    return provider;
  }
  register(
    root: string,
    name: string,
    description: string,
    provider?: ProviderId,
    freshKey?: string,
  ) {
    const receipt = freshKey ? `project-spawn:${freshKey}` : null;
    const saved = receipt ? this.getSetting(receipt) : null;
    const existing = saved
      ? this.project(String(saved))
      : !freshKey
        ? this.projects().find((p) => p.root === root)
        : undefined;
    if (existing) return projectSchema.parse(existing);
    return this.transaction(() => {
      const p: PrivateProject = {
        id: randomUUID(),
        root,
        name,
        description,
        managerId: randomUUID(),
        createdAt: now(),
      };
      this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id, root, JSON.stringify(p));
      this.addAgent({
        id: p.managerId,
        projectId: p.id,
        parentId: null,
        taskId: null,
        name: `${name} manager`,
        role: 'manager',
        cwd: root,
        provider,
      });
      this.event('project.created', p.id, p.managerId, { name });
      const workflow = newProjectWorkflow(
        modelPolicySchema.parse(this.getSetting('model-policy') ?? defaultModelPolicy),
      );
      this.setSetting(`project-workflow:${p.id}`, workflow);
      this.event('project.workflow_changed', p.id, p.managerId, workflow);
      if (receipt) this.setSetting(receipt, p.id);
      return projectSchema.parse(p);
    });
  }
  addAgent(
    input: Pick<PrivateAgent, 'projectId' | 'parentId' | 'taskId' | 'name' | 'role' | 'cwd'> & {
      id?: string;
      scope?: string;
      provider?: ProviderId;
    },
  ) {
    const provider = this.defaultProvider(input.role, input.provider);
    const value: PrivateAgent = {
      ...input,
      id: input.id ?? randomUUID(),
      scope: input.scope ?? '',
      provider,
      assignment: null,
      status: 'idle',
      model: null,
      effort: 'medium',
      permission: ['manager', 'implementer'].includes(input.role) ? 'workspace-write' : 'read-only',
      toolPolicy: 'native',
      mcpServers: [],
      pluginsEnabled: false,
      webSearch: input.role === 'manager' || provider === 'claude' ? 'disabled' : 'cached',
      imageGeneration: false,
      nativeRootId: null,
      nativePath: null,
      checkpoint: '',
      threadId: null,
      turnId: null,
      autoTurns: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db
      .prepare('INSERT INTO agents VALUES(?,?,?)')
      .run(value.id, value.projectId, JSON.stringify(value));
    this.event('agent.created', value.projectId, value.id, agentSchema.parse(value));
    return value;
  }
  addManager(projectId: string, name: string, scope: string, provider?: ProviderId) {
    const project = this.project(projectId);
    if (
      this.agents().some(
        (a) =>
          a.projectId === projectId &&
          a.role === 'manager' &&
          a.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Conflict('A manager with this name already exists in this project.');
    return this.addAgent({
      projectId,
      parentId: null,
      taskId: null,
      name,
      scope,
      role: 'manager',
      cwd: project.root,
      provider,
    });
  }
  updateAgent(id: string, changes: Partial<PrivateAgent>) {
    const previous = this.agent(id);
    if (
      changes.provider &&
      changes.provider !== previous.provider &&
      (previous.threadId ||
        this.entries(id).length ||
        this.runs().some((run) => run.agentId === id) ||
        this.db.prepare('SELECT 1 FROM provider_contexts WHERE agent_id=? LIMIT 1').get(id))
    )
      throw new Conflict(
        'A saved conversation keeps its provider. Create a new agent to use another provider.',
      );
    const value = { ...previous, ...changes, id, updatedAt: now() };
    agentSchema.parse(value);
    if (value.threadId) this.rememberContext(id, value.threadId, value.provider);
    this.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(value), id);
    this.event('agent.updated', value.projectId, id, agentSchema.parse(value));
    return value;
  }
  contextOwner(threadId: string, provider: ProviderId = 'codex') {
    const row = this.db
      .prepare('SELECT agent_id FROM provider_contexts WHERE provider=? AND thread_id=?')
      .get(provider, threadId);
    return row ? String(row.agent_id) : null;
  }
  requireActiveAgent(agentId: string) {
    const visited = new Set<string>();
    const pending = [agentId];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const agent = this.agent(id);
      if (agent.archivedAt)
        throw new Conflict(
          'This manager was removed. Its files and saved history are retained. Create a new manager to start new work.',
        );
      // Evidence-only discussions are new conversations, not a restart of archived work.
      if (agent.interview) continue;
      if (agent.parentId) pending.push(agent.parentId);
      if (agent.nativeRootId) pending.push(agent.nativeRootId);
      if (agent.taskId) pending.push(this.task(agent.taskId).managerId);
    }
  }
  managerFamily(managerId: string) {
    const owned = new Set([managerId]);
    const agents = this.agents();
    const tasks = new Set(
      this.tasks()
        .filter((task) => task.managerId === managerId)
        .map((task) => task.id),
    );
    for (let changed = true; changed; ) {
      changed = false;
      for (const agent of agents)
        if (
          !owned.has(agent.id) &&
          !agent.interview &&
          ((agent.parentId && owned.has(agent.parentId)) ||
            (agent.nativeRootId && owned.has(agent.nativeRootId)) ||
            (agent.taskId && tasks.has(agent.taskId)))
        ) {
          owned.add(agent.id);
          changed = true;
        }
    }
    return agents.filter((agent) => owned.has(agent.id));
  }
  rememberContext(agentId: string, threadId: string, provider = this.agent(agentId).provider) {
    if (provider !== this.agent(agentId).provider)
      throw new Conflict('This context belongs to a different provider.');
    const owner = this.contextOwner(threadId, provider);
    if (owner && owner !== agentId)
      throw new Conflict('This provider context belongs to another agent.');
    if (provider === 'codex') {
      const legacy = this.db
        .prepare('SELECT agent_id FROM contexts WHERE thread_id=?')
        .get(threadId);
      if (legacy && legacy.agent_id !== agentId)
        throw new Conflict('This Codex context belongs to another agent.');
      this.db
        .prepare('INSERT OR IGNORE INTO contexts(thread_id, agent_id) VALUES(?,?)')
        .run(threadId, agentId);
    }
    this.db
      .prepare(
        'INSERT OR IGNORE INTO provider_contexts(provider, thread_id, agent_id) VALUES(?,?,?)',
      )
      .run(provider, threadId, agentId);
    if (this.contextOwner(threadId, provider) !== agentId)
      throw new Conflict('This provider context belongs to another agent.');
  }
  observedContext(threadId: string, provider: ProviderId = 'codex') {
    return Boolean(
      this.getSetting(`observed:${provider}:${threadId}`) ||
        (provider === 'codex' && this.getSetting(`observed:${threadId}`)),
    );
  }
  observeContext(threadId: string, provider: ProviderId = 'codex') {
    this.setSetting(`observed:${provider}:${threadId}`, true);
    if (provider === 'codex') this.setSetting(`observed:${threadId}`, true);
  }
  addTask(
    projectId: string,
    input: Pick<Task, 'title' | 'goal' | 'acceptance' | 'parentId'> & {
      managerId?: string;
      scheduling?: Task['scheduling'];
    },
  ) {
    const managerId = input.managerId ?? this.project(projectId).managerId;
    const manager = this.agent(managerId);
    this.requireActiveAgent(managerId);
    if (manager.projectId !== projectId || manager.role !== 'manager')
      throw new Conflict('Select a manager belonging to this project.');
    if (input.parentId) {
      const parent = this.task(input.parentId);
      if (parent.projectId !== projectId || parent.managerId !== managerId)
        throw new Conflict('A split task must retain its parent task’s project and manager.');
    }
    const value: PrivateTask = {
      ...input,
      scheduling: jobEstimateSchema.parse(input.scheduling ?? {}),
      id: randomUUID(),
      projectId,
      managerId,
      status: 'open',
      revisions: 0,
      review: null,
      worktree: null,
      baseCommit: null,
      reviewedCommit: null,
      reviewAgentId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db
      .prepare('INSERT INTO tasks VALUES(?,?,?)')
      .run(value.id, projectId, JSON.stringify(value));
    this.event('task.created', projectId, null, publicTask(value));
    return value;
  }
  updateTask(id: string, changes: Partial<PrivateTask>) {
    const value = { ...this.task(id), ...changes, id, updatedAt: now() };
    publicTask(value);
    this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(value), id);
    this.event('task.updated', value.projectId, null, publicTask(value));
    return value;
  }
  enqueue(
    agentId: string,
    key: string,
    text: string,
    kind: Run['kind'] = 'user',
    sourceId: string | null = null,
  ) {
    const old = this.db.prepare('SELECT body FROM runs WHERE key=?').get(key);
    if (old) {
      const value = JSON.parse(String(old.body)) as PrivateRun;
      if (
        value.agentId !== agentId ||
        value.text !== text ||
        value.kind !== kind ||
        value.sourceId !== sourceId
      )
        throw new Conflict('This retry key belongs to a different message.');
      return runSchema.parse(value);
    }
    const a = this.agent(agentId);
    this.requireActiveAgent(agentId);
    const run: PrivateRun = {
      id: randomUUID(),
      agentId,
      sourceId,
      key,
      text,
      kind,
      status: 'queued',
      turnId: null,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
      .run(run.id, agentId, key, 'queued', JSON.stringify(run));
    this.entry({
      id: run.id,
      agentId,
      runId: run.id,
      kind: kind === 'user' ? 'user' : 'message',
      title: sourceId ? this.agent(sourceId).name : kind === 'resume' ? 'Recovery' : 'You',
      text,
      status: 'queued',
      createdAt: now(),
    });
    if (!['running', 'waiting'].includes(a.status))
      this.updateAgent(agentId, { status: 'queued', ...(kind === 'user' ? { autoTurns: 0 } : {}) });
    else if (kind === 'user') this.updateAgent(agentId, { autoTurns: 0 });
    this.event('run.queued', a.projectId, agentId, runSchema.parse(run));
    return runSchema.parse(run);
  }
  updateRun(id: string, changes: Partial<PrivateRun>) {
    const value = { ...this.run(id), ...changes, id };
    this.db
      .prepare('UPDATE runs SET status=?,body=? WHERE id=?')
      .run(value.status, JSON.stringify(value), id);
    const a = this.agent(value.agentId);
    this.event(`run.${value.status}`, a.projectId, a.id, runSchema.parse(value));
    return value;
  }
  entry(value: Entry) {
    entrySchema.parse(value);
    this.db
      .prepare('INSERT INTO entries VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(value.id, value.agentId, JSON.stringify(value));
    // The saved entry owns the text. The append-only stream only invalidates it;
    // otherwise each delta permanently duplicates the entire reply accumulated so far.
    this.event('entry.updated', this.agent(value.agentId).projectId, value.agentId, {
      entryId: value.id,
      runId: value.runId,
      kind: value.kind,
      status: value.status,
    });
  }
  /** One immutable blob per original tool item; savepoints also support atomic history import. */
  imageEntry(value: Entry, bytes: Buffer) {
    const dimensions = inspectPng(bytes);
    this.db.exec('SAVEPOINT image_entry');
    try {
      const previous = this.db
        .prepare('SELECT id, agent_id, data FROM images WHERE entry_id=?')
        .get(value.id);
      if (
        previous &&
        (previous.agent_id !== value.agentId ||
          !Buffer.from(previous.data as Uint8Array).equals(bytes))
      )
        throw new Conflict('This image item was replayed with different content.');
      const imageId = previous ? String(previous.id) : randomUUID();
      if (!previous)
        this.db
          .prepare('INSERT INTO images VALUES(?,?,?,?)')
          .run(imageId, value.id, value.agentId, bytes);
      this.entry({
        ...value,
        image: { id: imageId, mimeType: 'image/png', byteLength: bytes.length, ...dimensions },
      });
      this.db.exec('RELEASE image_entry');
    } catch (error) {
      this.db.exec('ROLLBACK TO image_entry; RELEASE image_entry');
      throw error;
    }
  }
  image(agentId: string, imageId: string) {
    this.agent(agentId);
    const row = this.db
      .prepare('SELECT data FROM images WHERE id=? AND agent_id=?')
      .get(imageId, agentId);
    if (!row) throw new Missing('Image not found for this agent.');
    return Buffer.from(row.data as Uint8Array);
  }
  savedEntry(agentId: string, entryId: string): Entry | null {
    const row = this.db
      .prepare('SELECT body FROM entries WHERE id=? AND agent_id=?')
      .get(entryId, agentId);
    return row ? entrySchema.parse(JSON.parse(String(row.body))) : null;
  }
  entries(agentId: string, before?: string, limit = 200) {
    const rows = before
      ? this.db
          .prepare(
            'SELECT body FROM entries WHERE agent_id=? AND rowid<(SELECT rowid FROM entries WHERE id=? AND agent_id=?) ORDER BY rowid DESC LIMIT ?',
          )
          .all(agentId, before, agentId, limit)
      : this.db
          .prepare('SELECT body FROM entries WHERE agent_id=? ORDER BY rowid DESC LIMIT ?')
          .all(agentId, limit);
    return rows.reverse().map((row) => entrySchema.parse(JSON.parse(String(row.body))));
  }
  addApproval(
    agentId: string,
    input: Omit<PrivateApproval, 'id' | 'agentId' | 'status' | 'createdAt'>,
  ) {
    const value: PrivateApproval = {
      ...input,
      id: randomUUID(),
      agentId,
      status: 'pending',
      createdAt: now(),
    };
    approvalSchema.parse(value);
    this.db
      .prepare('INSERT INTO approvals VALUES(?,?,?)')
      .run(value.id, agentId, JSON.stringify(value));
    this.updateAgent(agentId, { status: 'waiting' });
    this.event(
      'approval.requested',
      this.agent(agentId).projectId,
      agentId,
      approvalSchema.parse(value),
    );
    return value;
  }
  updateApproval(id: string, status: Approval['status']) {
    const value = { ...this.approval(id), status };
    this.db.prepare('UPDATE approvals SET body=? WHERE id=?').run(JSON.stringify(value), id);
    this.event(
      'approval.resolved',
      this.agent(value.agentId).projectId,
      value.agentId,
      approvalSchema.parse(value),
    );
    return value;
  }
  decision(input: Omit<Decision, 'id' | 'createdAt'>) {
    const value = decisionSchema.parse({ ...input, id: randomUUID(), createdAt: now() });
    this.db
      .prepare('INSERT INTO decisions VALUES(?,?,?)')
      .run(value.id, value.projectId, JSON.stringify(value));
    this.event('decision.recorded', value.projectId, value.agentId, value);
    return value;
  }
  getSetting(key: string) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? (JSON.parse(String(row.value)) as unknown) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  recover() {
    this.transaction(() => {
      for (const r of this.runs().filter((r) => r.status === 'running'))
        this.updateRun(r.id, { status: 'interrupted' });
      for (const a of this.agents().filter((a) => ['running', 'waiting'].includes(a.status))) {
        this.updateAgent(a.id, { status: 'interrupted', turnId: null });
        this.entry({
          id: randomUUID(),
          agentId: a.id,
          runId: null,
          kind: 'system',
          title: 'Interrupted',
          text: 'The service restarted during work. History is retained. Inspect the result, then resume explicitly; an uncertain action is never replayed automatically.',
          status: 'complete',
          createdAt: now(),
        });
      }
      for (const a of this.approvals().filter((a) => a.status === 'pending'))
        this.updateApproval(a.id, 'expired');
    });
  }
  close() {
    this.removeAllListeners();
    this.db.close();
  }
}
