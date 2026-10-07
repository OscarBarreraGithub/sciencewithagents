import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  groupNativeOwnerInputSchema,
  groupNativeOwnerStatusSchema,
  type GroupNativeOwnerStatus,
} from '@dock/shared/dist/group-native-owner.js';
import type { GroupHostFeatureContext } from './group-host-context.js';
import type { GroupNativeConnector } from './group-native-connector.js';
import type { GroupNativeHandoff } from './group-native-production.js';
import type { GroupNativeExecution } from './group-native-execution.js';
import type { GroupNativeOwnerConfig } from './group-native-owner-config.js';
import { privateGroupFile, protectGroupSidecars } from './group-host-storage.js';
import { publicationCanonical } from './group-publication-protocol.js';

export interface GroupNativeOwnerPort {
  control(
    scope: GroupHostFeatureContext,
    input: unknown,
    ownerAuthorized: boolean,
    retainedRequest?: GroupNativeHandoff,
  ): Promise<GroupNativeOwnerStatus>;
  close(): void | Promise<void>;
}
type Acceptance = ReturnType<GroupNativeConnector['ownerAcceptance']>;
type Live = { acceptance: Acceptance; execution?: GroupNativeExecution; busy?: Promise<void> };
type LoginTerminal = (
  key: string,
  invocation: ReturnType<GroupNativeExecution['ownerClaudeLogin']>,
) => string;
const safeFailure =
  'Native setup could not complete. Inspect this saved context before retrying; uncertain model input is never replayed.';

/** Owning-installation owner capability controller. Durable intent precedes every effect. Codes,
 * native IDs, paths, credentials and provider diagnostics are never journaled. */
export class GroupNativeOwner implements GroupNativeOwnerPort {
  private readonly db: DatabaseSync;
  private readonly live = new Map<string, Live>();
  private readonly signIns = new Map<
    string,
    { expires: number; device?: GroupNativeOwnerStatus['device']; terminalId?: string }
  >();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    directory: string,
    private readonly connector: GroupNativeConnector,
    private readonly config: GroupNativeOwnerConfig | null,
    private readonly loginTerminal?: LoginTerminal,
  ) {
    const path = join(directory, 'native-owner.sqlite');
    privateGroupFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS gno_contexts(handle TEXT PRIMARY KEY,scope TEXT NOT NULL,setup_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gno_operations(key TEXT PRIMARY KEY,input TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gno_operations_request_action ON gno_operations(json_extract(input,'$.requestId'),json_extract(input,'$.action'));
      CREATE TABLE IF NOT EXISTS gno_continuations(request_id TEXT PRIMARY KEY,key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gno_signins(binding TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS gno_signin_retries(key TEXT PRIMARY KEY,binding TEXT NOT NULL,attempted_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS gno_signin_retries_binding ON gno_signin_retries(binding);
      CREATE TABLE IF NOT EXISTS gno_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,handle TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gno_receipts_handle_sequence ON gno_receipts(handle,sequence);
      CREATE TRIGGER IF NOT EXISTS gno_contexts_immutable BEFORE UPDATE ON gno_contexts BEGIN SELECT RAISE(ABORT,'immutable owner context'); END;
      CREATE TRIGGER IF NOT EXISTS gno_operations_immutable BEFORE UPDATE ON gno_operations BEGIN SELECT RAISE(ABORT,'immutable owner operation'); END;
      CREATE TRIGGER IF NOT EXISTS gno_receipts_immutable BEFORE UPDATE ON gno_receipts BEGIN SELECT RAISE(ABORT,'immutable owner receipt'); END;`);
    // Preserve old append-only attempts. Their unknown timestamps cannot justify
    // a lifetime lockout; new attempts enforce only the explicit recent cooldown.
    if (
      !this.db
        .prepare('PRAGMA table_info(gno_signin_retries)')
        .all()
        .some((row) => row.name === 'attempted_at')
    )
      this.db.exec('ALTER TABLE gno_signin_retries ADD COLUMN attempted_at INTEGER NOT NULL DEFAULT 0');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS gno_signin_retries_recent ON gno_signin_retries(binding,attempted_at)',
    );
    for (const table of [
      'gno_contexts',
      'gno_operations',
      'gno_receipts',
      'gno_continuations',
      'gno_signins',
      'gno_signin_retries',
    ]) {
      this.db.exec(
        `CREATE TRIGGER IF NOT EXISTS ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retained owner evidence'); END;`,
      );
      if (
        table === 'gno_continuations' ||
        table === 'gno_signins' ||
        table === 'gno_signin_retries'
      )
        this.db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable owner evidence'); END;`,
        );
    }
    protectGroupSidecars(path);
  }
  private saved(handle: string) {
    const row = this.db
      .prepare('SELECT body FROM gno_receipts WHERE handle=? ORDER BY sequence DESC LIMIT 1')
      .get(handle);
    return row ? groupNativeOwnerStatusSchema.parse(JSON.parse(String(row.body))) : null;
  }
  private record(handle: string, value: GroupNativeOwnerStatus) {
    const prior = this.saved(handle);
    if (prior?.state === 'rejected' && value.state !== 'rejected') return prior;
    const safe = groupNativeOwnerStatusSchema.omit({ device: true, terminalId: true }).parse(value);
    if (prior && publicationCanonical(prior) === publicationCanonical(safe)) return prior;
    this.db
      .prepare('INSERT INTO gno_receipts(handle,body) VALUES (?,?)')
      .run(handle, JSON.stringify(safe));
    return safe;
  }
  private initial(): GroupNativeOwnerStatus {
    return {
      configured: !!this.config,
      productionReady: false,
      provider: this.config?.route.provider ?? null,
      setupId: null,
      state: this.config ? 'not-started' : 'unconfigured',
      message: this.config
        ? 'Prepare this saved context, then authorize its fresh isolated provider sign-in.'
        : 'Ask your setup agent to register the verified native host route. Human messages remain available.',
    };
  }
  private binding(scope: GroupHostFeatureContext) {
    const saved = this.db
      .prepare('SELECT scope FROM gno_contexts WHERE handle=?')
      .get(scope.handle);
    if (
      saved &&
      String(saved.scope) !==
        publicationCanonical({ context: scope.context, enrollmentHandle: scope.enrollmentHandle })
    )
      throw new Error('Owner context changed.');
  }
  async control(
    scope: GroupHostFeatureContext,
    raw: unknown,
    ownerAuthorized: boolean,
    retainedRequest?: GroupNativeHandoff,
  ): Promise<GroupNativeOwnerStatus> {
    const input = groupNativeOwnerInputSchema.parse(raw);
    if (scope.handle !== input.handle || scope.context.provider !== 'owner')
      throw new Error('Saved owner context required.');
    await scope.revalidate();
    this.binding(scope);
    // Only the owning installation’s authenticated owner UI may reach this port.
    if (!ownerAuthorized)
      throw new Error('Authenticate as the owner of the selected installation.');
    const previous = this.locks.get(input.handle) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.perform(scope, input, retainedRequest));
    this.locks.set(input.handle, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(input.handle) === pending) this.locks.delete(input.handle);
    }
  }
  private async perform(
    scope: GroupHostFeatureContext,
    input: ReturnType<typeof groupNativeOwnerInputSchema.parse>,
    retainedRequest?: GroupNativeHandoff,
  ): Promise<GroupNativeOwnerStatus> {
    await scope.revalidate();
    if ('requestId' in input && input.requestId) return this.requestControl(scope, input, retainedRequest);
    let status = this.saved(scope.handle) ?? this.initial();
    const current = this.live.get(scope.handle);
    if (input.action === 'status') {
      const readiness = await this.connector.availability();
      status = { ...status, productionReady: readiness.productionReady };
      if (readiness.productionReady && !status.setupId)
        status = {
          ...status,
          message:
            'Verified native route ready. Ask the group agent; a new shared/private context may need its own provider authorization.',
        };
      if (status.setupId && !current && !['stopped', 'rejected', 'error'].includes(status.state))
        return this.record(scope.handle, {
          ...status,
          state: 'unknown',
          message:
            'The previous native runtime ended. This saved group and request remain unchanged. Ask the setup agent to reconcile its stopped runtime; no sign-in or model input was replayed.',
        });
      if (
        current?.execution &&
        !current.busy &&
        ['signed-out', 'pending', 'authenticated'].includes(status.state)
      ) {
        try {
          const auth = await current.execution.authentication();
          status = this.record(scope.handle, {
            ...status,
            state:
              auth === 'authenticated'
                ? 'authenticated'
                : status.state === 'pending'
                  ? 'pending'
                  : 'signed-out',
            message:
              auth === 'authenticated'
                ? 'This isolated context is signed in. Continue the saved request or explicitly verify native tools.'
                : 'This isolated context still needs its own provider authorization.',
          });
        } catch {
          status = this.record(scope.handle, { ...status, state: 'error', message: safeFailure });
        }
      }
      return this.retryStatus(
        status.setupId,
        current?.execution,
        this.withSignIn(status.setupId, status),
      );
    }
    const prior = this.db.prepare('SELECT input FROM gno_operations WHERE key=?').get(input.key);
    const canonical = publicationCanonical(input);
    if (prior) {
      if (String(prior.input) !== canonical) throw new Error('Owner operation retry changed.');
      return ['sign-in', 'restart-sign-in'].includes(input.action)
        ? this.withSignIn(status.setupId, status)
        : status; // Lost acknowledgements never repeat effects.
    }
    if (!this.config) return this.initial();
    if (current?.busy && input.action !== 'reject')
      throw new Error('Wait for this saved native setup operation.');
    this.db.prepare('INSERT INTO gno_operations(key,input) VALUES (?,?)').run(input.key, canonical);
    if (input.action === 'prepare') {
      if (status.setupId) return status;
      const setupId = randomUUID();
      this.db.prepare('INSERT INTO gno_contexts(handle,scope,setup_id) VALUES (?,?,?)').run(
        scope.handle,
        publicationCanonical({
          context: scope.context,
          enrollmentHandle: scope.enrollmentHandle,
        }),
        setupId,
      );
      status = this.record(scope.handle, {
        ...status,
        setupId,
        state: 'queued',
        message: 'Owned isolated setup is queued through model policy and QUARK.',
      });
      try {
        const acceptance = this.connector.ownerAcceptance({
          context: scope.context,
          enrollmentHandle: scope.enrollmentHandle,
        });
        const live: Live = { acceptance };
        this.live.set(scope.handle, live);
        live.busy = acceptance.admitted
          .then(async (execution) => {
            live.execution = execution;
            await scope.revalidate();
            const auth = await execution.authentication();
            this.record(scope.handle, {
              ...status,
              provider: execution.provider,
              state: auth === 'authenticated' ? 'authenticated' : 'signed-out',
              message:
                'Fresh isolated context prepared. Authorize its native provider sign-in explicitly.',
            });
          })
          .catch(async () => {
            if (live.execution) await live.execution.close().catch(() => {});
            this.record(scope.handle, { ...status, state: 'error', message: safeFailure });
          })
          .finally(() => {
            live.busy = undefined;
          });
      } catch {
        return this.record(scope.handle, { ...status, state: 'error', message: safeFailure });
      }
      return status;
    }
    const execution = current?.execution;
    if (!execution || !current)
      throw new Error('No retained owned setup capability. Inspect this saved context.');
    if (input.action === 'sign-in' || input.action === 'restart-sign-in') {
      status = this.record(scope.handle, {
        ...status,
        state: 'pending',
        message:
          'Complete native authorization, then check sign-in. Sign-in details are transient and stay outside group messages.',
      });
      return input.action === 'restart-sign-in'
        ? this.restartSignIn(status.setupId!, input.key, execution, status)
        : this.signIn(status.setupId!, input.key, execution, status);
    }
    if (input.action === 'reject') {
      await execution.close();
      return this.record(scope.handle, {
        ...status,
        state: 'rejected',
        message:
          'This owned setup was stopped. No provider credentials were copied or model input replayed.',
      });
    }
    if (input.action === 'approve') {
      current.acceptance.approve(this.config.reviewedCommit);
      const readiness = await this.connector.availability();
      return this.record(scope.handle, {
        ...status,
        productionReady: readiness.productionReady,
        message:
          'Actual native acceptance and the host-pinned independent source review were recorded.',
      });
    }
    if (input.action === 'continue')
      throw new Error('Saved requests use their original request-bound consent route.');
    if (input.action === 'verify-tools' && (await execution.authentication()) !== 'authenticated')
      throw new Error('Authorize this isolated context first.');
    const before = status;
    status = this.record(scope.handle, {
      ...status,
      state: 'checking',
      message:
        'The explicitly requested real native acceptance check is running. Reconnect and inspect; retry never repeats a model turn.',
    });
    current.busy = (async () => {
      await scope.revalidate();
      if (input.action === 'verify-tools') await execution.acceptanceToolTurn();
      else if (input.action === 'verify-stop') {
        execution.startDescendantCanary();
        if (input.kind === 'crash') await execution.crashStopCanary();
        else await execution.explicitStopCanary();
      }
      this.record(scope.handle, {
        ...before,
        state: input.action === 'verify-stop' ? 'stopped' : 'verified',
        message:
          input.action === 'verify-stop'
            ? 'Owned detached descendants stopped. Complete the other stop check in another fresh shared/private context, then record acceptance.'
            : 'A real native shell tool and its synthetic file receipt were verified. Choose an owned stop check next.',
      });
    })()
      .catch(() => {
        this.record(scope.handle, { ...before, state: 'error', message: safeFailure });
      })
      .finally(() => {
        current.busy = undefined;
      });
    return status;
  }
  private requestRejected(requestId: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM gno_operations WHERE
      json_extract(input,'$.action')='reject' AND json_extract(input,'$.requestId')=? LIMIT 1`).get(requestId));
  }
  private async requestControl(
    scope: GroupHostFeatureContext,
    input: ReturnType<typeof groupNativeOwnerInputSchema.parse>,
    retainedRequest?: GroupNativeHandoff,
  ) {
    if (!this.config)
      throw new Error('Register the private native host route before owner authorization.');
    if (!('requestId' in input) || !input.requestId) throw new Error('Saved request required.');
    const requestId = input.requestId;
    const snapshot = await this.connector.inspect({ requestId });
    const execution = this.connector.ownerExecution(requestId);
    let status: GroupNativeOwnerStatus = {
      ...this.initial(),
      provider: execution?.provider ?? this.config.route.provider,
      productionReady: (await this.connector.availability()).productionReady,
      setupId: requestId,
      state: execution ? 'signed-out' : 'unknown',
      message: snapshot.message,
    };
    if (input.action === 'status') {
      if (execution && snapshot.state === 'pending-consent')
        status = {
          ...status,
          state:
            (await execution.authentication()) === 'authenticated' ? 'authenticated' : 'signed-out',
        };
      status.canReconnect = Boolean(!execution && this.connector.canRecoverPendingConsent(requestId) &&
        !this.requestRejected(requestId));
      return this.retryStatus(
        requestId,
        execution ?? undefined,
        this.withSignIn(requestId, status),
      );
    }
    if (!('key' in input)) throw new Error('Owner operation key required.');
    const prior = this.db.prepare('SELECT input FROM gno_operations WHERE key=?').get(input.key);
    const canonical = publicationCanonical(input);
    if (prior) {
      if (String(prior.input) !== canonical) throw new Error('Owner operation retry changed.');
      return this.withSignIn(requestId, {
        ...status,
        message:
          'The original owner operation was retained. Check this saved request; it was not replayed.',
      });
    }
    if (input.action === 'reconnect') {
      if (!retainedRequest || retainedRequest.requestId !== requestId ||
          publicationCanonical(retainedRequest.context) !== publicationCanonical(scope.context) ||
          retainedRequest.enrollmentHandle !== scope.enrollmentHandle || this.requestRejected(requestId))
        throw new Error('Exact retained owner request required; a declined request cannot reconnect.');
      this.db.prepare('INSERT INTO gno_operations(key,input) VALUES (?,?)').run(input.key, canonical);
      await scope.revalidate();
      await this.connector.recoverPendingConsent(retainedRequest);
      return { ...status, state: 'checking' as const, message: 'Reconnecting the same unsubmitted request. Check sign-in when admission completes; no model input was sent.' };
    }
    if (!execution || snapshot.state !== 'pending-consent')
      throw new Error('This exact saved request is not awaiting retained native consent.');
    this.db.prepare('INSERT INTO gno_operations(key,input) VALUES (?,?)').run(input.key, canonical);
    await scope.revalidate();
    if (input.action === 'sign-in' || input.action === 'restart-sign-in') {
      return input.action === 'restart-sign-in'
        ? this.restartSignIn(requestId, input.key, execution, status)
        : this.signIn(requestId, input.key, execution, status);
    }
    if (input.action === 'reject') {
      await execution.close();
      return {
        ...status,
        state: 'rejected' as const,
        message: 'This exact pending request was stopped.',
      };
    }
    if (input.action !== 'continue' || (await execution.authentication()) !== 'authenticated')
      throw new Error('Complete this exact context’s native authorization first.');
    const claimed = this.db
      .prepare('INSERT OR IGNORE INTO gno_continuations(request_id,key) VALUES (?,?)')
      .run(`${requestId}:${execution.admissionId}`, input.key);
    if (!Number(claimed.changes))
      return {
        ...status,
        state: 'unknown' as const,
        message:
          'The original continuation was already claimed. Inspect this same saved request; its input is never replayed.',
      };
    // Connector atomically consumes the retained pending text before starting the
    // turn. HTTP disconnect/retry cannot create another handoff or tool turn.
    void this.connector.continueAfterConsent(requestId).catch(() => {});
    return {
      ...status,
      state: 'checking' as const,
      message:
        'Continuing the original saved request in its authorized native context. Recover that same request for its result.',
    };
  }
  private withSignIn(binding: string | null, status: GroupNativeOwnerStatus) {
    if (!binding) return status;
    const transient = this.signIns.get(binding);
    if (
      transient &&
      (transient.expires < Date.now() ||
        ['authenticated', 'rejected', 'stopped', 'error', 'unknown'].includes(status.state))
    ) {
      this.signIns.delete(binding);
      return status;
    }
    return transient
      ? groupNativeOwnerStatusSchema.parse({
          ...status,
          state: 'pending',
          ...(transient.device ? { device: transient.device } : {}),
          ...(transient.terminalId ? { terminalId: transient.terminalId } : {}),
        })
      : status;
  }
  private async signIn(
    binding: string,
    key: string,
    execution: GroupNativeExecution,
    status: GroupNativeOwnerStatus,
  ) {
    if (this.signIns.has(binding)) return this.withSignIn(binding, status);
    const claimed = this.db
      .prepare('INSERT OR IGNORE INTO gno_signins(binding) VALUES (?)')
      .run(`${binding}:${execution.admissionId}`);
    if (!Number(claimed.changes))
      return {
        ...status,
        state: 'unknown' as const,
        message:
          'The original native sign-in was already started. Check authorization; it is never silently restarted.',
      };
    if (execution.provider === 'codex')
      this.signIns.set(binding, {
        expires: Date.now() + 14 * 60_000,
        device: await execution.beginDeviceSignIn(),
      });
    else {
      if (!this.loginTerminal) throw new Error('Owned login terminal unavailable.');
      this.signIns.set(binding, {
        expires: Date.now() + 60 * 60_000,
        terminalId: this.loginTerminal(key, execution.ownerClaudeLogin()),
      });
    }
    return this.withSignIn(binding, status);
  }
  private retryStatus(
    binding: string | null,
    execution: GroupNativeExecution | undefined,
    status: GroupNativeOwnerStatus,
  ) {
    return {
      ...status,
      canRetrySignIn: Boolean(
        binding &&
          execution && execution.canRestartDeviceSignIn() &&
          status.state !== 'authenticated' &&
          this.hasSignIn(binding, execution) &&
          this.recentSignInRetries(binding) < 3,
      ),
    };
  }
  private hasSignIn(binding: string, execution: GroupNativeExecution) {
    return this.db.prepare('SELECT 1 FROM gno_signins WHERE binding IN (?,?)')
      .get(binding, `${binding}:${execution.admissionId}`);
  }
  private recentSignInRetries(binding: string) {
    return Number(
      this.db
        .prepare('SELECT count(*) AS n FROM gno_signin_retries WHERE binding=? AND attempted_at>?')
        .get(binding, Date.now() - 60_000)!.n,
    );
  }
  private async restartSignIn(
    binding: string,
    key: string,
    execution: GroupNativeExecution,
    status: GroupNativeOwnerStatus,
  ) {
    if (!this.hasSignIn(binding, execution))
      throw new Error('Start this isolated context’s sign-in before requesting a retry.');
    if (!execution.canRestartDeviceSignIn())
      throw new Error(
        'The original native runtime is unavailable or input was already submitted. Inspect this saved request; no replay is allowed.',
      );
    if (this.recentSignInRetries(binding) >= 3)
      throw new Error(
        'Three sign-in retries were requested within one minute. Wait a minute, then check sign-in to retry the same saved request.',
      );
    this.db
      .prepare('INSERT INTO gno_signin_retries(key,binding,attempted_at) VALUES (?,?,?)')
      .run(key, binding, Date.now());
    try {
      const device = await execution.restartDeviceSignIn();
      this.signIns.set(binding, { expires: Date.now() + 14 * 60_000, device });
      return this.withSignIn(binding, {
        ...status,
        state: 'pending',
        message:
          'The previous native sign-in was canceled or confirmed absent. Complete this new code, then continue the same saved request.',
      });
    } catch (error) {
      this.signIns.delete(binding);
      throw error;
    }
  }
  async close() {
    await Promise.all([...this.live.values()].map((v) => v.busy));
    this.signIns.clear();
    this.db.close();
  }
}
