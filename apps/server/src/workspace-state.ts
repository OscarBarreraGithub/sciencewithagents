import { randomUUID } from 'node:crypto';
import {
  workspaceDraftHistorySchema,
  workspaceClientSchema,
  workspaceDraftSchema,
  workspaceDraftSubmissionSchema,
  workspaceDraftsSchema,
  workspaceDraftUpdateSchema,
  workspaceRegisterSchema,
  workspaceSnapshotSchema,
  workspaceUpdateSchema,
  type WorkspaceClient,
  type WorkspaceDraft,
  type WorkspaceDraftUpdateResult,
  type WorkspaceUpdateResult,
} from '@dock/shared';
import { Conflict, Missing, Store, now } from './store.js';

/** Browser IDs identify private owner views, not authentication or provider sessions. */
export class WorkspaceState {
  readonly hostId: string;

  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_clients (
        id TEXT PRIMARY KEY, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_drafts (
        client_id TEXT NOT NULL REFERENCES workspace_clients(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        body TEXT NOT NULL, PRIMARY KEY(client_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_deliveries (
        delivery_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
        text TEXT NOT NULL, mode TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_submissions (
        request_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
        input TEXT NOT NULL, delivery_key TEXT NOT NULL REFERENCES workspace_deliveries(delivery_key)
      );
    `);
    store.db.exec(`CREATE INDEX IF NOT EXISTS workspace_draft_history ON operations(
      json_extract(input,'$.clientId'), json_extract(input,'$.agentId'),
      CAST(json_extract(result,'$.state.own.revision') AS INTEGER)
    ) WHERE json_extract(input,'$.kind')='workspace.draft' AND json_extract(result,'$.status')='applied'`);
    this.hostId = store.transaction(() => {
      const existing = store.getSetting('workspace:host-id');
      if (typeof existing === 'string') return workspaceRegisterSchema.shape.key.parse(existing);
      const created = randomUUID();
      store.setSetting('workspace:host-id', created);
      return created;
    });
  }

  private client(clientId: string): WorkspaceClient {
    const row = this.store.db
      .prepare('SELECT body FROM workspace_clients WHERE id=?')
      .get(workspaceRegisterSchema.shape.key.parse(clientId));
    if (!row) throw new Missing('This browser is not registered on this computer.');
    return workspaceClientSchema.parse(JSON.parse(String(row.body)));
  }

  private putClient(client: WorkspaceClient) {
    this.store.db
      .prepare(
        'INSERT INTO workspace_clients(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(client.id, JSON.stringify(workspaceClientSchema.parse(client)));
  }

  private checkHost(hostId: string) {
    if (hostId !== this.hostId)
      throw new Conflict(
        'This change belongs to a different computer. Open that computer before retrying.',
      );
  }

  snapshot(clientId: string) {
    const client = this.client(clientId);
    const others = this.store.db
      .prepare(
        "SELECT body FROM workspace_clients WHERE id<>? ORDER BY json_extract(body, '$.updatedAt') DESC, id LIMIT 100",
      )
      .all(clientId)
      .map((row) => workspaceClientSchema.parse(JSON.parse(String(row.body))));
    return workspaceSnapshotSchema.parse({ hostId: this.hostId, client, others });
  }

  openAgentIds() {
    const ids = this.store.db
      .prepare(
        "SELECT DISTINCT value AS id FROM workspace_clients, json_each(workspace_clients.body, '$.openAgentIds')",
      )
      .all()
      .map((row) => String(row.id));
    const existing = new Set(this.store.agents().map((agent) => agent.id));
    return ids.filter((id) => existing.has(id));
  }

  register(raw: unknown) {
    const input = workspaceRegisterSchema.parse(raw);
    return this.store.operation(input.key, { kind: 'workspace.register', ...input }, () => {
      const client: WorkspaceClient = {
        id: randomUUID(),
        label: input.label,
        revision: 0,
        openAgentIds: [],
        selectedAgentId: null,
        updatedAt: now(),
      };
      this.putClient(client);
      this.store.event('workspace.registered', null, null, {
        clientId: client.id,
        label: client.label,
      });
      return this.snapshot(client.id);
    });
  }

  update(clientId: string, raw: unknown): WorkspaceUpdateResult {
    const input = workspaceUpdateSchema.parse(raw);
    this.checkHost(input.hostId);
    return this.store.operation(input.key, { kind: 'workspace.update', clientId, ...input }, () => {
      const client = this.client(clientId);
      const conflict = (reason: string): WorkspaceUpdateResult => ({
        status: 'conflict',
        state: this.snapshot(clientId),
        reason,
      });
      if (client.revision !== input.revision)
        return conflict(
          'This browser workspace changed in another tab. Your requested change was not applied.',
        );
      const action = input.action;
      let next = { ...client, openAgentIds: [...client.openAgentIds] };
      if (action.kind === 'open') {
        this.store.agent(action.agentId);
        if (!next.openAgentIds.includes(action.agentId)) next.openAgentIds.push(action.agentId);
        next.selectedAgentId = action.agentId;
      } else if (action.kind === 'close') {
        next.openAgentIds = next.openAgentIds.filter((id) => id !== action.agentId);
        if (next.selectedAgentId === action.agentId)
          next.selectedAgentId = next.openAgentIds.at(-1) ?? null;
      } else if (action.kind === 'rename') {
        next.label = action.label;
      } else {
        if (action.sourceClientId === clientId)
          throw new Conflict('Choose a different browser workspace.');
        const source = this.client(action.sourceClientId);
        if (source.revision !== action.sourceRevision)
          return conflict(
            'The other browser changed its open conversations. Review its latest workspace before continuing here.',
          );
        for (const id of source.openAgentIds) this.store.agent(id);
        next.openAgentIds = [...new Set([...next.openAgentIds, ...source.openAgentIds])];
        next.selectedAgentId = source.selectedAgentId ?? next.selectedAgentId;
      }
      if (next.openAgentIds.length > 100)
        throw new Conflict(
          'Close an open conversation before opening more. Closing keeps its complete saved history.',
        );
      next = { ...next, revision: client.revision + 1, updatedAt: now() };
      this.putClient(next);
      this.store.event('workspace.changed', null, null, {
        clientId,
        revision: next.revision,
        action,
      });
      return { status: 'applied', state: this.snapshot(clientId) };
    });
  }

  private ownDraft(clientId: string, agentId: string): WorkspaceDraft {
    const row = this.store.db
      .prepare('SELECT body FROM workspace_drafts WHERE client_id=? AND agent_id=?')
      .get(clientId, agentId);
    const draft = row
      ? workspaceDraftSchema.parse(JSON.parse(String(row.body)))
      : {
          clientId,
          agentId,
          revision: 0,
          text: '',
          deliveryKey: null,
          submitted: false,
          updatedAt: '',
        };
    return { ...draft, submitted: this.delivered(draft.deliveryKey) };
  }

  private delivered(key: string | null) {
    return Boolean(
      key &&
        this.store.db.prepare('SELECT 1 FROM workspace_deliveries WHERE delivery_key=?').get(key),
    );
  }

  drafts(clientId: string, agentId: string) {
    this.client(clientId);
    this.store.agent(agentId);
    const others = this.store.db
      .prepare(
        `
      SELECT d.body, json_extract(c.body, '$.label') AS label
      FROM workspace_drafts d JOIN workspace_clients c ON c.id=d.client_id
      WHERE d.agent_id=? AND d.client_id<>? AND json_extract(d.body, '$.text')<>''
      ORDER BY json_extract(d.body, '$.updatedAt') DESC, d.client_id LIMIT 100
    `,
      )
      .all(agentId, clientId)
      .map((row) => {
        const draft = workspaceDraftSchema.parse(JSON.parse(String(row.body)));
        return { ...draft, submitted: this.delivered(draft.deliveryKey), label: String(row.label) };
      });
    return workspaceDraftsSchema.parse({
      hostId: this.hostId,
      clientId,
      agentId,
      own: this.ownDraft(clientId, agentId),
      others,
    });
  }

  draftHistory(clientId: string, agentId: string, before = Number.MAX_SAFE_INTEGER) {
    this.client(clientId);
    this.store.agent(agentId);
    const rows = this.store.db
      .prepare(
        `SELECT json_extract(result,'$.state.own') AS draft
      FROM operations WHERE json_extract(input,'$.kind')='workspace.draft'
      AND json_extract(result,'$.status')='applied' AND json_extract(input,'$.clientId')=?
      AND json_extract(input,'$.agentId')=? AND CAST(json_extract(result,'$.state.own.revision') AS INTEGER)<?
      ORDER BY CAST(json_extract(result,'$.state.own.revision') AS INTEGER) DESC LIMIT 21`,
      )
      .all(clientId, agentId, before);
    const versions = rows
      .slice(0, 20)
      .map((row) => workspaceDraftSchema.parse(JSON.parse(String(row.draft))));
    return workspaceDraftHistorySchema.parse({
      versions,
      nextBefore: rows.length > 20 ? versions.at(-1)!.revision : null,
    });
  }

  saveDraft(clientId: string, agentId: string, raw: unknown): WorkspaceDraftUpdateResult {
    const input = workspaceDraftUpdateSchema.parse(raw);
    this.checkHost(input.hostId);
    return this.store.operation(
      input.key,
      { kind: 'workspace.draft', clientId, agentId, ...input },
      () => {
        this.client(clientId);
        const agent = this.store.agent(agentId);
        const own = this.ownDraft(clientId, agentId);
        const conflict = (reason: string): WorkspaceDraftUpdateResult => ({
          status: 'conflict',
          state: this.drafts(clientId, agentId),
          reason,
        });
        if (own.revision !== input.revision)
          return conflict(
            'This draft changed in another tab. Your text is retained here; review both versions before saving.',
          );
        let text: string;
        let deliveryKey: string | null = randomUUID();
        if (input.action.kind === 'copy') {
          if (input.action.sourceClientId === clientId)
            throw new Conflict('Choose a draft from another browser.');
          this.client(input.action.sourceClientId);
          const source = this.ownDraft(input.action.sourceClientId, agentId);
          if (source.revision !== input.action.sourceRevision)
            return conflict(
              'The other browser changed this draft. Review its latest text before copying.',
            );
          text = source.text;
          deliveryKey = source.deliveryKey;
        } else text = input.action.text;
        const draft: WorkspaceDraft = {
          clientId,
          agentId,
          text,
          deliveryKey,
          submitted: false,
          revision: own.revision + 1,
          updatedAt: now(),
        };
        this.store.db
          .prepare(
            `
        INSERT INTO workspace_drafts(client_id,agent_id,body) VALUES(?,?,?)
        ON CONFLICT(client_id,agent_id) DO UPDATE SET body=excluded.body
      `,
          )
          .run(clientId, agentId, JSON.stringify(draft));
        // Text belongs in the private draft/operation record, not every event-stream update.
        this.store.event('workspace.draft_changed', agent.projectId, agentId, {
          clientId,
          revision: draft.revision,
          empty: text.length === 0,
          ...(input.action.kind === 'copy' ? { sourceClientId: input.action.sourceClientId } : {}),
        });
        return { status: 'applied', state: this.drafts(clientId, agentId) };
      },
    );
  }

  /** Call inside the same Store.transaction as enqueue. Returns one key for all copies. */
  reserveSubmission(
    agentId: string,
    raw: unknown,
    requestKey: string,
    text: string,
    mode: 'message' | 'steer' = 'message',
  ) {
    const token = workspaceDraftSubmissionSchema.parse(raw);
    workspaceRegisterSchema.shape.key.parse(requestKey);
    this.checkHost(token.hostId);
    const input = JSON.stringify({ token, text, mode });
    const previous = this.store.db
      .prepare('SELECT * FROM workspace_submissions WHERE request_key=?')
      .get(requestKey);
    if (previous) {
      if (previous.agent_id !== agentId || previous.input !== input)
        throw new Conflict('This retry key belongs to a different draft submission.');
      return String(previous.delivery_key);
    }
    this.client(token.clientId);
    this.store.agent(agentId);
    const draft = this.ownDraft(token.clientId, agentId);
    if (
      draft.revision !== token.revision ||
      draft.deliveryKey !== token.deliveryKey ||
      draft.text.trim() !== text ||
      !text
    )
      throw new Conflict(
        'This draft changed before it could be sent. Review the saved version and send again.',
      );
    const delivered = this.store.db
      .prepare('SELECT * FROM workspace_deliveries WHERE delivery_key=?')
      .get(token.deliveryKey);
    if (
      delivered &&
      (delivered.agent_id !== agentId || delivered.text !== text || delivered.mode !== mode)
    )
      throw new Conflict(
        'This copy was already submitted with a different action. Edit a new draft to send another message.',
      );
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO workspace_deliveries(delivery_key,agent_id,text,mode) VALUES(?,?,?,?)',
      )
      .run(token.deliveryKey, agentId, text, mode);
    this.store.db
      .prepare(
        'INSERT INTO workspace_submissions(request_key,agent_id,input,delivery_key) VALUES(?,?,?,?)',
      )
      .run(requestKey, agentId, input, token.deliveryKey);
    return token.deliveryKey;
  }

  /** Resolve a browser retry receipt without disclosing another agent's submission. */
  receiptKey(agentId: string, requestKey: string) {
    const row = this.store.db
      .prepare('SELECT delivery_key FROM workspace_submissions WHERE request_key=? AND agent_id=?')
      .get(requestKey, agentId);
    return row ? String(row.delivery_key) : requestKey;
  }
}
