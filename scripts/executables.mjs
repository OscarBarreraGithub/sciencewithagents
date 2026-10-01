/** Host-side setup only. Retain installer-managed entries, never versioned symlink targets. */
import { access, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const standardToolDirectories = () =>
  process.platform === 'darwin'
    ? [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(homedir(), '.local/bin'),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]
    : [join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'];
export const pathDirectories = (value = process.env.PATH ?? '') => [
  ...new Set(value.split(delimiter).filter((path) => isAbsolute(path) && !path.includes('\0'))),
];
async function stableInstalledEntry(path) {
  const entry = resolve(path);
  const brew = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/([^/]+)$/.exec(entry);
  if (!brew) return entry;
  const target = await realpath(entry);
  for (const alias of [
    join(brew[1], 'bin', brew[3]),
    join(brew[1], 'opt', brew[2], 'bin', brew[3]),
  ]) {
    try {
      await access(alias, constants.X_OK);
      if ((await stat(alias)).isFile() && (await realpath(alias)) === target) return alias;
    } catch {
      /* A missing or different alias does not authorize selecting another runtime. */
    }
  }
  return entry;
}
export async function executableEntry(
  command,
  { label = 'executable', required = false, directories = pathDirectories() } = {},
) {
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.includes('\0') ||
    command.startsWith('-') ||
    (!isAbsolute(command) && !/^[a-zA-Z0-9._-]+$/.test(command))
  )
    throw new Error(`Choose an absolute ${label} executable path or an installed command name`);
  const candidates = isAbsolute(command)
    ? [command]
    : directories.map((folder) => join(folder, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile())
        return isAbsolute(command) ? resolve(candidate) : await stableInstalledEntry(candidate);
    } catch {
      /* Try another installed entry. No environment or credentials are printed. */
    }
  }
  if (required) throw new Error(`The selected ${label} executable is missing or not executable`);
  return null;
}

export async function nodeEntry(explicit) {
  if (explicit !== undefined) return executableEntry(explicit, { label: 'Node', required: true });
  const running = await realpath(process.execPath);
  // Prefer an installed stable alias only when it resolves to this exact runtime.
  for (const directory of [...pathDirectories(), ...standardToolDirectories()]) {
    const candidate = await executableEntry(join(directory, 'node'));
    if (candidate && (await realpath(candidate)) === running)
      return stableInstalledEntry(candidate);
  }
  return stableInstalledEntry(process.execPath);
}

export async function selectedTool(args, flag, environment, fallback, label) {
  const index = args.indexOf(flag);
  const explicit = index >= 0 || process.env[environment] !== undefined;
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--')))
    throw new Error(`Choose an absolute ${label} executable path or an installed command name`);
  return executableEntry(index >= 0 ? args[index + 1] : (process.env[environment] ?? fallback), {
    label,
    required: explicit,
  });
}
