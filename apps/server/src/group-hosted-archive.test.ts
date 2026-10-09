import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  ftruncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { GroupExportPage, GroupExportRequest } from '@dock/shared/dist/group-hosted-export.js';
import { captureHostedArchive, verifyHostedArchive } from './group-hosted-archive.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'group-private-archive-'));
  roots.push(root);
  const groupId = randomUUID(),
    snapshot = {
      kind: 'bookmark' as const,
      value: 'synthetic-immutable-snapshot',
      expiresAt: Date.now() + 180000,
    };
  const schema: NonNullable<GroupExportPage['schema']> = [
    {
      type: 'table',
      name: 'ga_receipts',
      table: 'ga_receipts',
      sql: 'CREATE TABLE ga_receipts(id TEXT,exact INTEGER,bytes BLOB)',
    },
    {
      type: 'table',
      name: 'metadata',
      table: 'metadata',
      sql: 'CREATE TABLE metadata(group_id TEXT)',
    },
  ];
  const tables = [
    { name: 'ga_receipts', columns: ['id', 'exact', 'bytes'], rows: 2 },
    { name: 'metadata', columns: ['group_id'], rows: 0 },
  ];
  const pages: GroupExportPage[] = [
    {
      version: 1,
      groupId,
      snapshot,
      table: 0,
      columns: tables[0].columns,
      rows: [
        {
          rowid: '3',
          cells: [
            { type: 'text', value: '  Exact receipt\n🧬\u0000' },
            { type: 'integer', value: '9223372036854775807' },
            { type: 'blob', value: 'AP8BgA0K' },
          ],
        },
      ],
      next: { table: 0, after: '3' },
      schema,
      tables,
    },
    {
      version: 1,
      groupId,
      snapshot,
      table: 0,
      columns: tables[0].columns,
      rows: [
        {
          rowid: '19',
          cells: [
            { type: 'text', value: 'Other exact receipt' },
            { type: 'integer', value: '-9223372036854775808' },
            { type: 'null' },
          ],
        },
      ],
      next: { table: 1, after: null },
      schema: null,
      tables: null,
    },
    {
      version: 1,
      groupId,
      snapshot,
      table: 1,
      columns: tables[1].columns,
      rows: [],
      next: null,
      schema: null,
      tables: null,
    },
  ];
  const reader = () => {
    let n = 0;
    return async (request: GroupExportRequest) => {
      expect(request).toEqual(
        n ? { snapshot, cursor: pages[n - 1].next } : { snapshot: null, cursor: null },
      );
      return pages[n++];
    };
  };
  return { root, groupId, pages, reader };
}
it('creates a fresh private verified self-contained archive and re-verifies exact binary/64-bit data after restart', async () => {
  const f = fixture(),
    saved = await captureHostedArchive(f.root, f.groupId, f.reader());
  const path = join(f.root, 'hosted-archives', saved.archiveId, 'archive.jsonl');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.root, 'hosted-archives', saved.archiveId)).mode & 0o777).toBe(0o700);
  expect(verifyHostedArchive(f.root, saved.archiveId)).toEqual(saved);
  expect(readFileSync(path, 'utf8')).toContain('9223372036854775807');
  expect(readFileSync(path, 'utf8')).toContain('AP8BgA0K');
  expect(saved).toMatchObject({ pages: 3, rows: 2 });
  const another = await captureHostedArchive(f.root, f.groupId, f.reader());
  expect(another.archiveId).not.toBe(saved.archiveId);
  expect(verifyHostedArchive(f.root, saved.archiveId)).toEqual(saved);
});
it('retains a sparse held archive above the former aggregate bound and refuses at four GiB before reading a new snapshot', async () => {
  const f = fixture(),
    base = join(f.root, 'hosted-archives'),
    held = join(base, randomUUID());
  mkdirSync(base, { mode: 0o700 });
  mkdirSync(held, { mode: 0o700 });
  const path = join(held, 'archive.jsonl'),
    fd = openSync(path, 'wx', 0o600);
  try {
    // Sparse length exercises actual filesystem retention without allocating or
    // parsing GiB of fixture bytes. Held bytes are never altered by capture.
    ftruncateSync(fd, 3 * 1024 ** 3);
    const saved = await captureHostedArchive(f.root, f.groupId, f.reader());
    expect(statSync(path).size).toBe(3 * 1024 ** 3);
    expect(verifyHostedArchive(f.root, saved.archiveId)).toEqual(saved);
    ftruncateSync(fd, 4 * 1024 ** 3);
    let reads = 0;
    await expect(
      captureHostedArchive(f.root, f.groupId, async () => {
        reads++;
        return f.pages[0];
      }),
    ).rejects.toThrow(/retention limit/);
    expect(reads).toBe(0);
    expect(readdirSync(base)).toHaveLength(2);
    expect(statSync(path).size).toBe(4 * 1024 ** 3);
    expect(verifyHostedArchive(f.root, saved.archiveId)).toEqual(saved);
  } finally {
    closeSync(fd);
  }
});
it('rejects corrupted or truncated archived bytes without executing exported SQL', async () => {
  const f = fixture(),
    saved = await captureHostedArchive(f.root, f.groupId, f.reader()),
    path = join(f.root, 'hosted-archives', saved.archiveId, 'archive.jsonl'),
    original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('Other exact receipt', 'Edited exact receipt'));
  expect(() => verifyHostedArchive(f.root, saved.archiveId)).toThrow(/digest/);
  writeFileSync(path, original.split('\n').slice(0, -2).join('\n') + '\n');
  expect(() => verifyHostedArchive(f.root, saved.archiveId)).toThrow(/footer/);
});
it('reconciles the exact retained archive identity without a duplicate, revalidates current scope, and preserves corrupt prior bytes', async () => {
  const f = fixture(),
    archiveId = randomUUID();
  const saved = await captureHostedArchive(f.root, f.groupId, f.reader(), undefined, archiveId);
  let calls = 0;
  const replay = await captureHostedArchive(
    f.root,
    f.groupId,
    async () => {
      calls++;
      return f.pages[0];
    },
    undefined,
    archiveId,
  );
  expect(replay).toEqual(saved);
  expect(calls).toBe(1);
  expect(readdirSync(join(f.root, 'hosted-archives'))).toEqual([archiveId]);
  await expect(
    captureHostedArchive(f.root, randomUUID(), f.reader(), undefined, archiveId),
  ).rejects.toThrow(/scope/);
  await expect(
    captureHostedArchive(
      f.root,
      f.groupId,
      async () => {
        throw new Error('creator revoked');
      },
      undefined,
      archiveId,
    ),
  ).rejects.toThrow(/revoked/);
  expect(verifyHostedArchive(f.root, archiveId)).toEqual(saved);
  const path = join(f.root, 'hosted-archives', archiveId, 'archive.jsonl');
  writeFileSync(path, 'preserve incomplete prior bytes');
  await expect(
    captureHostedArchive(f.root, f.groupId, f.reader(), undefined, archiveId),
  ).rejects.toThrow(/needs inspection/);
  expect(readFileSync(path, 'utf8')).toBe('preserve incomplete prior bytes');
  const fresh = await captureHostedArchive(f.root, f.groupId, f.reader());
  expect(fresh.archiveId).not.toBe(archiveId);
  expect(readFileSync(path, 'utf8')).toBe('preserve incomplete prior bytes');
});
it('rejects missing rows, changed snapshots, noncanonical blobs and deletes only its failed fresh output', async () => {
  for (const change of ['gap', 'snapshot', 'blob'] as const) {
    const f = fixture();
    if (change === 'gap') f.pages[1].rows = [];
    if (change === 'snapshot') f.pages[1].snapshot = { ...f.pages[1].snapshot, value: 'changed' };
    if (change === 'blob') f.pages[0].rows[0].cells[2] = { type: 'blob', value: 'not-base64' };
    await expect(captureHostedArchive(f.root, f.groupId, f.reader())).rejects.toThrow();
    expect(readdirSync(join(f.root, 'hosted-archives'))).toEqual([]);
  }
});
it('preserves and counts an empty held directory while allowing an explicitly fresh archive', async () => {
  const f = fixture(),
    base = join(f.root, 'hosted-archives'),
    emptyId = randomUUID();
  mkdirSync(base, { mode: 0o700 });
  mkdirSync(join(base, emptyId), { mode: 0o700 });
  await expect(
    captureHostedArchive(f.root, f.groupId, f.reader(), undefined, emptyId),
  ).rejects.toThrow(/needs inspection/);
  const fresh = await captureHostedArchive(f.root, f.groupId, f.reader());
  expect(fresh.archiveId).not.toBe(emptyId);
  expect(readdirSync(join(base, emptyId))).toEqual([]);
  for (let n = 0; n < 6; n++) mkdirSync(join(base, randomUUID()), { mode: 0o700 });
  await expect(captureHostedArchive(f.root, f.groupId, f.reader())).rejects.toThrow(
    /retention limit/,
  );
  expect(readdirSync(base)).toHaveLength(8);
  expect(verifyHostedArchive(f.root, fresh.archiveId)).toEqual(fresh);
});
it('keeps a moved verified file intact and its empty directory held, while a fresh snapshot uses a new identity', async () => {
  const f = fixture(),
    backup = fixture();
  const saved = await captureHostedArchive(f.root, f.groupId, f.reader());
  const original = join(f.root, 'hosted-archives', saved.archiveId),
    destination = join(backup.root, 'hosted-archives', saved.archiveId);
  mkdirSync(join(backup.root, 'hosted-archives'), { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  renameSync(join(original, 'archive.jsonl'), join(destination, 'archive.jsonl'));
  await expect(
    captureHostedArchive(f.root, f.groupId, f.reader(), undefined, saved.archiveId),
  ).rejects.toThrow(/needs inspection/);
  const fresh = await captureHostedArchive(f.root, f.groupId, f.reader());
  expect(fresh.archiveId).not.toBe(saved.archiveId);
  expect(readdirSync(original)).toEqual([]);
  expect(verifyHostedArchive(backup.root, saved.archiveId)).toEqual(saved);
  expect(verifyHostedArchive(f.root, fresh.archiveId)).toEqual(fresh);
});
it('refuses symlink files and unrecognized contents inside retained UUID directories', async () => {
  for (const unsafe of ['symlink', 'entry'] as const) {
    const f = fixture(),
      other = fixture(),
      base = join(f.root, 'hosted-archives'),
      child = join(base, randomUUID());
    mkdirSync(base, { mode: 0o700 });
    mkdirSync(child, { mode: 0o700 });
    if (unsafe === 'symlink')
      symlinkSync(join(other.root, 'missing'), join(child, 'archive.jsonl'));
    else writeFileSync(join(child, 'unknown'), 'preserved', { mode: 0o600 });
    await expect(captureHostedArchive(f.root, f.groupId, f.reader())).rejects.toThrow();
    expect(readdirSync(base)).toHaveLength(1);
    expect(readdirSync(child)).toEqual([unsafe === 'symlink' ? 'archive.jsonl' : 'unknown']);
  }
});
it('bounds export time and concurrent jobs without overwriting existing private archives', async () => {
  const f = fixture();
  let elapsed = 0;
  await expect(
    captureHostedArchive(f.root, f.groupId, f.reader(), () => (elapsed += 180001)),
  ).rejects.toThrow(/timed out/);
  expect(readdirSync(join(f.root, 'hosted-archives'))).toEqual([]);
  elapsed = 0;
  const slow = f.reader();
  await expect(
    captureHostedArchive(
      f.root,
      f.groupId,
      async (request) => {
        const page = await slow(request);
        elapsed = 180001;
        return page;
      },
      () => elapsed,
    ),
  ).rejects.toThrow(/timed out/);
  expect(readdirSync(join(f.root, 'hosted-archives'))).toEqual([]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    reader = f.reader();
  const first = captureHostedArchive(f.root, f.groupId, async (request) => {
    await held;
    return reader(request);
  });
  await expect(captureHostedArchive(f.root, f.groupId, f.reader())).rejects.toThrow(
    /already running/,
  );
  release();
  expect((await first).rows).toBe(2);
});
it('refuses symlink archive storage and browser-style arbitrary archive paths', async () => {
  const f = fixture(),
    other = fixture();
  symlinkSync(other.root, join(f.root, 'hosted-archives'));
  await expect(captureHostedArchive(f.root, f.groupId, f.reader())).rejects.toThrow(
    /Private archive directory/,
  );
  expect(() => verifyHostedArchive(other.root, '../../secret')).toThrow(/identity/);
});
