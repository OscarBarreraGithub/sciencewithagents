import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  recoveryCopyRequestSchema,
  recoveryCopySchema,
  type RecoveryCopy,
  type RecoveryCopies,
} from '@dock/shared';
import { Conflict, Missing, Store } from './store.js';

type SavedCopy = RecoveryCopy & { digest: string | null };
const failedMessage =
  'This copy could not be verified. Your current workspace was not changed. Try creating another copy; if it fails again, ask your setup agent to check available disk space and private backup storage.';
const interruptedMessage =
  'The app stopped before this copy was verified. Your current workspace was not changed. Create another copy before relying on a backup.';
const services = new WeakMap<Store, RecoveryBackups>();

/** Same-host recovery only: never serves database bytes or accepts a filesystem path. */
export class RecoveryBackups {
  private active: Promise<RecoveryCopy> | null = null;
  private readonly directory: string;
  constructor(
    private readonly store: Store,
    dataDir: string,
  ) {
    this.directory = join(dataDir, 'recovery-backups');
    store.db.exec(`CREATE TABLE IF NOT EXISTS recovery_backups (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL
    )`);
    for (const row of store.db
      .prepare("SELECT body FROM recovery_backups WHERE json_extract(body, '$.state')='creating'")
      .all()) {
      const record = JSON.parse(String(row.body)) as SavedCopy;
      if (record.state === 'creating')
        this.save({ ...record, state: 'failed', message: interruptedMessage });
    }
  }
  private read(id: string): SavedCopy {
    const row = this.store.db.prepare('SELECT body FROM recovery_backups WHERE id=?').get(id);
    if (!row) throw new Missing('That recovery copy is not recorded on this computer.');
    return JSON.parse(String(row.body)) as SavedCopy;
  }
  private public(record: SavedCopy): RecoveryCopy {
    const { digest: _digest, ...value } = record;
    return recoveryCopySchema.parse(value);
  }
  private save(record: SavedCopy) {
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE recovery_backups SET body=? WHERE id=?')
        .run(JSON.stringify(record), record.id);
      this.store.event(`recovery_copy.${record.state}`, null, null, this.public(record));
    });
    return this.public(record);
  }
  get(id: string): RecoveryCopy {
    return this.public(this.read(z.string().uuid().parse(id)));
  }
  status(): RecoveryCopies {
    return {
      copies: this.store.db
        .prepare('SELECT body FROM recovery_backups ORDER BY created_at DESC, id DESC LIMIT 20')
        .all()
        .map((row) => this.public(JSON.parse(String(row.body)) as SavedCopy)),
      creating: this.active !== null,
    };
  }
  private ensureDirectory() {
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
      throw new Error('Recovery storage must be a private regular directory.');
  }
  private file(id: string) {
    return join(this.directory, `recovery-${z.string().uuid().parse(id)}.sqlite`);
  }
  private async inspect(id: string) {
    this.ensureDirectory();
    const file = this.file(id);
    const sidecars = ['-wal', '-shm', '-journal'].map((suffix) => `${file}${suffix}`);
    if (sidecars.some((sidecar) => existsSync(sidecar)))
      throw new Error('Recovery copy has unexpected journal files.');
    const before = lstatSync(file);
    if (!before.isFile() || (before.mode & 0o077) !== 0)
      throw new Error('Recovery copy is not a private regular file.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const db = new DatabaseSync(file, { readOnly: true });
    let counts: NonNullable<RecoveryCopy['counts']>;
    try {
      const checked = db.prepare('PRAGMA quick_check').all();
      if (checked.length !== 1 || Object.values(checked[0])[0] !== 'ok')
        throw new Error('Recovery copy failed its integrity check.');
      const count = (table: 'projects' | 'agents' | 'entries' | 'images') =>
        Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
      counts = {
        projects: count('projects'),
        conversations: count('agents'),
        entries: count('entries'),
        images: count('images'),
      };
    } finally {
      db.close();
    }
    const after = lstatSync(file);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      sidecars.some((sidecar) => existsSync(sidecar))
    )
      throw new Error('Recovery copy changed during verification.');
    return { digest: hash.digest('hex'), sizeBytes: after.size, counts };
  }
  async create(input: unknown): Promise<RecoveryCopy> {
    const { key } = recoveryCopyRequestSchema.parse(input);
    const previous = this.store.db.prepare('SELECT id FROM recovery_backups WHERE id=?').get(key);
    if (previous) {
      // Waiting on the one already-owned copy never starts another disk write.
      if (this.read(key).state === 'creating' && this.active) await this.active;
      return this.get(key);
    }
    if (this.active)
      throw new Conflict('A recovery copy is already being checked. Wait for it to finish.');
    this.store.operation(key, { kind: 'recovery.copy' }, () => {
      const record: SavedCopy = {
        id: key,
        state: 'creating',
        createdAt: new Date().toISOString(),
        checkedAt: null,
        sizeBytes: null,
        counts: null,
        digest: null,
        message: 'Saving and checking a private recovery copy on this computer…',
      };
      this.store.db
        .prepare('INSERT INTO recovery_backups VALUES(?,?,?)')
        .run(key, record.createdAt, JSON.stringify(record));
      this.store.event('recovery_copy.creating', null, null, this.public(record));
      return { id: key };
    });
    const operation = this.write(key);
    this.active = operation;
    try {
      return await operation;
    } finally {
      if (this.active === operation) this.active = null;
    }
  }
  private async write(id: string): Promise<RecoveryCopy> {
    try {
      this.ensureDirectory();
      const file = this.file(id);
      // Reserve only a new generated filename. Existing files are never overwritten.
      closeSync(openSync(file, 'wx', 0o600));
      await backup(this.store.db, file);
      // The source uses WAL. Finalize only our new copy as a self-contained file
      // before hashing it, so an untracked sidecar can never contribute to verification.
      const standalone = new DatabaseSync(file);
      try {
        standalone.exec('PRAGMA journal_mode=DELETE;');
      } finally {
        standalone.close();
      }
      const verified = await this.inspect(id);
      return this.save({
        ...this.read(id),
        ...verified,
        state: 'verified',
        checkedAt: new Date().toISOString(),
        message: 'Saved on this computer and passed the database integrity check.',
      });
    } catch {
      // Retain failed/partial files for local inspection; no retention purge or automatic retry.
      return this.save({ ...this.read(id), state: 'failed', message: failedMessage });
    }
  }
  async verify(id: string): Promise<RecoveryCopy> {
    const previous = this.read(z.string().uuid().parse(id));
    if (previous.state === 'creating' || !previous.digest)
      throw new Conflict('This copy never finished verification. Create another copy instead.');
    if (this.active) throw new Conflict('Another recovery copy is being checked. Please wait.');
    const operation = (async () => {
      try {
        const checked = await this.inspect(id);
        if (checked.digest !== previous.digest) throw new Error('Recovery copy bytes changed.');
        return this.save({
          ...previous,
          ...checked,
          state: 'verified',
          checkedAt: new Date().toISOString(),
          message:
            'The saved copy still matches its original bytes and passes the integrity check.',
        });
      } catch {
        return this.save({
          ...previous,
          state: 'failed',
          checkedAt: new Date().toISOString(),
          message: failedMessage,
        });
      }
    })();
    this.active = operation;
    try {
      return await operation;
    } finally {
      if (this.active === operation) this.active = null;
    }
  }
  async idle() {
    await this.active;
  }
}

export function registerRecoveryBackupRoutes(app: FastifyInstance, store: Store, dataDir: string) {
  let service = services.get(store);
  if (!service) {
    service = new RecoveryBackups(store, dataDir);
    services.set(store, service);
  }
  const backups = service;
  app.get('/api/recovery-backups', async () => backups.status());
  app.get('/api/recovery-backups/:id', async (request) =>
    backups.get(z.object({ id: z.string().uuid() }).parse(request.params).id),
  );
  app.post('/api/recovery-backups', async (request) => backups.create(request.body));
  app.post('/api/recovery-backups/:id/verify', async (request) => {
    z.object({}).strict().parse(request.body);
    return backups.verify(z.object({ id: z.string().uuid() }).parse(request.params).id);
  });
  // Requests may disconnect while SQLite is still making the one owned copy.
  app.addHook('preClose', async () => {
    await backups.idle();
  });
}
