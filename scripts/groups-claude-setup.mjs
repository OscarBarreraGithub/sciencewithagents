import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  mkdirSync,
  lstatSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function configureGroups(
  dataDirectory,
  file = join(homedir(), '.config/sciencewithagents/groups-claude.json'),
) {
  const installation = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  dataDirectory = resolve(dataDirectory);
  const fd = openSync(
    join(dataDirectory, 'local-access.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Use this account’s existing private SWA data directory.');
    const config = JSON.parse(readFileSync(fd, 'utf8'));
    if (config.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(config.origin))
      throw new Error('Open SWA once to prepare its authenticated local connection.');
  } finally {
    closeSync(fd);
  }
  if (!existsSync(join(installation, 'apps/server/dist/groups-external-mcp.js')))
    throw new Error('Build this reviewed SWA checkout before configuring Groups.');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(file));
  if (
    !parent.isDirectory() ||
    parent.mode & 0o077 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw new Error('Groups connection needs a private directory owned by this account.');
  const next = JSON.stringify({ version: 1, installation, dataDirectory });
  if (existsSync(file)) {
    const previous = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(previous);
      if (
        !stat.isFile() ||
        stat.size > 4096 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('Existing Groups connection is not private.');
      if (readFileSync(previous, 'utf8').trim() === next) return file;
      throw new Error(
        'Groups already points to another installation. Reconcile that saved connection explicitly before replacing it.',
      );
    } finally {
      closeSync(previous);
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next + '\n', { mode: 0o600, flag: 'wx' });
    linkSync(temporary, file); // Atomic no-replace: concurrent setup cannot replace another connection.
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return file;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/groups-claude-setup.mjs /absolute/existing/SWA/data');
    console.log(
      `Groups connection saved: ${configureGroups(process.argv[2])}. Enable plugins/groups in Claude Code; see docs/GROUPS_CLAUDE.md. No provider, account or server was restarted.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
