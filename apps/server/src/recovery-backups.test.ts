import { modelFixture } from './model-policy.fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recoveryCopiesSchema, recoveryCopySchema } from '@dock/shared';
import { Store } from './store.js';
import { RecoveryBackups } from './recovery-backups.js';
import { Runtime } from './runtime.js';
import { DemoProvider } from './demo.js';
import { createServer } from './server.js';
import { PhoneAccess, phoneConfigSchema } from './phone-access.js';
import { Terminals } from './terminal.js';
import { proxyPath } from './hosts.js';

let root: string, store: Store, manager: string;
const directory = () => join(root, 'recovery-backups');
const file = (id: string) => join(directory(), `recovery-${id}.sqlite`);
const headers = {
  host: '127.0.0.1:4999',
  origin: 'http://127.0.0.1:4999',
  'content-type': 'application/json',
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-recovery-copy-'));
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  manager = store.register(root, 'Recovery fixture', '').managerId;
  store.enqueue(manager, randomUUID(), 'Private saved message');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});

it('creates a private verified online snapshot without changing current work or exporting paths', async () => {
  const backups = new RecoveryBackups(store, root);
  expect(backups.status()).toEqual({ copies: [], creating: false });
  const before = store.entries(manager);
  const key = randomUUID();
  const copy = await backups.create({ key });
  expect(recoveryCopySchema.parse(copy)).toMatchObject({
    id: key,
    state: 'verified',
    counts: { projects: 1, conversations: 1, entries: 1, images: 0 },
  });
  expect(statSync(directory()).mode & 0o077).toBe(0);
  expect(statSync(file(key)).mode & 0o077).toBe(0);
  expect(readdirSync(directory())).toEqual([`recovery-${key}.sqlite`]);
  const saved = new DatabaseSync(file(key), { readOnly: true });
  try {
    expect(saved.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(JSON.parse(String(saved.prepare('SELECT body FROM entries').get()!.body)).text).toBe(
      'Private saved message',
    );
  } finally {
    saved.close();
  }
  expect(store.entries(manager)).toEqual(before);
  expect(JSON.stringify(backups.status())).not.toContain(root);
  expect(JSON.stringify(backups.status())).not.toContain('digest');
  expect(
    store
      .events()
      .filter((event) => event.type.startsWith('recovery_copy.'))
      .map((event) => event.type),
  ).toEqual(['recovery_copy.creating', 'recovery_copy.verified']);
});

it('deduplicates concurrent requests and retains the exact receipt across restart', async () => {
  const backups = new RecoveryBackups(store, root);
  const input = { key: randomUUID() };
  const [one, two] = await Promise.all([backups.create(input), backups.create(input)]);
  expect(two).toEqual(one);
  expect(readdirSync(directory()).filter((name) => name.endsWith('.sqlite'))).toHaveLength(1);
  const head = store.head;
  expect(await backups.create(input)).toEqual(one);
  expect(store.head).toBe(head);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const restarted = new RecoveryBackups(store, root);
  expect(await restarted.create(input)).toEqual(one);
  expect(restarted.status().copies).toHaveLength(1);
});

it('opens an independent restored fixture with the saved archive and image bytes, without copying external setup files', async () => {
  const entry = store.entries(manager)[0];
  const imageId = randomUUID();
  const fixtureBytes = Buffer.from('private saved image fixture');
  store.db
    .prepare('INSERT INTO images VALUES (?,?,?,?)')
    .run(imageId, entry.id, manager, fixtureBytes);
  store.setSetting('fixture:preference', { name: 'saved preference' });
  writeFileSync(join(root, 'external-credential-fixture.txt'), 'NEVER_COPY_EXTERNAL_SETUP_FIXTURE');
  const backups = new RecoveryBackups(store, root);
  const copy = await backups.create({ key: randomUUID() });
  expect(copy.counts?.images).toBe(1);
  expect(
    readFileSync(file(copy.id)).includes(Buffer.from('NEVER_COPY_EXTERNAL_SETUP_FIXTURE')),
  ).toBe(false);
  const originalEntries = store.entries(manager);
  const restoredPath = join(root, 'separate-restored-fixture.sqlite');
  copyFileSync(file(copy.id), restoredPath);
  const restored = new Store(restoredPath);
  modelFixture(restored);
  try {
    expect(restored.entries(manager)).toEqual(originalEntries);
    expect(restored.getSetting('fixture:preference')).toEqual({ name: 'saved preference' });
    expect(
      Buffer.from(
        restored.db.prepare('SELECT data FROM images WHERE id=?').get(imageId)!.data as Uint8Array,
      ),
    ).toEqual(fixtureBytes);
    restored.setSetting('fixture:preference', { name: 'restored only' });
    expect(store.getSetting('fixture:preference')).toEqual({ name: 'saved preference' });
  } finally {
    restored.close();
  }
  expect(store.entries(manager)).toEqual(originalEntries);
});

it('does not overwrite a colliding file and reports failure before an explicit new attempt', async () => {
  const backups = new RecoveryBackups(store, root);
  mkdirSync(directory(), { mode: 0o700 });
  const key = randomUUID();
  writeFileSync(file(key), 'preserve me', { mode: 0o600 });
  const failed = await backups.create({ key });
  expect(failed.state).toBe('failed');
  expect(failed.message).not.toContain(root);
  expect(statSync(file(key)).size).toBe(11);
  expect(await backups.create({ key })).toEqual(failed);
  expect((await backups.create({ key: randomUUID() })).state).toBe('verified');
});

it('refuses linked backup storage without writing into its target', async () => {
  const backups = new RecoveryBackups(store, root);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, directory());
  expect((await backups.create({ key: randomUUID() })).state).toBe('failed');
  expect(readdirSync(elsewhere)).toEqual([]);
});

it('detects later modifications even when the copy is still a valid database', async () => {
  const backups = new RecoveryBackups(store, root);
  const copy = await backups.create({ key: randomUUID() });
  expect((await backups.verify(copy.id)).state).toBe('verified');
  const modified = new DatabaseSync(file(copy.id));
  modified.prepare('INSERT INTO settings VALUES (?,?)').run('fixture-modification', 'true');
  modified.close();
  expect((await backups.verify(copy.id)).state).toBe('failed');
  expect(backups.get(copy.id).message).toContain('could not be verified');
  expect(store.entries(manager)[0].text).toBe('Private saved message');
});

it('refuses an unexpected journal rather than verifying only the main file bytes', async () => {
  const backups = new RecoveryBackups(store, root);
  const copy = await backups.create({ key: randomUUID() });
  writeFileSync(`${file(copy.id)}-wal`, 'untracked journal fixture', { mode: 0o600 });
  expect((await backups.verify(copy.id)).state).toBe('failed');
  expect(store.entries(manager)[0].text).toBe('Private saved message');
});

it('marks interrupted reservations as unverified and never automatically retries them', async () => {
  const backups = new RecoveryBackups(store, root);
  const key = randomUUID();
  const interrupted = {
    id: key,
    state: 'creating',
    createdAt: new Date().toISOString(),
    checkedAt: null,
    sizeBytes: null,
    counts: null,
    digest: null,
    message: 'In progress',
  };
  store.db
    .prepare('INSERT INTO recovery_backups VALUES (?,?,?)')
    .run(key, interrupted.createdAt, JSON.stringify(interrupted));
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  modelFixture(store);
  const restarted = new RecoveryBackups(store, root);
  expect(restarted.get(key)).toMatchObject({ state: 'failed', checkedAt: null });
  expect(restarted.get(key).message).toContain('app stopped');
  expect((await restarted.create({ key })).state).toBe('failed');
  expect((await restarted.create({ key: randomUUID() })).state).toBe('verified');
  expect(backups).toBeDefined();
});

it('rejects unknown paths/extra fields and keeps status, create and recheck within same-origin APIs', async () => {
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const app = await createServer(store, runtime, { port: 4999, ownsRuntime: false });
  try {
    expect(
      recoveryCopiesSchema.parse(
        (await app.inject({ url: '/api/recovery-backups', headers })).json(),
      ).copies,
    ).toEqual([]);
    const key = randomUUID();
    for (const [method, path] of [
      ['GET', '/recovery-backups'],
      ['GET', `/recovery-backups/${key}`],
      ['POST', '/recovery-backups'],
      ['POST', `/recovery-backups/${key}/verify`],
    ])
      expect(proxyPath(method, path)).toBe(`/api${path}`);
    expect(proxyPath('GET', `/recovery-backups/${key}/download`)).toBeNull();
    expect(proxyPath('POST', `/recovery-backups/${key}/restore`)).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/recovery-backups',
          headers: { ...headers, 'x-dock-target-host': randomUUID() },
          payload: { key },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/recovery-backups',
          headers,
          payload: { key, path: '/arbitrary' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/recovery-backups',
          headers: { ...headers, origin: 'https://elsewhere.test' },
          payload: { key },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/recovery-backups',
      headers,
      payload: { key },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().state).toBe('verified');
    expect((await app.inject({ url: `/api/recovery-backups/${key}`, headers })).json()).toEqual(
      created.json(),
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/recovery-backups/${key}/verify`,
          headers,
          payload: {},
        })
      ).json().state,
    ).toBe('verified');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/recovery-backups/${key}/verify`,
          headers,
          payload: { path: '/arbitrary' },
        })
      ).statusCode,
    ).toBe(400);
    for (const suffix of ['download', 'restore'])
      expect(
        (await app.inject({ url: `/api/recovery-backups/${key}/${suffix}`, headers })).statusCode,
      ).toBe(404);
  } finally {
    await app.close();
    await runtime.close();
  }
});

it('protects recovery metadata and writes behind the existing phone unlock boundary', async () => {
  const runtime = new Runtime(store, root, 'codex', async () => new DemoProvider());
  const phone = new PhoneAccess(
    store,
    phoneConfigSchema.parse({
      origin: 'https://dock.example.test',
      authentication: 'paired',
      port: 4998,
    }),
  );
  phone.setEnabled(true);
  const terminals = new Terminals(runtime);
  const remote = await createServer(store, runtime, {
    port: 4998,
    phone,
    terminals,
    remote: true,
    ownsRuntime: false,
  });
  const remoteHeaders = {
    host: 'dock.example.test',
    origin: 'https://dock.example.test',
    'content-type': 'application/json',
  };
  const key = randomUUID();
  try {
    for (const url of ['/api/recovery-backups', `/api/recovery-backups/${key}`])
      expect((await remote.inject({ url, headers: remoteHeaders })).statusCode).toBe(401);
    for (const url of ['/api/recovery-backups', `/api/recovery-backups/${key}/verify`])
      expect(
        (await remote.inject({ method: 'POST', url, headers: remoteHeaders, payload: { key } }))
          .statusCode,
      ).toBe(401);
    // Session verification is covered by the actual WebAuthn suite; this checks route authority after it.
    vi.spyOn(phone.pairedDevices!, 'session').mockReturnValue({
      deviceId: randomUUID(),
      expiresAt: null,
    });
    const response = await remote.inject({
      method: 'POST',
      url: '/api/recovery-backups',
      headers: remoteHeaders,
      payload: { key },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe('verified');
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain('Private saved message');
  } finally {
    await remote.close();
    await terminals.close();
    await runtime.close();
  }
});
