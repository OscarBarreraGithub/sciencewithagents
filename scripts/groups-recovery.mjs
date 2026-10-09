/** Private, offline maintenance only. Never restores over an installation,
 * starts a provider, changes identities or uploads credentials. */
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  readdir,
  lstat,
  readFile,
  writeFile,
  open,
  rename,
  realpath,
  chmod,
} from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { backup, DatabaseSync } from 'node:sqlite';

const MAX_FILES = 50000,
  MAX_BYTES = 4 * 1024 ** 3;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safe = (p) =>
  typeof p === 'string' &&
  p.length > 0 &&
  !isAbsolute(p) &&
  !p.split('/').some((s) => !s || s === '.' || s === '..') &&
  !/[\\\0]/u.test(p);
const regular = (s) =>
  s.isFile() && s.nlink === 1 && (!process.getuid || s.uid === process.getuid());
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error('Recovery storage must be a private regular directory.');
}
async function stopped(dataDir) {
  let port = Number(process.env.DOCK_PORT ?? 4330);
  try {
    const config = JSON.parse(await readFile(join(dataDir, 'launcher/config.json'), 'utf8'));
    if (resolve(config.dataDir) !== dataDir) throw new Error('Launcher data directory differs.');
    port = config.port;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid app port.');
  await new Promise((yes, no) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      no(new Error('Quit sciencewithagents before making a Groups recovery archive.'));
    });
    socket.once('error', (e) => {
      socket.destroy();
      e.code === 'ECONNREFUSED' ? yes() : no(e);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      no(new Error('App stopped state could not be confirmed.'));
    });
  });
  const db = new DatabaseSync(join(dataDir, 'dock.sqlite'), { readOnly: true });
  try {
    if (
      db.prepare("SELECT 1 FROM runs WHERE json_extract(body,'$.status')='running' LIMIT 1").get()
    )
      throw new Error('Running work is still recorded. Reconcile it before archiving Groups.');
  } finally {
    db.close();
  }
}
async function checkedFile(path, destination, collect = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let writer;
  try {
    const before = await handle.stat();
    if (!regular(before)) throw new Error('Recovery only accepts owned, unlinked regular files.');
    if (destination) writer = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256'),
      chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_BYTES || (collect && size > 16 * 1024 ** 2))
        throw new Error('Recovery file limit reached.');
      hash.update(chunk);
      if (writer) await writer.writeFile(chunk);
      if (collect) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      throw new Error('A file changed during recovery capture.');
    return { bytes: collect ? Buffer.concat(chunks) : undefined, size, sha256: hash.digest('hex') };
  } finally {
    await writer?.close();
    await handle.close();
  }
}
async function integrity(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await lstat(`${path}${suffix}`);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    throw new Error('Recovery database has an unexpected journal sidecar.');
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok')
      throw new Error('Recovery database integrity failed.');
  } finally {
    db.close();
  }
}
export async function recoveryInventory(roots) {
  const found = [];
  const walk = async (path) => {
    const s = await lstat(path);
    if (found.length >= MAX_FILES) throw new Error('Groups recovery inventory file limit reached.');
    if (s.isDirectory() && !s.isSymbolicLink()) {
      found.push([path, 'directory', s.dev, s.ino, s.mode]);
      for (const entry of (await readdir(path)).sort()) {
        if (/\.(?:sqlite|db)-shm$/u.test(entry)) continue;
        await walk(join(path, entry));
      }
    } else found.push([path, s.dev, s.ino, s.size, s.mtimeMs]);
  };
  for (const path of roots) {
    await walk(path);
    if (/\.(?:sqlite|db)$/u.test(path)) {
      for (const suffix of ['-wal', '-journal']) {
        try {
          await walk(`${path}${suffix}`);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          found.push([`${path}${suffix}`, 'absent']);
        }
      }
    }
  }
  return JSON.stringify(found);
}
export async function saveGroups(dataDirectory) {
  const dataDir = resolve(dataDirectory);
  await stopped(dataDir);
  const root = join(dataDir, 'group-recovery');
  await privateDirectory(root);
  const id = randomUUID(),
    pending = join(root, `.pending-${id}`),
    destination = join(root, id);
  await mkdir(pending, { mode: 0o700 });
  const files = [],
    directories = [],
    external = [];
  const roots = [join(dataDir, 'dock.sqlite'), join(dataDir, 'groups')],
    capturedWorktrees = new Set();
  let total = 0;
  const inventory = () => recoveryInventory(roots);
  // Inventory task roots before capture so a writer appearing during any part
  // of the operation invalidates the whole new archive, not the live data.
  const taskRoots = [];
  const hostPath = join(dataDir, 'groups/host-native.sqlite');
  try {
    await lstat(hostPath);
    const host = new DatabaseSync(hostPath, { readOnly: true }),
      projects = new Set();
    try {
      for (const row of host.prepare('SELECT body FROM hnr_bindings').all())
        projects.add(JSON.parse(String(row.body)).projectId);
    } finally {
      host.close();
    }
    const dock = new DatabaseSync(join(dataDir, 'dock.sqlite'), { readOnly: true });
    try {
      for (const row of dock.prepare('SELECT id,project_id,body FROM tasks').all()) {
        if (!projects.has(row.project_id)) continue;
        const path = JSON.parse(String(row.body)).worktree;
        if (!path) continue;
        const rel = relative(dataDir, path);
        if (!safe(rel) || !rel.startsWith('worktrees/')) {
          external.push({ taskId: row.id, path });
          continue;
        }
        if (!capturedWorktrees.has(path)) {
          capturedWorktrees.add(path);
          roots.push(path);
          taskRoots.push([path, rel]);
        }
      }
    } finally {
      dock.close();
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const before = await inventory();
  const copy = async (source, name) => {
    if (!safe(name)) throw new Error('Invalid recovery file name.');
    const s = await lstat(source);
    if (s.isDirectory() && !s.isSymbolicLink()) {
      if (directories.length + files.length >= MAX_FILES)
        throw new Error('Groups recovery directory limit reached.');
      directories.push(name);
      await mkdir(join(pending, name), { recursive: true, mode: 0o700 });
      for (const entry of (await readdir(source)).sort()) {
        if (/\.(?:sqlite|db)-(?:wal|shm|journal)$/u.test(entry)) continue;
        await copy(join(source, entry), `${name}/${entry}`);
      }
      return;
    }
    if (!regular(s) || files.length >= MAX_FILES || total + s.size > MAX_BYTES)
      throw new Error(
        'Groups recovery file type or capacity limit reached. Originals were preserved.',
      );
    const target = join(pending, name);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    if (/\.(?:sqlite|db)$/u.test(name)) {
      await writeFile(target, '', { flag: 'wx', mode: 0o600 });
      const reader = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(reader, target);
      } finally {
        reader.close();
      }
      const standalone = new DatabaseSync(target);
      try {
        standalone.exec('PRAGMA journal_mode=DELETE');
      } finally {
        standalone.close();
      }
      await integrity(target);
    } else {
      await checkedFile(source, target);
      if (s.mode & 0o100) await chmod(target, 0o700);
    }
    const captured = await checkedFile(target);
    total += captured.size;
    if (total > MAX_BYTES) throw new Error('Groups recovery byte limit reached.');
    files.push({
      path: name,
      bytes: captured.size,
      sha256: captured.sha256,
      mode: s.mode & 0o100 ? 0o700 : 0o600,
    });
  };
  await copy(join(dataDir, 'dock.sqlite'), 'dock.sqlite');
  await copy(join(dataDir, 'groups'), 'groups');
  // Group task worktrees may live outside groups/. Include only their exact
  // retained locations beneath this installation; never sweep unrelated tasks.
  for (const [path, rel] of taskRoots) await copy(path, rel);
  await stopped(dataDir);
  if (before !== (await inventory()))
    throw new Error(
      'Groups changed during capture. Partial archive retained; quit the app and create another.',
    );
  const manifest = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    sourceDataDir: dataDir,
    files,
    directories,
    external,
    coverage:
      'dock database, Groups local journals/configuration/workspaces, installation-owned Groups task worktrees; excludes hosted Cloudflare data and native provider history',
  };
  const body = JSON.stringify(manifest, null, 2);
  await writeFile(join(pending, 'manifest.json'), body, { flag: 'wx', mode: 0o600 });
  await rename(pending, destination);
  await writeFile(
    join(root, `${id}.receipt.json`),
    JSON.stringify({ id, manifestSha256: createHash('sha256').update(body).digest('hex') }),
    { flag: 'wx', mode: 0o600 },
  );
  return { id, files: files.length, bytes: total, externalWorktrees: external.length };
}
export async function verifyGroups(dataDirectory, id) {
  if (!uuid.test(id)) throw new Error('Use the exact Groups recovery archive reference.');
  const directory = join(resolve(dataDirectory), 'group-recovery', id);
  if ((await realpath(directory)) !== directory)
    throw new Error('Linked recovery storage is refused.');
  const { bytes } = await checkedFile(join(directory, 'manifest.json'), undefined, true);
  const receipt = JSON.parse(
    (
      await checkedFile(
        join(resolve(dataDirectory), 'group-recovery', `${id}.receipt.json`),
        undefined,
        true,
      )
    ).bytes,
  );
  if (
    receipt.id !== id ||
    receipt.manifestSha256 !== createHash('sha256').update(bytes).digest('hex')
  )
    throw new Error('Recovery manifest no longer matches its original receipt.');
  const manifest = JSON.parse(bytes);
  if (
    manifest.version !== 1 ||
    manifest.id !== id ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.directories) ||
    manifest.files.length > MAX_FILES
  )
    throw new Error('Invalid recovery manifest.');
  const seen = new Set();
  for (const directoryName of manifest.directories) {
    if (!safe(directoryName) || seen.has(directoryName))
      throw new Error('Invalid recovery directory identity.');
    seen.add(directoryName);
    const path = join(directory, directoryName),
      s = await lstat(path);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (s.mode & 0o777) !== 0o700 ||
      (await realpath(path)) !== path
    )
      throw new Error('Recovery directory changed or is no longer private.');
  }
  for (const file of manifest.files) {
    if (!safe(file.path) || seen.has(file.path)) throw new Error('Invalid recovery file identity.');
    seen.add(file.path);
    const path = join(directory, file.path);
    if ((await realpath(path)) !== path) throw new Error('Linked recovery file is refused.');
    if (![0o600, 0o700].includes(file.mode) || ((await lstat(path)).mode & 0o777) !== file.mode)
      throw new Error('Recovery file is no longer private or its executable mode changed.');
    const checked = await checkedFile(path);
    if (checked.sha256 !== file.sha256 || checked.size !== file.bytes)
      throw new Error('Recovery bytes changed.');
    if (/\.(?:sqlite|db)$/u.test(file.path)) await integrity(path);
  }
  return {
    id,
    verified: true,
    files: manifest.files.length,
    externalWorktrees: manifest.external.length,
  };
}
export async function stageGroups(dataDirectory, id) {
  const verified = await verifyGroups(dataDirectory, id),
    dataDir = resolve(dataDirectory);
  const source = join(dataDir, 'group-recovery', id);
  const manifest = JSON.parse(
    (await checkedFile(join(source, 'manifest.json'), undefined, true)).bytes,
  );
  const parent = join(dataDir, 'group-recovery-staging');
  await privateDirectory(parent);
  const stageId = randomUUID(),
    destination = join(parent, stageId);
  await mkdir(destination, { mode: 0o700 });
  for (const name of manifest.directories)
    await mkdir(join(destination, name), { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const path = join(destination, file.path);
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    const captured = await checkedFile(join(source, file.path), path);
    if (file.mode === 0o700) await chmod(path, file.mode);
    if (captured.sha256 !== file.sha256 || captured.size !== file.bytes)
      throw new Error('Archive changed during staging; partial stage preserved.');
  }
  return { ...verified, stageId, started: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const [command, dataDir, id] = process.argv.slice(2);
  try {
    if (!dataDir || !['save', 'verify', 'stage'].includes(command))
      throw new Error(
        'Use: groups-recovery.mjs save DATA_DIR | verify DATA_DIR UUID | stage DATA_DIR UUID',
      );
    console.log(
      JSON.stringify(
        command === 'save'
          ? await saveGroups(dataDir)
          : command === 'stage'
            ? await stageGroups(dataDir, id)
            : await verifyGroups(dataDir, id),
      ),
    );
  } catch (e) {
    console.error(
      e.code
        ? 'Groups recovery could not complete. Originals and any partial archive were preserved; inspect locally.'
        : e.message,
    );
    process.exitCode = 1;
  }
}
