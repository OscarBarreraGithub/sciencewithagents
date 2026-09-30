import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import {
  phoneConfirmSchema,
  phoneCredentialSchema,
  phonePairSchema,
  phonePreferencesSchema,
} from '@dock/shared';
import { Conflict, Store } from './store.js';
import type { PhoneSession } from './phone-access.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const enrollmentCookie = '__Host-dock_enrollment';
const unlockCookie = '__Host-dock_unlock';
const browserLifetime = 400 * 24 * 60 * 60; // Browser storage lifetime, not enrollment expiry.
const unlockLifetime = 15 * 60 * 1000;
const pendingKey = 'phone:device-pending';
type Credential = { id: string; publicKey: string; counter: number };
type Pending = {
  id: string;
  name: string;
  browserHash: string;
  confirmation: string;
  expiresAt: number;
  challenge: string | null;
  credential: Credential | null;
};
type Device = {
  id: string;
  name: string;
  browser_hash: string;
  credential_id: string;
  public_key: string;
  counter: number;
  created_at: number;
  revoked_at: number | null;
  require_unlock: number;
  setup_complete: number;
};
type Pairing = { key: string; hash: string; expiresAt: number; attempts: number; used: boolean };

function cookieValue(cookies: string | undefined, name: string) {
  const values = (cookies ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function cookie(name: string, value: string, seconds: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
}

/** Durable enrollment plus server-enforced, user-verified passkey unlock. No account IdP. */
export class PairedDevices {
  readonly rpID: string;
  constructor(
    readonly store: Store,
    readonly origin: string,
    private readonly enabled: () => boolean,
    private readonly changed: () => void,
  ) {
    this.rpID = new URL(origin).hostname;
    store.db.exec(`CREATE TABLE IF NOT EXISTS paired_devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, browser_hash TEXT NOT NULL UNIQUE,
      credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
      created_at INTEGER NOT NULL, revoked_at INTEGER,
      require_unlock INTEGER NOT NULL DEFAULT 1 CHECK(require_unlock IN (0,1)),
      setup_complete INTEGER NOT NULL DEFAULT 0 CHECK(setup_complete IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS device_unlocks (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES paired_devices(id),
      token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
      remembered INTEGER NOT NULL DEFAULT 0 CHECK(remembered IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS device_challenges (
      device_id TEXT PRIMARY KEY REFERENCES paired_devices(id), challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );`);
    // Additive migration: existing enrollments and short unlocks stay intact,
    // with the original, secure repeat-verification behavior by default.
    store.transaction(() => {
      for (const [table, column, defaultValue] of [
        ['paired_devices', 'require_unlock', 1],
        ['paired_devices', 'setup_complete', 0],
        ['device_unlocks', 'remembered', 0],
      ] as const) {
        const columns = store.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((value) => value.name === column))
          store.db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${defaultValue} CHECK(${column} IN (0,1))`,
          );
      }
      if (
        !store.db
          .prepare('PRAGMA table_info(device_unlocks)')
          .all()
          .some((value) => value.name === 'revision')
      )
        store.db.exec('ALTER TABLE device_unlocks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    });
  }
  private assertEnabled() {
    if (!this.enabled()) throw new Conflict('Phone access is turned off on your computer.');
  }
  private revision() {
    return Number(this.store.getSetting('phone:unlock-revision') ?? 0);
  }
  private invalidateVerification() {
    this.store.setSetting('phone:unlock-revision', this.revision() + 1);
  }
  private pending(): Pending | null {
    const value = this.store.getSetting(pendingKey) as Pending | null;
    return value && value.expiresAt > Date.now() ? value : null;
  }
  private device(cookies?: string): Device | null {
    const token = cookieValue(cookies, enrollmentCookie);
    return token
      ? ((this.store.db
          .prepare('SELECT * FROM paired_devices WHERE browser_hash=? AND revoked_at IS NULL')
          .get(hash(token)) as Device | undefined) ?? null)
      : null;
  }
  status(remote: boolean, cookies?: string) {
    const device = this.device(cookies);
    const pairing = this.store.getSetting('phone:pairing') as Pairing | null;
    const pending = this.pending();
    const token = cookieValue(cookies, enrollmentCookie);
    const canSeePending = !remote || (token && pending?.browserHash === hash(token));
    return {
      enrolled: !!device,
      requireUnlock: remote && device ? device.require_unlock !== 0 : true,
      setupComplete: remote && device ? device.setup_complete === 1 : false,
      enrollmentOpen: !!(
        this.enabled() &&
        pairing &&
        !pairing.used &&
        pairing.attempts < 5 &&
        pairing.expiresAt > Date.now()
      ),
      // Desktop guidance only; never expose an unverified name or confirmation number.
      enrollmentInProgress: !remote && !!pending && !pending.credential,
      pending:
        pending?.credential && canSeePending
          ? {
              id: pending.id,
              name: pending.name,
              confirmation: pending.confirmation,
            }
          : null,
      devices: remote
        ? []
        : this.store.db
            .prepare(
              'SELECT id,name,created_at,revoked_at FROM paired_devices ORDER BY created_at DESC LIMIT 100',
            )
            .all()
            .map((row) => ({
              id: String(row.id),
              name: String(row.name),
              createdAt: new Date(Number(row.created_at)).toISOString(),
              expiresAt: null,
              revokedAt:
                row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(),
            })),
    };
  }
  renewedCookie(cookies?: string) {
    const token = cookieValue(cookies, enrollmentCookie);
    return token && this.device(cookies) ? cookie(enrollmentCookie, token, browserLifetime) : null;
  }
  renewedCookies(cookies?: string) {
    const enrollment = this.renewedCookie(cookies);
    const session = this.session(cookies);
    const token = cookieValue(cookies, unlockCookie);
    return [
      ...(enrollment ? [enrollment] : []),
      // Status can refresh browser retention, never create server access or
      // promote an expired short unlock into remembered access.
      ...(session?.expiresAt === null && token
        ? [cookie(unlockCookie, token, browserLifetime)]
        : []),
    ];
  }
  preferences(raw: unknown, cookies?: string, admittedSession?: PhoneSession) {
    const input = phonePreferencesSchema.parse(raw);
    let changed = false;
    const result = this.store.transaction(() => {
      this.assertEnabled();
      const device = this.device(cookies);
      const session = this.session(cookies);
      // Revalidate after body parsing, inside the same synchronous transaction
      // as the update. Earlier request admission is not ongoing authorization.
      if (
        !device ||
        !session ||
        (admittedSession &&
          (!this.valid(admittedSession) || admittedSession.unlockId !== session.unlockId))
      )
        throw new Conflict(
          'Unlock sciencewithagents on this device before changing phone settings.',
        );
      const policyChanged = (device.require_unlock !== 0) !== input.requireUnlock;
      const setupComplete = input.setupComplete ?? device.setup_complete === 1;
      changed = policyChanged || setupComplete !== (device.setup_complete === 1);
      let expiresAt = session.expiresAt;
      if (policyChanged) {
        this.invalidateVerification();
        this.store.db.prepare('DELETE FROM device_challenges WHERE device_id=?').run(device.id);
        this.store.db
          .prepare('DELETE FROM device_unlocks WHERE device_id=? AND id<>?')
          .run(device.id, session.unlockId!);
        expiresAt = input.requireUnlock ? Date.now() + unlockLifetime : null;
        this.store.db
          .prepare(
            'UPDATE device_unlocks SET remembered=?,expires_at=?,revision=revision+1 WHERE id=?',
          )
          .run(input.requireUnlock ? 0 : 1, expiresAt ?? 0, session.unlockId!);
      }
      if (changed) {
        this.store.db
          .prepare('UPDATE paired_devices SET require_unlock=?,setup_complete=? WHERE id=?')
          .run(input.requireUnlock ? 1 : 0, setupComplete ? 1 : 0, device.id);
        this.store.event('phone.preferences_changed', null, null, {
          deviceId: device.id,
          requireUnlock: input.requireUnlock,
          setupComplete,
        });
      }
      // Keep the current opaque token: a lost acknowledgement can be retried
      // without locking the phone out. An identical retry cannot extend TTL.
      return [
        cookie(
          unlockCookie,
          cookieValue(cookies, unlockCookie)!,
          expiresAt === null
            ? browserLifetime
            : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
        ),
        this.renewedCookie(cookies)!,
      ];
    });
    if (changed) this.changed();
    return result;
  }
  closeEnrollment() {
    this.store.db.exec('SAVEPOINT close_phone_enrollment');
    try {
      this.store.setSetting('phone:pairing', null);
      this.store.setSetting(pendingKey, null);
      this.store.db.exec('RELEASE close_phone_enrollment');
    } catch (error) {
      this.store.db.exec('ROLLBACK TO close_phone_enrollment; RELEASE close_phone_enrollment');
      throw error;
    }
  }
  pause() {
    this.invalidateVerification();
    this.closeEnrollment();
    this.store.db.exec('DELETE FROM device_unlocks; DELETE FROM device_challenges;');
    this.changed();
  }
  resetTrust() {
    this.pause();
    this.store.db
      .prepare('UPDATE paired_devices SET revoked_at=? WHERE revoked_at IS NULL')
      .run(Date.now());
  }
  async begin(raw: unknown, cookies?: string) {
    this.assertEnabled();
    if (this.device(cookies))
      throw new Conflict('This browser is already paired. Unlock it instead.');
    const input = phonePairSchema.parse(raw);
    const pairing = this.store.getSetting('phone:pairing') as Pairing | null;
    if (!pairing || pairing.used || pairing.expiresAt <= Date.now() || pairing.attempts >= 5)
      throw new Conflict('Pairing is closed. Create a new code on your computer.');
    this.store.setSetting('phone:pairing', { ...pairing, attempts: pairing.attempts + 1 });
    const candidate = input.code.toUpperCase().replace(/[\s-]/g, '');
    if (!timingSafeEqual(Buffer.from(hash(candidate), 'hex'), Buffer.from(pairing.hash, 'hex')))
      throw new Conflict('That code did not match. Check the code on your computer.');
    const token = secret(),
      challenge = secret(),
      id = randomUUID();
    const pending: Pending = {
      id,
      name: input.name,
      browserHash: hash(token),
      confirmation: String(randomInt(100000, 1000000)),
      challenge,
      // One bounded window includes entering the code, saving the passkey and
      // computer confirmation. Beginning near expiry must not silently extend it.
      expiresAt: pairing.expiresAt,
      credential: null,
    };
    this.store.transaction(() => {
      this.store.setSetting('phone:pairing', { ...pairing, used: true });
      this.store.setSetting(pendingKey, pending);
    });
    const options = await generateRegistrationOptions({
      rpID: this.rpID,
      rpName: 'sciencewithagents',
      userName: `sciencewithagents · ${input.name}`,
      userDisplayName: `sciencewithagents · ${input.name}`,
      userID: new TextEncoder().encode(id),
      challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
      attestationType: 'none',
      timeout: Math.max(1, pending.expiresAt - Date.now()),
      supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
    });
    this.assertEnabled();
    if (this.pending()?.id !== id) throw new Conflict('Pairing was cancelled. Create a new code.');
    return { options, cookie: cookie(enrollmentCookie, token, browserLifetime) };
  }
  async finish(raw: unknown, cookies?: string) {
    this.assertEnabled();
    const input = phoneCredentialSchema.parse(raw);
    const token = cookieValue(cookies, enrollmentCookie),
      pending = this.pending();
    if (!token || !pending?.challenge || pending.browserHash !== hash(token))
      throw new Conflict('Pairing is unavailable. Create a new code on your computer.');
    // Persist challenge consumption before asynchronous cryptography; never accept a replay.
    this.store.setSetting(pendingKey, { ...pending, challenge: null });
    let credential: Credential;
    try {
      if (!input.response.attestationObject) throw new Error('Missing registration');
      const result = await verifyRegistrationResponse({
        response: input as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) throw new Error('Unverified registration');
      const value = result.registrationInfo.credential;
      credential = {
        id: value.id,
        publicKey: Buffer.from(value.publicKey).toString('base64url'),
        counter: value.counter,
      };
    } catch {
      throw new Conflict('Phone verification did not finish. Create a new code and try again.');
    }
    this.assertEnabled();
    if (this.pending()?.id !== pending.id)
      throw new Conflict('Pairing was cancelled. Create a new code.');
    this.store.setSetting(pendingKey, { ...pending, challenge: null, credential });
    this.store.event('phone.device_confirmation_requested', null, null, { deviceId: pending.id });
    return { ok: true };
  }
  confirm(raw: unknown) {
    this.assertEnabled();
    const input = phoneConfirmSchema.parse(raw),
      pending = this.pending();
    // A successful repeated confirmation is harmless, but cannot restore a revoked enrollment.
    if (!pending) {
      if (
        this.store.db
          .prepare('SELECT id FROM paired_devices WHERE id=? AND revoked_at IS NULL')
          .get(input.id)
      )
        return;
      throw new Conflict('This pairing request is no longer available.');
    }
    if (
      pending.id !== input.id ||
      pending.confirmation !== input.confirmation ||
      !pending.credential
    )
      throw new Conflict('Check that the confirmation number matches your phone.');
    this.store.transaction(() => {
      const value = pending.credential!;
      this.store.db
        .prepare(
          'INSERT INTO paired_devices(id,name,browser_hash,credential_id,public_key,counter,created_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)',
        )
        .run(
          pending.id,
          pending.name,
          pending.browserHash,
          value.id,
          value.publicKey,
          value.counter,
          Date.now(),
        );
      this.closeEnrollment();
      this.store.event('phone.device_paired', null, null, { deviceId: pending.id });
    });
    this.changed();
  }
  async unlockOptions(cookies?: string) {
    this.assertEnabled();
    const device = this.device(cookies);
    if (!device)
      throw new Conflict('This browser is not paired. Pair it from your computer first.');
    const challenge = secret();
    this.store.db
      .prepare(
        'INSERT OR REPLACE INTO device_challenges(device_id,challenge,expires_at) VALUES(?,?,?)',
      )
      .run(device.id, challenge, Date.now() + 60_000);
    return generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
      userVerification: 'required',
      allowCredentials: [{ id: device.credential_id }],
    });
  }
  async unlock(raw: unknown, cookies?: string) {
    this.assertEnabled();
    const input = phoneCredentialSchema.parse(raw),
      device = this.device(cookies);
    if (!device) throw new Conflict('This browser is not paired.');
    const challenge = this.store.db
      .prepare('SELECT challenge,expires_at FROM device_challenges WHERE device_id=?')
      .get(device.id);
    const revision = this.revision();
    this.store.db.prepare('DELETE FROM device_challenges WHERE device_id=?').run(device.id);
    if (!challenge || Number(challenge.expires_at) <= Date.now())
      throw new Conflict('Unlock expired. Try Unlock sciencewithagents again.');
    let counter: number;
    try {
      if (
        input.id !== device.credential_id ||
        !input.response.signature ||
        !input.response.authenticatorData
      )
        throw new Error('Wrong credential');
      const result = await verifyAuthenticationResponse({
        response: input as AuthenticationResponseJSON,
        expectedChallenge: String(challenge.challenge),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: device.credential_id,
          publicKey: new Uint8Array(Buffer.from(device.public_key, 'base64url')),
          counter: device.counter,
        },
      });
      if (!result.verified) throw new Error('Unverified unlock');
      counter = result.authenticationInfo.newCounter;
    } catch {
      throw new Conflict('Phone verification did not finish. Try Unlock sciencewithagents again.');
    }
    this.assertEnabled();
    const current = this.device(cookies);
    if (
      !current ||
      current.id !== device.id ||
      current.counter !== device.counter ||
      this.revision() !== revision
    )
      throw new Conflict('Device access changed. Try unlocking again.');
    const token = secret(),
      id = randomUUID(),
      remembered = current.require_unlock === 0,
      expiresAt = remembered ? 0 : Date.now() + unlockLifetime;
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE paired_devices SET counter=? WHERE id=?')
        .run(counter, device.id);
      this.store.db
        .prepare('DELETE FROM device_unlocks WHERE device_id=? OR (remembered=0 AND expires_at<=?)')
        .run(device.id, Date.now());
      this.store.db
        .prepare(
          'INSERT INTO device_unlocks(id,device_id,token_hash,expires_at,remembered) VALUES(?,?,?,?,?)',
        )
        .run(id, device.id, hash(token), expiresAt, remembered ? 1 : 0);
    });
    this.changed();
    return [
      cookie(unlockCookie, token, remembered ? browserLifetime : unlockLifetime / 1000),
      this.renewedCookie(cookies)!,
    ];
  }
  session(cookies?: string): PhoneSession | null {
    if (!this.enabled()) return null;
    const device = this.device(cookies),
      token = cookieValue(cookies, unlockCookie);
    if (!device || !token) return null;
    const row = this.store.db
      .prepare(
        `SELECT id,expires_at,remembered,revision FROM device_unlocks WHERE token_hash=? AND device_id=?
        AND ((remembered=0 AND expires_at>? AND ?=1)
          OR (remembered=1 AND expires_at=0 AND ?=0))`,
      )
      .get(hash(token), device.id, Date.now(), device.require_unlock, device.require_unlock);
    return row
      ? {
          deviceId: device.id,
          email: '',
          subject: device.id,
          unlockId: String(row.id),
          unlockRevision: Number(row.revision),
          expiresAt: row.remembered === 1 ? null : Number(row.expires_at),
        }
      : null;
  }
  valid(session: PhoneSession) {
    if (!this.enabled()) return false;
    const row = this.store.db
      .prepare(
        `SELECT u.expires_at,u.remembered,u.revision,d.require_unlock FROM device_unlocks u
        JOIN paired_devices d ON d.id=u.device_id
        WHERE u.id=? AND d.id=? AND d.revoked_at IS NULL`,
      )
      .get(session.unlockId ?? '', session.deviceId);
    if (!row || row.revision !== session.unlockRevision) return false;
    // Compare the captured mode/deadline as well as current validity. Existing
    // streams must reconnect when the preference changes in either direction.
    return session.expiresAt === null
      ? row.remembered === 1 && row.expires_at === 0 && row.require_unlock === 0
      : row.remembered === 0 &&
          row.require_unlock === 1 &&
          row.expires_at === session.expiresAt &&
          session.expiresAt > Date.now();
  }
  lock(cookies?: string) {
    const device = this.device(cookies);
    if (device) {
      this.invalidateVerification();
      this.store.db.prepare('DELETE FROM device_unlocks WHERE device_id=?').run(device.id);
      this.store.db.prepare('DELETE FROM device_challenges WHERE device_id=?').run(device.id);
      this.changed();
    }
    return cookie(unlockCookie, '', 0);
  }
  revoke(id: string) {
    this.store.transaction(() => {
      this.invalidateVerification();
      this.store.db
        .prepare('UPDATE paired_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(Date.now(), id);
      this.store.db.prepare('DELETE FROM device_unlocks WHERE device_id=?').run(id);
      this.store.db.prepare('DELETE FROM device_challenges WHERE device_id=?').run(id);
      this.store.event('phone.device_revoked', null, null, { deviceId: id });
    });
    this.changed();
  }
}
