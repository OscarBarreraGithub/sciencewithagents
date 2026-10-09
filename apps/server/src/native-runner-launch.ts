import { randomUUID } from 'node:crypto';
import {
  nativeRunnerStartSchema,
  nativeRunnerStartReceiptSchema,
  nativeRunnerLaunchOptionsSchema,
  type NativeRunnerStart,
  type NativeRunnerStartReceipt,
} from '@dock/shared';
import { Conflict, Missing, type Store } from './store.js';
import { NativeConnections, nativeConnectionLimits } from './native-connections.js';
import {
  readNativeConnectionProfiles,
  type NativeConnectionProfile,
} from './native-connections-config.js';
import { profileSignature } from './native-terminal-driver.js';
import {
  NativeRunnerCliDriver,
  NativeRunnerNotStarted,
  type NativeRunnerDriver,
  type NativeRunnerPrepared,
} from './native-runner-driver.js';
import type { ModelPolicy } from './model-policy.js';
import type { FolderBrowser } from './folder-browser.js';

type Row = { input: string; body: string };
/** Durable one-shot native creation. It never schedules turns or restarts uncertain native work. */
export class NativeRunnerLaunch {
  private stopped = false;
  private pending = new Map<
    string,
    { input: string; promise: Promise<NativeRunnerStartReceipt> }
  >();
  beforeStart: () => void = () => {};
  constructor(
    private store: Store,
    private native: NativeConnections,
    private modelPolicy: ModelPolicy,
    private driver: NativeRunnerDriver,
    private profiles: () => NativeConnectionProfile[],
    private enabled = true,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS nc_starts(key TEXT PRIMARY KEY,input TEXT NOT NULL,
      source TEXT NOT NULL,signature TEXT NOT NULL,folder TEXT NOT NULL,nonce TEXT NOT NULL,
      proof TEXT,body TEXT NOT NULL)`);
  }
  static production(
    store: Store,
    root: string,
    native: NativeConnections,
    modelPolicy: ModelPolicy,
    binaries: ConstructorParameters<typeof NativeRunnerCliDriver>[0],
    enabled = true,
  ) {
    return new NativeRunnerLaunch(
      store,
      native,
      modelPolicy,
      new NativeRunnerCliDriver(binaries),
      () => readNativeConnectionProfiles(root),
      enabled,
    );
  }
  activeCount() {
    return this.pending.size;
  }
  private row(key: string) {
    return this.store.db.prepare('SELECT input,body FROM nc_starts WHERE key=?').get(key) as
      | Row
      | undefined;
  }
  read(key: string) {
    const row = this.row(key);
    if (!row) throw new Missing('No native start receipt is recorded for this exact request.');
    return nativeRunnerStartReceiptSchema.parse(JSON.parse(row.body));
  }
  async options() {
    const profiles = this.enabled
      ? this.profiles().filter((p) => p.kind === 'tmux' && !p.sshAlias)
      : [];
    const sources = await Promise.all(
      profiles.map(async (p) => ({ id: p.id, label: p.label, ...(await this.driver.source(p)) })),
    );
    const providers = await Promise.all(
      (['codex', 'claude'] as const).map(async (provider) => ({
        provider,
        ...(this.enabled
          ? await this.driver.provider(provider)
          : {
              installed: false,
              version: '',
              message: 'Native runner launch is disabled in this fixture.',
            }),
      })),
    );
    return nativeRunnerLaunchOptionsSchema.parse({
      sources: sources.filter((p) =>
        profiles.some(
          (old) =>
            old.id === p.id &&
            this.profiles().some(
              (current) =>
                current.id === old.id && profileSignature(current) === profileSignature(old),
            ),
        ),
      ),
      providers,
      starts: (
        this.store.db.prepare('SELECT body FROM nc_starts ORDER BY rowid DESC LIMIT 20').all() as {
          body: string;
        }[]
      ).map((row) => JSON.parse(row.body)),
    });
  }
  start(raw: unknown, folders: FolderBrowser) {
    const input = nativeRunnerStartSchema.parse(raw),
      json = JSON.stringify(input),
      previous = this.row(input.key);
    if (previous) {
      if (previous.input !== json)
        throw new Conflict('This native start key belongs to different input.');
      return Promise.resolve(this.read(input.key));
    }
    const pending = this.pending.get(input.key);
    if (pending) {
      if (pending.input !== json)
        throw new Conflict('This native start key belongs to different input.');
      return pending.promise;
    }
    this.beforeStart();
    if (this.stopped || !this.enabled) throw new Conflict('Native runner launch is unavailable.');
    if (this.pending.size >= nativeConnectionLimits.active)
      throw new Conflict(
        'Another native start is still being inspected. Wait for its saved receipt.',
      );
    const promise = this.prepare(input, folders).finally(() => {
      this.pending.delete(input.key);
    });
    this.pending.set(input.key, { input: json, promise });
    return promise;
  }
  private current(profile: NativeConnectionProfile) {
    if (
      !this.profiles().some(
        (p) => p.id === profile.id && profileSignature(p) === profileSignature(profile),
      )
    )
      throw new Conflict(
        'The configured native source changed. Choose its current source before starting.',
      );
  }
  private async prepare(input: NativeRunnerStart, folders: FolderBrowser) {
    const profile = this.profiles().find((p) => p.id === input.sourceId);
    if (!profile || profile.kind !== 'tmux' || profile.sshAlias)
      throw new Conflict(
        'Choose a configured local tmux source. Herdr and SSH folder launch are not supported yet.',
      );
    const checks = await Promise.allSettled([
      this.driver.source(profile),
      this.driver.provider(input.provider),
      this.modelPolicy.resolveNativeLaunch(input.provider, input.choice),
      folders.nativeSelection(input.folderId),
    ] as const);
    for (const check of checks) if (check.status === 'rejected') throw check.reason;
    // All preflight metadata reads have settled before any durable creation intent.
    const source = (
      checks[0] as PromiseFulfilledResult<Awaited<ReturnType<NativeRunnerDriver['source']>>>
    ).value;
    const provider = (
      checks[1] as PromiseFulfilledResult<Awaited<ReturnType<NativeRunnerDriver['provider']>>>
    ).value;
    const resolution = (
      checks[2] as PromiseFulfilledResult<Awaited<ReturnType<ModelPolicy['resolveNativeLaunch']>>>
    ).value;
    const folder = (
      checks[3] as PromiseFulfilledResult<Awaited<ReturnType<FolderBrowser['nativeSelection']>>>
    ).value;
    if (!source.available || !provider.installed)
      throw new Conflict(!source.available ? source.message : provider.message);
    this.current(profile);
    if (this.stopped) throw new Conflict('Native launch was cancelled while the app was stopping.');
    const receipt = nativeRunnerStartReceiptSchema.parse({
      ...input,
      state: 'uncertain',
      folderName: folder.name,
      resolution,
      createdAt: new Date().toISOString(),
      message:
        'Native start is recorded; creation is not confirmed. Do not replay an uncertain receipt. Inspect native connections.',
    });
    const json = JSON.stringify(input),
      nonce = randomUUID();
    let prepared: NativeRunnerPrepared;
    try {
      prepared = await this.driver.prepare(profile, folder.path, nonce, resolution);
    } catch (error) {
      if (!(error instanceof NativeRunnerNotStarted)) throw error;
      const refusal = { ...receipt, state: 'not_started' as const, message: error.message };
      const folderJson = JSON.stringify(folder);
      // A final preflight refusal needs no mutable completion or target reserve.
      this.native.reserveLaunch(
        2 * Buffer.byteLength(json) +
          Buffer.byteLength(folderJson) +
          Buffer.byteLength(JSON.stringify(refusal)) +
          2048,
        () => {
          this.store.db
            .prepare('INSERT INTO nc_starts VALUES(?,?,?,?,?,?,NULL,?)')
            .run(
              input.key,
              json,
              profile.id,
              profileSignature(profile),
              folderJson,
              nonce,
              JSON.stringify(refusal),
            );
          this.event('start.not_started', input.key);
        },
      );
      return refusal;
    }
    this.current(profile);
    if (this.stopped) throw new Conflict('Native launch was cancelled while the app was stopping.');
    const folderJson = JSON.stringify({ ...folder, preparation: prepared });
    // Charge both retained input copies and two fixed slots: mutable start
    // receipt plus its proof copy, and the issued target. Private preparation,
    // folder bytes, signature/nonce/keys and the two transition rows are charged too.
    this.native.reserveLaunch(
      2 * Buffer.byteLength(json) +
        Buffer.byteLength(folderJson) +
        2048 +
        2 * nativeConnectionLimits.receiptReserve,
      () => {
        this.store.db
          .prepare('INSERT INTO nc_starts VALUES(?,?,?,?,?,?,NULL,?)')
          .run(
            input.key,
            json,
            profile.id,
            profileSignature(profile),
            folderJson,
            nonce,
            JSON.stringify(receipt),
          );
        this.event('start.recorded', input.key);
      },
    );
    try {
      await folders.verifyNativeSelection(folder);
      this.current(profile);
      if (this.stopped) throw new Conflict('Native launch stopped before handoff.');
    } catch {
      return this.update({
        ...receipt,
        state: 'not_started',
        message:
          'The folder, source or app lifecycle changed before native creation. Nothing was started.',
      });
    }
    let created;
    try {
      created = await this.driver.create(prepared);
      this.current(profile);
    } catch (error) {
      if (error instanceof NativeRunnerNotStarted)
        return this.update({ ...receipt, state: 'not_started', message: error.message });
      return this.read(input.key);
    }
    // Final identity and receipt use the prepaid slots, even at the journal
    // fence. A failed final write leaves the original uncertain intent readable.
    this.store.db.exec('SAVEPOINT native_start_complete');
    try {
      this.store.db
        .prepare('UPDATE nc_starts SET proof=? WHERE key=?')
        .run(JSON.stringify(created.proof), input.key);
      const targetId = this.native.retainCreated(input.key, profile, created);
      const result = this.update({
        ...receipt,
        state: 'created',
        targetId,
        message:
          'Native session created. Connect explicitly to view it. Native sign-in and the program’s current state remain native; no agent turn is claimed.',
      });
      this.store.db.exec('RELEASE native_start_complete');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO native_start_complete; RELEASE native_start_complete');
      throw error;
    }
  }
  private event(event: string, key: string) {
    this.store.db
      .prepare('INSERT INTO nc_events(event,identity,at) VALUES(?,?,?)')
      .run(event, key, new Date().toISOString());
  }
  private update(receipt: NativeRunnerStartReceipt) {
    nativeRunnerStartReceiptSchema.parse(receipt);
    const body = JSON.stringify(receipt);
    const proof = this.store.db
      .prepare('SELECT proof FROM nc_starts WHERE key=?')
      .get(receipt.key) as { proof: string | null };
    if (
      Buffer.byteLength(body) + Buffer.byteLength(proof.proof ?? '') >
      nativeConnectionLimits.receiptReserve
    )
      throw new Conflict('Native start completion exceeds its reserved receipt slot.');
    this.store.db.prepare('UPDATE nc_starts SET body=? WHERE key=?').run(body, receipt.key);
    this.event(`start.${receipt.state}`, receipt.key);
    return receipt;
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.pending.values()].map((p) => p.promise));
  }
}
