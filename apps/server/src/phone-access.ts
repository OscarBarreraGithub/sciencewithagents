import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import {
  phoneCodeSchema,
  phoneDeviceSchema,
  phonePairSchema,
  phoneStatusSchema,
} from '@dock/shared';
import { Conflict, Store } from './store.js';
import { PairedDevices } from './paired-devices.js';

const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname.includes('.') &&
      !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.endsWith('.localhost') &&
      !url.hostname.endsWith('.local')
    );
  }, 'Use a canonical public HTTPS origin without a path or port.');
export const phoneConfigSchema = z
  .object({
    origin,
    authentication: z.enum(['access', 'paired']).default('access'),
    issuer: z
      .string()
      .regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/)
      .optional(),
    audience: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    owner: z
      .email()
      .transform((value) => value.toLowerCase())
      .optional(),
    port: z.number().int().min(1024).max(65535).default(4331),
    transport: z.enum(['cloudflare', 'tailscale']).optional(),
    tailscaleNode: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.authentication === 'paired' || !!(value.issuer && value.audience && value.owner),
    'Access authentication requires issuer, audience and owner.',
  )
  .refine(
    (value) =>
      value.transport !== 'tailscale' ||
      (value.authentication === 'paired' &&
        !!value.tailscaleNode &&
        /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(new URL(value.origin).hostname)),
    'A private connection needs its verified Tailscale address and paired authentication.',
  );
export type PhoneConfig = z.infer<typeof phoneConfigSchema>;
export type PhoneIdentity = { email: string; subject: string; expiresAt: number };
export type PhoneSession = Omit<PhoneIdentity, 'expiresAt'> & {
  deviceId: string;
  unlockId?: string;
  unlockRevision?: number;
  expiresAt: number | null;
};
const deviceLifetime = 30 * 24 * 60 * 60 * 1000;
const codeLifetime = 15 * 60 * 1000;
const cookieName = '__Host-dock_device';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Pairing = { key: string; hash: string; expiresAt: number; attempts: number; used: boolean };

export function readPhoneConfig(dataDir: string): PhoneConfig | null {
  const file = join(dataDir, 'phone-access.json');
  if (!existsSync(file)) return null;
  try {
    return phoneConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new Error(
      'Phone access configuration is invalid. Ask your setup agent to check data/phone-access.json.',
    );
  }
}

/** Explicit host-selected authentication; legacy Access never silently becomes paired mode. */
export class PhoneAccess extends EventEmitter {
  private devices: PairedDevices | null;
  private currentConfig: PhoneConfig | null;
  get pairedDevices() {
    return this.devices;
  }
  get config() {
    return this.currentConfig;
  }
  connection: 'external' | 'off' | 'connecting' | 'connected' | 'error' = 'external';
  private keys: JWTVerifyGetKey | null;
  private issue: 'configuration' | 'listener' | null;
  private codeReceipt: { key: string; code: string; expiresAt: number } | null = null;
  constructor(
    readonly store: Store,
    config: PhoneConfig | null,
    keys?: JWTVerifyGetKey,
    setupIssue: 'configuration' | 'listener' | null = null,
  ) {
    super();
    this.currentConfig = config;
    this.issue = setupIssue;
    if (config) phoneConfigSchema.parse(config);
    this.keys =
      keys ??
      (config?.authentication === 'access'
        ? createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
            timeoutDuration: 5000,
          })
        : null);
    store.db.exec(`CREATE TABLE IF NOT EXISTS phone_devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );`);
    this.devices =
      config?.authentication === 'paired'
        ? new PairedDevices(
            store,
            config.origin,
            () => this.enabled,
            () => this.emit('change'),
          )
        : null;
    // Listener ports are transport, not the passkey/Access trust boundary. Canonical
    // versioned identity survives harmless config edits and future optional fields.
    const { authentication: _authentication, ...legacyConfig } = config ?? {};
    const legacyFingerprint = config
      ? digest(JSON.stringify(config.authentication === 'access' ? legacyConfig : config))
      : null;
    const fingerprint = config
      ? `v2:${digest(
          JSON.stringify({
            origin: config.origin,
            authentication: config.authentication,
            ...(config.authentication === 'access'
              ? { issuer: config.issuer, audience: config.audience, owner: config.owner }
              : {}),
          }),
        )}`
      : null;
    const saved = store.getSetting('phone:configuration');
    // Unreadable/unavailable configuration is not an owner request to revoke trust.
    // No remote entry or connector can operate until a later healthy startup validates it.
    if (!this.issue && saved !== fingerprint) {
      store.transaction(() => {
        store.setSetting('phone:configuration', fingerprint);
        // Migrate only when the old fingerprint proves the complete current config
        // is unchanged. Never infer old trust from a merely similar hostname.
        if (config && saved === legacyFingerprint) return;
        store.setSetting('phone:enabled', false);
        store.setSetting('phone:pairing', null);
        store.db
          .prepare('UPDATE phone_devices SET revoked_at=? WHERE revoked_at IS NULL')
          .run(Date.now());
        this.pairedDevices?.resetTrust();
      });
    }
  }
  get setupIssue() {
    return this.issue;
  }
  /** First setup only; changing a paired installation remains a separate explicit migration. */
  configureInitial(raw: PhoneConfig) {
    if (this.config || this.issue)
      throw new Conflict(
        'This computer already has phone settings. Its connection was not replaced.',
      );
    const config = phoneConfigSchema.parse(raw);
    if (config.authentication !== 'paired')
      throw new Conflict('New phone connections use passkey pairing.');
    this.currentConfig = config;
    this.devices = new PairedDevices(
      this.store,
      config.origin,
      () => this.enabled,
      () => this.emit('change'),
    );
    this.store.setSetting(
      'phone:configuration',
      `v2:${digest(JSON.stringify({ origin: config.origin, authentication: config.authentication }))}`,
    );
    this.store.setSetting('phone:enabled', false);
    this.connection = 'off';
  }
  listenerReady() {
    if (this.issue === 'listener') this.issue = null;
  }
  unavailable(issue: 'configuration' | 'listener') {
    this.issue = issue;
    this.connection = 'error';
    this.emit('change');
  }
  get enabled() {
    return !this.issue && !!this.config && this.store.getSetting('phone:enabled') === true;
  }
  setEnabled(enabled: boolean) {
    if (enabled && this.issue)
      throw new Conflict(
        'Phone setup needs repair on this computer. Its saved pairing is retained; reopen the app after repair.',
      );
    if (enabled && !this.config) throw new Conflict('Phone access needs to finish setup first.');
    this.store.transaction(() => {
      this.store.setSetting('phone:enabled', enabled);
      if (!enabled) {
        this.store.setSetting('phone:pairing', null);
        this.codeReceipt = null;
        if (this.pairedDevices) this.pairedDevices.pause();
        else
          this.store.db
            .prepare('UPDATE phone_devices SET revoked_at=? WHERE revoked_at IS NULL')
            .run(Date.now());
      }
      this.store.event('phone.access_changed', null, null, { enabled });
    });
    this.emit('change');
  }
  status(remote: boolean, paired = false, cookies?: string) {
    return phoneStatusSchema.parse({
      mode: remote ? 'remote' : 'local',
      configured: !!this.config,
      transport: this.config ? (this.config.transport ?? 'cloudflare') : null,
      setupIssue: this.issue,
      enabled: this.enabled,
      connection: this.issue ? 'error' : remote ? 'external' : this.connection,
      paired: remote ? paired : true,
      authentication: this.config?.authentication ?? 'access',
      origin: this.config?.origin ?? null,
      devices: remote
        ? []
        : this.store.db
            .prepare(
              'SELECT id,name,created_at,expires_at,revoked_at FROM phone_devices ORDER BY created_at DESC LIMIT 100',
            )
            .all()
            .map((row) =>
              phoneDeviceSchema.parse({
                id: row.id,
                name: row.name,
                createdAt: new Date(Number(row.created_at)).toISOString(),
                expiresAt: new Date(Number(row.expires_at)).toISOString(),
                revokedAt:
                  row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(),
              }),
            ),
      ...(this.pairedDevices ? this.pairedDevices.status(remote, cookies) : {}),
    });
  }
  issueCode(key: string) {
    if (!this.enabled || !this.config)
      throw new Conflict('Turn on phone access before connecting a device.');
    const existing = this.store.getSetting('phone:pairing') as Pairing | null;
    if (existing?.key === key) {
      if (
        !existing.used &&
        existing.expiresAt > Date.now() &&
        existing.attempts < 5 &&
        this.codeReceipt?.key === key
      )
        return phoneCodeSchema.parse({
          code: this.codeReceipt.code,
          expiresAt: new Date(existing.expiresAt).toISOString(),
          origin: this.config.origin,
        });
      throw new Conflict('This code is no longer available. Choose Create a new code.');
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = [...randomBytes(16)].map((value) => alphabet[value & 31]).join('');
    const code = raw.match(/.{4}/g)!.join('-');
    const expiresAt = Date.now() + codeLifetime;
    this.store.transaction(() => {
      this.pairedDevices?.closeEnrollment();
      this.store.setSetting('phone:pairing', {
        key,
        hash: digest(raw),
        expiresAt,
        attempts: 0,
        used: false,
      });
      this.store.event('phone.code_created', null, null, { expiresAt });
    });
    this.codeReceipt = { key, code, expiresAt };
    return phoneCodeSchema.parse({
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      origin: this.config.origin,
    });
  }
  async identity(token: unknown): Promise<PhoneIdentity | null> {
    if (
      !this.enabled ||
      !this.config ||
      this.pairedDevices ||
      !this.keys ||
      typeof token !== 'string' ||
      token.length > 16_384
    )
      return null;
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'email'],
      });
      if (
        payload.type !== 'app' ||
        typeof payload.email !== 'string' ||
        !payload.sub ||
        payload.email.toLowerCase() !== this.config.owner
      )
        return null;
      return { email: this.config.owner!, subject: payload.sub, expiresAt: payload.exp! * 1000 };
    } catch {
      return null;
    } // Never echo credentials, JWT payloads or verification internals.
  }
  session(identity: PhoneIdentity, cookie: string | undefined): PhoneSession | null {
    if (!this.enabled || identity.expiresAt <= Date.now()) return null;
    const values = (cookie ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.store.db
      .prepare(
        'SELECT id,expires_at FROM phone_devices WHERE token_hash=? AND email=? AND subject=? AND revoked_at IS NULL AND expires_at>?',
      )
      .get(digest(token), identity.email, identity.subject, Date.now());
    return row
      ? {
          ...identity,
          deviceId: String(row.id),
          expiresAt: Math.min(identity.expiresAt, Number(row.expires_at)),
        }
      : null;
  }
  pair(identity: PhoneIdentity, raw: unknown) {
    if (this.pairedDevices) throw new Conflict('Use device pairing and passkey verification.');
    const input = phonePairSchema.parse(raw);
    if (!this.enabled || identity.expiresAt <= Date.now())
      throw new Conflict('Sign in again before pairing.');
    const pairing = this.store.getSetting('phone:pairing') as Pairing | null;
    const code = input.code.toUpperCase().replace(/[\s-]/g, '');
    if (!pairing || pairing.used || pairing.expiresAt <= Date.now() || pairing.attempts >= 5)
      throw new Conflict('That code is unavailable. Create a new code on your computer.');
    // Persist unsuccessful attempts too; a restart must not reset the attempt limit.
    this.store.setSetting('phone:pairing', { ...pairing, attempts: pairing.attempts + 1 });
    if (!timingSafeEqual(Buffer.from(digest(code), 'hex'), Buffer.from(pairing.hash, 'hex')))
      throw new Conflict('That code did not match. Check the code on your computer.');
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID(),
      createdAt = Date.now();
    this.store.transaction(() => {
      this.store.setSetting('phone:pairing', { ...pairing, used: true });
      this.store.db
        .prepare('INSERT INTO phone_devices VALUES(?,?,?,?,?,?,?,NULL)')
        .run(
          id,
          input.name,
          identity.email,
          identity.subject,
          digest(token),
          createdAt,
          createdAt + deviceLifetime,
        );
      this.store.event('phone.device_paired', null, null, { deviceId: id });
    });
    this.codeReceipt = null;
    return {
      cookie: `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${deviceLifetime / 1000}`,
    };
  }
  revoke(id: string) {
    if (this.pairedDevices) return this.pairedDevices.revoke(id);
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE phone_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(Date.now(), id);
      this.store.event('phone.device_revoked', null, null, { deviceId: id });
    });
    this.emit('change');
  }
  valid(session: PhoneSession) {
    if (this.pairedDevices) return this.pairedDevices.valid(session);
    return (
      this.enabled &&
      session.expiresAt !== null &&
      session.expiresAt > Date.now() &&
      !!this.store.db
        .prepare('SELECT id FROM phone_devices WHERE id=? AND revoked_at IS NULL AND expires_at>?')
        .get(session.deviceId, Date.now())
    );
  }
  watch(session: PhoneSession, close: () => void) {
    const check = () => {
      if (!this.valid(session)) close();
    };
    // Remembered sessions have no timer, but still close on lock, revocation or
    // preference changes. A capped long timeout would silently expire them.
    const timer =
      session.expiresAt === null
        ? null
        : setTimeout(close, Math.max(0, Math.min(2_147_483_647, session.expiresAt - Date.now())));
    timer?.unref();
    this.on('change', check);
    check();
    return () => {
      if (timer) clearTimeout(timer);
      this.off('change', check);
    };
  }
}
