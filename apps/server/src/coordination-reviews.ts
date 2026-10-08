import { createHash, randomUUID } from 'node:crypto';
import {
  jobEstimateSchema,
  coordinationReviewRequestSchema,
  type CoordinationReviewRead,
} from '@dock/shared';
import { Conflict, type PrivateRun, type Store } from './store.js';

const batchLimit = 1000;
const batchKey = 'coordination-review:';
/** Owner/recovery input and goal continuations are never internal updates. */
export function isManagerCoordination(store: Store, run: PrivateRun) {
  return (
    store.agent(run.agentId).role === 'manager' &&
    ['report', 'message'].includes(run.kind) &&
    store.getSetting(`managed-goal:run:${run.id}`) === null &&
    (run.sourceId !== null || run.key.startsWith(batchKey) || run.key.startsWith('quark:wake:'))
  );
}
function taskAncestors(store: Store, projectId: string, heads: (string | null)[]) {
  const result = new Set<string>();
  for (let taskId of heads) {
    while (taskId && !result.has(taskId)) {
      const task = store.task(taskId);
      if (task.projectId !== projectId) break;
      result.add(taskId);
      taskId = task.parentId;
    }
  }
  return [...result];
}
function sourceTaskIds(store: Store, run: PrivateRun) {
  const agent = store.agent(run.agentId);
  const source = run.sourceId ? store.agent(run.sourceId) : null;
  const saved = store.getSetting(`pulsar:task:${run.id}`);
  return taskAncestors(store, agent.projectId, [
    agent.taskId ??
      (source?.projectId === agent.projectId ? source.taskId : null) ??
      (typeof saved === 'string' ? saved : null),
  ]);
}
/** Joint review remains conservatively inside every retained source task cap. */
export function coordinationTaskIds(store: Store, run: PrivateRun) {
  if (!run.key?.startsWith(batchKey)) return [];
  const projectId = store.agent(run.agentId).projectId;
  const rows = store.db
    .prepare(
      `SELECT DISTINCT json_extract(a.body,'$.taskId') AS task_id
     FROM coordination_review_sources s JOIN runs r ON r.id=s.source_run_id
     JOIN agents a ON a.id=json_extract(r.body,'$.sourceId')
     WHERE s.batch_run_id=? AND a.project_id=? ORDER BY task_id`,
    )
    .all(run.id, projectId);
  return taskAncestors(
    store,
    projectId,
    rows.map((row) => (typeof row.task_id === 'string' ? row.task_id : null)),
  );
}
/** Batching and its queue projection must preserve the same individual controls. */
export function isBatchableCoordination(store: Store, run: PrivateRun) {
  if (
    run.status !== 'queued' ||
    !run.sourceId ||
    !isManagerCoordination(store, run) ||
    run.queueEdit ||
    store.getSetting(`pulsar:held:${run.id}`) === true
  )
    return false;
  if (
    store.db
      .prepare('SELECT 1 FROM settings WHERE key IN (?,?,?,?) LIMIT 1')
      .get(
        `managed-goal:run:${run.id}`,
        `pulsar:task:${run.id}`,
        `pulsar:override:${run.id}`,
        `group:host-native-run:${run.id}`,
      )
  )
    return false;
  if (store.db.prepare('SELECT 1 FROM pulsar_leases WHERE run_id=?').get(run.id)) return false;
  return !sourceTaskIds(store, run).some(
    (taskId) => store.getSetting(`pulsar:held-task:${taskId}`) === true,
  );
}
export function coordinationCount(store: Store, run: PrivateRun) {
  if (!isManagerCoordination(store, run)) return 0;
  if (run.sourceId && !isBatchableCoordination(store, run)) return 0;
  if (!run.key.startsWith(batchKey)) return 1;
  return Number(
    store.db
      .prepare('SELECT COUNT(*) AS n FROM coordination_review_sources WHERE batch_run_id=?')
      .get(run.id)?.n ?? 0,
  );
}

/** No summarizer, provider call, history deletion or replay. Membership is immutable. */
export class CoordinationReviews {
  constructor(readonly store: Store) {}
  preview(agentId: string) {
    const agent = this.store.agent(agentId);
    if (agent.role !== 'manager' || agent.nativeRootId || agent.archivedAt)
      throw new Conflict('Only a retained app manager can review coordination updates.');
    const hasReceipts = this.store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coordination_reviews'")
      .get();
    const pendingBatch = hasReceipts
      ? this.store.db
          .prepare(
            `SELECT r.id FROM runs r JOIN coordination_reviews b ON b.run_id=r.id
       WHERE r.agent_id=? AND r.status IN ('queued','running') ORDER BY r.rowid LIMIT 1`,
          )
          .get(agentId)
      : undefined;
    // Direct group Work lineage, individual job holds and task holds must not be collapsed.
    const rows = this.store.db
      .prepare(
        `SELECT r.body FROM runs r WHERE r.agent_id=? AND r.status='queued'
       AND json_extract(r.body,'$.kind') IN ('report','message')
       AND json_extract(r.body,'$.sourceId') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key='pulsar:held:'||r.id AND s.value='true')
       AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key='managed-goal:run:'||r.id)
       AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key IN ('pulsar:task:'||r.id,'pulsar:override:'||r.id,'group:host-native-run:'||r.id))
       ORDER BY r.rowid LIMIT ?`,
      )
      .all(agentId, batchLimit + 1);
    const candidates = rows
      .map((r) => JSON.parse(String(r.body)) as PrivateRun)
      .filter((run) => isBatchableCoordination(this.store, run));
    const sources = candidates.slice(0, batchLimit);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          agentId,
          pendingBatch: pendingBatch?.id ?? null,
          sources: sources.map((r) => [
            r.id,
            r.kind,
            r.sourceId,
            r.text,
            this.store.getSetting(`pulsar:estimate:${r.id}`),
          ]),
        }),
      )
      .digest('hex');
    return {
      agentId,
      managerStatus: agent.status,
      fingerprint,
      pendingBatchRunId: pendingBatch ? String(pendingBatch.id) : null,
      sourceCount: sources.length,
      hasMore: rows.length > batchLimit,
      canCoalesce: !pendingBatch && sources.length >= 2,
      // Exact identity preview, never the unbounded conversation payload.
      sources: sources.map((r) => ({
        runId: r.id,
        kind: r.kind,
        sourceId: r.sourceId,
        createdAt: r.createdAt,
      })),
      notice:
        'Original records and text stay retained. Coalescing creates one review receipt, does not review or finish tasks, resume a stopped manager, change limits or call a model.',
    };
  }
  apply(agentId: string, raw: unknown) {
    const input = coordinationReviewRequestSchema.parse(raw);
    return this.store.operation(`coordination-review:${input.key}`, { agentId, ...input }, () => {
      const preview = this.preview(agentId);
      if (preview.fingerprint !== input.expectedFingerprint)
        throw new Conflict('Pending coordination changed. Read a fresh preview before coalescing.');
      if (!preview.canCoalesce) return { ...preview, batchRunId: preview.pendingBatchRunId };
      const text =
        `${preview.sourceCount} retained team updates are ready for one manager review. They are evidence, not new owner requests. Reconcile current tasks, saved requests and outcomes once; do not replay every notification as a separate assignment or assume an old report means work is still needed. Continue independent authorized work within existing limits.\n` +
        `Read bounded source pages with dock_inspect {coordination:{batchRunId:BATCH_ID,offset:0,limit:20}}. Fetch only relevant evidence. Older native tool catalogs can use dock_inspect.history for this manager and dock_inspect.read for each source entry ID.\n` +
        `Latest ${Math.min(preview.sourceCount, 20)} source entry IDs:\n` +
        preview.sources
          .slice(-20)
          .map((r) => `${r.runId} (${r.kind}, source ${r.sourceId}, ${r.createdAt})`)
          .join('\n');
      // Allocate before enqueue so the bounded prompt contains its exact stable receipt ID.
      const id = randomUUID();
      const run = this.store.enqueue(
        agentId,
        `${batchKey}${id}`,
        text.replace('BATCH_ID', `"${id}"`),
        'report',
        null,
        id,
      );
      const estimates = preview.sources.flatMap((source) => {
        const saved = this.store.getSetting(`pulsar:estimate:${source.runId}`);
        return saved ? [jobEstimateSchema.parse(saved)] : [];
      });
      if (estimates.length) {
        const rank = { background: 0, normal: 1, high: 2, interactive: 3 };
        const estimate = estimates.reduce((combined, current) => ({
          ...combined,
          priority:
            rank[current.priority] > rank[combined.priority] ? current.priority : combined.priority,
          expectedTokens: Math.max(combined.expectedTokens, current.expectedTokens),
          tokenBudget: Math.max(combined.tokenBudget, current.tokenBudget),
          quotaPercent: Math.max(combined.quotaPercent, current.quotaPercent),
          expectedSeconds: Math.max(combined.expectedSeconds, current.expectedSeconds),
          cpuCores: Math.max(combined.cpuCores, current.cpuCores),
          memoryMb: Math.max(combined.memoryMb, current.memoryMb),
          estimatedCostUsd:
            combined.estimatedCostUsd === null
              ? current.estimatedCostUsd
              : current.estimatedCostUsd === null
                ? combined.estimatedCostUsd
                : Math.max(combined.estimatedCostUsd, current.estimatedCostUsd),
          deadline: !combined.deadline
            ? current.deadline
            : !current.deadline
              ? combined.deadline
              : combined.deadline < current.deadline
                ? combined.deadline
                : current.deadline,
          estimateNote:
            'One coalesced manager review; preserves the largest source forecast and highest source priority. Original estimates stay retained; these are planning hints, not allowance caps.',
        }));
        this.store.setSetting(`pulsar:estimate:${run.id}`, estimate);
      }
      const batchEntry = this.store.db.prepare('SELECT body FROM entries WHERE id=?').get(run.id)!;
      this.store.entry({ ...JSON.parse(String(batchEntry.body)), title: 'Team review' });
      this.store.db
        .prepare('INSERT INTO coordination_reviews(run_id,fingerprint,created_at) VALUES(?,?,?)')
        .run(run.id, preview.fingerprint, run.createdAt);
      for (let index = 0; index < preview.sources.length; index++) {
        const source = preview.sources[index]!;
        this.store.db
          .prepare(
            'INSERT INTO coordination_review_sources(batch_run_id,source_run_id,position) VALUES(?,?,?)',
          )
          .run(run.id, source.runId, index);
        this.store.updateRun(source.runId, { status: 'coalesced' });
        const entry = this.store.db
          .prepare('SELECT body FROM entries WHERE id=?')
          .get(source.runId);
        if (entry) this.store.entry({ ...JSON.parse(String(entry.body)), status: 'coalesced' });
      }
      this.store.event('coordination.coalesced', this.store.agent(agentId).projectId, agentId, {
        batchRunId: run.id,
        sourceCount: preview.sourceCount,
        fingerprint: preview.fingerprint,
      });
      return { ...preview, batchRunId: run.id };
    });
  }
  coalescePending() {
    const ids = this.store.db
      .prepare(
        `SELECT DISTINCT r.agent_id FROM runs r JOIN agents a ON a.id=r.agent_id
      WHERE r.status='queued' AND json_extract(a.body,'$.role')='manager'
      AND json_extract(r.body,'$.kind') IN ('report','message') AND json_extract(r.body,'$.sourceId') IS NOT NULL`,
      )
      .all();
    for (const row of ids) {
      const agent = this.store.agent(String(row.agent_id));
      if (agent.archivedAt || agent.nativeRootId) continue;
      const preview = this.preview(agent.id);
      if (preview.canCoalesce)
        this.apply(agent.id, { key: randomUUID(), expectedFingerprint: preview.fingerprint });
    }
  }
  read(projectId: string, input: CoordinationReviewRead) {
    const batch = this.store.run(input.batchRunId);
    if (this.store.agent(batch.agentId).projectId !== projectId)
      throw new Conflict('Coordination review is outside this project.');
    const total = Number(
      this.store.db
        .prepare('SELECT COUNT(*) AS n FROM coordination_review_sources WHERE batch_run_id=?')
        .get(batch.id)?.n ?? 0,
    );
    const rows = input.sourceRunId
      ? this.store.db
          .prepare(
            'SELECT source_run_id FROM coordination_review_sources WHERE batch_run_id=? AND source_run_id=?',
          )
          .all(batch.id, input.sourceRunId)
      : this.store.db
          .prepare(
            'SELECT source_run_id FROM coordination_review_sources WHERE batch_run_id=? ORDER BY position LIMIT ? OFFSET ?',
          )
          .all(batch.id, input.limit, input.offset);
    if (input.sourceRunId && !rows.length)
      throw new Conflict('Source does not belong to this review receipt.');
    return {
      batchRunId: batch.id,
      total,
      nextOffset:
        !input.sourceRunId && input.offset + rows.length < total
          ? input.offset + rows.length
          : null,
      sources: rows.map((row) => {
        const run = this.store.run(String(row.source_run_id));
        return {
          runId: run.id,
          sourceId: run.sourceId,
          kind: run.kind,
          createdAt: run.createdAt,
          text: run.text.slice(input.textOffset, input.textOffset + input.textLimit),
          textOffset: input.textOffset,
          textLength: run.text.length,
          truncated: input.textOffset > 0 || run.text.length > input.textOffset + input.textLimit,
        };
      }),
    };
  }
}
