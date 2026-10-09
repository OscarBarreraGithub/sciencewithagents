import {
  constants,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  GROUP_EXPORT_LIMITS as L,
  groupExportPageSchema,
  groupExportArchiveSchema,
  type GroupExportRequest,
  type GroupExportPage,
} from '@dock/shared/dist/group-hosted-export.js';
import { publicationCanonical } from '@dock/shared/dist/group-delivery.js';

const footerKind = 'swa-group-sql-archive-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = new Set<string>();
export class HostedArchiveHeld extends Error {
  constructor(readonly archiveId: string) {
    super(
      `Private archive ${archiveId} needs inspection. Its existing bytes were preserved. Keep it and explicitly start a fresh snapshot, or ask your setup agent to inspect it.`,
    );
  }
}
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Private archive directory required.');
}
function safeFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    closeSync(fd);
    throw new Error('Private archive file required.');
  }
  return fd;
}
/** No SQL execution, restore or caller-selected filesystem path. */
class ArchiveVerifier {
  private first?: GroupExportPage;
  private cursor: GroupExportRequest['cursor'] = null;
  private count = 0;
  private tableRows = 0;
  private last: string | null = null;
  rows = 0;
  bytes = 0;
  pages = 0;
  readonly hash = createHash('sha256');
  page(raw: unknown, line: string) {
    const page = groupExportPageSchema.parse(raw);
    if (Buffer.byteLength(line) > L.pageBytes + 1 || ++this.pages > L.pages)
      throw new Error('Archive page limit.');
    if (!this.first) {
      if (page.table !== 0 || !page.tables || !page.schema)
        throw new Error('Archive catalog missing.');
      const names = page.schema.filter((row) => row.type === 'table').map((row) => row.name);
      if (
        publicationCanonical(names) !== publicationCanonical(page.tables.map((table) => table.name))
      )
        throw new Error('Archive schema differs from catalog.');
      this.first = page;
    } else if (
      !this.cursor ||
      page.schema !== null ||
      page.tables !== null ||
      page.groupId !== this.first.groupId ||
      publicationCanonical(page.snapshot) !== publicationCanonical(this.first.snapshot) ||
      page.table !== this.cursor.table
    )
      throw new Error('Archive page continuity failed.');
    const table = this.first.tables![page.table];
    if (!table || publicationCanonical(table.columns) !== publicationCanonical(page.columns))
      throw new Error('Archive columns changed.');
    for (const row of page.rows) {
      if (
        row.cells.length !== table.columns.length ||
        (this.last !== null && BigInt(row.rowid) <= BigInt(this.last))
      )
        throw new Error('Archive row identity changed.');
      for (const cell of row.cells) {
        if (
          cell.type === 'integer' &&
          (!/^-?(?:0|[1-9][0-9]*)$/.test(cell.value) ||
            BigInt(cell.value) < -9223372036854775808n ||
            BigInt(cell.value) > 9223372036854775807n)
        )
          throw new Error('Invalid exact integer.');
        if (cell.type === 'real' && !Number.isFinite(Number(cell.value)))
          throw new Error('Invalid exact real.');
        if (
          cell.type === 'blob' &&
          Buffer.from(cell.value, 'base64').toString('base64') !== cell.value
        )
          throw new Error('Invalid exact blob.');
      }
      this.last = row.rowid;
      this.tableRows++;
      this.rows++;
    }
    if (this.rows > L.rows || this.tableRows > table.rows)
      throw new Error('Archive row count limit.');
    if (page.next?.table === page.table) {
      if (!page.rows.length || page.next.after !== this.last || this.tableRows >= table.rows)
        throw new Error('Archive continuation changed.');
    } else {
      if (
        this.tableRows !== table.rows ||
        (page.next
          ? page.next.table !== page.table + 1 || page.next.after !== null
          : page.table !== this.first.tables!.length - 1)
      )
        throw new Error('Archive table incomplete.');
      this.count++;
      this.tableRows = 0;
      this.last = null;
    }
    this.cursor = page.next;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > L.totalBytes) throw new Error('Archive byte limit.');
    this.hash.update(line);
    return page;
  }
  finish() {
    if (!this.first || this.cursor || this.count !== this.first.tables!.length)
      throw new Error('Archive incomplete.');
    return {
      groupId: this.first.groupId,
      pages: this.pages,
      rows: this.rows,
      bytes: this.bytes,
      sha256: this.hash.digest('hex'),
    };
  }
}
/** Fresh private output, bounded pages/bytes/time; never replaces a prior archive. */
export async function captureHostedArchive(
  root: string,
  groupId: string,
  page: (request: GroupExportRequest) => Promise<GroupExportPage>,
  now = () => Date.now(),
  archiveId: string = randomUUID(),
) {
  if (!uuid.test(archiveId)) throw new Error('Exact archive identity required.');
  privateDirectory(root);
  const canonical = realpathSync(root);
  if (active.has(canonical)) throw new Error('A hosted archive export is already running.');
  active.add(canonical);
  let directory: string | undefined, fd: number | undefined;
  try {
    const base = join(canonical, 'hosted-archives');
    try {
      mkdirSync(base, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    privateDirectory(base);
    const selected = join(base, archiveId);
    let exists = false;
    try {
      lstatSync(selected);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists) {
      // A process may have died after fsync and before its HTTP acknowledgement.
      // Never replace any existing output, including an incomplete/corrupt file.
      let saved;
      try {
        saved = verifyHostedArchive(root, archiveId);
      } catch {
        throw new HostedArchiveHeld(archiveId);
      }
      if (saved.groupId !== groupId) throw new Error('Archive scope changed.');
      const current = groupExportPageSchema.parse(await page({ snapshot: null, cursor: null }));
      if (current.groupId !== groupId) throw new Error('Archive scope changed.');
      return saved;
    }
    let total = 0,
      count = 0;
    for (const name of readdirSync(base)) {
      if (!uuid.test(name)) throw new Error('Unrecognized archive entry.');
      const child = join(base, name);
      privateDirectory(child);
      const entries = readdirSync(child);
      count++;
      // Death after mkdir/before open, or deliberate movement of a retained
      // file, leaves an empty held directory. Preserve/count it at zero bytes.
      if (!entries.length) continue;
      if (entries.length !== 1 || entries[0] !== 'archive.jsonl')
        throw new Error('Unrecognized archive entry.');
      const existing = safeFile(join(child, 'archive.jsonl'));
      try {
        total += fstatSync(existing).size;
      } finally {
        closeSync(existing);
      }
    }
    if (count >= 8 || total >= 1024 ** 3)
      throw new Error(
        'Private archive retention limit reached. Move a verified private archive directory before exporting again.',
      );
    directory = selected;
    mkdirSync(directory, { mode: 0o700 });
    fd = openSync(
      join(directory, 'archive.jsonl'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const verify = new ArchiveVerifier(),
      start = now();
    let request: GroupExportRequest = { snapshot: null, cursor: null };
    for (let index = 0; index < L.pages; index++) {
      if (now() - start > L.timeoutMs)
        throw new Error('Archive export timed out; start a fresh export.');
      const raw = await page(request);
      if (now() - start > L.timeoutMs)
        throw new Error('Archive export timed out; start a fresh export.');
      const line = JSON.stringify(raw) + '\n',
        current = verify.page(raw, line);
      if (current.groupId !== groupId || total + verify.bytes + 4096 > 1024 ** 3)
        throw new Error('Archive scope or retention limit.');
      writeSync(fd, line);
      if (!current.next) break;
      request = { snapshot: current.snapshot, cursor: current.next };
    }
    const receipt = groupExportArchiveSchema.parse({
      archiveId,
      ...verify.finish(),
      createdAt: new Date(now()).toISOString(),
    });
    writeSync(fd, JSON.stringify({ kind: footerKind, receipt }) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const checked = verifyHostedArchive(root, archiveId);
    if (publicationCanonical(checked) !== publicationCanonical(receipt))
      throw new Error('Archive verification failed.');
    return receipt;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    active.delete(canonical);
  }
}
/** Verifies the complete bounded file without executing exported SQL. */
export function verifyHostedArchive(root: string, archiveId: string) {
  if (!uuid.test(archiveId)) throw new Error('Exact archive identity required.');
  privateDirectory(root);
  const base = join(realpathSync(root), 'hosted-archives');
  privateDirectory(base);
  const directory = join(base, archiveId);
  privateDirectory(directory);
  const fd = safeFile(join(directory, 'archive.jsonl'));
  let buffer = Buffer.alloc(0),
    footer: unknown,
    finished = false;
  const verify = new ArchiveVerifier();
  try {
    if (fstatSync(fd).size > L.totalBytes + 4096) throw new Error('Archive byte limit.');
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, chunk);
      if (!count) break;
      if (finished) throw new Error('Trailing archive bytes.');
      buffer = Buffer.concat([buffer, chunk.subarray(0, count)]);
      let at: number;
      while ((at = buffer.indexOf(10)) >= 0) {
        const bytes = buffer.subarray(0, at + 1);
        buffer = buffer.subarray(at + 1);
        if (bytes.length > L.pageBytes + 1) throw new Error('Archive line limit.');
        const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          raw: unknown = JSON.parse(line);
        if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === footerKind) {
          footer = raw;
          finished = true;
          if (buffer.length) throw new Error('Trailing archive bytes.');
          break;
        }
        verify.page(raw, line);
      }
      if (buffer.length > L.pageBytes) throw new Error('Archive line limit.');
    }
    if (buffer.length || !footer || typeof footer !== 'object' || !('receipt' in footer))
      throw new Error('Archive footer missing.');
    const receipt = groupExportArchiveSchema.parse(footer.receipt),
      actual = verify.finish();
    if (
      receipt.archiveId !== archiveId ||
      publicationCanonical(actual) !==
        publicationCanonical({
          groupId: receipt.groupId,
          pages: receipt.pages,
          rows: receipt.rows,
          bytes: receipt.bytes,
          sha256: receipt.sha256,
        })
    )
      throw new Error('Archive digest/count verification failed.');
    return receipt;
  } finally {
    closeSync(fd);
  }
}
