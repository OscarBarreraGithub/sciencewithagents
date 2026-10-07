import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { groupContextSchema, groupSourceSchema, type GroupContext } from '@dock/shared';
import { GroupIsolationBlocked } from './group-isolation.js';
import type { GroupContainerPlan } from './group-container.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const documentNativeDigest = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex');
export function assertPrivateDocumentFile(path: string) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid!() || s.mode & 0o077)
    throw new GroupIsolationBlocked('Private owning-host document journal required.');
}
const receiptSchema = z.object({
  requestId: z.uuid(),
  contextId: z.uuid(),
  state: z.literal('completed'),
  runId: z.uuid(),
  nativeTurnId: z.string().min(1).max(256),
  text: z.string().min(1).max(1048576),
  nativeToolItems: z.number().int().nonnegative(),
  source: groupSourceSchema.optional(),
});
export interface DocumentNativeResult {
  resultId: string;
  requestId: string;
  handle: string;
  context: GroupContext;
  nativeContext: GroupContext;
  receiptSequence: number;
  resultDigest: string;
  text: string;
  source?: z.infer<typeof groupSourceSchema>;
  runId: string;
  containerId: string;
  nativeTurnId: string;
  volume: string;
  plan: GroupContainerPlan;
}
/** Concrete read-only index of the owning GroupHost and GroupNativeJournal, never Store.
 * Reserved host result UUID must map to the exact completed native request/context/turn.
 * Before capture the host result may not yet be projected; describe/export require that projection.
 */
export class GroupDocumentNativeResultIndex {
  readonly #host: DatabaseSync;
  readonly #native: DatabaseSync;
  constructor(hostJournalPath: string, nativeJournalPath: string) {
    assertPrivateDocumentFile(hostJournalPath);
    assertPrivateDocumentFile(nativeJournalPath);
    this.#host = new DatabaseSync(hostJournalPath, { readOnly: true });
    try {
      this.#native = new DatabaseSync(nativeJournalPath, { readOnly: true });
    } catch (error) {
      this.#host.close();
      throw error;
    }
  }
  resultIdForRequest(requestId: string): string {
    z.uuid().parse(requestId);
    const row = this.#host
      .prepare('SELECT ids FROM ghn_requests WHERE request_id=?')
      .get(requestId);
    if (!row) throw new GroupIsolationBlocked('No owning-host request reservation.');
    return z.uuid().parse(JSON.parse(String(row.ids)).resultId);
  }
  read(resultId: string, requireProjection = true): DocumentNativeResult {
    z.uuid().parse(resultId);
    const request = this.#host
      .prepare(
        "SELECT handle,request_id,input,ids FROM ghn_requests WHERE json_extract(ids,'$.resultId')=?",
      )
      .get(resultId);
    if (!request) throw new GroupIsolationBlocked('No exact owning-host result reservation.');
    const input = z
      .object({ requestId: z.uuid(), context: groupContextSchema, enrollmentHandle: z.uuid() })
      .parse(JSON.parse(String(request.input)));
    if (input.requestId !== request.request_id)
      throw new GroupIsolationBlocked('Host result request binding changed.');
    const nativeRequest = this.#native
      .prepare('SELECT context_id FROM gn_requests WHERE request_id=?')
      .get(input.requestId);
    if (!nativeRequest) throw new GroupIsolationBlocked('No actual native request identity.');
    const nativeRow = this.#native
      .prepare('SELECT local_json FROM gn_contexts WHERE context_id=?')
      .get(String(nativeRequest.context_id));
    const nativeContext = groupContextSchema.parse(
      JSON.parse(String(nativeRow?.local_json)).context,
    );
    const completed = this.#native
      .prepare(
        'SELECT sequence,event_json FROM gn_request_events WHERE request_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(input.requestId);
    const receipt = receiptSchema.parse(JSON.parse(String(completed?.event_json)));
    if (
      !requireProjection &&
      this.#native
        .prepare(
          'SELECT request_id FROM gn_requests WHERE context_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(nativeContext.sessionId)?.request_id !== input.requestId
    )
      throw new GroupIsolationBlocked('Capture must precede the next native request.');
    const created = this.#native
      .prepare(
        "SELECT detail FROM gn_events WHERE context_id=? AND kind='container-created' ORDER BY sequence DESC LIMIT 1",
      )
      .get(nativeContext.sessionId);
    const containerId = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(JSON.parse(String(created?.detail)).container);
    const actual = this.#native
      .prepare('SELECT provider,native_id FROM gn_native WHERE context_id=?')
      .get(nativeContext.sessionId);
    if (
      !actual ||
      input.context.provider !== 'owner' ||
      actual.provider !== nativeContext.provider ||
      nativeContext.provider === 'owner' ||
      receipt.requestId !== input.requestId ||
      receipt.contextId !== nativeContext.sessionId ||
      !['groupId', 'memberId', 'installationId', 'visibility'].every(
        (k) => input.context[k as keyof GroupContext] === nativeContext[k as keyof GroupContext],
      )
    )
      throw new GroupIsolationBlocked('Native result owner/context mismatch.');
    if (nativeContext.visibility === 'shared') {
      if (
        !receipt.source ||
        receipt.source.sessionId !== nativeContext.sessionId ||
        receipt.source.nativeSessionId !== nativeContext.nativeSessionId ||
        receipt.source.provider !== nativeContext.provider ||
        !this.#native
          .prepare('SELECT 1 FROM gn_messages WHERE context_id=? AND alias=?')
          .get(nativeContext.sessionId, receipt.source.messageId)
      )
        throw new GroupIsolationBlocked('Exact shared native source alias required.');
    } else if (receipt.source)
      throw new GroupIsolationBlocked('Private result cannot claim shared publication authority.');
    const projected = this.#host
      .prepare('SELECT body FROM ghn_results WHERE request_id=?')
      .get(input.requestId);
    if (requireProjection && !projected)
      throw new GroupIsolationBlocked('Native result has not reached its durable owning chat.');
    if (projected) {
      const body = z
        .object({
          context: groupContextSchema,
          text: z.string(),
          nativeToolItems: z.number(),
          source: groupSourceSchema.optional(),
        })
        .parse(JSON.parse(String(projected.body)));
      if (
        documentNativeDigest(body.context) !== documentNativeDigest(nativeContext) ||
        body.text !== receipt.text ||
        body.nativeToolItems !== receipt.nativeToolItems ||
        documentNativeDigest(body.source ?? null) !== documentNativeDigest(receipt.source ?? null)
      )
        throw new GroupIsolationBlocked('Host projection differs from exact native completion.');
    }
    const reserved = this.#native
      .prepare(
        "SELECT detail FROM gn_events WHERE context_id=? AND kind='container-reserved' ORDER BY sequence DESC LIMIT 1",
      )
      .get(nativeContext.sessionId);
    const saved = z
      .object({ volume: z.string().regex(/^swa-group-[a-f0-9-]{36}$/), manifest: z.string() })
      .parse(JSON.parse(String(reserved?.detail)));
    const plan = JSON.parse(saved.manifest) as GroupContainerPlan;
    if (
      JSON.parse(String(created?.detail)).volume !== saved.volume ||
      plan.context?.contextId !== nativeContext.sessionId ||
      plan.context.groupId !== nativeContext.groupId ||
      plan.context.memberId !== nativeContext.memberId ||
      plan.context.installationId !== nativeContext.installationId ||
      plan.context.visibility !== nativeContext.visibility
    )
      throw new GroupIsolationBlocked('Native guest volume context changed.');
    const volumes = this.#native
      .prepare("SELECT detail FROM gn_events WHERE context_id=? AND kind='container-reserved'")
      .all(nativeContext.sessionId)
      .map((r) => JSON.parse(String(r.detail)).volume);
    if (new Set(volumes).size !== 1)
      throw new GroupIsolationBlocked('Native source volume identity changed.');
    return {
      resultId,
      requestId: input.requestId,
      handle: String(request.handle),
      context: input.context,
      nativeContext,
      receiptSequence: Number(completed!.sequence),
      resultDigest: documentNativeDigest({
        resultId,
        input,
        receiptSequence: completed!.sequence,
        receipt,
        actual,
      }),
      text: receipt.text,
      runId: receipt.runId,
      containerId,
      ...(receipt.source ? { source: receipt.source } : {}),
      nativeTurnId: receipt.nativeTurnId,
      volume: saved.volume,
      plan,
    };
  }
  close() {
    this.#host.close();
    this.#native.close();
  }
}
