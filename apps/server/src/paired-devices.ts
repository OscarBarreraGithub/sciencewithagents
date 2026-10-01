import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  phoneConfirmSchema,
  phoneCredentialSchema,
  phonePairSchema,
  phoneSetupCompleteSchema,
} from '@dock/shared';
import { Conflict, Store } from './store.js';
import type { PhoneSession } from './phone-access.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const enrollmentCookie = '__Host-dock_enrollment';
const browserLifetime = 400 * 24 * 60 * 60; // Browser storage lifetime, not enrollment expiry.
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

/** Computer-approved, passkey-verified enrollment with a durable, revocable browser credential. */
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
      setup_complete INTEGER NOT NULL DEFAULT 0 CHECK(setup_complete IN (0,1))
    );`);
    // The approved browser credential already exists on paired phones. Preserve it;
    // recurring verification and its expired sessions are no longer part of access.
    store.transaction(() => {
      const columns = store.db.prepare('PRAGMA table_info(paired_devices)').all();
      if (!columns.some((value) => value.name === 'setup_complete'))
        store.db.exec(
          'ALTER TABLE paired_devices ADD COLUMN setup_complete INTEGER NOT NULL DEFAULT 0 CHECK(setup_complete IN (0,1))',
        );
      store.db.exec('DROP TABLE IF EXISTS device_unlocks; DROP TABLE IF EXISTS device_challenges;');
      if (columns.some((value) => value.name === 'require_unlock'))
        store.db.exec('ALTER TABLE paired_devices DROP COLUMN require_unlock');
      store.db.prepare('DELETE FROM settings WHERE key=?').run('phone:unlock-revision');
    });
  }
  private assertEnabled() {
    if (!this.enabled()) throw new Conflict('Phone access is turned off on your computer.');
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
    const enrollment = this.enabled() ? this.renewedCookie(cookies) : null;
    return enrollment ? [enrollment] : [];
  }
  completeSetup(raw: unknown, cookies?: string, admittedSession?: PhoneSession) {
    phoneSetupCompleteSchema.parse(raw);
    this.store.transaction(() => {
      this.assertEnabled();
      const device = this.device(cookies);
      if (
        !device ||
        (admittedSession &&
          (!this.valid(admittedSession) || admittedSession.deviceId !== device.id))
      )
        throw new Conflict('Pair this browser from your computer before finishing phone setup.');
      if (device.setup_complete !== 1) {
        this.store.db
          .prepare('UPDATE paired_devices SET setup_complete=1 WHERE id=?')
          .run(device.id);
        this.store.event('phone.setup_completed', null, null, { deviceId: device.id });
      }
    });
    return this.renewedCookies(cookies);
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
    this.closeEnrollment();
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
      throw new Conflict('This browser is already paired. Open your workspace.');
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
  session(cookies?: string): PhoneSession | null {
    if (!this.enabled()) return null;
    const device = this.device(cookies);
    return device ? { deviceId: device.id, email: '', subject: device.id, expiresAt: null } : null;
  }
  valid(session: PhoneSession) {
    return (
      this.enabled() &&
      !!this.store.db
        .prepare('SELECT id FROM paired_devices WHERE id=? AND revoked_at IS NULL')
        .get(session.deviceId)
    );
  }
  revoke(id: string) {
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE paired_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(Date.now(), id);
      this.store.event('phone.device_revoked', null, null, { deviceId: id });
    });
    this.changed();
  }
}
