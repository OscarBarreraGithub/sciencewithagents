import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Conflict } from './store.js';
import {
  localChallengeSchema,
  localPeerProof,
  localRequestProof,
  localAuthorization,
  type LocalRole,
} from '@dock/shared/dist/local-authorization.js';

const secret = z.string().regex(/^[a-f0-9]{64}$/);
const configSchema = z
  .object({
    version: z.literal(1),
    origin: z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{4,5}$/)
      .refine((value) => {
        const port = Number(new URL(value).port);
        return port >= 1024 && port <= 65535;
      }),
    owner: secret,
    bridge: secret,
    host: secret,
  })
  .strict();
export type LocalAccessConfiguration = z.infer<typeof configSchema>;
const configurationFile = (root: string) => join(root, 'local-access.json');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieLifetime = 30 * 24 * 60 * 60 * 1000;
const handoffLifetime = 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Installation credentials, not provider credentials. Never expose through web APIs. */
export function readLocalAccess(root: string): LocalAccessConfiguration {
  const fd = openSync(configurationFile(root), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Local access needs a private configuration owned by this OS account.');
    return configSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
export function prepareLocalAccess(root: string, port: number): LocalAccessConfiguration {
  let previous: LocalAccessConfiguration | undefined;
  try {
    previous = readLocalAccess(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = configSchema.parse({
    version: 1,
    origin: `http://127.0.0.1:${port}`,
    owner: previous?.owner ?? randomBytes(32).toString('hex'),
    bridge: previous?.bridge ?? randomBytes(32).toString('hex'),
    host: previous?.host ?? randomBytes(32).toString('hex'),
  });
  if (previous?.origin !== config.origin) {
    const temporary = `${configurationFile(root)}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, configurationFile(root));
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return config;
}

/** Existing same-account CLI entry; absent only on legacy/demo installations. */
export async function ownerAuthorization(root: string, port: number, method: string, path: string) {
  let config;
  try {
    config = readLocalAccess(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (config.origin !== `http://127.0.0.1:${port}`)
    throw new Error('The local app address does not match its saved connection.');
  return localAuthorization(config.origin, config.owner, 'owner', method, path);
}

/** One installation, with separate browser, owner and gateway authority. */
export class LocalAccess {
  private handoffs = new Map<string, number>();
  private challenges = new Map<string, { role: LocalRole; challenge: string; expiresAt: number }>();
  private transfers = new Map<
    string,
    {
      kind: 'export' | 'import';
      source: string;
      destination: string;
      recover: boolean;
      expiresAt: number;
    }
  >();
  readonly cookieName: string;
  readonly browserOrigin: string;
  constructor(
    readonly configuration: LocalAccessConfiguration,
    private now = Date.now,
  ) {
    configSchema.parse(configuration);
    this.cookieName = `swa_local_${digest(configuration.owner).slice(0, 16)}`;
    this.browserOrigin = `http://swa-${digest(configuration.owner).slice(0, 24)}.localhost:${new URL(configuration.origin).port}`;
  }
  proof(input: unknown) {
    const value = localChallengeSchema.parse(input);
    for (const [key, entry] of this.challenges)
      if (entry.expiresAt <= this.now()) this.challenges.delete(key);
    if (this.challenges.size >= 256)
      throw new Conflict('Local connection is busy. Please try again in a minute.');
    const nonce = randomBytes(32).toString('hex');
    this.challenges.set(nonce, { ...value, expiresAt: this.now() + handoffLifetime });
    return {
      nonce,
      proof: localPeerProof(
        this.configuration[value.role],
        this.configuration.origin,
        value.role,
        value.challenge,
        nonce,
      ),
    };
  }
  authenticate(authorization: unknown, method: string, path: string): LocalRole | null {
    if (typeof authorization !== 'string') return null;
    const parsed = /^Dock (owner|bridge|host)\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(authorization);
    if (!parsed) return null;
    const [, role, nonce, signature] = parsed;
    const entry = this.challenges.get(nonce);
    if (!entry || entry.role !== role || entry.expiresAt <= this.now()) return null;
    if (
      !equal(
        signature,
        localRequestProof(
          this.configuration[entry.role],
          this.configuration.origin,
          entry.role,
          entry.challenge,
          nonce,
          method,
          path,
        ),
      )
    )
      return null;
    this.challenges.delete(nonce);
    return entry.role;
  }
  private sign(value: string) {
    return createHmac('sha256', this.configuration.owner).update(`browser:${value}`).digest('hex');
  }
  browser(cookies: string | undefined) {
    const values = (cookies ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return false;
    const value = values[0].slice(this.cookieName.length + 1);
    const parsed = /^(\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
    if (!parsed) return false;
    const expiresAt = Number(parsed[1]);
    return (
      expiresAt > this.now() &&
      expiresAt <= this.now() + cookieLifetime &&
      equal(parsed[3], this.sign(`${parsed[1]}.${parsed[2]}`))
    );
  }
  issueHandoff() {
    for (const [key, expiresAt] of this.handoffs)
      if (expiresAt <= this.now()) this.handoffs.delete(key);
    if (this.handoffs.size >= 16)
      throw new Conflict('Too many app-opening requests. Wait a minute and try again.');
    const ticket = randomBytes(32).toString('hex');
    this.handoffs.set(digest(ticket), this.now() + handoffLifetime);
    return { ticket, expiresAt: new Date(this.now() + handoffLifetime).toISOString() };
  }
  consumeHandoff(ticket: string) {
    if (!/^[a-f0-9]{64}$/.test(ticket))
      throw new Conflict('Open sciencewithagents again to connect this browser.');
    const hash = digest(ticket),
      expiresAt = this.handoffs.get(hash);
    this.handoffs.delete(hash);
    if (!expiresAt || expiresAt <= this.now())
      throw new Conflict('Open sciencewithagents again to connect this browser.');
    const body = `${this.now() + cookieLifetime}.${randomBytes(16).toString('hex')}`;
    return `${this.cookieName}=${body}.${this.sign(body)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookieLifetime / 1000}`;
  }
  private transfer(
    kind: 'export' | 'import',
    source: string,
    destination: string,
    recover: boolean,
  ) {
    if (
      !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{4,5}$/.test(source) ||
      new URL(destination).hostname !== new URL(this.browserOrigin).hostname
    )
      throw new Conflict('Use this installation’s browser addresses.');
    for (const [key, value] of this.transfers)
      if (value.expiresAt <= this.now()) this.transfers.delete(key);
    if (this.transfers.size >= 16)
      throw new Conflict('Too many browser reconnects. Wait a minute and try again.');
    const ticket = randomBytes(32).toString('hex');
    this.transfers.set(digest(ticket), {
      kind,
      source,
      destination,
      recover,
      expiresAt: this.now() + handoffLifetime,
    });
    return ticket;
  }
  issueMigration(source: string, destination: string, recover: boolean) {
    return this.transfer('export', source, destination, recover);
  }
  private takeTransfer(
    ticket: string,
    kind: 'export' | 'import',
    origin: string,
    destination: string,
  ) {
    if (!/^[a-f0-9]{64}$/.test(ticket))
      throw new Conflict('Reconnect this tab to try restoring its drafts again.');
    const key = digest(ticket),
      value = this.transfers.get(key);
    if (
      !value ||
      value.kind !== kind ||
      value.source !== origin ||
      value.destination !== destination ||
      value.expiresAt <= this.now()
    )
      throw new Conflict('Reconnect this tab to try restoring its drafts again.');
    this.transfers.delete(key);
    return value;
  }
  exportMigration(ticket: string, source: string, destination: string) {
    const value = this.takeTransfer(ticket, 'export', source, destination);
    return {
      ...value,
      ticket: this.transfer('import', value.source, value.destination, value.recover),
    };
  }
  importMigration(ticket: string, source: string, destination: string) {
    return this.takeTransfer(ticket, 'import', source, destination);
  }
}
