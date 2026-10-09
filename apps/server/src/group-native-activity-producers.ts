import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GROUP_LIMITS, groupContextSchema, groupEventIdSchema } from '@dock/shared';
import {
  groupActionSchema,
  groupActionOriginSchema,
  type GroupAction,
} from '@dock/shared/dist/group-actions.js';
import {
  groupNativeActivitySchema,
  groupNativeActivityEntryIdSchema,
  type GroupNativeActivity,
} from '@dock/shared/dist/group-native-activity.js';
import type { Store } from './store.js';
import { groupHostTurnSchema } from './group-host-work-continuation.js';
import { publicationCanonical } from './group-publication-protocol.js';

const initialized = new WeakSet<Store>();
export function initializeGroupActivity(store: Store) {
  if (initialized.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS group_native_activity(id TEXT PRIMARY KEY,enrollment TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_native_activity_delivery(id TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_native_activity_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,requested_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_native_activity_bodies(id TEXT PRIMARY KEY,enrollment TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,body BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS group_native_activity_gaps(enrollment TEXT NOT NULL,reason TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(enrollment,reason));
    CREATE TABLE IF NOT EXISTS group_native_activity_finals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,entry_id TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,body BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS group_native_activity_final_gaps(run_id TEXT PRIMARY KEY,enrollment TEXT NOT NULL,reason TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS gna_final_run ON group_native_activity_finals(run_id);
    CREATE INDEX IF NOT EXISTS gna_delivery_pending ON group_native_activity_delivery(state,id);
    CREATE INDEX IF NOT EXISTS gna_enrollment ON group_native_activity(enrollment);
    CREATE TRIGGER IF NOT EXISTS gna_immutable BEFORE UPDATE ON group_native_activity BEGIN SELECT RAISE(ABORT,'immutable native producer receipt'); END;
    CREATE TRIGGER IF NOT EXISTS gna_retain BEFORE DELETE ON group_native_activity BEGIN SELECT RAISE(ABORT,'retain native producer receipt'); END;
    CREATE TRIGGER IF NOT EXISTS gna_delivery_identity BEFORE UPDATE ON group_native_activity_delivery WHEN NEW.id<>OLD.id OR NEW.state NOT IN ('pending','complete') OR (OLD.state='complete' AND NEW.state<>'complete') BEGIN SELECT RAISE(ABORT,'retained native delivery identity'); END;
    CREATE TRIGGER IF NOT EXISTS gna_delivery_retain BEFORE DELETE ON group_native_activity_delivery BEGIN SELECT RAISE(ABORT,'retain native delivery identity'); END;
    CREATE TRIGGER IF NOT EXISTS gna_job_immutable BEFORE UPDATE ON group_native_activity_jobs BEGIN SELECT RAISE(ABORT,'immutable native job binding'); END;
    CREATE TRIGGER IF NOT EXISTS gna_job_retain BEFORE DELETE ON group_native_activity_jobs BEGIN SELECT RAISE(ABORT,'retain native job binding'); END;`);
  store.db
    .exec(`CREATE TRIGGER IF NOT EXISTS gna_body_immutable BEFORE UPDATE ON group_native_activity_bodies BEGIN SELECT RAISE(ABORT,'immutable native result original'); END;
    CREATE TRIGGER IF NOT EXISTS gna_body_retain BEFORE DELETE ON group_native_activity_bodies BEGIN SELECT RAISE(ABORT,'retain native result original'); END;`);
  for (const table of ['group_native_activity_finals', 'group_native_activity_final_gaps'])
    store.db
      .exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable native final proof'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retain native final proof'); END;`);
  initialized.add(store);
}
export const activityId = (...parts: string[]) => {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** Resolve only the exact producer run and its original owner Work. No recent-run,
 * project-history, event/SSE prose, private-context or native-control fallback. */
export function groupNativeActivityBinding(store: Store, runId: string) {
  if (store.getSetting(`group:native-control:${runId}`)) return null;
  const turn = groupHostTurnSchema.safeParse(store.getSetting(`group:host-native-run:${runId}`));
  if (!turn.success || turn.data.intent !== 'work' || turn.data.context.visibility !== 'shared')
    return null;
  const run = store.run(runId),
    agent = store.agent(run.agentId),
    marker = z
      .object({ context: groupContextSchema, enrollmentHandle: z.uuid() })
      .safeParse(store.getSetting(`group:host-native-agent:${agent.id}`));
  if (
    !marker.success ||
    publicationCanonical(marker.data.context) !== publicationCanonical(turn.data.context)
  )
    return null;
  const original = store.db
    .prepare('SELECT id,agent_id FROM runs WHERE key=?')
    .get(turn.data.requestId);
  if (!original || (run.id !== original.id && turn.data.originRunId !== original.id)) return null;
  const root = groupHostTurnSchema.safeParse(
    store.getSetting(`group:host-native-run:${original.id}`),
  );
  if (
    !root.success ||
    root.data.intent !== 'work' ||
    root.data.requestId !== turn.data.requestId ||
    publicationCanonical(root.data.context) !== publicationCanonical(turn.data.context)
  )
    return null;
  const manager = store.agent(String(original.agent_id));
  if (
    manager.role !== 'manager' ||
    agent.projectId !== manager.projectId ||
    (agent.id !== manager.id && agent.parentId !== manager.id && agent.nativeRootId !== manager.id)
  )
    return null;
  const workId = agent.taskId
    ? store.getSetting(`group:coordination:${turn.data.context.sessionId}:worker:${agent.id}`)
    : null;
  let sourceRun = runId,
    action: {
      origin: GroupNativeActivity['origin'];
      workId: string;
      sharedGoalId: GroupNativeActivity['sharedGoalId'];
      taskId: string;
    } | null = null;
  for (let depth = 0; depth < 8; depth++) {
    const key = String(
        store.db.prepare('SELECT key FROM runs WHERE id=?').get(sourceRun)?.key ?? '',
      ),
      actionId = key.startsWith('delegate:group:host-coordination-action:')
        ? key.slice('delegate:group:host-coordination-action:'.length)
        : null,
      row = actionId
        ? store.db
            .prepare('SELECT result FROM operations WHERE key=?')
            .get(`group:host-coordination-origin:${actionId}`)
        : null;
    if (row) {
      action = z
        .object({
          origin: groupActionOriginSchema,
          workId: z.uuid(),
          sharedGoalId: groupEventIdSchema,
          taskId: z.uuid(),
        })
        .parse(JSON.parse(String(row.result)));
      break;
    }
    const parent = groupHostTurnSchema.safeParse(
      store.getSetting(`group:host-native-run:${sourceRun}`),
    );
    if (
      !parent.success ||
      !parent.data.parentRunId ||
      parent.data.requestId !== turn.data.requestId
    )
      break;
    sourceRun = parent.data.parentRunId;
  }
  if (action && action.taskId !== agent.taskId) return null;
  return {
    run,
    agent,
    enrollment: marker.data.enrollmentHandle,
    base: {
      kind: 'group-native-activity' as const,
      version: 1 as const,
      context: turn.data.context,
      requestId: turn.data.requestId,
      rootRunId: String(original.id),
      runId,
      managerId: manager.id,
      workerId: agent.id === manager.id ? null : agent.id,
      workId: action?.workId ?? (typeof workId === 'string' ? workId : null),
      taskId: action?.taskId ?? agent.taskId,
      origin: action?.origin ?? null,
      sharedGoalId: action?.sharedGoalId ?? null,
      instructionEventId: action?.origin?.kind === 'instruction' ? action.origin.eventId : null,
    },
  };
}
const binding = groupNativeActivityBinding;
function gap(
  store: Store,
  enrollment: string,
  reason: 'receipt-capacity' | 'original-capacity' | 'unsupported-source' | 'capture-failed',
) {
  store.db
    .prepare(
      'INSERT INTO group_native_activity_gaps VALUES(?,?,1) ON CONFLICT(enrollment,reason) DO UPDATE SET count=count+1',
    )
    .run(enrollment, reason);
}
function finalGap(
  store: Store,
  runId: string,
  enrollment: string,
  reason: 'unsupported-source' | 'original-capacity' | 'capture-failed',
) {
  if (
    store.db
      .prepare('SELECT run_id FROM group_native_activity_final_gaps WHERE run_id=?')
      .get(runId)
  )
    return;
  if (
    Number(store.db.prepare('SELECT count(*) n FROM group_native_activity_final_gaps').get()!.n) >=
    8192
  ) {
    gap(store, enrollment, 'original-capacity');
    return;
  }
  if (
    store.db
      .prepare('INSERT OR IGNORE INTO group_native_activity_final_gaps VALUES(?,?,?)')
      .run(runId, enrollment, reason).changes
  )
    gap(store, enrollment, reason);
}
/** A capture failure is evidence unavailability, never native completion authority. */
function captureSafely(store: Store, runId: string, fn: () => void) {
  try {
    if (!binding(store, runId)) return;
    initializeGroupActivity(store);
    store.db.exec('SAVEPOINT group_activity_evidence');
    try {
      fn();
      store.db.exec('RELEASE group_activity_evidence');
    } catch (error) {
      store.db.exec('ROLLBACK TO group_activity_evidence; RELEASE group_activity_evidence');
      throw error;
    }
  } catch {
    try {
      const b = binding(store, runId);
      if (b) {
        initializeGroupActivity(store);
        finalGap(store, runId, b.enrollment, 'capture-failed');
      }
    } catch {
      /* Native state settlement must remain independent of unavailable capture. */
    }
  }
}
/** Called only by a live provider's explicit completed final event, before display
 * slicing. Display entries, deltas, unknown phases and historical polling cannot call it. */
export function captureGroupNativeFinal(
  store: Store,
  runId: string,
  entryId: string,
  text: string,
) {
  captureSafely(store, runId, () => {
    const b = binding(store, runId);
    if (!b || b.run.status !== 'running' || b.agent.role === 'manager' || !b.agent.taskId || !text)
      return;
    initializeGroupActivity(store);
    if (!groupNativeActivityEntryIdSchema.safeParse(entryId).success) {
      finalGap(store, runId, b.enrollment, 'unsupported-source');
      return;
    }
    const id = activityId('raw-final', runId, entryId),
      sha256 = createHash('sha256').update(text).digest('hex'),
      bytes = Buffer.byteLength(text),
      old = store.db
        .prepare('SELECT sha256,bytes FROM group_native_activity_finals WHERE id=?')
        .get(id);
    if (old) {
      if (old.sha256 !== sha256 || old.bytes !== bytes)
        finalGap(store, runId, b.enrollment, 'unsupported-source');
      return;
    }
    const capacity = store.db
      .prepare(
        'SELECT (SELECT COALESCE(sum(bytes+2),0) FROM group_native_activity_finals)+(SELECT COALESCE(sum(bytes),0) FROM group_native_activity_bodies) bytes,(SELECT count(*) FROM group_native_activity_finals) n',
      )
      .get()!;
    if (bytes + 2 + Number(capacity.bytes) > 64 * 1024 * 1024 || Number(capacity.n) >= 8192) {
      finalGap(store, runId, b.enrollment, 'original-capacity');
      return;
    }
    store.db
      .prepare('INSERT INTO group_native_activity_finals VALUES(?,?,?,?,?,?)')
      .run(id, runId, entryId, bytes, sha256, Buffer.from(text));
  });
}
/** Read a byte range from the immutable raw proof named by an exact retained receipt.
 * Only scoped owner/paired readers call this; there is no path or personal-history lookup. */
export function readGroupNativeFinalOriginal(
  store: Store,
  receiptId: string,
  enrollment: string,
  start: number,
  length: number,
) {
  const row = store.db
    .prepare('SELECT body FROM group_native_activity WHERE id=? AND enrollment=?')
    .get(receiptId, enrollment);
  if (!row) return null;
  const receipt = groupNativeActivitySchema.parse(JSON.parse(String(row.body)));
  if (receipt.detail.producer !== 'worker' || receipt.detail.result.availability === 'unavailable')
    return null;
  const result = receipt.detail.result,
    rows = store.db
      .prepare('SELECT id,bytes FROM group_native_activity_finals WHERE run_id=? ORDER BY rowid')
      .all(receipt.runId);
  if (
    !rows.length ||
    rows.reduce((n, r) => n + Number(r.bytes), 2 * (rows.length - 1)) !== result.bytes
  )
    return null;
  const parts: Buffer[] = [];
  let offset = 0;
  const slice = (body: Buffer, position: number) => {
    const from = Math.max(start - position, 0),
      to = Math.min(start + length - position, body.length);
    if (to > from) parts.push(body.subarray(from, to));
  };
  for (const [i, proof] of rows.entries()) {
    if (i) {
      slice(Buffer.from('\n\n'), offset);
      offset += 2;
    }
    const from = Math.max(0, start - offset),
      count = Math.min(Number(proof.bytes) - from, start + length - Math.max(offset, start));
    if (count > 0) {
      const part = store.db
        .prepare('SELECT substr(body,?,?) body FROM group_native_activity_finals WHERE id=?')
        .get(from + 1, count, proof.id)!;
      parts.push(Buffer.from(part.body as Uint8Array));
    }
    offset += Number(proof.bytes);
    if (offset >= start + length) break;
  }
  return { bytes: result.bytes!, sha256: result.sha256!, body: Buffer.concat(parts) };
}
function retain(
  store: Store,
  runId: string,
  producerReceipt: string,
  detail: GroupNativeActivity['detail'],
  extra: Partial<GroupNativeActivity> = {},
) {
  const b = binding(store, runId);
  if (!b) return;
  initializeGroupActivity(store);
  const receiptId = activityId(detail.producer, producerReceipt);
  let value = groupNativeActivitySchema.parse({
      ...b.base,
      ...extra,
      receiptId,
      producerReceipt,
      detail,
    }),
    body = publicationCanonical(value);
  // Leave room for the exact hosted instruction/goal references added once by
  // the publication projection; text is never truncated to make the bound fit.
  if (
    value.detail.producer === 'worker' &&
    Buffer.byteLength(body) > GROUP_LIMITS.payloadBytes - 4096
  ) {
    value = {
      ...value,
      detail: {
        ...value.detail,
        result: {
          ...value.detail.result,
          text: null,
          availability: 'local-only',
        },
      },
    };
    body = publicationCanonical(value);
  }
  const old = store.db
    .prepare('SELECT enrollment,body FROM group_native_activity WHERE id=?')
    .get(receiptId);
  if (old) {
    if (old.enrollment !== b.enrollment || old.body !== body)
      throw new Error('Native producer receipt changed.');
    return;
  }
  const capacity = store.db
    .prepare(
      'SELECT count(*) n,COALESCE(sum(length(CAST(body AS BLOB))),0) bytes FROM group_native_activity',
    )
    .get()!;
  if (
    Number(capacity.n) >= 8192 ||
    Number(capacity.bytes) + Buffer.byteLength(body) > 64 * 1024 * 1024
  ) {
    gap(store, b.enrollment, 'receipt-capacity');
    return;
  }
  store.db.exec('SAVEPOINT group_native_activity_capture');
  try {
    store.db
      .prepare('INSERT INTO group_native_activity VALUES(?,?,?)')
      .run(receiptId, b.enrollment, body);
    store.db
      .prepare('INSERT INTO group_native_activity_delivery VALUES(?,?)')
      .run(receiptId, 'pending');
    store.db.exec('RELEASE group_native_activity_capture');
  } catch (error) {
    store.db.exec(
      'ROLLBACK TO group_native_activity_capture; RELEASE group_native_activity_capture',
    );
    throw error;
  }
}
export function captureGroupRunTransition(store: Store, runId: string, producerReceipt: string) {
  captureSafely(store, runId, () => captureGroupRunTransitionExact(store, runId, producerReceipt));
}
function captureGroupRunTransitionExact(store: Store, runId: string, producerReceipt: string) {
  const b = binding(store, runId);
  if (
    !b ||
    !['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(b.run.status)
  )
    return;
  const state = z
    .enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'])
    .parse(b.run.status);
  const eventId = /^run:(\d+)$/.exec(producerReceipt)?.[1],
    event = eventId
      ? store.db.prepare('SELECT type,data FROM events WHERE id=?').get(Number(eventId))
      : null;
  if (event) {
    const body = z
      .object({ id: z.uuid(), status: z.string() })
      .safeParse(JSON.parse(String(event.data)));
    if (
      !body.success ||
      body.data.id !== runId ||
      body.data.status !== state ||
      event.type !== `run.${state}`
    )
      return;
  } else if (producerReceipt !== `run:${runId}:queued` || state !== 'queued') return;
  retain(store, runId, producerReceipt, { producer: 'job', jobId: runId, state });
  if (
    b.agent.role === 'manager' ||
    !b.agent.taskId ||
    !['completed', 'failed', 'interrupted', 'cancelled'].includes(state)
  )
    return;
  if (
    store.db
      .prepare('SELECT id FROM group_native_activity WHERE id=?')
      .get(activityId('worker', `result:${runId}`))
  )
    return;
  const entries = store.db
      .prepare(
        'SELECT entry_id,body FROM group_native_activity_finals WHERE run_id=? ORDER BY rowid',
      )
      .iterate(runId),
    hash = createHash('sha256'),
    entryIds: string[] = [];
  let text: string | null = '',
    bytes = 0,
    entryCount = 0;
  for (const row of entries) {
    const part =
      (entryCount++ ? '\n\n' : '') + Buffer.from(row.body as Uint8Array).toString('utf8');
    hash.update(part);
    bytes += Buffer.byteLength(part);
    if (entryIds.length < 16) entryIds.push(groupNativeActivityEntryIdSchema.parse(row.entry_id));
    text = text !== null && bytes <= GROUP_LIMITS.payloadBytes ? text + part : null;
  }
  const issue = store.db
      .prepare('SELECT reason FROM group_native_activity_final_gaps WHERE run_id=?')
      .get(runId),
    proofGapCapacity =
      Number(
        store.db.prepare('SELECT count(*) n FROM group_native_activity_final_gaps').get()!.n,
      ) >= 8192,
    reason =
      state !== 'completed'
        ? 'not-completed'
        : issue
          ? z
              .enum(['unsupported-source', 'original-capacity', 'capture-failed'])
              .parse(issue.reason)
          : proofGapCapacity
            ? 'original-capacity'
            : !entryCount
              ? 'missing-final'
              : null;
  retain(store, runId, `result:${runId}`, {
    producer: 'worker',
    state,
    result: {
      sha256: reason ? null : hash.digest('hex'),
      bytes: reason ? null : bytes,
      text: reason ? null : text,
      availability: reason ? 'unavailable' : text !== null ? 'complete' : 'local-only',
      reason,
      entryIds,
    },
  });
}
export function captureGroupQuarkTransition(
  store: Store,
  runId: string,
  producerReceipt: string,
  state: 'held' | 'resumed',
  cause: string,
) {
  const eventId = /^quark:(\d+)$/.exec(producerReceipt)?.[1],
    row = eventId
      ? store.db.prepare('SELECT type,data FROM events WHERE id=?').get(Number(eventId))
      : null;
  if (
    !row ||
    !(state === 'held' ? ['quark.paused', 'quark.pause_changed'] : ['quark.resumed']).includes(
      String(row.type),
    )
  )
    return;
  const data = z
    .object({ runId: z.uuid(), cause: z.string() })
    .safeParse(JSON.parse(String(row.data)));
  if (!data.success || data.data.runId !== runId || data.data.cause !== cause) return;
  const safeCause = [
    'manual',
    'budget',
    'lease',
    'capacity',
    'headroom',
    'reset',
    'resource',
  ].includes(cause)
    ? cause
    : 'other';
  retain(store, runId, producerReceipt, {
    producer: 'quark',
    state,
    cause: safeCause as Extract<GroupNativeActivity['detail'], { producer: 'quark' }>['cause'],
  });
}
export function captureGroupManagerAction(
  store: Store,
  runId: string,
  raw: GroupAction,
  outcome: GroupAction['outcome'],
) {
  const action = groupActionSchema.parse(raw),
    work = action.proposal.observed,
    bound = binding(store, runId);
  if (
    !bound ||
    bound.base.managerId !== work.managerId ||
    bound.base.context.groupId !== work.owner.groupId ||
    bound.base.context.memberId !== work.owner.memberId ||
    bound.base.context.installationId !== work.owner.installationId
  )
    return;
  const blocked = store.db
      .prepare('SELECT result FROM operations WHERE key=?')
      .get(`group:activity-blocked:${action.actionId}`),
    saved = (
      outcome?.status === 'blocked' && blocked
        ? JSON.parse(String(blocked.result))
        : store.getSetting(
            `group:coordination:${bound.base.context.sessionId}:action:${action.actionId}`,
          )
    ) as {
      outcome?: unknown;
      taskId?: string;
      causal?: unknown;
    } | null;
  if (
    !saved ||
    saved.taskId !== work.taskId ||
    publicationCanonical(saved.causal) !== publicationCanonical(action) ||
    (outcome
      ? publicationCanonical(saved.outcome) !== publicationCanonical(outcome)
      : Boolean(saved.outcome))
  )
    return;
  retain(
    store,
    runId,
    `action:${action.actionId}:${outcome ? 'completed' : 'uncertain'}`,
    {
      producer: 'manager',
      actionId: action.actionId,
      proposalId: action.proposal.proposalId,
      outcomeId: outcome?.outcomeId ?? null,
      state: outcome?.status ?? 'uncertain',
      jobId: outcome?.jobId ?? null,
      origin: action.proposal.origin,
    },
    {
      taskId: work.taskId,
      workId: work.workId,
      sharedGoalId: work.sharedGoalId,
      workerId: outcome?.workerId ?? null,
      origin: action.proposal.origin,
      instructionEventId:
        action.proposal.origin.kind === 'instruction' ? action.proposal.origin.eventId : null,
    },
  );
}
export function captureGroupFileChange(
  store: Store,
  runId: string,
  commit: string,
  paths: string[],
  omitted: boolean,
) {
  retain(store, runId, `checkpoint:${runId}:${commit}`, {
    producer: 'file',
    commit,
    paths,
    omitted,
  });
}
export function bindGroupNativeLocalJob(
  store: Store,
  jobId: string,
  runId: string,
  requestedBy: string,
) {
  const b = binding(store, runId);
  if (!b || b.agent.id !== requestedBy) return;
  initializeGroupActivity(store);
  const old = store.db
    .prepare('SELECT run_id,requested_by FROM group_native_activity_jobs WHERE id=?')
    .get(jobId);
  if (old) {
    if (old.run_id !== runId || old.requested_by !== requestedBy)
      throw new Error('Native local job binding changed.');
    return;
  }
  if (
    Number(store.db.prepare('SELECT count(*) n FROM group_native_activity_jobs').get()!.n) >= 8192
  ) {
    gap(store, b.enrollment, 'receipt-capacity');
    return;
  }
  store.db
    .prepare('INSERT INTO group_native_activity_jobs VALUES(?,?,?)')
    .run(jobId, runId, requestedBy);
}
export function captureGroupLocalJobTransition(
  store: Store,
  jobId: string,
  producerReceipt: string,
) {
  initializeGroupActivity(store);
  const origin = store.db
      .prepare('SELECT run_id FROM group_native_activity_jobs WHERE id=?')
      .get(jobId),
    row = store.db.prepare('SELECT body FROM local_jobs WHERE id=?').get(jobId);
  if (!origin || !row) return;
  const runId = z.uuid().parse(origin.run_id),
    b = binding(store, runId),
    job = z
      .object({
        id: z.uuid(),
        requestedBy: z.uuid().nullable(),
        projectId: z.uuid().nullable(),
        taskId: z.uuid().nullable(),
        status: z.enum([
          'queued',
          'running',
          'paused',
          'completed',
          'failed',
          'interrupted',
          'cancelled',
        ]),
      })
      .parse(JSON.parse(String(row.body)));
  if (!b || job.requestedBy !== b.agent.id || job.projectId !== b.agent.projectId) return;
  const eventId = /^localjob:(\d+)$/.exec(producerReceipt)?.[1],
    event = eventId
      ? store.db.prepare('SELECT type,data FROM events WHERE id=?').get(Number(eventId))
      : null,
    data =
      event?.type === 'localjob.updated'
        ? z
            .object({ jobId: z.uuid(), status: z.string() })
            .safeParse(JSON.parse(String(event.data)))
        : null;
  if (!data?.success || data.data.jobId !== jobId || data.data.status !== job.status) return;
  retain(
    store,
    runId,
    producerReceipt,
    { producer: 'job', jobId, state: job.status },
    { taskId: job.taskId },
  );
}
