import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Conflict } from './store.js';

export type ProjectEditorOpener = (registeredRoot: string) => Promise<void>;
/** The caller supplies a registered server-side root, never a browser-supplied path. */
export const openProjectEditor: ProjectEditorOpener = async (registeredRoot) => {
  try {
    const executable = process.platform === 'darwin' ? '/usr/bin/open' : 'code';
    const args =
      process.platform === 'darwin'
        ? ['-n', '-b', 'com.microsoft.VSCode', '--args', '--new-window', registeredRoot]
        : ['--new-window', registeredRoot];
    await promisify(execFile)(executable, args, { timeout: 10_000, maxBuffer: 16_384 });
  } catch {
    throw new Conflict(
      'VS Code could not open on this project’s computer. Check that VS Code is installed there. Your project is unchanged.',
    );
  }
};
