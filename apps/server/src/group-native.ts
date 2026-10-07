import {
  groupPromotionNativeScope,
  groupPromotionNativeMode,
} from './group-promotion-native-synthesis.js';
import { groupNativeChildScope } from './group-native-coordination-scope.js';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, userInfo } from 'node:os';
import { z } from 'zod';
import { groupContextSchema, groupSourceSchema, type GroupContext } from '@dock/shared';
import { CodexRpc } from './codex.js';
import { GroupNetworkProxy } from './group-network.js';
import { GroupNativeAuth } from './group-native-auth.js';
import {
  groupContainerSourceDigest,
  GroupContainer,
  GroupDockerEngine,
} from './group-container.js';
import { GroupNativeExecution, type GroupExecutionResources } from './group-native-execution.js';
import { ClaudeSession, type ClaudeIdentity } from './claude-session.js';
import { GroupEventRepository } from './group-events.js';
import {
  GroupIsolation,
  GroupIsolationBlocked,
  groupResourceMounts,
  type GroupIsolationGrant,
} from './group-isolation.js';
import type { ModelPolicy } from './model-policy.js';
import type { NativeProviderBoundary } from './native-provider-boundary.js';
import type { Quark } from './quark.js';
import type { Store } from './store.js';

export interface GroupNativeContext {
  readonly __groupNativeContext: unique symbol;
}
const providerSchema = z.enum(['codex', 'claude']);
const localRowSchema = z.strictObject({
  context: groupContextSchema,
  agentId: z.uuid(),
  // Claude chooses its fresh native ID before startup. Codex returns one after thread/start.
  freshClaudeId: z.uuid().nullable(),
});
type LocalRow = z.infer<typeof localRowSchema>;

export function groupNativeHostDigest() {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const hash = createHash('sha256');
  for (const name of [
    'group-promotion-native-synthesis',
    'group-native',
    'group-container',
    'group-native-execution',
    'group-native-production',
    'group-native-connector',
    'group-native-git-export',
    'group-native-git-export-guest',
    'group-native-coordination-scope',
    'group-coordination-runtime',
    'group-coordination-runtime-native',
    'group-coordination',
    'store',
    'group-events',
    'native-provider-boundary',
    'runtime',
    'model-policy',
    'pulsar',
    'quark',
    'codex',
    'claude-session',
    'group-isolation',
    'group-native-auth',
    'group-network',
    'usage',
  ]) {
    hash
      .update(name + '\0')
      .update(readFileSync(fileURLToPath(new URL(`./${name}.${extension}`, import.meta.url))));
  }
  return hash.digest('hex');
}
const loadedHostDigest = groupNativeHostDigest();
function currentNativeHostDigest() {
  const current = groupNativeHostDigest();
  if (current !== loadedHostDigest)
    throw new GroupIsolationBlocked(
      'Native host source changed after startup. Restart the exact reviewed host snapshot before acceptance/launch.',
    );
  return current;
}
const nativeRequestState = z.enum([
  'queued',
  'admitted',
  'pending-consent',
  'write-intent',
  'native-started',
  'completed',
  'unknown',
  'failed',
]);
const nativeReceiptSchema = z.strictObject({
  requestId: z.uuid(),
  contextId: z.uuid(),
  state: nativeRequestState,
  runId: z.uuid().optional(),
  nativeTurnId: z.string().min(1).max(256).optional(),
  text: z.string().optional(),
  nativeToolItems: z.number().int().nonnegative().optional(),
  source: groupSourceSchema.optional(),
  reason: z.string().optional(),
  reconciled: z.literal(true).optional(),
});
export type GroupNativeReceipt = z.infer<typeof nativeReceiptSchema>;
export type GroupNativeCheck =
  | 'guest-sandbox'
  | 'native-tool'
  | 'namespace-crash'
  | 'namespace-explicit';

/** Local host journal only. Keep it in private ignored host data, outside every
 * group grant; never serve rows, SQLite, raw native events or Store/SSE to peers.
 * The repository stores opaque source aliases; real native IDs remain here.
 */
export class GroupNativeJournal {
  readonly #db: DatabaseSync;
  readonly #handles = new WeakMap<GroupNativeContext, string>();
  constructor(
    readonly path: string,
    readonly repository: GroupEventRepository,
  ) {
    if (path !== ':memory:') {
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0
      )
        throw new GroupIsolationBlocked('Native identity journal must be privately owned.');
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS gn_contexts (context_id TEXT PRIMARY KEY, local_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gn_native (context_id TEXT PRIMARY KEY REFERENCES gn_contexts(context_id),
        provider TEXT NOT NULL, native_id TEXT NOT NULL, UNIQUE(provider,native_id));
      CREATE TABLE IF NOT EXISTS gn_preparations (context_id TEXT PRIMARY KEY REFERENCES gn_contexts(context_id), broker_path TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS gn_messages (context_id TEXT NOT NULL REFERENCES gn_native(context_id),
        native_id TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, PRIMARY KEY(context_id,native_id));
      CREATE TABLE IF NOT EXISTS gn_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gn_requests (request_id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES gn_contexts(context_id), prompt_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gn_request_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES gn_requests(request_id), event_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gn_request_events_request ON gn_request_events(request_id,sequence);
      CREATE TABLE IF NOT EXISTS gn_checks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL REFERENCES gn_contexts(context_id), image TEXT NOT NULL,
        image_source TEXT NOT NULL, host_source TEXT NOT NULL, runtime_signature TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gn_reviews (review_id TEXT PRIMARY KEY, provider TEXT NOT NULL, image TEXT NOT NULL,
        image_source TEXT NOT NULL, host_source TEXT NOT NULL, runtime_signature TEXT NOT NULL, reviewed_commit TEXT NOT NULL, owner_scope TEXT NOT NULL);
      PRAGMA foreign_keys=ON;
      ${[
        'gn_contexts',
        'gn_native',
        'gn_preparations',
        'gn_messages',
        'gn_events',
        'gn_requests',
        'gn_request_events',
        'gn_checks',
        'gn_reviews',
      ]
        .flatMap((table) => [
          `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable native identity'); END;`,
          `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'permanent native identity'); END;`,
        ])
        .join('\n')}
    `);
  }
  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #handle(id: string): GroupNativeContext {
    const handle = Object.freeze({}) as GroupNativeContext;
    this.#handles.set(handle, id);
    return handle;
  }
  /** Host resolves persisted membership. No browser provisioning endpoint exists. */
  issue(
    input: Pick<GroupContext, 'groupId' | 'memberId' | 'installationId' | 'visibility'>,
    agentId: string,
    provider: 'codex' | 'claude',
  ): GroupNativeContext {
    z.uuid().parse(agentId);
    providerSchema.parse(provider);
    const context = this.repository.createContext({
      groupId: input.groupId,
      memberId: input.memberId,
      installationId: input.installationId,
      visibility: input.visibility,
      provider,
      nativeSessionId: randomUUID(),
    });
    const row: LocalRow = {
      context,
      agentId,
      freshClaudeId: provider === 'claude' ? randomUUID() : null,
    };
    this.#transaction(() => {
      this.#db
        .prepare('INSERT INTO gn_contexts VALUES (?,?)')
        .run(context.sessionId, JSON.stringify(row));
      this.#db
        .prepare('INSERT INTO gn_events(context_id,kind,detail) VALUES (?,?,?)')
        .run(context.sessionId, 'issued', 'fresh');
    });
    // If either database write fails the native process has not started. Orphans
    // are burned, never adopted or silently reissued as a resumed conversation.
    return this.#handle(context.sessionId);
  }
  reopen(id: string): GroupNativeContext {
    z.uuid().parse(id);
    if (!this.#db.prepare('SELECT 1 FROM gn_contexts WHERE context_id=?').get(id))
      throw new GroupIsolationBlocked('Unknown local group context.');
    const handle = this.#handle(id);
    this.resolve(handle);
    return handle;
  }
  resolve(handle: GroupNativeContext): LocalRow {
    const id = this.#handles.get(handle);
    if (!id)
      throw new GroupIsolationBlocked(
        'Host-issued context handle required. Browser identity claims have no authority.',
      );
    const saved = this.#db
      .prepare('SELECT local_json FROM gn_contexts WHERE context_id=?')
      .get(id) as { local_json: string };
    const row = localRowSchema.parse(JSON.parse(saved.local_json));
    this.repository.trustedHostScope({
      groupId: row.context.groupId,
      memberId: row.context.memberId,
      installationId: row.context.installationId,
      visibility: row.context.visibility,
      source: {
        sessionId: row.context.sessionId,
        provider: row.context.provider,
        nativeSessionId: row.context.nativeSessionId,
        messageId: 'host-membership-check',
      },
      causalRefs: [],
    });
    return row;
  }
  /** Host adapter event only; never accept a browser's claimed native identity. */
  bindNative(handle: GroupNativeContext, nativeId: string) {
    const row = this.resolve(handle);
    z.string().min(1).max(256).parse(nativeId);
    if (row.freshClaudeId && nativeId !== row.freshClaudeId)
      throw new GroupIsolationBlocked('Claude returned another native identity.');
    this.#transaction(() => {
      const prior = this.#db
        .prepare('SELECT native_id FROM gn_native WHERE context_id=?')
        .get(row.context.sessionId) as { native_id: string } | undefined;
      if (prior) {
        if (prior.native_id !== nativeId)
          throw new GroupIsolationBlocked('Native identity is immutable.');
        return;
      }
      this.#db
        .prepare('INSERT INTO gn_native VALUES (?,?,?)')
        .run(row.context.sessionId, row.context.provider, nativeId);
      this.#db
        .prepare('INSERT INTO gn_events(context_id,kind,detail) VALUES (?,?,?)')
        .run(row.context.sessionId, 'bound', 'fresh-native');
    });
  }
  /** Export only scoped opaque aliases, including message IDs. Private contexts
   * cannot create a publication source. Native IDs never enter groupSource.
   */
  publicationSource(handle: GroupNativeContext, nativeMessageId: string) {
    const row = this.resolve(handle);
    if (row.context.visibility !== 'shared')
      throw new GroupIsolationBlocked('Private native context has no publication authority.');
    z.string().min(1).max(256).parse(nativeMessageId);
    return this.#transaction(() => {
      const prior = this.#db
        .prepare('SELECT alias FROM gn_messages WHERE context_id=? AND native_id=?')
        .get(row.context.sessionId, nativeMessageId) as { alias: string } | undefined;
      const alias = prior?.alias ?? randomUUID();
      if (!prior)
        this.#db
          .prepare('INSERT INTO gn_messages VALUES (?,?,?)')
          .run(row.context.sessionId, nativeMessageId, alias);
      return groupSourceSchema.parse({
        sessionId: row.context.sessionId,
        provider: row.context.provider,
        nativeSessionId: row.context.nativeSessionId,
        messageId: alias,
      });
    });
  }
  claimPreparation(handle: GroupNativeContext, brokerSocket?: string) {
    const row = this.resolve(handle);
    try {
      this.#transaction(() => {
        this.#db
          .prepare('INSERT INTO gn_preparations VALUES (?,?)')
          .run(row.context.sessionId, brokerSocket ? realpathSync.native(brokerSocket) : null);
        this.#db
          .prepare('INSERT INTO gn_events(context_id,kind,detail) VALUES (?,?,?)')
          .run(row.context.sessionId, 'preparation-claimed', 'permanent');
      });
    } catch {
      throw new GroupIsolationBlocked(
        'Native preparation cannot be claimed. Inspect prior attempt/storage; no context reuse or automatic retry.',
      );
    }
  }
  blocked(handle: GroupNativeContext, reason: string) {
    const row = this.resolve(handle);
    this.#db
      .prepare('INSERT INTO gn_events(context_id,kind,detail) VALUES (?,?,?)')
      .run(row.context.sessionId, 'blocked', reason);
  }
  nativeId(handle: GroupNativeContext): string | null {
    const row = this.resolve(handle);
    const native = this.#db
      .prepare('SELECT native_id FROM gn_native WHERE context_id=?')
      .get(row.context.sessionId);
    return native ? String(native.native_id) : null;
  }
  retainPrivateMessage(handle: GroupNativeContext, nativeMessageId: string) {
    const row = this.resolve(handle);
    if (row.context.visibility !== 'private')
      throw new GroupIsolationBlocked('Private receipt required.');
    z.string().min(1).max(256).parse(nativeMessageId);
    this.#db
      .prepare('INSERT OR IGNORE INTO gn_messages VALUES (?,?,?)')
      .run(row.context.sessionId, nativeMessageId, randomUUID());
  }
  runtimeEvent(handle: GroupNativeContext, kind: string, detail: Record<string, string>) {
    const id = this.#handles.get(handle);
    if (!id) throw new GroupIsolationBlocked('Local cleanup ownership required.');
    z.enum([
      'container-reserved',
      'container-created',
      'container-stopped',
      'container-stop-unverified',
    ]).parse(kind);
    z.record(z.string(), z.string().max(16384)).parse(detail);
    this.#db
      .prepare('INSERT INTO gn_events(context_id,kind,detail) VALUES (?,?,?)')
      .run(id, kind, JSON.stringify(detail));
  }
  containerReceipt(handle: GroupNativeContext, container: string, kind: 'created' | 'stopped') {
    const row = this.resolve(handle);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(container);
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM gn_events WHERE context_id=? AND kind=? AND json_extract(detail,'$.container')=?",
        )
        .get(row.context.sessionId, `container-${kind}`, container) !== undefined
    );
  }
  request(handle: GroupNativeContext, requestId: string): GroupNativeReceipt | null {
    const row = this.resolve(handle);
    z.uuid().parse(requestId);
    const request = this.#db
      .prepare('SELECT context_id FROM gn_requests WHERE request_id=?')
      .get(requestId);
    if (!request) return null;
    if (request.context_id !== row.context.sessionId)
      throw new GroupIsolationBlocked('Native request belongs to another trusted context.');
    const latest = this.#db
      .prepare(
        'SELECT event_json FROM gn_request_events WHERE request_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(requestId);
    return latest
      ? nativeReceiptSchema.parse(JSON.parse(String(latest.event_json)))
      : { requestId, contextId: row.context.sessionId, state: 'queued' };
  }
  beginRequest(handle: GroupNativeContext, requestId: string, prompt: string) {
    const row = this.resolve(handle);
    z.uuid().parse(requestId);
    z.string().trim().min(1).max(200000).parse(prompt);
    const hash = createHash('sha256').update(prompt).digest('hex');
    return this.#transaction(() => {
      const prior = this.#db
        .prepare('SELECT context_id,prompt_hash FROM gn_requests WHERE request_id=?')
        .get(requestId);
      if (prior) {
        if (prior.context_id !== row.context.sessionId || prior.prompt_hash !== hash)
          throw new GroupIsolationBlocked(
            'Native request idempotency key changed context or input.',
          );
        return { fresh: false, receipt: this.request(handle, requestId)! };
      }
      this.#db
        .prepare('INSERT INTO gn_requests VALUES (?,?,?)')
        .run(requestId, row.context.sessionId, hash);
      return {
        fresh: true,
        receipt: { requestId, contextId: row.context.sessionId, state: 'queued' as const },
      };
    });
  }
  /** Before-input recovery proof. Absence of an actual turn ID alone is not
   * enough: the append-only write-intent is persisted before provider delivery. */
  canRecoverPendingConsent(handle: GroupNativeContext, requestId: string) {
    const receipt = this.request(handle, requestId);
    if (!receipt || !['pending-consent', 'unknown', 'failed'].includes(receipt.state)) return false;
    const history = this.#db
      .prepare(
        `SELECT
        EXISTS(SELECT 1 FROM gn_request_events WHERE request_id=? AND json_extract(event_json,'$.state')='pending-consent') AS consent,
        EXISTS(SELECT 1 FROM gn_request_events WHERE request_id=? AND
          (json_extract(event_json,'$.state') IN ('write-intent','native-started','completed') OR json_extract(event_json,'$.nativeTurnId') IS NOT NULL)) AS submitted`,
      )
      .get(requestId, requestId)!;
    return Boolean(history.consent && !history.submitted && this.savedContainer(handle));
  }
  /** Called only after the ordinary admitted bridge has verified the old
   * namespaces stopped and reopened their exact volume. Never a generic rollback. */
  restorePendingConsent(
    handle: GroupNativeContext,
    requestId: string,
    prompt: string,
    runId: string,
  ) {
    z.uuid().parse(runId);
    return this.#transaction(() => {
      const prior = this.request(handle, requestId);
      const input = this.#db
        .prepare('SELECT prompt_hash FROM gn_requests WHERE request_id=?')
        .get(requestId);
      if (
        !prior ||
        input?.prompt_hash !== createHash('sha256').update(prompt).digest('hex') ||
        !this.canRecoverPendingConsent(handle, requestId)
      )
        throw new GroupIsolationBlocked('Only a proved unsubmitted pending request may reconnect.');
      const restored = nativeReceiptSchema.parse({
        ...prior,
        state: 'pending-consent',
        runId,
        reason:
          'The same unsubmitted request and private guest state were reconnected. Check native sign-in, then explicitly continue.',
      });
      // An earlier read-only inspection may have reconciled no result. That
      // marker cannot suppress reconciliation of a later explicitly sent turn.
      delete restored.reconciled;
      this.#db
        .prepare('INSERT INTO gn_request_events(request_id,event_json) VALUES (?,?)')
        .run(requestId, JSON.stringify(restored));
      return restored;
    });
  }
  requestEvent(
    handle: GroupNativeContext,
    requestId: string,
    patch: Partial<Omit<GroupNativeReceipt, 'requestId' | 'contextId'>>,
  ) {
    const old = this.request(handle, requestId);
    if (!old) throw new GroupIsolationBlocked('Durable native request intent required.');
    if (old.state === 'completed') return old;
    const transitions: Record<GroupNativeReceipt['state'], GroupNativeReceipt['state'][]> = {
      queued: ['queued', 'admitted', 'unknown', 'failed'],
      admitted: ['admitted', 'pending-consent', 'write-intent', 'unknown', 'failed'],
      'pending-consent': ['pending-consent', 'write-intent', 'unknown', 'failed'],
      'write-intent': ['write-intent', 'native-started', 'completed', 'unknown'],
      'native-started': ['native-started', 'completed', 'unknown'],
      unknown: ['unknown', 'completed'],
      failed: ['failed'],
      completed: ['completed'],
    };
    if (patch.state && !transitions[old.state].includes(patch.state))
      throw new GroupIsolationBlocked('Native receipt cannot regress or replay submitted input.');
    if (old.nativeTurnId && patch.nativeTurnId && old.nativeTurnId !== patch.nativeTurnId)
      throw new GroupIsolationBlocked('Native request actual turn identity is immutable.');
    const next = nativeReceiptSchema.parse({ ...old, ...patch });
    if (
      (next.text !== undefined || next.source || next.nativeToolItems !== undefined) &&
      next.state !== 'completed'
    )
      throw new GroupIsolationBlocked('Only verified native completion carries a result.');
    if (this.resolve(handle).context.visibility === 'private' && next.source)
      throw new GroupIsolationBlocked('Private native result has no shared source.');
    if (next.source) {
      const row = this.resolve(handle).context;
      if (
        next.source.sessionId !== row.sessionId ||
        next.source.nativeSessionId !== row.nativeSessionId ||
        next.source.provider !== row.provider ||
        !this.#db
          .prepare('SELECT 1 FROM gn_messages WHERE context_id=? AND alias=?')
          .get(row.sessionId, next.source.messageId)
      )
        throw new GroupIsolationBlocked('Exact actual native message alias required.');
    }
    this.#db
      .prepare('INSERT INTO gn_request_events(request_id,event_json) VALUES (?,?)')
      .run(requestId, JSON.stringify(next));
    return next;
  }
  /** Internal actual-namespace observation only, never a browser/owner bool. */
  nativeCheck(
    handle: GroupNativeContext,
    image: string,
    runtimeSignature: string,
    kind: GroupNativeCheck,
    detail: unknown,
  ) {
    const row = this.resolve(handle);
    z.string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(image);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(runtimeSignature);
    const schema =
      kind === 'guest-sandbox'
        ? z.strictObject({
            privacy: z.literal(true),
            nested: z.literal(true),
            browser: z.literal(true),
          })
        : kind === 'native-tool'
          ? z.strictObject({
              toolReceiptVerified: z.literal(true),
              nativeToolItems: z.number().int().positive(),
            })
          : z.strictObject({
              stopped: z.literal(true),
              descendantClasses: z.tuple([
                z.literal('double-fork'),
                z.literal('fork'),
                z.literal('setsid'),
              ]),
              heartbeatsCeased: z.literal(true),
            });
    const value = schema.parse(detail);
    this.#db
      .prepare(
        'INSERT INTO gn_checks(context_id,image,image_source,host_source,runtime_signature,kind,detail_json) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        row.context.sessionId,
        image,
        groupContainerSourceDigest(),
        currentNativeHostDigest(),
        runtimeSignature,
        kind,
        JSON.stringify(value),
      );
  }
  /** Root-only exact independent-review disposition AFTER real captured checks.
   * No arbitrary available flag: image/kernel/host/image-source checks are required.
   * Root explicitly accepts the documented Linux-native scope, never macOS control.
   */
  approveNativeArtifact(
    handle: GroupNativeContext,
    reviewedCommit: string,
    scope: 'linux-guest-tools',
  ) {
    const row = this.resolve(handle);
    z.string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(reviewedCommit);
    z.literal('linux-guest-tools').parse(scope);
    const source = groupContainerSourceDigest(),
      host = currentNativeHostDigest();
    const latest = this.#db
      .prepare(
        'SELECT image,runtime_signature FROM gn_checks WHERE context_id=? AND image_source=? AND host_source=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(row.context.sessionId, source, host);
    if (!latest)
      throw new GroupIsolationBlocked('Actual current native acceptance evidence is missing.');
    const kinds = this.#db
      .prepare(
        `SELECT DISTINCT c.kind FROM gn_checks c JOIN gn_contexts x ON x.context_id=c.context_id
      WHERE c.image=? AND c.image_source=? AND c.host_source=? AND c.runtime_signature=? AND json_extract(x.local_json,'$.context.provider')=?`,
      )
      .all(
        String(latest.image),
        source,
        host,
        String(latest.runtime_signature),
        row.context.provider,
      )
      .map((r) => r.kind);
    if (
      !['guest-sandbox', 'native-tool', 'namespace-crash', 'namespace-explicit'].every((kind) =>
        kinds.includes(kind),
      )
    )
      throw new GroupIsolationBlocked(
        'Real native tool, sandbox/browser, detached crash AND explicit-stop acceptance required.',
      );
    const reviewId = randomUUID();
    this.#db
      .prepare('INSERT INTO gn_reviews VALUES (?,?,?,?,?,?,?,?)')
      .run(
        reviewId,
        row.context.provider,
        String(latest.image),
        source,
        host,
        String(latest.runtime_signature),
        reviewedCommit,
        scope,
      );
    return { reviewId, image: String(latest.image), provider: row.context.provider, scope };
  }
  artifactReady(image: string, provider: 'codex' | 'claude', runtimeSignature: string) {
    return !!this.#db
      .prepare(
        'SELECT 1 FROM gn_reviews WHERE image=? AND provider=? AND image_source=? AND host_source=? AND runtime_signature=? AND owner_scope=?',
      )
      .get(
        image,
        provider,
        groupContainerSourceDigest(),
        currentNativeHostDigest(),
        runtimeSignature,
        'linux-guest-tools',
      );
  }
  savedContainer(handle: GroupNativeContext) {
    const row = this.resolve(handle);
    const saved = this.#db
      .prepare(
        "SELECT detail FROM gn_events WHERE context_id=? AND kind='container-reserved' ORDER BY sequence",
      )
      .all(row.context.sessionId);
    if (!saved.length) return null;
    const epochs = saved.map((entry) =>
      z
        .object({
          volume: z.string().regex(/^swa-group-[a-f0-9-]{36}$/),
          name: z.string().regex(/^swa-group-[a-f0-9-]{36}$/),
          manifest: z.string(),
        })
        .parse(JSON.parse(String(entry.detail))),
    );
    if (new Set(epochs.map((epoch) => epoch.volume)).size !== 1)
      throw new GroupIsolationBlocked('Context guest volume identity changed; no auth relocation.');
    return { ...epochs.at(-1)!, epochs };
  }
  close() {
    this.#db.close();
  }
}

export const GROUP_NATIVE_BLOCKER =
  'Native authentication/network, provider nesting and full native tools are unverified; escaped-descendant stop failed its canary. Production group launch is denied; no account-home or full-access fallback.';

/** Concrete native adapter seam. There is deliberately no verified=true flag,
 * browser switch or self-certified receipt that can enable production launch.
 * A separate reviewed auth/transport implementation must replace this denial.
 */
export class GroupNativeBridge {
  constructor(
    readonly journal: GroupNativeJournal,
    readonly store: Store,
    readonly models: ModelPolicy,
    readonly quark: Quark,
  ) {}
  #admitted(runId: string, handle: GroupNativeContext) {
    const row = this.journal.resolve(handle),
      run = this.store.run(runId);
    const agent = this.store.agent(row.agentId);
    const ledger = this.quark.runs().find((entry) => entry.runId === runId);
    if (
      run.agentId !== row.agentId ||
      run.status !== 'running' ||
      !this.quark.executing().has(agent.id) ||
      !this.quark.pulsar.hasReservation(runId) ||
      !ledger ||
      ledger.finishedAt !== null ||
      ledger.agentId !== agent.id ||
      ledger.provider !== agent.provider ||
      ledger.model !== agent.model ||
      this.store.getSetting(`group:native-stop-intent:${runId}`) ||
      this.store.getSetting(`group:native-stop-unverified:${runId}`) ||
      agent.provider !== row.context.provider ||
      agent.nativeRootId ||
      (agent.threadId && agent.threadId !== this.journal.nativeId(handle)) ||
      agent.toolPolicy !== 'native'
    )
      throw new GroupIsolationBlocked(
        'Fresh native agent and current host QUARK execution required.',
      );
    if (agent.role === 'manager') this.quark.requireManagerLease(run);
    const reason = this.quark.reason(run);
    if (reason) throw new GroupIsolationBlocked(`QUARK admission held: ${reason}`);
    return { row, run, agent };
  }
  /** Full native acceptance route, not an auth-only canary. Owner runtime/native
   * consent follows independent review. The normal app remains denied until
   * actual native tools, nesting and detached/crash stop acceptance is retained.
   * The owning host supplies the reviewed image ID and complete resource inventory.
   */
  async prepareExecution(
    runId: string,
    handle: GroupNativeContext,
    resources: GroupExecutionResources,
  ) {
    return this.#execution(runId, handle, resources, true);
  }
  async probeExecution(
    runId: string,
    handle: GroupNativeContext,
    resources: GroupExecutionResources,
  ) {
    return this.#execution(runId, handle, resources, false);
  }
  async #execution(
    runId: string,
    handle: GroupNativeContext,
    resources: GroupExecutionResources,
    production: boolean,
  ) {
    const { row, agent: original } = this.#admitted(runId, handle);
    const synthesis = production
      ? groupPromotionNativeScope(
          this.store,
          this.journal.repository,
          this.journal,
          handle,
          resources,
        )
      : null;
    const synthesisBinding = synthesis
      ? groupPromotionNativeMode(this.store, row.agentId)!
      : undefined;
    const retained = production ? this.journal.savedContainer(handle) : null;
    const childScope =
      production && !synthesis
        ? groupNativeChildScope(this.store, this.journal, handle, resources)
        : null;
    if (!retained && (original.threadId || this.journal.nativeId(handle)))
      throw new GroupIsolationBlocked('Fresh native context required.');
    const agent = await this.models.prepare(original, runId);
    this.#admitted(runId, handle);
    if (!agent.model || !agent.effort)
      throw new GroupIsolationBlocked('Central model policy is unresolved.');
    const engine = new GroupDockerEngine();
    const available = await engine.availability(resources.image);
    if (available.state !== 'ready') throw new GroupIsolationBlocked(available.reason);
    // No image pull, runtime start, host auth lookup or credential export here.
    if (
      production &&
      !this.journal.artifactReady(
        resources.image,
        providerSchema.parse(row.context.provider),
        available.runtimeSignature,
      )
    )
      throw new GroupIsolationBlocked(
        'Exact independent review and real native sandbox/tool/detached-stop acceptance are required for this artifact and Engine.',
      );
    if (!retained) this.journal.claimPreparation(handle);
    else
      for (const epoch of retained.epochs)
        await engine.retireReservation(epoch.name, JSON.parse(epoch.manifest), epoch.volume);
    const state = join(
      realpathSync.native(resources.stateBase),
      `native-container-${row.context.sessionId}-${runId}`,
    );
    mkdirSync(state, { mode: 0o700 });
    const mounts = groupResourceMounts(resources.workspace, resources.readResources, state, [
      ...new Set([...resources.forbiddenPaths, ...this.#privateRoots()]),
    ]);
    const admitted = () => {
      this.#admitted(runId, handle);
      synthesis?.check();
      mounts.check();
      if (Date.now() >= resources.expiresAt)
        throw new GroupIsolationBlocked('Guest grant expired.');
    };
    const container = new GroupContainer(
      engine,
      {
        context: {
          installationId: row.context.installationId,
          groupId: row.context.groupId,
          memberId: row.context.memberId,
          contextId:
            synthesis?.context.sessionId ?? childScope?.context.sessionId ?? row.context.sessionId,
          visibility: row.context.visibility,
        },
        image: resources.image,
        workspace: mounts.workspace,
        reads: mounts.reads,
        expiresAt: resources.expiresAt,
        outbound: resources.outbound,
        ...this.quark.pulsar.admittedResources(runId),
      },
      admitted,
      state,
      (kind, detail) => {
        this.journal.runtimeEvent(handle, kind, detail);
        if (kind === 'container-stop-unverified') {
          if (!this.store.getSetting(`group:native-stop-intent:${runId}`))
            this.store.setSetting(`group:native-stop-intent:${runId}`, {
              requestedAt: new Date().toISOString(),
              reason: 'Owned namespace close could not be verified.',
            });
          this.store.setSetting(`group:native-stop-unverified:${runId}`, true);
          this.quark.hold(
            this.store.run(runId),
            'Owned namespace stop is unverified. Retain reservation; no automatic restart.',
          );
        }
      },
      retained?.volume ?? synthesis?.volume ?? childScope?.volume,
    );
    const execution = new GroupNativeExecution(
      container,
      agent,
      this.store,
      runId,
      this.journal,
      handle,
      admitted,
      {
        retained: !!retained || !!childScope || !!synthesis,
        ...(synthesis ? { workspace: synthesis.workspace, synthesisBinding } : {}),
        ...(childScope ? { workspace: childScope.workspace } : {}),
        tools: (resources.tools ?? []).map((tool) => ({
          ...tool,
          invoke: async (input, context) => {
            admitted();
            const result = await tool.invoke(input, context);
            admitted();
            return result;
          },
        })),
        recordCheck: (kind, detail) =>
          this.journal.nativeCheck(
            handle,
            resources.image,
            available.runtimeSignature,
            kind,
            detail,
          ),
      },
    );
    try {
      await execution.initialize();
      return execution;
    } catch {
      await execution.close();
      throw new GroupIsolationBlocked(
        'Owned full native route failed preparation. No unconfined fallback or automatic context reuse.',
      );
    }
  }
  /** Supported local owning-executor entry point for root acceptance. The run
   * must already be admitted by the normal scheduler/Pulsar/QUARK; this method
   * never manufactures a reservation or launches through an unmanaged CLI.
   * Actual native account/read is performed, but no model/tool call or sign-in.
   * Device consent is a separate explicit operation on the returned capability.
   */
  async probeAuthentication(
    runId: string,
    handle: GroupNativeContext,
    resources: Omit<GroupIsolationGrant, 'identity' | 'authentication'>,
    binary: string,
  ) {
    const { row, agent: original } = this.#admitted(runId, handle);
    if (row.context.provider !== 'codex')
      throw new GroupIsolationBlocked(
        'Claude native Keychain access is not yet proven isolated from personal credentials. No API-billing or token-extraction fallback.',
      );
    await this.models.prepare(original, runId);
    this.#admitted(runId, handle);
    if (resources.requireNestedSandbox)
      throw new GroupIsolationBlocked(
        'Authentication-only admission does not launch tools or nest a provider sandbox.',
      );
    this.journal.claimPreparation(handle, resources.broker?.socket);
    const current = () => {
      try {
        this.#admitted(runId, handle);
        return Date.now() < resources.expiresAt;
      } catch {
        return false;
      }
    };
    const proxy = await GroupNetworkProxy.open(
      ['auth.openai.com', 'chatgpt.com', 'api.openai.com'],
      current,
    );
    const socket = join(
      realpathSync.native('/tmp'),
      `swa-group-auth-${process.getuid!()}-${randomUUID()}`,
      'rpc.sock',
    );
    let isolation: GroupIsolation | undefined;
    let adapter: CodexRpc | undefined;
    let directoryCreated = false;
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        await adapter?.close();
        await proxy.close();
        isolation?.close();
        if (directoryCreated) {
          // Remove only the directory exclusively created by this route.
          rmSync(dirname(socket), { recursive: true, force: true });
          directoryCreated = false;
        }
      })());
    try {
      mkdirSync(dirname(socket), { mode: 0o700 });
      directoryCreated = true;
      isolation = GroupIsolation.prepare({
        ...resources,
        forbiddenPaths: [...new Set([...resources.forbiddenPaths, ...this.#privateRoots()])],
        authentication: { socket, proxyPort: proxy.port },
        identity: {
          installationId: row.context.installationId,
          groupId: row.context.groupId,
          memberId: row.context.memberId,
          contextId: row.context.sessionId,
          visibility: row.context.visibility,
        },
      });
      const boundary: NativeProviderBoundary = {
        codexDirect: true,
        // Official native memory-only auth. No account credential files are
        // loaded/copied and no provider feature classes are disabled/renamed.
        codexArgs: ['-c', 'cli_auth_credentials_store="ephemeral"'],
        environment: Object.freeze({
          ...isolation.environment(),
          HTTPS_PROXY: proxy.url,
          HTTP_PROXY: proxy.url,
          ALL_PROXY: proxy.url,
          NO_PROXY: '',
        }),
        check: async (provider) => {
          this.#admitted(runId, handle);
          if (provider !== 'codex') throw new GroupIsolationBlocked('Provider mismatch.');
        },
        spawn: (executable, args, options) => {
          this.#admitted(runId, handle);
          if (executable !== binary || options.cwd !== resources.workspace)
            throw new GroupIsolationBlocked(
              'Only the host-selected native authentication process is admitted.',
            );
          return isolation!.spawnAuthentication(
            executable,
            args,
            { ...boundary.environment, RUST_LOG: 'error' },
            current,
          );
        },
        verifyClaudeIdentity: async () => {
          throw new GroupIsolationBlocked('No Claude authentication grant.');
        },
      };
      adapter = new CodexRpc(
        binary,
        socket,
        resources.workspace,
        false,
        false,
        'v2',
        'disabled',
        false,
        true,
        undefined,
        boundary,
      );
      await adapter.start();
      const auth = new GroupNativeAuth(
        adapter,
        () => {
          this.#admitted(runId, handle);
          if (!current())
            throw new GroupIsolationBlocked('Native authentication grant expired or was revoked.');
        },
        close,
      );
      try {
        if ((await auth.inspect()) !== 'signed-out')
          throw new GroupIsolationBlocked(
            'Fresh ephemeral native process unexpectedly had an account.',
          );
      } catch (error) {
        await auth.close();
        throw error;
      }
      this.journal.blocked(
        handle,
        'Native auth probe initialized; manual device authorization and whole-tree native compatibility remain required.',
      );
      return auth;
    } catch {
      await close();
      throw new GroupIsolationBlocked(
        'Admitted isolated native authentication probe failed. No sign-in, model turn, credential copy or full-access fallback was started.',
      );
    }
  }
  #privateRoots() {
    return [
      dirname(this.store.path),
      dirname(this.journal.path),
      ...[homedir(), userInfo().homedir]
        .flatMap((home) => [
          join(home, '.codex'),
          join(home, '.claude'),
          join(home, '.claude.json'),
        ])
        .filter(existsSync),
      ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter(
        (path): path is string => !!path && existsSync(path),
      ),
    ];
  }
  async prepare(
    runId: string,
    handle: GroupNativeContext,
    resources: Omit<GroupIsolationGrant, 'identity' | 'authentication'>,
    binary: string,
  ) {
    const admitted = this.#admitted(runId, handle);
    const agent = await this.models.prepare(admitted.agent, runId);
    this.#admitted(runId, handle); // Discovery is asynchronous; never borrow an old admission.
    if (!agent.model || !agent.effort)
      throw new GroupIsolationBlocked('Central model assignment is unresolved.');
    const context = admitted.row.context;
    const affinity =
      context.provider === 'claude'
        ? z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .safeParse(this.store.getSetting(`claude:account:${agent.id}`))
        : null;
    if (affinity && !affinity.success)
      throw new GroupIsolationBlocked(
        'Trusted sanitized Claude account affinity required; scoped authentication is unavailable.',
      );
    const privateRoots = this.#privateRoots();
    // Permanent across restart and state-root changes. An uncertain/failed
    // preparation must be inspected, never retried as a fresh native context.
    this.journal.claimPreparation(handle, resources.broker?.socket);
    const isolation = GroupIsolation.prepare({
      ...resources,
      forbiddenPaths: [...new Set([...resources.forbiddenPaths, ...privateRoots])],
      identity: {
        installationId: context.installationId,
        groupId: context.groupId,
        memberId: context.memberId,
        contextId: context.sessionId,
        visibility: context.visibility,
      },
    });
    const deny = () => {
      this.journal.blocked(handle, GROUP_NATIVE_BLOCKER);
      throw new GroupIsolationBlocked(GROUP_NATIVE_BLOCKER);
    };
    const boundary: NativeProviderBoundary = {
      environment: Object.freeze({
        HOME: isolation.home,
        CODEX_HOME: join(isolation.home, 'codex'),
        CLAUDE_CONFIG_DIR: join(isolation.home, 'claude'),
      }),
      check: async () => {
        this.#admitted(runId, handle);
        deny();
      },
      spawn: deny,
      verifyClaudeIdentity: async (): Promise<ClaudeIdentity> => deny(),
    };
    // Preserve the native adapters' inheritance switches. Actual native config,
    // skills/hooks/tool compatibility is still unverified in a fresh home.
    let adapter: CodexRpc | ClaudeSession;
    try {
      adapter =
        context.provider === 'codex'
          ? new CodexRpc(
              binary,
              join(isolation.temp, 'rpc.sock'),
              resources.workspace,
              false,
              agent.pluginsEnabled,
              'v2',
              agent.webSearch,
              agent.imageGeneration,
              true,
              undefined,
              boundary,
            )
          : new ClaudeSession({
              binary,
              cwd: resources.workspace,
              sessionId: admitted.row.freshClaudeId!,
              resume: false,
              accountAffinity: affinity!.data!,
              role: 'implementer',
              inheritNative: true,
              model: agent.model,
              effort: agent.effort,
              charter: 'Use only host-granted group resources.',
              tools: [],
              boundary,
            });
    } catch (error) {
      isolation.close();
      throw error;
    }
    return {
      adapter,
      isolation,
      close: async () => {
        try {
          await adapter.close();
        } finally {
          isolation.close();
        }
      },
    };
  }
}
