import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { Conflict } from './store.js';

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Fixed native action. The app never receives login codes, passwords or tokens. */
export function claudeSignInCommand(binary: string, configDir?: string) {
  if (!isAbsolute(binary) || binary.includes('\0') || configDir?.includes('\0'))
    throw new Conflict('Claude needs a valid host executable selection.');
  return [
    ...(configDir ? ['/usr/bin/env', `CLAUDE_CONFIG_DIR=${configDir}`] : []),
    binary,
    'auth',
    'login',
    '--claudeai',
  ]
    .map(quote)
    .join(' ');
}
export async function openClaudeSignIn(binary: string) {
  if (process.platform !== 'darwin')
    throw new Conflict('Opening a native Claude sign-in window is currently available on Mac.');
  let command: string;
  try {
    let selected = binary;
    if (!isAbsolute(selected)) {
      if (!/^[a-zA-Z0-9._-]+$/.test(selected)) throw new Error('Invalid executable');
      selected = (
        await execute('/usr/bin/which', [selected], { timeout: 5000, maxBuffer: 8192 })
      ).stdout.trim();
    }
    await access(selected, constants.X_OK);
    command = claudeSignInCommand(selected, process.env.CLAUDE_CONFIG_DIR);
  } catch {
    throw new Conflict(
      'Claude could not be found on this computer. Check its native installation and retry.',
    );
  }
  try {
    await execute(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv\n tell application "Terminal"\n do script (item 1 of argv)\n activate\n end tell\nend run',
        command,
      ],
      { timeout: 20_000, maxBuffer: 8192 },
    );
  } catch {
    throw new Conflict(
      'The Claude sign-in window could not be confirmed. Check Terminal on this Mac before opening another window.',
    );
  }
}
