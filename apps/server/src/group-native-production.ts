import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { z } from 'zod';
import { groupContextSchema, type GroupScope } from '@dock/shared';
import { GroupIsolationBlocked } from './group-isolation.js';

export const nativeHandoffSchema = z.strictObject({
  intent: z.enum(['ask', 'work']).optional(),
  requestId: z.uuid(),
  key: z.uuid(),
  context: groupContextSchema,
  enrollmentHandle: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(200000)
    .refine((text) => text.trim().length > 0),
});
export type GroupNativeHandoff = z.infer<typeof nativeHandoffSchema>;
/** Private host intent index, never a transcript API. The ordinary GroupHost
 * owns its separate request/result ledger; this one pins native context/input. */
export class GroupNativeIntents {
  readonly #db: DatabaseSync;
  constructor(path: string) {
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
      stat.mode & 0o077
    )
      throw new GroupIsolationBlocked('Private host native intent index required.');
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS native_bindings (binding_key TEXT PRIMARY KEY, context_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS native_intents (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, context_id TEXT NOT NULL);
      ${['native_bindings', 'native_intents']
        .flatMap((table) => [
          `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable native handoff'); END;`,
          `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'permanent native handoff'); END;`,
        ])
        .join('\n')}`);
  }
  binding(input: Pick<GroupNativeHandoff, 'enrollmentHandle' | 'context'>) {
    return JSON.stringify([
      input.enrollmentHandle,
      input.context.groupId,
      input.context.memberId,
      input.context.installationId,
      input.context.visibility,
      input.context.sessionId,
      input.context.nativeSessionId,
    ]);
  }
  findBinding(input: Pick<GroupNativeHandoff, 'enrollmentHandle' | 'context'>) {
    const row = this.#db
      .prepare('SELECT context_id FROM native_bindings WHERE binding_key=?')
      .get(this.binding(input));
    return row ? String(row.context_id) : null;
  }
  bind(input: GroupNativeHandoff, contextId: string) {
    z.uuid().parse(contextId);
    this.#db
      .prepare('INSERT INTO native_bindings VALUES (?,?)')
      .run(this.binding(input), contextId);
  }
  find(requestId: string) {
    z.uuid().parse(requestId);
    const row = this.#db
      .prepare('SELECT context_id FROM native_intents WHERE request_id=?')
      .get(requestId);
    return row ? String(row.context_id) : null;
  }
  ownsAnchor(scope: GroupScope, contextId: string) {
    const row = this.#db
      .prepare('SELECT binding_key FROM native_bindings WHERE context_id=?')
      .get(contextId);
    if (!row) return false;
    const key = JSON.parse(String(row.binding_key)) as unknown[];
    return (
      scope.source.provider === 'owner' &&
      key[1] === scope.groupId &&
      key[2] === scope.memberId &&
      key[3] === scope.installationId &&
      key[4] === scope.visibility &&
      key[5] === scope.source.sessionId &&
      key[6] === scope.source.nativeSessionId
    );
  }
  claim(input: GroupNativeHandoff, contextId: string) {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const old = this.#db
      .prepare('SELECT input_hash,context_id FROM native_intents WHERE request_id=?')
      .get(input.requestId);
    if (old) {
      const { intent, ...legacy } = input;
      const legacyHash =
        intent === 'work'
          ? null
          : createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
      if (
        (old.input_hash !== hash && old.input_hash !== legacyHash) ||
        old.context_id !== contextId
      )
        throw new GroupIsolationBlocked(
          'Host native handoff idempotency key changed input or context.',
        );
      return false;
    }
    this.#db
      .prepare('INSERT INTO native_intents VALUES (?,?,?)')
      .run(input.requestId, hash, contextId);
    return true;
  }
  close() {
    this.#db.close();
  }
}
